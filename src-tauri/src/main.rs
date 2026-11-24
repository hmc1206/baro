#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod ai;
mod clip;
mod config;
mod embed;
mod expand;
mod extensions;
mod indexer;
mod rag;
mod search;
mod shot;
mod system;
mod vault;
mod wiki;
mod window;

use base64::Engine;
use std::{collections::HashMap, path::{Path, PathBuf}, sync::Mutex};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

#[derive(Default)]
struct AppState {
    apps: Mutex<Vec<indexer::AppEntry>>,
    usage: Mutex<HashMap<String, u32>>,
    prev_pid: Mutex<Option<i32>>, // Baro를 열기 전 앞에 있던 앱 (창 관리 대상)
    hotkeys: Mutex<HashMap<u32, String>>, // 등록된 단축키 id → 기능 이름
    action: Mutex<String>, // 지금 창이 열린 기능
    suspended: Mutex<bool>, // 단축키 입력받는 동안 전역 단축키를 잠시 해제
    dialog_open: Mutex<bool>, // 폴더 선택 창이 떠 있는 동안에는 포커스를 잃어도 숨기지 않음
    pinned: Mutex<bool>, // 창 고정: 다른 앱을 눌러도 숨기지 않고 화면 위에 계속 띄움
    prev_bundle: Mutex<Option<String>>, // Baro 직전에 앞에 있던 앱 (고정 중 포커스 돌려주기용)
    placed: Mutex<bool>, // 사용자가 끌기 막대로 창을 옮겼으면 다음에 열 때도 그 자리에 띄움
}


fn data_dir(app: &AppHandle) -> PathBuf { app.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir().join("baro")) }
fn icon_dir(app: &AppHandle) -> PathBuf {
    app.path().app_cache_dir().unwrap_or_else(|_| std::env::temp_dir().join("baro")).join("icons")
}
fn usage_file(app: &AppHandle) -> PathBuf { data_dir(app).join("usage.json") }
fn config_file(app: &AppHandle) -> PathBuf { data_dir(app).join("config.json") }
fn ext_dir(app: &AppHandle) -> PathBuf { data_dir(app).join("extensions") }

// 실행이 끝난 뒤: 이전 앱으로 포커스를 돌려줌. 고정 중이면 Baro 창은 그대로 둠
fn dismiss(app: &AppHandle) {
    let st = app.state::<AppState>();
    if *st.pinned.lock().unwrap() {
        if let Some(b) = st.prev_bundle.lock().unwrap().clone() { system::activate(&b); }
        return;
    }
    close(app);
}

// 고정 여부와 상관없이 창 닫기
fn close(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") { let _ = w.hide(); }
    #[cfg(target_os = "macos")]
    let _ = app.hide();
}

#[tauri::command]
fn close_window(app: AppHandle) { close(&app); }

// 끌기 막대로 옮기기 시작하면 on=true. on=false면 위치 기억을 지우고 가운데로
#[tauri::command]
fn set_placed(on: bool, app: AppHandle, win: WebviewWindow) {
    *app.state::<AppState>().placed.lock().unwrap() = on;
    if !on { let _ = win.center(); }
}

#[tauri::command]
fn set_pinned(on: bool, app: AppHandle, win: WebviewWindow) -> bool {
    let st = app.state::<AppState>();
    let was = std::mem::replace(&mut *st.pinned.lock().unwrap(), on);
    // 고정하면 고정 크기로 (왼쪽 위 위치는 그대로), 풀면 지금 화면 종류의 크기로
    if on != was { window::apply(&win, on, !on && !*st.placed.lock().unwrap()); }
    on
}

// 화면 종류(normal·wide·graph)가 바뀌면 그 종류에 기억한 크기로. 고정 중에는 크기를 바꾸지 않음
#[tauri::command]
fn set_view(kind: String, app: AppHandle, win: WebviewWindow) {
    let st = app.state::<AppState>();
    let pinned = *st.pinned.lock().unwrap();
    if window::set_view(&kind) && !pinned { window::apply(&win, false, !*st.placed.lock().unwrap()); }
}

// 기억한 창 크기를 모두 지우고 기본 크기로
#[tauri::command]
fn window_reset(app: AppHandle, win: WebviewWindow) {
    let st = app.state::<AppState>();
    window::reset();
    window::apply(&win, *st.pinned.lock().unwrap(), !*st.placed.lock().unwrap());
}

#[tauri::command]
fn search(q: String, st: State<AppState>) -> Vec<indexer::AppEntry> {
    search::rank(&st.apps.lock().unwrap(), &st.usage.lock().unwrap(), &q, 8)
}

