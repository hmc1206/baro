// 바탕화면 모드: 화면 전체 크기의 투명 창("desktop")을 바탕화면 아이콘 위, 모든 앱 창 아래에 깔아 둠
// - 런처(main 창)는 그대로 단축키로 맨 위에 뜸. 이 창은 늘 맨 아래에 있고 모든 데스크톱(Space)에 보임
// - 켜짐/꺼짐은 data_dir/desktop.json에 저장해 앱을 다시 켜도 유지
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

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
    let _ = w.show();
    Ok(())
}

// 창 높이를 일반 앱 창 바로 아래로: 바탕화면 아이콘보다는 위(아이콘이 패널을 덮지 않게), 앱 창을 눌러도 이 창이 위로 올라오지 않음
#[cfg(target_os = "macos")]
fn pin_to_desktop(w: &tauri::WebviewWindow) {
    use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};
    let Ok(ptr) = w.ns_window() else { return };
    let ptr = ptr as usize;
    let _ = w.run_on_main_thread(move || {
        // SAFETY: Tauri가 돌려준 살아 있는 NSWindow 포인터를 메인 스레드에서만 사용
        let ns: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
        ns.setLevel(objc2_core_graphics::kCGNormalWindowLevel as isize - 1);
        ns.setCollectionBehavior(NSWindowCollectionBehavior::CanJoinAllSpaces | NSWindowCollectionBehavior::Stationary | NSWindowCollectionBehavior::IgnoresCycle);
        ns.setHasShadow(false);
    });
}
#[cfg(not(target_os = "macos"))]
fn pin_to_desktop(w: &tauri::WebviewWindow) { let _ = w.set_always_on_bottom(true); }
