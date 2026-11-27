#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod ai;
mod clip;
mod cmd_ai;
mod cmd_notes;
mod config;
mod embed;
mod expand;
mod extensions;
mod indexer;
mod log;
mod notion;
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
    if *st.pinned.lock().unwrap_or_else(std::sync::PoisonError::into_inner) {
        if let Some(b) = st.prev_bundle.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone() { system::activate(&b); }
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
// 화면에서 난 실패도 로그 파일에 남김
#[tauri::command]
fn log_error(msg: String) { log::write(&format!("화면 오류: {msg}")); }

// 끌기 막대로 옮기기 시작하면 on=true. on=false면 위치 기억을 지우고 가운데로
#[tauri::command]
fn set_placed(on: bool, app: AppHandle, win: WebviewWindow) {
    *app.state::<AppState>().placed.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = on;
    if !on { let _ = win.center(); }
}

#[tauri::command]
fn set_pinned(on: bool, app: AppHandle, win: WebviewWindow) -> bool {
    let st = app.state::<AppState>();
    let was = std::mem::replace(&mut *st.pinned.lock().unwrap_or_else(std::sync::PoisonError::into_inner), on);
    // 고정하면 고정 크기로 (왼쪽 위 위치는 그대로), 풀면 지금 화면 종류의 크기로
    if on != was { window::apply(&win, on, !on && !*st.placed.lock().unwrap_or_else(std::sync::PoisonError::into_inner)); }
    on
}

// 화면 종류(normal·wide·graph)가 바뀌면 그 종류에 기억한 크기로. 고정 중에는 크기를 바꾸지 않음
#[tauri::command]
fn set_view(kind: String, app: AppHandle, win: WebviewWindow) {
    let st = app.state::<AppState>();
    let pinned = *st.pinned.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if window::set_view(&kind) && !pinned { window::apply(&win, false, !*st.placed.lock().unwrap_or_else(std::sync::PoisonError::into_inner)); }
}

// 기억한 창 크기를 모두 지우고 기본 크기로
#[tauri::command]
fn window_reset(app: AppHandle, win: WebviewWindow) {
    let st = app.state::<AppState>();
    window::reset();
    window::apply(&win, *st.pinned.lock().unwrap_or_else(std::sync::PoisonError::into_inner), !*st.placed.lock().unwrap_or_else(std::sync::PoisonError::into_inner));
}

#[tauri::command]
fn search(q: String, st: State<AppState>) -> Vec<indexer::AppEntry> {
    search::rank(&st.apps.lock().unwrap_or_else(std::sync::PoisonError::into_inner), &st.usage.lock().unwrap_or_else(std::sync::PoisonError::into_inner), &q, 8)
}

// 앱 실행 화면: 입력이 없으면 전체 앱(자주 쓴 순 → 이름순), 있으면 일치하는 앱 전부
#[tauri::command]
fn apps(q: String, st: State<AppState>) -> Vec<indexer::AppEntry> {
    let list = st.apps.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let usage = st.usage.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if !q.trim().is_empty() { return search::rank(&list, &usage, q.trim(), list.len()); }
    let mut v = list.clone();
    v.sort_by(|a, b| usage.get(&b.path).unwrap_or(&0).cmp(usage.get(&a.path).unwrap_or(&0))
        .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    v
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
    let mut usage = st.usage.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
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

// 파일 찾기 화면 오른쪽 미리보기
#[tauri::command]
async fn file_preview(path: String, app: AppHandle) -> Result<system::FilePreview, String> {
    let tmp = app.path().app_cache_dir().unwrap_or_else(|_| std::env::temp_dir().join("baro"));
    tauri::async_runtime::spawn_blocking(move || system::file_preview(&path, &tmp)).await.map_err(|e| e.to_string())?
}

// 파일 찾기 화면, 검색어 없을 때: 최근 바뀐 파일. 화면에는 종류별로 몇 개씩만 보이니 노트가 많아도 다른 종류가 밀려나지 않게 넉넉히
#[tauri::command]
async fn files_recent() -> Vec<String> {
    tauri::async_runtime::spawn_blocking(|| system::recent_files(4000)).await.unwrap_or_default()
}

// 파일 찾기 화면: 홈 + 외장 디스크에서 이름으로 검색
#[tauri::command]
async fn files_wide(q: String) -> Vec<String> {
    tauri::async_runtime::spawn_blocking(move || system::find_files_wide(&q, 60)).await.unwrap_or_default()
}

// 캘린더·할 일: 노션 계정들의 일정 DB를 합쳐 읽기·쓰기
#[derive(serde::Serialize)]
struct CalData { events: Vec<notion::Event>, dbs: Vec<notion::Db>, errors: Vec<String> }

fn notion_accounts(app: &AppHandle) -> Result<Vec<config::NotionAccount>, String> {
    let a = config::load(&config_file(app))?.notion_accounts;
    if a.iter().all(|x| x.token.trim().is_empty()) { return Err("NO_ACCOUNT".into()); }
    Ok(a)
}

#[tauri::command]
async fn notion_events(start: String, end: String, fresh: bool, app: AppHandle) -> Result<CalData, String> {
    let accts = notion_accounts(&app)?;
    if fresh { notion::invalidate_all(); }
    let (events, mut errors) = notion::events(&accts, &start, &end).await?;
    let (dbs, e2) = notion::databases(&accts).await;
    errors.extend(e2);
    Ok(CalData { events, dbs, errors })
}

#[tauri::command]
async fn notion_create(db_id: String, title: String, start: String, end: Option<String>, app: AppHandle) -> Result<(), String> {
    let accts = notion_accounts(&app)?;
    let db = notion::find_db(&accts, &db_id).await?;
    notion::create(&accts, &db, &title, &start, end.as_deref()).await
}

#[tauri::command]
async fn notion_done(account: String, page: String, prop: String, done: bool, app: AppHandle) -> Result<(), String> {
    notion::set_done(&notion_accounts(&app)?, &account, &page, &prop, done).await
}

#[tauri::command]
async fn notion_edit(account: String, page: String, db_id: String, title: String, start: String, end: Option<String>, app: AppHandle) -> Result<(), String> {
    let accts = notion_accounts(&app)?;
    let db = notion::find_db(&accts, &db_id).await?;
    notion::edit(&accts, &account, &page, &db, &title, &start, end.as_deref()).await
}

#[tauri::command]
async fn notion_trash(account: String, page: String, restore: bool, app: AppHandle) -> Result<(), String> {
    notion::trash(&notion_accounts(&app)?, &account, &page, restore).await
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
    let pid = (*app.state::<AppState>().prev_pid.lock().unwrap_or_else(std::sync::PoisonError::into_inner)).ok_or("배치할 창이 없어요.")?;
    let m = win.current_monitor().ok().flatten().ok_or("화면 정보를 읽지 못했어요.")?;
    let s = m.scale_factor();
    let wa = m.work_area();
    let area = ((wa.position.x as f64 / s) as i32, (wa.position.y as f64 / s) as i32,
        (wa.size.width as f64 / s) as i32, (wa.size.height as f64 / s) as i32);
    dismiss(&app);
    system::layout(pid, &kind, area)
}

// 같은 기능의 단축키를 다시 누르면 닫고, 다른 기능이면 그 화면으로 전환
// 고정 중에 다른 앱을 쓰다가 단축키를 누르면 닫지 않고 Baro로 포커스만 옮김
fn toggle(w: &WebviewWindow, action: &str) {
    let st = w.state::<AppState>();
    let visible = w.is_visible().unwrap_or(false);
    let focused = w.is_focused().unwrap_or(false);
    let pinned = *st.pinned.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if visible && (focused || !pinned) && *st.action.lock().unwrap_or_else(std::sync::PoisonError::into_inner) == action { close(w.app_handle()); return; }
    if !(visible && focused) {
        // 창 관리·붙여넣기 대상이 되도록 Baro가 앞에 오기 전에 현재 앱을 기억
        let me = std::process::id() as i32;
        let (pid, bundle) = system::frontmost();
        if pid != Some(me) {
            *st.prev_pid.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = pid;
            *st.prev_bundle.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = bundle;
        }
        // 고정 중이거나 사용자가 옮겨 둔 창은 그 위치를 유지
        if !visible && !pinned && !*st.placed.lock().unwrap_or_else(std::sync::PoisonError::into_inner) { let _ = w.center(); }
        let _ = w.show(); let _ = w.set_focus();
    }
    *st.action.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = action.to_string();
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
    *app.state::<AppState>().hotkeys.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = ids;
    *app.state::<AppState>().suspended.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = false;
    errors
}

// 새 단축키를 누르는 동안 기존 전역 단축키가 가로채지 않도록 잠시 해제
#[tauri::command]
fn suspend_hotkeys(on: bool, app: AppHandle) {
    if on {
        let _ = app.global_shortcut().unregister_all();
        *app.state::<AppState>().suspended.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = true;
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
    *app.state::<AppState>().dialog_open.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = true;
    let _ = win.set_always_on_top(false);
    let mut d = app.dialog().file().set_title("노트 폴더 선택");
    if std::path::Path::new(&start).is_dir() { d = d.set_directory(&start); }
    let picked = d.blocking_pick_folder();
    let _ = win.set_always_on_top(true);
    *app.state::<AppState>().dialog_open.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = false;
    let _ = win.show(); let _ = win.set_focus();
    picked.map(|p| p.to_string())
}

// 메뉴 막대(화면 오른쪽 위) 아이콘: Baro가 돌아가는지 보이고, 열기·로그·종료를 고를 수 있음
fn tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    let open = MenuItem::with_id(app, "open", "Baro 열기", true, None::<&str>)?;
    let logs = MenuItem::with_id(app, "logs", "로그 보기", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Baro 종료", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &logs, &PredefinedMenuItem::separator(app)?, &quit])?;
    tauri::tray::TrayIconBuilder::with_id("baro")
        .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?)
        .icon_as_template(true) // 밝은·어두운 메뉴 막대에 맞춰 색이 바뀜
        .tooltip(format!("Baro {} 실행 중", env!("CARGO_PKG_VERSION")))
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, e| match e.id().as_ref() {
            "open" => if let Some(w) = app.get_webview_window("main") { toggle(&w, "baro"); },
            "logs" => if let Some(p) = log::path() { let _ = open::that_detached(p); },
            "quit" => { log::write("메뉴 막대에서 종료"); app.exit(0); }
            _ => {}
        })
        .build(app)?;
    Ok(())
}

fn main() {
    log::init();
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
                let action = app.state::<AppState>().hotkeys.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get(&sc.id()).cloned();
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
            if let Err(e) = tray(app) { log::write(&format!("메뉴 막대 아이콘 실패: {e}")); }
            let h = app.handle().clone();
            for (action, e) in register_hotkeys(&h) { log::write(&format!("단축키 등록 실패 {action}: {e}")); }
            if let Ok(c) = config::load(&config_file(&h)) {
                expand::set_snippets(&c.snippets);
                if c.snippet_expand && !expand::enable(true) { log::write("스니펫 자동 확장: 입력 모니터링 권한 필요"); }
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
                if let Ok(u) = serde_json::from_slice(&b) { *h.state::<AppState>().usage.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = u; }
            }
            // 인덱싱과 아이콘 캐시 생성은 백그라운드에서
            std::thread::spawn(move || {
                let list = indexer::scan();
                let paths: Vec<String> = list.iter().map(|a| a.path.clone()).collect();
                *h.state::<AppState>().apps.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = list;
                let _ = h.emit("indexed", ());
                indexer::make_icons(&icon_dir(&h), &paths.iter().map(String::as_str).collect::<Vec<_>>());
            });
            Ok(())
        })
        .on_window_event(|w, e| if let WindowEvent::Resized(_) = e {
            let pinned = *w.app_handle().state::<AppState>().pinned.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(win) = w.app_handle().get_webview_window(w.label()) { window::resized(&win, pinned); }
        } else if let WindowEvent::Focused(false) = e {
            let st = w.app_handle().state::<AppState>();
            if *st.dialog_open.lock().unwrap_or_else(std::sync::PoisonError::into_inner) { return; }
            if *st.pinned.lock().unwrap_or_else(std::sync::PoisonError::into_inner) {
                // 고정 중: 숨기지 않고, 사용자가 옮겨 간 앱을 붙여넣기·포커스 대상으로 기억
                let app = w.app_handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(150));
                    let (pid, bundle) = system::frontmost();
                    if pid.is_some() && pid != Some(std::process::id() as i32) {
                        let st = app.state::<AppState>();
                        *st.prev_pid.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = pid;
                        *st.prev_bundle.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = bundle;
                    }
                });
                return;
            }
            let _ = w.hide();
            // 단축키 입력 중에 창이 닫히면 단축키를 되살려야 Baro를 다시 열 수 있음
            let app = w.app_handle();
            if *app.state::<AppState>().suspended.lock().unwrap_or_else(std::sync::PoisonError::into_inner) { register_hotkeys(app); }
        })
        .invoke_handler(tauri::generate_handler![log_error, search, apps, icon, launch, open_path, reveal, files_wide, files_recent, file_preview, open_url, hide,
            files, get_config, open_config, system_cmd, paste, window_layout, cmd_ai::ask_ai, cmd_ai::ask_notes, cmd_ai::notes_embed_build, cmd_ai::save_ai,
            permissions, open_settings, ext_list, ext_run, store_list, store_install, store_uninstall,
            get_hotkeys, set_hotkey, suspend_hotkeys,
            cmd_notes::notes_load, cmd_notes::note_set_field, cmd_notes::note_toggle_task, cmd_notes::note_add_evidence, cmd_notes::note_edit_evidence, cmd_notes::note_stage_status, cmd_notes::note_task_state, cmd_notes::notes_named, cmd_notes::note_add_record, cmd_notes::memo_daily, cmd_notes::memo_daily_read, cmd_notes::memo_daily_path, cmd_notes::shot_latest, cmd_notes::shot_save, cmd_notes::shot_read, cmd_notes::memo_remove, cmd_notes::memo_restore, cmd_notes::memo_replace, cmd_notes::clipboard_text, cmd_notes::note_create, cmd_notes::note_read, cmd_notes::note_write, save_note_search, delete_note_search, pick_folder,
            close_window, set_pinned, set_placed, set_view, window_reset, clip_list, clip_remove, clip_clear, clip_enabled, clip_set_enabled, copy_secret, cmd_notes::concept_create, snippet_expand_set, snippet_expand_state,
            notion_events, notion_create, notion_done, notion_edit, notion_trash])
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