// 아이콘을 data URL로 반환. 캐시에 없으면 그 자리에서 만듦 (async라 메인 스레드를 막지 않음)
#[tauri::command]
async fn icon(path: String, app: AppHandle) -> Option<String> {
    let dir = icon_dir(&app);
    let f = indexer::icon_file(&dir, &path);
    if !f.exists() { indexer::make_icons(&dir, &[&path]); }
    let bytes = std::fs::read(f).ok()?;
    Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

// Linux .desktop은 open으로 열면 편집기가 뜰 수 있어 gio로 실행
fn start(path: &str) -> std::io::Result<()> {
    #[cfg(target_os = "linux")]
    if path.ends_with(".desktop") {
        return std::process::Command::new("gio").args(["launch", path]).spawn().map(|_| ());
    }
    open::that_detached(path)
}

#[tauri::command]
fn launch(path: String, st: State<AppState>, app: AppHandle) -> Result<(), String> {
    start(&path).map_err(|e| e.to_string())?;
    dismiss(&app);
    // 사용 기록은 디스크에 저장해 재시작 후에도 유지
    let mut usage = st.usage.lock().unwrap();
    *usage.entry(path).or_default() += 1;
    let f = usage_file(&app);
    let _ = std::fs::create_dir_all(f.parent().unwrap());
    let _ = std::fs::write(f, serde_json::to_vec(&*usage).unwrap_or_default());
    Ok(())
}

// 파일 열기 (사용 기록에는 남기지 않음)
#[tauri::command]
fn open_path(path: String, app: AppHandle) -> Result<(), String> {
    open::that_detached(&path).map_err(|e| e.to_string())?;
    dismiss(&app);
    Ok(())
}

// 파일 관리자에서 위치 보기
#[tauri::command]
fn reveal(path: String, app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").args(["-R", &path]).spawn().map(|_| ());
    #[cfg(target_os = "windows")]
    let r = std::process::Command::new("explorer").arg(format!("/select,{path}")).spawn().map(|_| ());
    #[cfg(target_os = "linux")]
    let r = open::that_detached(std::path::Path::new(&path).parent().unwrap_or(std::path::Path::new("/")));
    r.map_err(|e| e.to_string())?;
    dismiss(&app);
    Ok(())
}

#[tauri::command]
fn open_url(url: String, app: AppHandle) -> Result<(), String> {
    open::that_detached(&url).map_err(|e| e.to_string())?;
    dismiss(&app);
    Ok(())
}

#[tauri::command]
fn hide(app: AppHandle) { dismiss(&app); }

#[tauri::command]
async fn files(q: String) -> Vec<String> {
    tauri::async_runtime::spawn_blocking(move || system::find_files(&q, 6)).await.unwrap_or_default()
}

// 파일 찾기 화면: 홈 + 외장 디스크에서 이름으로 검색
#[tauri::command]
async fn files_wide(q: String) -> Vec<String> {
    tauri::async_runtime::spawn_blocking(move || system::find_files_wide(&q, 60)).await.unwrap_or_default()
}

#[tauri::command]
fn get_config(app: AppHandle) -> config::PublicConfig {
    // 스니펫이 바뀌었을 수 있으니 자동 확장 목록도 새로
    if let Ok(c) = config::load(&config_file(&app)) { expand::set_snippets(&c.snippets); }
    config::public(&config_file(&app))
}

// 스니펫 자동 확장 켜기·끄기. 켰는데 권한이 없으면 "PERM:input" (macOS가 권한 창을 띄움)
#[tauri::command]
async fn snippet_expand_set(on: bool, app: AppHandle) -> Result<bool, String> {
    let f = config_file(&app);
    let mut c = config::load(&f)?;
    c.snippet_expand = on;
    config::save(&f, &c)?;
    expand::set_snippets(&c.snippets);
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || { let _ = tx.send(expand::enable(on)); }).map_err(|e| e.to_string())?;
    let running = rx.recv().map_err(|e| e.to_string())?;
    if on && !running { return Err("PERM:input".into()); }
    Ok(running)
}
#[tauri::command]
fn snippet_expand_state(app: AppHandle) -> bool { config::load(&config_file(&app)).map(|c| c.snippet_expand).unwrap_or(false) }

// 설정 파일을 기본 텍스트 편집기로 열기
#[tauri::command]
fn open_config(app: AppHandle) -> Result<(), String> {
    let f = config_file(&app);
    let _ = config::load(&f); // 없으면 기본값으로 생성
    #[cfg(target_os = "macos")]
    std::process::Command::new("open").arg("-t").arg(&f).spawn().map_err(|e| e.to_string())?;
    #[cfg(not(target_os = "macos"))]
    open::that_detached(&f).map_err(|e| e.to_string())?;
    dismiss(&app);
    Ok(())
}

// 실행이 끝난 뒤에 숨김: 권한 오류가 나면 창에 안내를 띄울 수 있도록
#[tauri::command]
async fn system_cmd(cmd: String, app: AppHandle) -> Result<(), String> {
    if cmd == "quit" { app.exit(0); return Ok(()); }
    system::run(&cmd)?;
    dismiss(&app);
    Ok(())
}

// 클립보드에 복사된 내용을 앞 앱에 붙여넣기
#[tauri::command]
async fn paste(app: AppHandle) -> Result<(), String> {
    system::need_ax()?;
    dismiss(&app);
    system::paste()
}

