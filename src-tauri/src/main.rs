#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod ai;
mod clip;
mod cmd_ai;
mod cmd_config;
mod cmd_launch;
mod cmd_notes;
mod cmd_notion;
mod cmd_window;
mod config;
mod embed;
mod expand;
mod extensions;
mod indexer;
mod log;
mod news;
mod notion;
mod desktop;
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
    // 바탕화면 모드면 앱 전체를 숨기면 바탕화면 창까지 사라지므로, 이전 앱에 포커스만 돌려줌
    if desktop::is_open(app) {
        if let Some(b) = app.state::<AppState>().prev_bundle.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone() { system::activate(&b); }
        return;
    }
    #[cfg(target_os = "macos")]
    let _ = app.hide();
}

// 단축키 기능 중 바탕화면 패널로 여는 것 (달력은 런처 화면. 노트 검색은 일반 노트·명령어·스니펫만. 커리큘럼·비밀번호·글쓰기는 런처 화면 그대로)
fn panel_for(app: &AppHandle, action: &str) -> Option<String> {
    match action {
        "files" | "memo" | "clipboard" | "graph" => Some(action.to_string()),
        _ => {
            let id = action.strip_prefix("note:")?;
            let c = config::load(&config_file(app)).ok()?;
            let n = c.note_searches.iter().find(|n| n.id == id)?;
            matches!(n.kind.as_str(), "notes" | "commands" | "snippets").then(|| format!("notes:{id}"))
        }
    }
}

// 지금 앞에 있는 앱을 창 관리·붙여넣기 대상으로 기억 (Baro 자신은 빼고)
fn remember_front(app: &AppHandle) {
    let st = app.state::<AppState>();
    let (pid, bundle) = system::frontmost();
    if pid.is_some() && pid != Some(std::process::id() as i32) {
        *st.prev_pid.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = pid;
        *st.prev_bundle.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = bundle;
    }
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
        if !visible && !pinned && !*st.placed.lock().unwrap_or_else(std::sync::PoisonError::into_inner) { window::center_top(w); }
        let _ = w.show(); let _ = w.set_focus();
    }
    *st.action.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = action.to_string();
    let _ = w.emit("shown", action);
}

