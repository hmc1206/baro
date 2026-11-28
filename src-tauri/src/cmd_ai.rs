// AI 명령: AI에게 묻기, 내 노트에게 묻기(RAG), 뜻 색인 만들기, 답변을 노트로 저장
// main.rs에서 그대로 옮김
use super::*;

#[tauri::command]
pub async fn ask_ai(id: u32, prompt: String, app: AppHandle) -> Result<Vec<rag::Source>, String> {
    let c = config::load(&config_file(&app))?;
    if c.ai_provider == "claude" && c.anthropic_api_key.trim().is_empty() {
        return Err("설정 파일에 anthropic_api_key를 넣거나 ai_provider를 \"ollama\"로 바꿔 주세요.".into());
    }
    // 최신 소식을 묻는 질문이면 뉴스를 먼저 가져와 근거로 붙임. 출처 링크는 모델이 아니라 여기서 만듦
    let (prompt, sources) = if news::detect(&prompt) { with_news(&prompt).await } else { (prompt, vec![]) };
    tauri::async_runtime::spawn(ai::ask(app, c, id, prompt));
    Ok(sources)
}

// 뉴스 기사를 붙인 질문과 출처 목록. 가져오지 못하면 로그만 남기고 질문 그대로(뉴스 없이 답함)
async fn with_news(question: &str) -> (String, Vec<rag::Source>) {
    match log::warn("뉴스 가져오기", news::fetch(&news::keyword(question)).await) {
        Some(items) => {
            let sources = items.iter().map(|a| rag::Source {
                title: if a.source.is_empty() { a.title.clone() } else { format!("{} · {}", a.title, a.source) },
                file: a.link.clone(),
            }).collect();
            (news::prompt(&news::today(), question, &items), sources)
        }
        None => (question.to_string(), vec![]),
    }
}

// AI 답변을 Obsidian 노트로 저장. 저장 폴더를 보는 노트 검색이 없으면 "AI 답변" 노트 검색을 만들어 다시 찾을 수 있게 함
// 내 노트에게 묻기: 관련 노트를 찾아 발췌와 함께 AI에 질문. 찾은 노트(출처)를 바로 돌려주고 답변은 스트리밍
#[tauri::command]
pub async fn ask_notes(id: u32, question: String, app: AppHandle) -> Result<Vec<rag::Source>, String> {
    let c = config::load(&config_file(&app))?;
    if c.ai_provider == "claude" && c.anthropic_api_key.trim().is_empty() {
        return Err("설정 파일에 anthropic_api_key를 넣거나 ai_provider를 \"ollama\"로 바꿔 주세요.".into());
    }
    let vault = std::path::PathBuf::from(&c.vault_dir);
    if !vault.is_dir() { return Err(format!("Vault를 읽을 수 없어요. 외장 디스크 연결을 확인하세요.\n{}", c.vault_dir)); }
    // 비밀번호 모음 폴더는 통째로 제외
    let skip: Vec<String> = c.note_searches.iter().filter(|n| n.kind == "passwords").map(|n| n.dir.clone()).collect();
    let skip = rag::skip_list(&skip);
    let ix = tauri::async_runtime::spawn_blocking(move || { let ix = rag::index(&vault, &skip); vault::save(); ix }).await.map_err(|e| e.to_string())?;
    // 뜻 검색: "노트 뜻 색인 만들기"를 한 번 해 둔 경우에만. 바뀐 단락이 조금(64개 이하)이면 지금 계산
    let url = c.ollama_url.trim_end_matches('/').to_string();
    let mut qvec = None;
    if embed::exists() && embed::count() > 0 {
        let items = rag::embed_items(&ix);
        let missing = items.iter().filter(|(k, _)| !embed::has(*k)).count();
        if missing > 0 && missing <= 64 && !embed::BUSY.load(std::sync::atomic::Ordering::Relaxed)
            && embed::fill(&url, &items, 16, |_, _| {}).await.is_ok() {
            embed::save(Some(&rag::embed_keys(&ix)));
        }
        // 실패하면 단어 검색만으로 진행
        qvec = log::warn("질문 뜻 벡터 만들기", embed::embed(&url, std::slice::from_ref(&question)).await).and_then(|mut v| v.pop());
    }
    let hits = rag::rank(&ix, &question, qvec.as_deref(), 5);
    if hits.is_empty() { return Err("질문과 관련된 노트를 찾지 못했어요. 노트에 나올 만한 단어로 물어보세요.".into()); }
    let sources = hits.iter().map(|h| rag::Source { title: h.title.clone(), file: h.file.clone() }).collect();
    tauri::async_runtime::spawn(ai::ask(app, c, id, rag::prompt(&question, &hits)));
    Ok(sources)
}