// 클립보드 기록
#[tauri::command]
fn clip_list() -> Vec<clip::Clip> { clip::list() }
#[tauri::command]
fn clip_remove(at: i64, text: String) { clip::remove(at, &text) }
#[tauri::command]
fn clip_clear() { clip::clear() }
#[tauri::command]
fn clip_enabled() -> bool { clip::ENABLED.load(std::sync::atomic::Ordering::Relaxed) }
#[tauri::command]
fn clip_set_enabled(on: bool, app: AppHandle) -> Result<(), String> {
    let f = config_file(&app);
    let mut c = config::load(&f)?;
    c.clipboard_history = on;
    config::save(&f, &c)?;
    clip::ENABLED.store(on, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}
// 비밀번호 복사: "숨김" 표시를 붙여 클립보드 기록(Baro·다른 앱)에 남지 않게
#[tauri::command]
fn copy_secret(text: String) -> Result<(), String> { clip::copy_secret(&text) }

#[tauri::command]
fn permissions() -> serde_json::Value { serde_json::json!({ "accessibility": system::ax_trusted() }) }

#[tauri::command]
fn open_settings(kind: String) -> Result<(), String> { system::open_settings(&kind) }

#[tauri::command]
fn ext_list(app: AppHandle) -> Vec<extensions::Manifest> { extensions::list(&ext_dir(&app)) }

#[tauri::command]
async fn ext_run(id: String, name: String, arg: String, app: AppHandle) -> Result<String, String> {
    // 스크립트는 오래 걸릴 수 있어 별도 스레드에서 실행
    let dir = ext_dir(&app);
    tauri::async_runtime::spawn_blocking(move || extensions::run(&dir, &id, &name, &arg)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn store_list(app: AppHandle) -> Result<Vec<extensions::StoreEntry>, String> {
    let c = config::load(&config_file(&app))?;
    if c.store_url.trim().is_empty() { return Err("설정 파일에 store_url을 넣어 주세요.".into()); }
    extensions::store(c.store_url.trim()).await
}

#[tauri::command]
async fn store_install(id: String, app: AppHandle) -> Result<extensions::Manifest, String> {
    let c = config::load(&config_file(&app))?;
    let dir = ext_dir(&app);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    extensions::install(&dir, c.store_url.trim(), &id).await
}

#[tauri::command]
fn store_uninstall(id: String, app: AppHandle) -> Result<(), String> { extensions::uninstall(&ext_dir(&app), &id) }

// 앞에 있던 앱의 창을 현재 화면 기준으로 배치
#[tauri::command]
async fn window_layout(kind: String, app: AppHandle, win: WebviewWindow) -> Result<(), String> {
    system::need_ax()?;
    let pid = (*app.state::<AppState>().prev_pid.lock().unwrap()).ok_or("배치할 창이 없어요.")?;
    let m = win.current_monitor().ok().flatten().ok_or("화면 정보를 읽지 못했어요.")?;
    let s = m.scale_factor();
    let wa = m.work_area();
    let area = ((wa.position.x as f64 / s) as i32, (wa.position.y as f64 / s) as i32,
        (wa.size.width as f64 / s) as i32, (wa.size.height as f64 / s) as i32);
    dismiss(&app);
    system::layout(pid, &kind, area)
}

#[tauri::command]
async fn ask_ai(id: u32, prompt: String, app: AppHandle) -> Result<(), String> {
    let c = config::load(&config_file(&app))?;
    if c.ai_provider == "claude" && c.anthropic_api_key.trim().is_empty() {
        return Err("설정 파일에 anthropic_api_key를 넣거나 ai_provider를 \"ollama\"로 바꿔 주세요.".into());
    }
    tauri::async_runtime::spawn(ai::ask(app, c, id, prompt));
    Ok(())
}

// AI 답변을 Obsidian 노트로 저장. 저장 폴더를 보는 노트 검색이 없으면 "AI 답변" 노트 검색을 만들어 다시 찾을 수 있게 함
// 내 노트에게 묻기: 관련 노트를 찾아 발췌와 함께 AI에 질문. 찾은 노트(출처)를 바로 돌려주고 답변은 스트리밍
#[tauri::command]
async fn ask_notes(id: u32, question: String, app: AppHandle) -> Result<Vec<rag::Source>, String> {
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
        qvec = embed::embed(&url, std::slice::from_ref(&question)).await.ok().and_then(|mut v| v.pop());
    }
    let hits = rag::rank(&ix, &question, qvec.as_deref(), 5);
    if hits.is_empty() { return Err("질문과 관련된 노트를 찾지 못했어요. 노트에 나올 만한 단어로 물어보세요.".into()); }
    let sources = hits.iter().map(|h| rag::Source { title: h.title.clone(), file: h.file.clone() }).collect();
    tauri::async_runtime::spawn(ai::ask(app, c, id, rag::prompt(&question, &hits)));
    Ok(sources)
}

// 노트 뜻 색인 만들기 (bge-m3): 없는 단락만 계산. 진행은 embed-progress, 끝나면 embed-done 이벤트. 돌려주는 값: 계산할 단락 수
#[tauri::command]
async fn notes_embed_build(app: AppHandle) -> Result<usize, String> {
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
fn save_ai(date: String, question: String, answer: String, app: AppHandle) -> Result<String, String> {
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

// 같은 기능의 단축키를 다시 누르면 닫고, 다른 기능이면 그 화면으로 전환
// 고정 중에 다른 앱을 쓰다가 단축키를 누르면 닫지 않고 Baro로 포커스만 옮김
fn toggle(w: &WebviewWindow, action: &str) {
    let st = w.state::<AppState>();
    let visible = w.is_visible().unwrap_or(false);
    let focused = w.is_focused().unwrap_or(false);
    let pinned = *st.pinned.lock().unwrap();
    if visible && (focused || !pinned) && *st.action.lock().unwrap() == action { close(w.app_handle()); return; }
    if !(visible && focused) {
        // 창 관리·붙여넣기 대상이 되도록 Baro가 앞에 오기 전에 현재 앱을 기억
        let me = std::process::id() as i32;
        let (pid, bundle) = system::frontmost();
        if pid != Some(me) {
            *st.prev_pid.lock().unwrap() = pid;
            *st.prev_bundle.lock().unwrap() = bundle;
        }
        // 고정 중이거나 사용자가 옮겨 둔 창은 그 위치를 유지
        if !visible && !pinned && !*st.placed.lock().unwrap() { let _ = w.center(); }
        let _ = w.show(); let _ = w.set_focus();
    }
    *st.action.lock().unwrap() = action.to_string();
    let _ = w.emit("shown", action);
}

// 설정의 단축키를 모두 다시 등록. 실패한 항목은 "기능: 이유"로 돌려줌
fn register_hotkeys(app: &AppHandle) -> Vec<(String, String)> {
    let c = config::load(&config_file(app)).unwrap_or_default();
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let mut ids = HashMap::new();
    let mut errors = vec![];
    for (action, accel) in config::hotkeys(&c) {
        if accel.trim().is_empty() { continue; }
        match accel.parse::<Shortcut>() {
            Ok(sc) => match gs.register(sc) {
                Ok(()) => { ids.insert(sc.id(), action); }
                Err(e) => errors.push((action, e.to_string())),
            },
            Err(e) => errors.push((action, e.to_string())),
        }
    }
    *app.state::<AppState>().hotkeys.lock().unwrap() = ids;
    *app.state::<AppState>().suspended.lock().unwrap() = false;
    errors
}

// 새 단축키를 누르는 동안 기존 전역 단축키가 가로채지 않도록 잠시 해제
#[tauri::command]
fn suspend_hotkeys(on: bool, app: AppHandle) {
    if on {
        let _ = app.global_shortcut().unregister_all();
        *app.state::<AppState>().suspended.lock().unwrap() = true;
    } else {
        register_hotkeys(&app);
    }
}

#[tauri::command]
fn get_hotkeys(app: AppHandle) -> std::collections::BTreeMap<String, String> {
    config::hotkeys(&config::load(&config_file(&app)).unwrap_or_default())
}

// 단축키 바꾸기. 다른 기능과 겹치거나 등록에 실패하면 이전 값으로 되돌림
#[tauri::command]
fn set_hotkey(action: String, accel: String, app: AppHandle) -> Result<std::collections::BTreeMap<String, String>, String> {
    if action == "baro" && accel.trim().is_empty() { return Err("Baro 열기 단축키는 비울 수 없어요.".into()); }
    if !accel.is_empty() { accel.parse::<Shortcut>().map_err(|e| format!("단축키 형식 오류: {e}"))?; }
    let path = config_file(&app);
    let mut c = config::load(&path)?;
    let mut keys = config::hotkeys(&c);
    if !keys.contains_key(&action) { return Err(format!("알 수 없는 기능: {action}")); }
    if let Some((other, _)) = keys.iter().find(|(a, k)| **a != action && !accel.is_empty() && k.eq_ignore_ascii_case(&accel)) {
        return Err(format!("이미 다른 기능({other})에 쓰고 있는 단축키예요."));
    }
    let old = keys.insert(action.clone(), accel.clone()).unwrap_or_default();
    c.hotkeys = keys.clone();
    config::save(&path, &c)?;
    if let Some((_, e)) = register_hotkeys(&app).into_iter().find(|(a, _)| *a == action) {
        c.hotkeys.insert(action, old);
        config::save(&path, &c)?;
        register_hotkeys(&app);
        return Err(format!("단축키를 등록하지 못했어요. 다른 앱이 쓰고 있을 수 있어요. ({e})"));
    }
    Ok(keys)
}

// 노트 검색 하나의 노트 읽기
#[tauri::command]
async fn notes_load(id: String, app: AppHandle) -> Result<wiki::Notes, String> {
    let c = config::load(&config_file(&app))?;
    // "__vault": 전체 노트 그래프용. Vault 전체를 일반 노트 방식으로 읽음
    let s = if id == "__vault" { config::NoteSearch { id, name: String::new(), dir: c.vault_dir.clone(), kind: "notes".into() } }
        else { c.note_searches.into_iter().find(|n| n.id == id).ok_or("노트 검색을 찾지 못했어요.")? };
    tauri::async_runtime::spawn_blocking(move || { let r = wiki::load(&s.dir, &s.kind, &c.vault_dir); vault::save(); r }).await.map_err(|e| e.to_string())?
}

fn note_dir(app: &AppHandle, id: &str) -> Result<String, String> {
    let c = config::load(&config_file(app))?;
    c.note_searches.into_iter().find(|n| n.id == id).map(|n| n.dir).ok_or("노트 검색을 찾지 못했어요.".into())
}

// 빠른 메모 기록·사진을 쓸 수 있는 폴더: 노트 검색 폴더. 커리큘럼은 허브가 가리키는 단계 노트가
// 다른 폴더(예: Network-Security/Hacking-Curriculum)에 있을 수 있어 Vault 전체
fn record_dir(app: &AppHandle, id: &str) -> Result<String, String> {
    let c = config::load(&config_file(app))?;
    let n = c.note_searches.into_iter().find(|n| n.id == id).ok_or("노트 검색을 찾지 못했어요.")?;
    Ok(if n.kind == "curriculum" && !c.vault_dir.is_empty() { c.vault_dir } else { n.dir })
}

// 커리큘럼 허브: "### 단계"의 상태 바꾸기 (학습 전·학습 중·복습 필요·완료)
#[tauri::command]
fn note_stage_status(id: String, file: String, heading: String, value: String, app: AppHandle) -> Result<(), String> {
    wiki::set_stage_status(&note_dir(&app, &id)?, &file, &heading, &value)
}

// 커리큘럼: 이름으로 노트 읽기 (단계의 개념 노트들). Vault 어디에 있든, 커리큘럼 폴더 안 노트 먼저
#[tauri::command]
async fn notes_named(id: String, names: Vec<String>, app: AppHandle) -> Result<Vec<wiki::Note>, String> {
    let c = config::load(&config_file(&app))?;
    let s = c.note_searches.into_iter().find(|n| n.id == id).ok_or("노트 검색을 찾지 못했어요.")?;
    if s.kind != "curriculum" { return Err("커리큘럼에서만 쓸 수 있어요.".into()); }
    let vault = c.vault_dir;
    tauri::async_runtime::spawn_blocking(move || { let r = wiki::named(&s.dir, &vault, &names); vault::save(); r }).await.map_err(|e| e.to_string())
}

// 커리큘럼 허브: 개념 항목(index번째 체크박스 줄)의 상태 바꾸기
#[tauri::command]
fn note_task_state(id: String, file: String, index: usize, text: String, value: String, app: AppHandle) -> Result<(), String> {
    wiki::set_task_state(&note_dir(&app, &id)?, &file, index, &text, &value)
}

// 노트 머리말 값 바꾸기 (비밀번호 모음의 비밀번호 수정 등). 해당 노트 검색 폴더 안의 파일만
#[tauri::command]
fn note_set_field(id: String, file: String, key: String, value: String, app: AppHandle) -> Result<(), String> {
    // 커리큘럼은 Vault 어디든 있는 개념 노트에도 (last_studied)
    wiki::set_field(&record_dir(&app, &id)?, &file, &key, &value)
}

// 커리큘럼: 노트의 index번째 체크박스 체크/해제
#[tauri::command]
fn note_toggle_task(id: String, file: String, index: usize, text: String, done: bool, app: AppHandle) -> Result<(), String> {
    wiki::toggle_task(&record_dir(&app, &id)?, &file, index, &text, done)
}

// 커리큘럼 개념: 완료 기준(index번째 체크박스)에 증거를 달고 체크. field가 있으면 머리말 evidence에도
#[tauri::command]
fn note_add_evidence(id: String, file: String, index: usize, text: String, date: String, body: String, field: Option<String>, app: AppHandle) -> Result<(), String> {
    wiki::add_evidence(&record_dir(&app, &id)?, &file, index, &text, &date, &body, field.as_deref())
}

// 커리큘럼 개념: 완료 기준 아래 n번째 증거 고치기 (체크·상태는 그대로)
#[tauri::command]
fn note_edit_evidence(id: String, file: String, index: usize, text: String, n: usize, first: String, body: String, field: Option<String>, app: AppHandle) -> Result<(), String> {
    wiki::edit_evidence(&record_dir(&app, &id)?, &file, index, &text, n, &first, &body, field.as_deref())
}

// 빠른 메모: 오늘 Daily 노트에 한 줄 추가
#[tauri::command]
fn memo_daily(date: String, time: String, text: String, app: AppHandle) -> Result<String, String> {
    let c = config::load(&config_file(&app))?;
    wiki::append_daily(&c.vault_dir, &date, &time, &text)
}

// 빠른 메모 기록 지우기·되돌리기. section이 "daily"면 오늘 Daily(date), 아니면 커리큘럼 단계 노트(id·file)의 그 칸
#[derive(serde::Serialize)]
struct Removed { line: usize, text: String }

#[tauri::command]
fn memo_remove(id: String, file: String, date: String, section: String, index: usize, first: String, app: AppHandle) -> Result<Removed, String> {
    let (line, text) = if section == "daily" {
        wiki::remove_daily(&config::load(&config_file(&app))?.vault_dir, &date, index, &first)?
    } else { wiki::remove_record(&record_dir(&app, &id)?, &file, &section, index, &first)? };
    Ok(Removed { line, text })
}

#[tauri::command]
fn memo_restore(id: String, file: String, date: String, section: String, line: usize, text: String, app: AppHandle) -> Result<(), String> {
    if section == "daily" { wiki::restore_daily(&config::load(&config_file(&app))?.vault_dir, &date, line, &text) }
    else { wiki::restore_record(&record_dir(&app, &id)?, &file, line, &text) }
}

// 빠른 메모 기록 고치기: 그 항목을 지운 자리에 고친 내용을 넣음
#[tauri::command]
fn memo_replace(id: String, file: String, date: String, section: String, index: usize, first: String, text: String, app: AppHandle) -> Result<(), String> {
    if text.trim().is_empty() { return Err("고친 내용이 비어 있어요.".into()); }
    if section == "daily" {
        let vault = config::load(&config_file(&app))?.vault_dir;
        let (line, _) = wiki::remove_daily(&vault, &date, index, &first)?;
        wiki::restore_daily(&vault, &date, line, &text)
    } else {
        let dir = record_dir(&app, &id)?;
        let (line, _) = wiki::remove_record(&dir, &file, &section, index, &first)?;
        wiki::restore_record(&dir, &file, line, &text)
    }
}

// 빠른 메모 스크린샷: 방금 찍은 것 (클립보드 이미지 또는 스크린샷 파일, 30분 이내)
#[tauri::command]
async fn shot_latest(app: AppHandle) -> Result<shot::Shot, String> {
    // 처음 데스크탑을 읽을 때 macOS 폴더 접근 확인 창이 뜨면 Baro가 초점을 잃음 → 그동안은 숨기지 않음
    let st = app.state::<AppState>();
    *st.dialog_open.lock().unwrap() = true;
    let r = tauri::async_runtime::spawn_blocking(shot::latest).await.map_err(|e| e.to_string());
    *st.dialog_open.lock().unwrap() = false;
    r?
}

// 메모할 노트의 폴더. id가 비면 오늘 Daily(03_Daily)
fn memo_note_dir(app: &AppHandle, vault: &Path, id: &str, file: &str) -> Result<PathBuf, String> {
    if id.is_empty() { return Ok(vault.join("03_Daily")); }
    Ok(wiki::inside(&record_dir(app, id)?, file)?.parent().ok_or("노트 폴더를 찾지 못했어요.")?.to_path_buf())
}

// 메모 기록에 붙은 사진(![[파일]])을 미리보기용 data URL로
#[tauri::command]
async fn shot_read(id: String, file: String, name: String, app: AppHandle) -> Result<String, String> {
    let vault = PathBuf::from(config::load(&config_file(&app))?.vault_dir);
    let dir = memo_note_dir(&app, &vault, &id, &file)?.join("attachments");
    tauri::async_runtime::spawn_blocking(move || shot::read(&dir, &name)).await.map_err(|e| e.to_string())?
}

// 스크린샷을 메모할 노트 옆 attachments/에 "날짜-이름"으로 저장하고, 그 폴더의 첨부 목록 노트에 링크 추가.
// id가 비면 오늘 Daily(03_Daily). 돌려주는 값: 파일 이름, 첨부 목록 노트 이름(추가 실패면 빈 글자)
#[tauri::command]
async fn shot_save(source: String, path: Option<String>, name: String, date: String, id: String, file: String, app: AppHandle) -> Result<(String, String), String> {
    let vault = PathBuf::from(config::load(&config_file(&app))?.vault_dir);
    let note_dir = memo_note_dir(&app, &vault, &id, &file)?;
    tauri::async_runtime::spawn_blocking(move || {
        let f = shot::save(&source, path.as_deref(), &name, &date, &note_dir.join("attachments"))?;
        let list = shot::add_to_list(&vault, &note_dir, &note_dir.join("attachments").join(&f))
            .unwrap_or_else(|e| { eprintln!("첨부 목록 추가 실패: {e}"); String::new() });
        Ok((f, list))
    }).await.map_err(|e| e.to_string())?
}

// 빠른 메모: 오늘 Daily 노트 경로 (Obsidian에서 열기용). 아직 없으면 Err
#[tauri::command]
fn memo_daily_path(date: String, app: AppHandle) -> Result<String, String> {
    if date.len() != 10 || !date.chars().all(|c| c.is_ascii_digit() || c == '-') { return Err("날짜 형식이 잘못됐어요.".into()); }
    let f = PathBuf::from(config::load(&config_file(&app))?.vault_dir).join("03_Daily").join(format!("{date}.md"));
    if !f.is_file() { return Err("오늘 Daily 노트가 아직 없어요. 메모를 하나 저장하면 만들어져요.".into()); }
    Ok(f.to_string_lossy().into_owned())
}

// 빠른 메모: 오늘 Daily 노트 읽기 (이미 적은 메모 보기)
#[tauri::command]
fn memo_daily_read(date: String, app: AppHandle) -> String {
    config::load(&config_file(&app)).map(|c| wiki::read_daily(&c.vault_dir, &date)).unwrap_or_default()
}

// 빠른 메모: 커리큘럼 단계 노트의 "내 기록" 칸에 추가
#[tauri::command]
fn note_add_record(id: String, file: String, section: String, block: String, app: AppHandle) -> Result<(), String> {
    wiki::add_record(&record_dir(&app, &id)?, &file, &section, &block)
}

// 클립보드 글자 (명령어 기록용)
#[tauri::command]
fn clipboard_text() -> Result<String, String> {
    let out = std::process::Command::new("pbpaste").output().map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

// 노트 검색 폴더에 새 노트 만들기
#[tauri::command]
fn note_create(id: String, name: String, content: String, app: AppHandle) -> Result<String, String> {
    wiki::create(&note_dir(&app, &id)?, &name, &content)
}

// 노트 검색 추가·수정. id가 비어 있으면 새로 만듦. 저장한 id를 돌려줌
// 아직 없는 [[링크]]로 개념 노트 만들기 (있으면 그 노트). 돌려주는 값: (경로, 새로 만들었는지)
#[tauri::command]
fn concept_create(src: String, name: String, date: String, app: AppHandle) -> Result<(String, bool), String> {
    let c = config::load(&config_file(&app))?;
    wiki::create_concept(&c.vault_dir, &src, &name, &date)
}

#[tauri::command]
fn save_note_search(mut search: config::NoteSearch, hotkey: String, app: AppHandle) -> Result<String, String> {
    search.name = search.name.trim().to_string();
    search.dir = search.dir.trim().trim_end_matches('/').to_string();
    if search.name.is_empty() { return Err("이름을 입력하세요.".into()); }
    if !config::NOTE_KINDS.contains(&search.kind.as_str()) { return Err("방식을 선택하세요.".into()); }
    if !std::path::Path::new(&search.dir).is_dir() { return Err(format!("폴더가 없어요: {}", search.dir)); }
    if search.id.is_empty() {
        search.id = format!("n{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0));
    }
    if !search.id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') { return Err("잘못된 id".into()); }
    if !hotkey.is_empty() { hotkey.parse::<Shortcut>().map_err(|e| format!("단축키 형식 오류: {e}"))?; }
    let action = format!("note:{}", search.id);
    let path = config_file(&app);
    let mut c = config::load(&path)?;
    if let Some((other, _)) = config::hotkeys(&c).iter().find(|(a, k)| **a != action && !hotkey.is_empty() && k.eq_ignore_ascii_case(&hotkey)) {
        return Err(format!("이미 다른 기능({other})에 쓰고 있는 단축키예요."));
    }
    match c.note_searches.iter_mut().find(|n| n.id == search.id) {
        Some(n) => *n = search.clone(),
        None => c.note_searches.push(search.clone()),
    }
    c.hotkeys = config::hotkeys(&c);
    c.hotkeys.insert(action.clone(), hotkey);
    config::save(&path, &c)?;
    if let Some((_, e)) = register_hotkeys(&app).into_iter().find(|(a, _)| *a == action) {
        c.hotkeys.insert(action, String::new());
        config::save(&path, &c)?;
        register_hotkeys(&app);
        return Err(format!("노트 검색은 저장했지만 단축키를 등록하지 못했어요. 다른 키로 바꿔 보세요. ({e})"));
    }
    Ok(search.id)
}

#[tauri::command]
fn delete_note_search(id: String, app: AppHandle) -> Result<(), String> {
    let path = config_file(&app);
    let mut c = config::load(&path)?;
    c.note_searches.retain(|n| n.id != id);
    c.hotkeys.remove(&format!("note:{id}"));
    if id == "linux" { c.hotkeys.remove("linux_wiki"); }
    config::save(&path, &c)?;
    register_hotkeys(&app);
    Ok(())
}

// Finder 폴더 선택 창. 창이 떠 있는 동안 Baro가 숨지 않고 위에 덮지 않도록 잠시 설정을 바꿈
#[tauri::command]
async fn pick_folder(start: String, app: AppHandle, win: WebviewWindow) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    *app.state::<AppState>().dialog_open.lock().unwrap() = true;
    let _ = win.set_always_on_top(false);
    let mut d = app.dialog().file().set_title("노트 폴더 선택");
    if std::path::Path::new(&start).is_dir() { d = d.set_directory(&start); }
    let picked = d.blocking_pick_folder();
    let _ = win.set_always_on_top(true);
    *app.state::<AppState>().dialog_open.lock().unwrap() = false;
    let _ = win.show(); let _ = win.set_focus();
    picked.map(|p| p.to_string())
}

fn main() {
    // 단축키는 설정 파일의 hotkeys에서 읽음 (기본: Baro ⌥Space, 리눅스 명령어 노트 검색 ⌥L). Baro의 "단축키 설정"에서 변경
    tauri::Builder::default()
        // 안전장치: Baro 창이 앱 화면 밖(웹사이트)으로 이동하지 않게. http(s) 주소는 기본 브라우저로 열고 창은 그대로
        .plugin(tauri::plugin::Builder::<tauri::Wry>::new("nav-guard")
            .on_navigation(|_webview, url| {
                let local = matches!(url.scheme(), "tauri" | "asset")
                    || url.host_str() == Some("tauri.localhost")
                    || (url.host_str() == Some("localhost") && url.port() == Some(1420)); // 개발 서버
                if local { return true; }
                if matches!(url.scheme(), "http" | "https" | "mailto") { let _ = open::that_detached(url.as_str()); }
                false
            }).build())
        .plugin(tauri_plugin_global_shortcut::Builder::new()
            .with_handler(|app, sc, ev| {
                if ev.state() != ShortcutState::Pressed { return; }
                let action = app.state::<AppState>().hotkeys.lock().unwrap().get(&sc.id()).cloned();
                // 퀵링크 단축키는 Baro 창을 띄우지 않고 바로 열기
                if let Some(kw) = action.as_deref().and_then(|a| a.strip_prefix("link:")) {
                    let c = config::load(&config_file(app)).unwrap_or_default();
                    if let Some(l) = c.quicklinks.iter().find(|l| l.keyword == kw) { let _ = open::that_detached(&l.url); }
                    return;
                }
                if let (Some(action), Some(w)) = (action, app.get_webview_window("main")) { toggle(&w, &action); }
            }).build())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .setup(move |app| {
            // Dock 아이콘·앱 전환기에서 숨김 (메뉴 막대 앱처럼 동작)
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let h = app.handle().clone();
            for (action, e) in register_hotkeys(&h) { eprintln!("단축키 등록 실패 {action}: {e}"); }
            if let Ok(c) = config::load(&config_file(&h)) {
                expand::set_snippets(&c.snippets);
                if c.snippet_expand && !expand::enable(true) { eprintln!("스니펫 자동 확장: 입력 모니터링 권한 필요"); }
            }
            // 노트 캐시: 저장해 둔 것을 읽고, 뒤에서 Vault를 한 번 훑어 바뀐 노트만 새로 읽어 둠
            vault::init(&data_dir(&h).join("note-cache.json"));
            embed::init(&data_dir(&h).join("embed-cache.bin"));
            // 창 크기: 화면 종류마다 기억한 크기 (가장자리를 끌어 조절)
            window::init(&data_dir(&h).join("window.json"));
            if let Some(w) = h.get_webview_window("main") {
                let _ = w.set_resizable(true);
                let _ = w.set_min_size(Some(tauri::LogicalSize::new(window::MIN.0, window::MIN.1)));
                window::apply(&w, false, true);
            }
            if let Ok(c) = config::load(&config_file(&h)) {
                std::thread::spawn(move || { vault::scan(Path::new(&c.vault_dir)); vault::save(); });
            }
            clip::start(&data_dir(&h).join("clipboard.json"), config::load(&config_file(&h)).map(|c| c.clipboard_history).unwrap_or(true));
            if let Ok(b) = std::fs::read(usage_file(&h)) {
                if let Ok(u) = serde_json::from_slice(&b) { *h.state::<AppState>().usage.lock().unwrap() = u; }
            }
            // 인덱싱과 아이콘 캐시 생성은 백그라운드에서
            std::thread::spawn(move || {
                let list = indexer::scan();
                let paths: Vec<String> = list.iter().map(|a| a.path.clone()).collect();
                *h.state::<AppState>().apps.lock().unwrap() = list;
                let _ = h.emit("indexed", ());
                indexer::make_icons(&icon_dir(&h), &paths.iter().map(String::as_str).collect::<Vec<_>>());
            });
            Ok(())
        })
        .on_window_event(|w, e| if let WindowEvent::Resized(_) = e {
            let pinned = *w.app_handle().state::<AppState>().pinned.lock().unwrap();
            if let Some(win) = w.app_handle().get_webview_window(w.label()) { window::resized(&win, pinned); }
        } else if let WindowEvent::Focused(false) = e {
            let st = w.app_handle().state::<AppState>();
            if *st.dialog_open.lock().unwrap() { return; }
            if *st.pinned.lock().unwrap() {
                // 고정 중: 숨기지 않고, 사용자가 옮겨 간 앱을 붙여넣기·포커스 대상으로 기억
                let app = w.app_handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(150));
                    let (pid, bundle) = system::frontmost();
                    if pid.is_some() && pid != Some(std::process::id() as i32) {
                        let st = app.state::<AppState>();
                        *st.prev_pid.lock().unwrap() = pid;
                        *st.prev_bundle.lock().unwrap() = bundle;
                    }
                });
                return;
            }
            let _ = w.hide();
            // 단축키 입력 중에 창이 닫히면 단축키를 되살려야 Baro를 다시 열 수 있음
            let app = w.app_handle();
            if *app.state::<AppState>().suspended.lock().unwrap() { register_hotkeys(app); }
        })
        .invoke_handler(tauri::generate_handler![search, icon, launch, open_path, reveal, files_wide, open_url, hide,
            files, get_config, open_config, system_cmd, paste, window_layout, ask_ai, ask_notes, notes_embed_build, save_ai,
            permissions, open_settings, ext_list, ext_run, store_list, store_install, store_uninstall,
            get_hotkeys, set_hotkey, suspend_hotkeys,
            notes_load, note_set_field, note_toggle_task, note_add_evidence, note_edit_evidence, note_stage_status, note_task_state, notes_named, note_add_record, memo_daily, memo_daily_read, memo_daily_path, shot_latest, shot_save, shot_read, memo_remove, memo_restore, memo_replace, clipboard_text, note_create, save_note_search, delete_note_search, pick_folder,
            close_window, set_pinned, set_placed, set_view, window_reset, clip_list, clip_remove, clip_clear, clip_enabled, clip_set_enabled, copy_secret, concept_create, snippet_expand_set, snippet_expand_state])
        .build(tauri::generate_context!())
        .expect("Baro 실행 실패")
        .run(|app, e| {
            // 이미 켜진 Baro를 다시 열면(open -a Baro, Finder·Dock) 창을 띄움. 단축키 없이도 열 수 있게
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = e {
                if let Some(w) = app.get_webview_window("main") {
                    if !w.is_visible().unwrap_or(false) { toggle(&w, "baro"); }
                }
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, e);
        });
}
