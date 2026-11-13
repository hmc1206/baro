#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod ai;
mod config;
mod extensions;
mod indexer;
mod search;
mod system;

use base64::Engine;
use std::{collections::HashMap, path::PathBuf, sync::Mutex};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

#[derive(Default)]
struct AppState {
    apps: Mutex<Vec<indexer::AppEntry>>,
    usage: Mutex<HashMap<String, u32>>,
    prev_pid: Mutex<Option<i32>>, // Baro를 열기 전 앞에 있던 앱 (창 관리 대상)
}

fn data_dir(app: &AppHandle) -> PathBuf { app.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir().join("baro")) }
fn icon_dir(app: &AppHandle) -> PathBuf {
    app.path().app_cache_dir().unwrap_or_else(|_| std::env::temp_dir().join("baro")).join("icons")
}
fn usage_file(app: &AppHandle) -> PathBuf { data_dir(app).join("usage.json") }
fn config_file(app: &AppHandle) -> PathBuf { data_dir(app).join("config.json") }
fn ext_dir(app: &AppHandle) -> PathBuf { data_dir(app).join("extensions") }

// Baro를 숨기고 이전 앱으로 포커스를 돌려줌
fn dismiss(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") { let _ = w.hide(); }
    #[cfg(target_os = "macos")]
    let _ = app.hide();
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

fn toggle(w: &WebviewWindow) {
    if w.is_visible().unwrap_or(false) { dismiss(w.app_handle()); return; }
    // 창 관리 대상이 되도록 Baro가 앞에 오기 전에 현재 앱을 기억
    let me = std::process::id() as i32;
    let pid = system::frontmost_pid().filter(|p| *p != me);
    *w.state::<AppState>().prev_pid.lock().unwrap() = pid;
    let _ = w.center(); let _ = w.show(); let _ = w.set_focus();
    let _ = w.emit("shown", ());
}

fn main() {
    let hotkey = Shortcut::new(Some(Modifiers::ALT), Code::Space); // ⌥Space (⌥⇧Space는 Dropover와 충돌). 변경은 여기서
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |app, sc, ev| {
                if sc == &hotkey && ev.state() == ShortcutState::Pressed {
                    if let Some(w) = app.get_webview_window("main") { toggle(&w); }
                }
            }).build())
        .manage(AppState::default())
        .setup(move |app| {
            // Dock 아이콘·앱 전환기에서 숨김 (메뉴 막대 앱처럼 동작)
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            app.global_shortcut().register(hotkey)?;
            let h = app.handle().clone();
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
        .on_window_event(|w, e| if let WindowEvent::Focused(false) = e { let _ = w.hide(); })
        .invoke_handler(tauri::generate_handler![search, icon, launch, open_path, reveal, open_url, hide,
            files, get_config, open_config, system_cmd, paste, window_layout, ask_ai,
            permissions, open_settings, ext_list, ext_run, store_list, store_install, store_uninstall])
        .run(tauri::generate_context!())
        .expect("Baro 실행 실패");
}