// 노트 뜻 색인 만들기 (bge-m3): 없는 단락만 계산. 진행은 embed-progress, 끝나면 embed-done 이벤트. 돌려주는 값: 계산할 단락 수
#[tauri::command]
pub async fn notes_embed_build(app: AppHandle) -> Result<usize, String> {
    use std::sync::atomic::Ordering;
    let c = config::load(&config_file(&app))?;
    let vault = std::path::PathBuf::from(&c.vault_dir);
    if !vault.is_dir() { return Err(format!("Vault를 읽을 수 없어요. 외장 디스크 연결을 확인하세요.\n{}", c.vault_dir)); }
    if embed::BUSY.swap(true, Ordering::SeqCst) { return Err("이미 만들고 있어요.".into()); }
    let skip = rag::skip_list(&c.note_searches.iter().filter(|n| n.kind == "passwords").map(|n| n.dir.clone()).collect::<Vec<_>>());
    let ix = match tauri::async_runtime::spawn_blocking(move || rag::index(&vault, &skip)).await {
        Ok(ix) => ix,
        Err(e) => { embed::BUSY.store(false, Ordering::SeqCst); return Err(e.to_string()); }
    };
    let items = rag::embed_items(&ix);
    let todo = items.iter().filter(|(k, _)| !embed::has(*k)).count();
    let url = c.ollama_url.trim_end_matches('/').to_string();
    tauri::async_runtime::spawn(async move {
        let a = app.clone();
        let r = embed::fill(&url, &items, 16, |done, total| {
            let _ = a.emit("embed-progress", serde_json::json!({ "done": done, "total": total }));
            if done % 320 == 0 { embed::save(None); } // 중간 저장 (도중에 꺼져도 이어서)
        }).await;
        embed::save(Some(&rag::embed_keys(&ix)));
        embed::BUSY.store(false, Ordering::SeqCst);
        let _ = app.emit("embed-done", serde_json::json!({ "total": todo, "count": embed::count(), "error": r.err() }));
    });
    Ok(todo)
}

#[tauri::command]
pub fn save_ai(date: String, question: String, answer: String, app: AppHandle) -> Result<String, String> {
    if !date.chars().all(|c| c.is_ascii_digit() || c == '-') { return Err("잘못된 날짜".into()); }
    let path = config_file(&app);
    let mut c = config::load(&path)?;
    let model = if c.ai_provider == "claude" { c.ai_model.clone() } else { c.ollama_model.clone() };
    let saved = wiki::save_ai(&c.ai_save_dir, &date, &question, &answer, &model)?;
    let dir = c.ai_save_dir.trim_end_matches('/').to_string();
    if !c.note_searches.iter().any(|n| n.dir.trim_end_matches('/') == dir) {
        let id = if c.note_searches.iter().any(|n| n.id == "ai") { format!("ai{}", c.note_searches.len()) } else { "ai".into() };
        c.note_searches.push(config::NoteSearch { id, name: "AI 답변".into(), dir, kind: "notes".into() });
        c.hotkeys = config::hotkeys(&c);
        config::save(&path, &c)?;
    }
    Ok(saved)
}
