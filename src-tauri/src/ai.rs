// AI 답변 스트리밍: Ollama(로컬, 기본값) 또는 Claude API (Rust 공식 SDK가 없어 HTTP로 직접 호출)
use futures_util::StreamExt;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::config::Config;

const SYSTEM: &str = "You are a quick assistant inside a desktop launcher. \
Answer concisely in the user's language. Prefer plain text with minimal markdown.";

// 모델은 오늘 날짜를 모르므로 시스템 프롬프트에 넣음
fn system() -> String { format!("{SYSTEM} Today's date: {}.", crate::news::today()) }

#[derive(Serialize, Clone)]
struct Chunk { id: u32, text: String }
#[derive(Serialize, Clone)]
struct Done { id: u32, error: Option<String> }

pub async fn ask(app: AppHandle, c: Config, id: u32, prompt: String) {
    let r = if c.ai_provider == "claude" {
        stream(&app, c.anthropic_api_key.trim(), &c.ai_model, id, &prompt).await
    } else {
        ollama(c.ollama_url.trim_end_matches('/'), &c.ollama_model, &prompt,
            |text| { let _ = app.emit("ai-chunk", Chunk { id, text: text.to_string() }); }).await
    };
    let _ = app.emit("ai-done", Done { id, error: r.err() });
}

// Ollama /api/chat: 한 줄에 JSON 하나씩(NDJSON) 스트리밍
async fn ollama(url: &str, model: &str, prompt: &str, mut on_text: impl FnMut(&str)) -> Result<(), String> {
    let body = json!({
        "model": model,
        "stream": true,
        "think": false, // 생각 과정은 건너뛰고 바로 답변 (런처에선 빠른 응답이 중요)
        "messages": [{ "role": "system", "content": system() }, { "role": "user", "content": prompt }],
    });
    let res = reqwest::Client::new().post(format!("{url}/api/chat")).json(&body).send().await
        .map_err(|_| "Ollama에 연결하지 못했어요. Ollama 앱이 켜져 있는지 확인하세요.".to_string())?;
    if res.status().as_u16() == 404 {
        return Err(format!("{model} 모델이 없어요. 터미널에서 `ollama pull {model}`로 받거나 설정의 ollama_model을 바꾸세요."));
    }
    if !res.status().is_success() {
        let s = res.status();
        return Err(format!("Ollama 오류 {s}: {}", res.text().await.unwrap_or_default()));
    }
    let mut buf: Vec<u8> = Vec::new();
    let mut body = res.bytes_stream();
    while let Some(chunk) = body.next().await {
        buf.extend_from_slice(&chunk.map_err(|e| format!("Ollama 연결 오류: {e}"))?);
        while let Some(pos) = buf.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            let Ok(v) = serde_json::from_slice::<Value>(&line) else { continue };
            if let Some(e) = v["error"].as_str() { return Err(format!("Ollama 오류: {e}")); }
            if let Some(text) = v["message"]["content"].as_str() {
                if !text.is_empty() { on_text(text); }
            }
        }
    }
    Ok(())
}

async fn stream(app: &AppHandle, key: &str, model: &str, id: u32, prompt: &str) -> Result<(), String> {
    let body = json!({
        "model": model,
        "max_tokens": 64000,
        "stream": true,
        // 런처의 짧은 질의응답이라 effort는 low
        "output_config": { "effort": "low" },
        // 안전 분류기가 거절하면 서버가 다른 모델로 자동 재시도
        "fallbacks": "default",
        "system": system(),
        "messages": [{ "role": "user", "content": prompt }],
    });
    let res = reqwest::Client::new()
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", key)
        .header("anthropic-version", "2026-10-21")
        .header("anthropic-beta", "server-side-fallback-2026-07-01")
        .json(&body)
        .send().await
        .map_err(|e| format!("네트워크 오류: {e}"))?;

    let status = res.status();
    if !status.is_success() {
        let text = res.text().await.unwrap_or_default();
        let msg = serde_json::from_str::<Value>(&text).ok()
            .and_then(|v| v["error"]["message"].as_str().map(String::from))
            .unwrap_or(text);
        return Err(match status.as_u16() {
            401 => "API 키가 올바르지 않아요. 설정 파일의 anthropic_api_key를 확인하세요.".into(),
            429 => "요청 한도를 넘었어요. 잠시 후 다시 시도하세요.".into(),
            _ => format!("API 오류 {status}: {msg}"),
        });
    }

    // SSE: 이벤트는 빈 줄로 구분. 한글이 청크 경계에서 잘리지 않도록 바이트 단위로 모아서 자름
    let mut buf: Vec<u8> = Vec::new();
    let mut body = res.bytes_stream();
    while let Some(chunk) = body.next().await {
        buf.extend_from_slice(&chunk.map_err(|e| format!("네트워크 오류: {e}"))?);
        while let Some(pos) = buf.windows(2).position(|w| w == b"\n\n") {
            let ev: Vec<u8> = buf.drain(..pos + 2).collect();
            for line in String::from_utf8_lossy(&ev).lines() {
                let Some(data) = line.strip_prefix("data: ") else { continue };
                let Ok(v) = serde_json::from_str::<Value>(data) else { continue };
                match v["type"].as_str() {
                    Some("content_block_delta") if v["delta"]["type"] == "text_delta" => {
                        let text = v["delta"]["text"].as_str().unwrap_or("").to_string();
                        let _ = app.emit("ai-chunk", Chunk { id, text });
                    }
                    Some("message_delta") if v["delta"]["stop_reason"] == "refusal" => {
                        return Err("이 요청에는 답할 수 없어요.".into());
                    }
                    Some("error") => {
                        return Err(format!("API 오류: {}", v["error"]["message"].as_str().unwrap_or("알 수 없음")));
                    }
                    _ => {}
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    // 로컬 Ollama가 켜져 있어야 함: cargo test --release ollama -- --ignored
    #[test]
    #[ignore]
    fn ollama_streams_answer() {
        let mut out = String::new();
        tauri::async_runtime::block_on(super::ollama("http://localhost:11434", "qwen3.5:9b", "1+1은? 숫자만", |t| out.push_str(t))).unwrap();
        assert!(out.contains('2'), "{out}");
        let e = tauri::async_runtime::block_on(super::ollama("http://localhost:11434", "nope:1b", "hi", |_| {})).unwrap_err();
        assert!(e.contains("ollama pull"), "{e}");
    }
}
