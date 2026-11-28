// 바탕화면 모드: 화면 전체 크기의 투명 창("desktop")을 바탕화면 아이콘 위, 모든 앱 창 아래에 깔아 둠
// - 런처(main 창)는 그대로 단축키로 맨 위에 뜸. 이 창은 늘 맨 아래에 있고 모든 데스크톱(Space)에 보임
// - 켜짐/꺼짐은 data_dir/desktop.json에 저장해 앱을 다시 켜도 유지
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "desktop";

fn file(dir: &Path) -> PathBuf { dir.join("desktop.json") }

pub fn is_on(dir: &Path) -> bool {
    std::fs::read(file(dir)).ok().and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .and_then(|v| v["on"].as_bool()).unwrap_or(false)
}

pub fn set(app: &AppHandle, dir: &Path, on: bool) -> Result<(), String> {
    let _ = std::fs::create_dir_all(dir);
    std::fs::write(file(dir), serde_json::json!({ "on": on }).to_string()).map_err(|e| e.to_string())?;
    if on { open(app) } else {
        if let Some(w) = app.get_webview_window(LABEL) { let _ = w.destroy(); }
        Ok(())
    }
}

pub fn is_open(app: &AppHandle) -> bool { app.get_webview_window(LABEL).is_some() }

// 단축키·런처 검색에서 패널을 부르면: 바탕화면을 잠깐 앱 창 위로 올리고 그 패널을 열게 함
// (창이 막 만들어졌으면 화면이 아직 없으니, 화면이 뜨면서 take_pending으로 가져감)
static PENDING: Mutex<Option<String>> = Mutex::new(None);
pub fn take_pending() -> Option<String> { PENDING.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take() }
pub fn open_panel(app: &AppHandle, dir: &Path, panel: &str) -> Result<(), String> {
    if !is_open(app) { set(app, dir, true)?; }
    *PENDING.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(panel.to_string());
    raise(app, true);
    let _ = app.emit_to(LABEL, "open-panel", ());
    Ok(())
}

// up: 앱 창들 위로 올려 바로 쓰게 (포커스까지). false: 다시 앱 창 아래로 (포커스를 잃거나 Esc)
pub fn raise(app: &AppHandle, up: bool) {
    let Some(w) = app.get_webview_window(LABEL) else { return };
    set_level(&w, if up { 1 } else { -1 });
    if up { let _ = w.show(); let _ = w.set_focus(); }
}

pub fn open(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window(LABEL).is_some() { return Ok(()); }
    let w = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html".into()))
        .title("Baro 바탕화면").decorations(false).transparent(true).shadow(false).resizable(false)
        .skip_taskbar(true).focused(false).visible(false)
        .build().map_err(|e| e.to_string())?;
    // 주 모니터 전체 (메뉴 막대·Dock 자리는 화면 쪽에서 비워 둠)
    if let Ok(Some(m)) = w.primary_monitor() {
        let _ = w.set_position(PhysicalPosition::new(m.position().x, m.position().y));
        let _ = w.set_size(PhysicalSize::new(m.size().width, m.size().height));
    }
    pin_to_desktop(&w);
    set_level(&w, -1);
    let _ = w.show();
    Ok(())
}

// 모든 데스크톱(Space)에 보이고, Mission Control에서 움직이지 않고, 창 순환(⌘`)에서 빠짐. 높이는 set_level
#[cfg(target_os = "macos")]
fn pin_to_desktop(w: &tauri::WebviewWindow) {
    use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};
    let Ok(ptr) = w.ns_window() else { return };
    let ptr = ptr as usize;
    let _ = w.run_on_main_thread(move || {
        // SAFETY: Tauri가 돌려준 살아 있는 NSWindow 포인터를 메인 스레드에서만 사용
        let ns: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
        ns.setCollectionBehavior(NSWindowCollectionBehavior::CanJoinAllSpaces | NSWindowCollectionBehavior::Stationary | NSWindowCollectionBehavior::IgnoresCycle);
        ns.setHasShadow(false);
    });
}
#[cfg(not(target_os = "macos"))]
fn pin_to_desktop(_w: &tauri::WebviewWindow) {}

// 창 높이 = 일반 앱 창 높이 + d. -1: 앱 창 바로 아래(바탕화면 아이콘보다는 위), 1: 앱 창 위
#[cfg(target_os = "macos")]
fn set_level(w: &tauri::WebviewWindow, d: isize) {
    use objc2_app_kit::NSWindow;
    let Ok(ptr) = w.ns_window() else { return };
    let ptr = ptr as usize;
    let _ = w.run_on_main_thread(move || {
        // SAFETY: Tauri가 돌려준 살아 있는 NSWindow 포인터를 메인 스레드에서만 사용
        let ns: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
        ns.setLevel(objc2_core_graphics::kCGNormalWindowLevel as isize + d);
    });
}
#[cfg(not(target_os = "macos"))]
fn set_level(w: &tauri::WebviewWindow, d: isize) { let _ = if d < 0 { w.set_always_on_bottom(true) } else { w.set_always_on_top(true) }; }
