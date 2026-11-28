// 창·바탕화면 명령: 바탕화면 모드·패널, 런처 창 고정·크기·위치
// main.rs에서 그대로 옮김
use super::*;

// 바탕화면 모드 켜기·끄기 (켜짐 여부는 앱을 다시 켜도 유지)
#[tauri::command]
pub fn desktop_state(app: AppHandle) -> bool { desktop::is_open(&app) }
#[tauri::command]
pub fn desktop_set(on: bool, app: AppHandle) -> Result<(), String> { desktop::set(&app, &data_dir(&app), on) }
// 단축키·런처 검색: 바탕화면을 앞으로 올리고 그 패널 열기 (calendar, clipboard, memo, files, window, graph, notes:<id>)
#[tauri::command]
pub fn open_panel(panel: String, app: AppHandle) -> Result<(), String> {
    remember_front(&app);
    if let Some(w) = app.get_webview_window("main") { let _ = w.hide(); }
    desktop::open_panel(&app, &data_dir(&app), &panel)
}
#[tauri::command]
pub fn desktop_lower(app: AppHandle) { desktop::raise(&app, false); }
#[tauri::command]
pub fn desktop_take_pending() -> Option<String> { desktop::take_pending() }

// 바탕화면의 독에서: 런처를 그 기능 화면으로 띄움
#[tauri::command]
pub fn open_launcher(action: String, app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") { toggle(&w, &action); }
}

#[tauri::command]
pub fn close_window(app: AppHandle) { close(&app); }
// 화면에서 난 실패도 로그 파일에 남김
#[tauri::command]
pub fn log_error(msg: String) { log::write(&format!("화면 오류: {msg}")); }

// 끌기 막대로 옮기기 시작하면 on=true. on=false면 위치 기억을 지우고 가운데로
#[tauri::command]
pub fn set_placed(on: bool, app: AppHandle, win: WebviewWindow) {
    *app.state::<AppState>().placed.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = on;
    if !on { window::center_top(&win); }
}

#[tauri::command]
pub fn set_pinned(on: bool, app: AppHandle, win: WebviewWindow) -> bool {
    let st = app.state::<AppState>();
    let was = std::mem::replace(&mut *st.pinned.lock().unwrap_or_else(std::sync::PoisonError::into_inner), on);
    // 고정하면 고정 크기로 (왼쪽 위 위치는 그대로), 풀면 지금 화면 종류의 크기로
    if on != was { window::apply(&win, on, !on && !*st.placed.lock().unwrap_or_else(std::sync::PoisonError::into_inner)); }
    on
}

// 화면 종류(normal·wide·graph)가 바뀌면 그 종류에 기억한 크기로. 고정 중에는 크기를 바꾸지 않음
#[tauri::command]
pub fn set_view(kind: String, app: AppHandle, win: WebviewWindow) {
    let st = app.state::<AppState>();
    let pinned = *st.pinned.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if window::set_view(&kind) && !pinned { window::apply(&win, false, !*st.placed.lock().unwrap_or_else(std::sync::PoisonError::into_inner)); }
}

// 기억한 창 크기를 모두 지우고 기본 크기로
#[tauri::command]
pub fn window_reset(app: AppHandle, win: WebviewWindow) {
    let st = app.state::<AppState>();
    window::reset();
    window::apply(&win, *st.pinned.lock().unwrap_or_else(std::sync::PoisonError::into_inner), !*st.placed.lock().unwrap_or_else(std::sync::PoisonError::into_inner));
}
