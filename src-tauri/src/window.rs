// 창 크기: 화면 종류마다 따로 기억 (보통 목록 · 넓은 화면 · 그래프 · 고정)
// - 사용자가 가장자리를 끌어 맞춘 크기를 그 종류 칸에 기억 → window.json(나만 읽기 권한)에 저장, 앱을 다시 켜도 유지
// - 그래프·노트 미리보기·AI 답변처럼 내용이 많은 화면은 처음엔 기본으로 크게 열림
// - 크기가 화면(작업 영역)보다 크면 줄이고, 창이 화면 밖으로 나가면 안으로 옮김
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{LogicalPosition, LogicalSize, WebviewWindow};

pub type Size = (f64, f64);
pub type Area = (f64, f64, f64, f64); // 작업 영역 x, y, 너비, 높이 (논리 픽셀)

pub const MIN: Size = (360.0, 220.0);

// 종류별 기본 크기
pub fn default_size(kind: &str) -> Size {
    match kind {
        "wide" => (960.0, 600.0),
        "graph" => (1120.0, 720.0),
        "pinned" => (480.0, 400.0),
        _ => (760.0, 480.0),
    }
}

static SIZES: Mutex<Option<HashMap<String, Size>>> = Mutex::new(None);
static VIEW: Mutex<String> = Mutex::new(String::new()); // 지금 화면 종류 (고정 중이 아닐 때)
static FILE: OnceLock<PathBuf> = OnceLock::new();
static GEN: AtomicU64 = AtomicU64::new(0); // 끌어서 크기를 바꾸는 동안 저장을 미루기 위한 번호

pub fn init(file: &Path) {
    let _ = FILE.set(file.to_path_buf());
    let map: HashMap<String, Size> = std::fs::read(file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    *SIZES.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(map);
}

fn save() {
    let Some(f) = FILE.get() else { return };
    let Ok(b) = serde_json::to_vec_pretty(SIZES.lock().unwrap_or_else(std::sync::PoisonError::into_inner).as_ref().unwrap_or(&HashMap::new())) else { return };
    let tmp = f.with_extension("json.tmp");
    if std::fs::write(&tmp, b).is_err() { return; }
    #[cfg(unix)]
    { use std::os::unix::fs::PermissionsExt; let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600)); }
    let _ = std::fs::rename(&tmp, f);
}

pub fn size_of(kind: &str) -> Size {
    SIZES.lock().unwrap_or_else(std::sync::PoisonError::into_inner).as_ref().and_then(|m| m.get(kind).copied()).unwrap_or_else(|| default_size(kind))
}

// 크기를 최소 크기 이상, 작업 영역 이하로
pub fn fit(s: Size, area: Area) -> Size {
    (s.0.max(MIN.0).min(area.2.max(MIN.0)), s.1.max(MIN.1).min(area.3.max(MIN.1)))
}

// 왼쪽 위 위치를 작업 영역 안으로 (오른쪽·아래로 넘치면 왼쪽·위로 당김)
pub fn keep_inside(pos: (f64, f64), s: Size, area: Area) -> (f64, f64) {
    let x = pos.0.min(area.0 + area.2 - s.0).max(area.0);
    let y = pos.1.min(area.1 + area.3 - s.1).max(area.1);
    (x, y)
}

fn area_of(win: &WebviewWindow) -> Option<(Area, f64)> {
    let m = win.current_monitor().ok().flatten()?;
    let k = m.scale_factor();
    let wa = m.work_area();
    Some(((wa.position.x as f64 / k, wa.position.y as f64 / k, wa.size.width as f64 / k, wa.size.height as f64 / k), k))
}

// 지금 크기 기준이 되는 종류: 고정 중이면 "pinned", 아니면 화면 종류
fn current(pinned: bool) -> String {
    if pinned { return "pinned".into(); }
    let v = VIEW.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if v.is_empty() { "normal".into() } else { v.clone() }
}

// 종류에 맞는 크기로 바꾸기. center: 사용자가 창을 옮기지 않았으면 가운데로
pub fn apply(win: &WebviewWindow, pinned: bool, center: bool) {
    let kind = current(pinned);
    let Some((area, k)) = area_of(win) else { return };
    let s = fit(size_of(&kind), area);
    if let Ok(now) = win.inner_size() {
        if ((now.width as f64 / k) - s.0).abs() < 1.0 && ((now.height as f64 / k) - s.1).abs() < 1.0 {
            if center { let _ = win.center(); }
            return;
        }
    }
    let _ = win.set_size(LogicalSize::new(s.0, s.1));
    if center { let _ = win.center(); return; }
    if let Ok(p) = win.outer_position() {
        let (x, y) = keep_inside((p.x as f64 / k, p.y as f64 / k), s, area);
        let _ = win.set_position(LogicalPosition::new(x, y));
    }
}

// 화면 종류가 바뀜 (프론트엔드가 알려 줌). 바뀌었으면 true
pub fn set_view(kind: &str) -> bool {
    let kind = if matches!(kind, "wide" | "graph") { kind } else { "normal" };
    let mut v = VIEW.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if *v == kind { return false; }
    *v = kind.to_string();
    true
}

// 사용자가 크기를 바꿈 (Resized 이벤트). 지금 종류 칸에 기억하고, 끌기가 멈추면 저장
pub fn resized(win: &WebviewWindow, pinned: bool) {
    let (Ok(s), Ok(k)) = (win.inner_size(), win.scale_factor()) else { return };
    if s.width == 0 || s.height == 0 || !win.is_visible().unwrap_or(false) { return; }
    let size = ((s.width as f64 / k).round(), (s.height as f64 / k).round());
    let kind = current(pinned);
    {
        let mut g = SIZES.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let m = g.get_or_insert_with(HashMap::new);
        if m.get(&kind) == Some(&size) || (m.get(&kind).is_none() && default_size(&kind) == size) { return; }
        m.insert(kind, size);
    }
    let n = GEN.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(500));
        if GEN.load(Ordering::SeqCst) == n { save(); }
    });
}

// 기억한 크기를 모두 지우고 기본 크기로
pub fn reset() {
    if let Some(m) = SIZES.lock().unwrap_or_else(std::sync::PoisonError::into_inner).as_mut() { m.clear(); }
    save();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn size_fits_screen_and_window_stays_inside() {
        let area = (0.0, 25.0, 1440.0, 875.0);
        assert_eq!(fit((1120.0, 720.0), area), (1120.0, 720.0));
        assert_eq!(fit((2000.0, 1200.0), area), (1440.0, 875.0)); // 화면보다 크면 줄임
        assert_eq!(fit((100.0, 100.0), area), MIN);
        // 오른쪽 아래로 넘치면 안으로 당김, 위쪽 메뉴 막대 아래로
        assert_eq!(keep_inside((900.0, 600.0), (960.0, 600.0), area), (480.0, 300.0));
        assert_eq!(keep_inside((-50.0, 0.0), (760.0, 480.0), area), (0.0, 25.0));
        // 두 번째 모니터 (왼쪽에 있음)
        assert_eq!(keep_inside((-500.0, 100.0), (760.0, 480.0), (-1920.0, 0.0, 1920.0, 1080.0)), (-760.0, 100.0));
    }

    #[test]
    fn view_kinds() {
        assert!(set_view("graph"));
        assert!(!set_view("graph"));
        assert_eq!(current(false), "graph");
        assert_eq!(current(true), "pinned");
        assert!(set_view("whatever"));
        assert_eq!(current(false), "normal");
        assert_eq!(default_size("whatever"), (760.0, 480.0));
    }
}
