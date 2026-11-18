#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod ai;
mod config;
mod extensions;
mod indexer;
mod search;
mod system;
mod wiki;

use base64::Engine;
use std::{collections::HashMap, path::PathBuf, sync::Mutex};
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
    pinned_size: Mutex<Option<(f64, f64)>>, // 고정 중에 사용자가 맞춘 창 크기 (다음 고정 때 다시 사용)
    placed: Mutex<bool>, // 사용자가 끌기 막대로 창을 옮겼으면 다음에 열 때도 그 자리에 띄움
}

// 창 크기 (논리 픽셀). 고정하면 작게 줄이고 크기 조절을 허용
const NORMAL_SIZE: (f64, f64) = (760.0, 480.0);
const PINNED_SIZE: (f64, f64) = (480.0, 400.0);
const PINNED_MIN: (f64, f64) = (360.0, 220.0);

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
    use tauri::LogicalSize;
    let st = app.state::<AppState>();
    let was = std::mem::replace(&mut *st.pinned.lock().unwrap(), on);
    if on && !was {
        // 창 왼쪽 위 위치는 그대로 두고 크기만 줄임
        let (w, h) = st.pinned_size.lock().unwrap().unwrap_or(PINNED_SIZE);
        let _ = win.set_resizable(true);
        let _ = win.set_min_size(Some(LogicalSize::new(PINNED_MIN.0, PINNED_MIN.1)));
        let _ = win.set_size(LogicalSize::new(w, h));
    } else if !on && was {
        // 사용자가 맞춘 크기를 기억해 두고 원래 크기로
        if let (Ok(s), Ok(f)) = (win.inner_size(), win.scale_factor()) {
            *st.pinned_size.lock().unwrap() = Some((s.width as f64 / f, s.height as f64 / f));
        }
        let _ = win.set_min_size(None::<LogicalSize<f64>>);
        let _ = win.set_size(LogicalSize::new(NORMAL_SIZE.0, NORMAL_SIZE.1));
        let _ = win.set_resizable(false);
        if !*st.placed.lock().unwrap() { let _ = win.center(); }
    }
    on
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
fn get_config(app: AppHandle) -> config::PublicConfig { config::public(&config_file(&app)) }

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
    tauri::async_runtime::spawn_blocking(move || wiki::load(&s.dir, &s.kind)).await.map_err(|e| e.to_string())?
}

fn note_dir(app: &AppHandle, id: &str) -> Result<String, String> {
    let c = config::load(&config_file(app))?;
    c.note_searches.into_iter().find(|n| n.id == id).map(|n| n.dir).ok_or("노트 검색을 찾지 못했어요.".into())
}

// 노트 머리말 값 바꾸기 (비밀번호 모음의 비밀번호 수정 등). 해당 노트 검색 폴더 안의 파일만
#[tauri::command]
fn note_set_field(id: String, file: String, key: String, value: String, app: AppHandle) -> Result<(), String> {
    wiki::set_field(&note_dir(&app, &id)?, &file, &key, &value)
}

// 커리큘럼: 노트의 index번째 체크박스 체크/해제
#[tauri::command]
fn note_toggle_task(id: String, file: String, index: usize, text: String, done: bool, app: AppHandle) -> Result<(), String> {
    wiki::toggle_task(&note_dir(&app, &id)?, &file, index, &text, done)
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
    } else { wiki::remove_record(&note_dir(&app, &id)?, &file, &section, index, &first)? };
    Ok(Removed { line, text })
}

#[tauri::command]
fn memo_restore(id: String, file: String, date: String, section: String, line: usize, text: String, app: AppHandle) -> Result<(), String> {
    if section == "daily" { wiki::restore_daily(&config::load(&config_file(&app))?.vault_dir, &date, line, &text) }
    else { wiki::restore_record(&note_dir(&app, &id)?, &file, line, &text) }
}

// 빠른 메모: 오늘 Daily 노트 읽기 (이미 적은 메모 보기)
#[tauri::command]
fn memo_daily_read(date: String, app: AppHandle) -> String {
    config::load(&config_file(&app)).map(|c| wiki::read_daily(&c.vault_dir, &date)).unwrap_or_default()
}

// 빠른 메모: 커리큘럼 단계 노트의 "내 기록" 칸에 추가
#[tauri::command]
fn note_add_record(id: String, file: String, section: String, block: String, app: AppHandle) -> Result<(), String> {
    wiki::add_record(&note_dir(&app, &id)?, &file, &section, &block)
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
        .on_window_event(|w, e| if let WindowEvent::Focused(false) = e {
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
            files, get_config, open_config, system_cmd, paste, window_layout, ask_ai, save_ai,
            permissions, open_settings, ext_list, ext_run, store_list, store_install, store_uninstall,
            get_hotkeys, set_hotkey, suspend_hotkeys,
            notes_load, note_set_field, note_toggle_task, note_add_record, memo_daily, memo_daily_read, memo_remove, memo_restore, clipboard_text, note_create, save_note_search, delete_note_search, pick_folder,
            close_window, set_pinned, set_placed])
        .run(tauri::generate_context!())
        .expect("Baro 실행 실패");
}