// 설정의 단축키를 모두 다시 등록. 실패한 항목은 "기능: 이유"로 돌려줌
fn register_hotkeys(app: &AppHandle) -> Vec<(String, String)> {
    let c = config::load(&config_file(app)).unwrap_or_else(|_| { log::write("실패 단축키 등록: 설정을 읽지 못해 기본값 사용"); Default::default() });
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

// 메뉴 막대(화면 오른쪽 위) 아이콘: Baro가 돌아가는지 보이고, 열기·로그·종료를 고를 수 있음
fn tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    let open = MenuItem::with_id(app, "open", "Baro 열기", true, None::<&str>)?;
    let logs = MenuItem::with_id(app, "logs", "로그 보기", true, None::<&str>)?;
    let desk = MenuItem::with_id(app, "desktop", "바탕화면 모드 켜기·끄기", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Baro 종료", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &desk, &logs, &PredefinedMenuItem::separator(app)?, &quit])?;
    tauri::tray::TrayIconBuilder::with_id("baro")
        .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?)
        .icon_as_template(true) // 밝은·어두운 메뉴 막대에 맞춰 색이 바뀜
        .tooltip(format!("Baro {} 실행 중", env!("CARGO_PKG_VERSION")))
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, e| match e.id().as_ref() {
            "open" => if let Some(w) = app.get_webview_window("main") { toggle(&w, "baro"); },
            "desktop" => { let on = !desktop::is_open(app); if let Err(e) = desktop::set(app, &data_dir(app), on) { log::write(&format!("바탕화면 모드 실패: {e}")); } }
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
                if let Some(p) = action.as_deref().and_then(|a| panel_for(app, a)) {
                    if let Err(e) = (|| { remember_front(app); desktop::open_panel(app, &data_dir(app), &p) })() { log::write(&format!("바탕화면 패널 실패: {e}")); }
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
                let _ = w.set_min_size(Some(tauri::LogicalSize::new(window::MIN.0, window::BAR_H)));
                window::apply(&w, false, true);
            }
            if let Ok(c) = config::load(&config_file(&h)) {
                std::thread::spawn(move || { vault::scan(Path::new(&c.vault_dir)); vault::save(); });
            }
            // 바탕화면 모드가 켜져 있었으면 바탕화면 창을 다시 깔기
            if desktop::is_on(&data_dir(&h)) { if let Err(e) = desktop::open(&h) { log::write(&format!("바탕화면 창 실패: {e}")); } }
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
        // 창 크기 기억·포커스를 잃으면 숨기기는 런처(main) 창만. 바탕화면 창은 늘 그대로
        .on_window_event(|w, e| if w.label() == desktop::LABEL {
            // 바탕화면: 다른 앱으로 넘어가면 다시 앱 창 아래로, 넘어간 앱을 창 관리 대상으로 기억
            if let WindowEvent::Focused(false) = e {
                let app = w.app_handle().clone();
                desktop::raise(&app, false);
                std::thread::spawn(move || { std::thread::sleep(std::time::Duration::from_millis(150)); remember_front(&app); });
            }
        } else if w.label() != "main" {
        } else if let WindowEvent::Resized(_) = e {
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
        .invoke_handler(tauri::generate_handler![cmd_window::log_error, cmd_launch::search, cmd_launch::apps, cmd_launch::icon, cmd_launch::launch, cmd_launch::open_path, cmd_launch::reveal,
            cmd_launch::files_wide, cmd_launch::files_recent, cmd_launch::file_preview, cmd_launch::open_url, cmd_launch::hide, cmd_launch::files,
            cmd_config::get_config, cmd_launch::open_config, cmd_launch::system_cmd, cmd_launch::paste, cmd_launch::window_layout, cmd_ai::ask_ai,
            cmd_ai::ask_notes, cmd_ai::notes_embed_build, cmd_ai::save_ai, cmd_launch::permissions, cmd_launch::open_settings, cmd_config::ext_list,
            cmd_config::ext_run, cmd_config::store_list, cmd_config::store_install, cmd_config::store_uninstall, cmd_config::get_hotkeys, cmd_config::set_hotkey,
            cmd_config::suspend_hotkeys, cmd_notes::notes_load, cmd_notes::note_set_field, cmd_notes::note_toggle_task, cmd_notes::note_add_evidence,
            cmd_notes::note_edit_evidence, cmd_notes::note_stage_status, cmd_notes::note_task_state, cmd_notes::notes_named, cmd_notes::note_add_record,
            cmd_notes::memo_daily, cmd_notes::memo_daily_read, cmd_notes::memo_daily_path, cmd_notes::shot_latest, cmd_notes::shot_save, cmd_notes::shot_read,
            cmd_notes::memo_remove, cmd_notes::memo_restore, cmd_notes::memo_replace, cmd_notes::clipboard_text, cmd_notes::note_create, cmd_notes::note_read,
            cmd_notes::note_write, cmd_config::save_note_search, cmd_config::delete_note_search, cmd_config::pick_folder, cmd_window::close_window,
            cmd_window::set_pinned, cmd_window::set_placed, cmd_window::set_view, cmd_window::window_reset, cmd_config::clip_list, cmd_config::clip_remove,
            cmd_config::clip_clear, cmd_config::clip_enabled, cmd_config::clip_set_enabled, cmd_config::copy_secret, cmd_notes::concept_create,
            cmd_config::snippet_expand_set, cmd_config::snippet_expand_state, cmd_window::desktop_state, cmd_window::desktop_set, cmd_window::open_launcher,
            cmd_window::open_panel, cmd_window::desktop_lower, cmd_window::desktop_take_pending, cmd_notion::notion_events, cmd_notion::notion_dbs,
            cmd_notion::notion_create, cmd_notion::notion_done, cmd_notion::notion_edit, cmd_notion::notion_trash])
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
