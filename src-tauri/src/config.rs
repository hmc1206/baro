// 사용자 설정 파일 (~/Library/Application Support/dev.hmc.baro/config.json)
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Serialize, Deserialize, Clone)]
pub struct Quicklink { pub keyword: String, pub name: String, pub url: String }

#[derive(Serialize, Deserialize, Clone)]
pub struct Snippet { pub keyword: String, pub name: String, pub text: String }

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct Config {
    // "ollama"(내 Mac에서 무료 실행) 또는 "claude"(API 키 필요)
    pub ai_provider: String,
    pub ollama_url: String,
    pub ollama_model: String,
    pub anthropic_api_key: String,
    pub ai_model: String,
    pub quicklinks: Vec<Quicklink>,
    pub snippets: Vec<Snippet>,
    // 확장 스토어 목록(index.json) 주소. https:// 또는 file://
    pub store_url: String,
}

fn ql(k: &str, n: &str, u: &str) -> Quicklink { Quicklink { keyword: k.into(), name: n.into(), url: u.into() } }
fn sn(k: &str, n: &str, t: &str) -> Snippet { Snippet { keyword: k.into(), name: n.into(), text: t.into() } }

impl Default for Config {
    fn default() -> Self {
        Config {
            ai_provider: "ollama".into(),
            ollama_url: "http://localhost:11434".into(),
            ollama_model: "qwen3.5:9b".into(),
            anthropic_api_key: String::new(),
            ai_model: "claude-opus-5-5".into(),
            quicklinks: vec![
                ql("yt", "YouTube 검색", "https://www.youtube.com/results?search_query={query}"),
                ql("nv", "네이버 검색", "https://search.naver.com/search.naver?query={query}"),
                ql("gh", "GitHub 검색", "https://github.com/search?q={query}"),
                ql("map", "네이버 지도 검색", "https://map.naver.com/p/search/{query}"),
            ],
            snippets: vec![
                sn("today", "오늘 날짜", "{date}"),
                sn("thx", "감사 인사", "확인 감사합니다. 좋은 하루 보내세요!"),
            ],
            store_url: String::new(),
        }
    }
}

// 파일이 없으면 기본값으로 만들고, 형식이 잘못됐으면 덮어쓰지 않고 오류를 돌려줌
pub fn load(path: &Path) -> Result<Config, String> {
    match std::fs::read(path) {
        Ok(b) => serde_json::from_slice(&b).map_err(|e| format!("설정 파일 형식 오류: {e}")),
        Err(_) => {
            let c = Config::default();
            if let Some(dir) = path.parent() { let _ = std::fs::create_dir_all(dir); }
            let _ = std::fs::write(path, serde_json::to_vec_pretty(&c).unwrap_or_default());
            Ok(c)
        }
    }
}

// 화면에 넘기는 설정 (API 키는 제외)
#[derive(Serialize)]
pub struct PublicConfig {
    pub ai_ready: bool,
    pub ai_model: String,
    pub quicklinks: Vec<Quicklink>,
    pub snippets: Vec<Snippet>,
    pub store_ready: bool,
    pub error: Option<String>,
}

pub fn public(path: &Path) -> PublicConfig {
    match load(path) {
        Ok(c) => PublicConfig {
            ai_ready: c.ai_provider != "claude" || !c.anthropic_api_key.trim().is_empty(),
            ai_model: if c.ai_provider == "claude" { c.ai_model } else { c.ollama_model },
            store_ready: !c.store_url.trim().is_empty(), quicklinks: c.quicklinks, snippets: c.snippets, error: None },
        Err(e) => PublicConfig { ai_ready: false, ai_model: String::new(), quicklinks: vec![], snippets: vec![], store_ready: false, error: Some(e) },
    }
}
