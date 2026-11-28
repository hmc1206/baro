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
    crate::log::warn("데스크톱 설정 폴더 만들기", std::fs::create_dir_all(dir));
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
    let first = fit(&w);
    pin_to_desktop(&w);
    set_level(&w, -1);
    let _ = w.show();
    watch_screen(app.clone(), first);
    Ok(())
}

// 창 영역: 위치 x, y와 크기 w, h (물리 픽셀)
type Rect = (i32, i32, u32, u32);

// 순수 함수: 모니터의 위치·크기 → 바탕화면 창 영역 (모니터 전체)
fn rect_for(pos: (i32, i32), size: (u32, u32)) -> Rect { (pos.0, pos.1, size.0, size.1) }

// 순수 함수: 새 영역이 비어 있지 않고 이전과 다를 때만 다시 맞춤
fn needs_refit(prev: Option<Rect>, now: Option<Rect>) -> bool {
    matches!(now, Some(r) if r.2 > 0 && r.3 > 0 && prev != now)
}

fn primary_rect(w: &tauri::WebviewWindow) -> Option<Rect> {
    let m = w.primary_monitor().ok().flatten()?;
    Some(rect_for((m.position().x, m.position().y), (m.size().width, m.size().height)))
}

// 현재 주 모니터에 맞추고 맞춘 영역을 돌려줌
fn fit(w: &tauri::WebviewWindow) -> Option<Rect> {
    let r = primary_rect(w)?;
    let _ = w.set_position(PhysicalPosition::new(r.0, r.1));
    let _ = w.set_size(PhysicalSize::new(r.2, r.3));
    Some(r)
}

// 해상도 변경·모니터 연결/해제·주 모니터 교체를 3초 간격으로 확인해 창을 다시 맞춤 (창이 닫히면 끝)
// 창 크기가 바뀌면 화면 쪽 resize 이벤트가 패널을 다시 배치함
fn watch_screen(app: AppHandle, first: Option<Rect>) {
    static RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if RUNNING.swap(true, std::sync::atomic::Ordering::SeqCst) { return; }
    std::thread::spawn(move || {
        let mut last = first;
        loop {
            std::thread::sleep(std::time::Duration::from_secs(3));
            let Some(w) = app.get_webview_window(LABEL) else { break };
            let now = primary_rect(&w);
            if needs_refit(last, now) { last = fit(&w); }
        }
        RUNNING.store(false, std::sync::atomic::Ordering::SeqCst);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rect_covers_monitor() {
        assert_eq!(rect_for((0, 0), (2560, 1440)), (0, 0, 2560, 1440));
        assert_eq!(rect_for((-1920, 0), (1920, 1080)), (-1920, 0, 1920, 1080));
    }
    #[test]
    fn refit_only_on_change() {
        let a = Some((0, 0, 1920, 1080));
        assert!(!needs_refit(a, a));
        assert!(needs_refit(a, Some((0, 0, 2560, 1440))));
        assert!(needs_refit(a, Some((100, 0, 1920, 1080))));
        assert!(needs_refit(None, a));
    }
    #[test]
    fn refit_ignores_missing_or_empty() {
        let a = Some((0, 0, 1920, 1080));
        assert!(!needs_refit(a, None));
        assert!(!needs_refit(a, Some((0, 0, 0, 0))));
    }
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
