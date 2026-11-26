// 스니펫 자동 확장: 어느 앱에서든 ";키워드"를 치면 스니펫 본문으로 바꿔 줌 (예: ;today → 2026-11-19)
// - 기본은 꺼짐. 켜면 macOS "입력 모니터링" 권한이 필요 (키 입력을 읽어야 해서)
// - 입력은 저장하지 않음: 마지막 40글자만 메모리에 두고 비교, 클릭·방향키·⌘/⌃ 조합이면 비움
// - 비밀번호 칸(보안 입력)에서는 macOS가 키 입력을 아예 넘겨주지 않음
// - 한글 등 영문이 아닌 입력기에서는 바꾸지 않음 (지울 글자 수가 달라 엉뚱한 글자를 지울 수 있음)
// - 클립보드는 건드리지 않고 글자를 직접 입력
use std::sync::atomic::{AtomicBool, AtomicPtr, Ordering};
use std::sync::Mutex;

pub static ON: AtomicBool = AtomicBool::new(false);
static SNIPPETS: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());
static BUF: Mutex<String> = Mutex::new(String::new());
const PREFIX: char = ';';
const KEEP: usize = 40;
const MAGIC: i64 = 0x0BA_0E_A9; // Baro가 직접 보낸 키 입력 표시 (다시 읽지 않게)

pub fn set_snippets(list: &[crate::config::Snippet]) {
    *SNIPPETS.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = list.iter().filter(|s| !s.keyword.trim().is_empty())
        .map(|s| (s.keyword.trim().to_string(), s.text.clone())).collect();
}

// 입력 버퍼 끝이 ";키워드"면 그 스니펫 (가장 긴 키워드 우선)
pub fn matched(buf: &str, list: &[(String, String)]) -> Option<(usize, String)> {
    list.iter()
        .filter(|(k, _)| buf.ends_with(&format!("{PREFIX}{k}")))
        .max_by_key(|(k, _)| k.chars().count())
        .map(|(k, t)| (k.chars().count() + 1, t.clone()))
}

// 키 하나 입력 → 버퍼 갱신. 맞는 스니펫이 있으면 (지울 글자 수, 본문)
pub fn feed(buf: &mut String, typed: &str, list: &[(String, String)]) -> Option<(usize, String)> {
    buf.push_str(typed);
    let n = buf.chars().count();
    if n > KEEP { *buf = buf.chars().skip(n - KEEP).collect(); }
    let m = matched(buf, list);
    if m.is_some() { buf.clear(); }
    m
}

fn fill(text: &str) -> String {
    if !text.contains("{date}") && !text.contains("{time}") { return text.to_string(); }
    let out = std::process::Command::new("date").arg("+%Y-%m-%d %H:%M").output().ok();
    let now = out.map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
    let (d, t) = now.split_once(' ').unwrap_or(("", ""));
    text.replace("{date}", d).replace("{time}", t)
}

#[cfg(target_os = "macos")]
mod mac {
    use super::*;
    use objc2_core_foundation::{kCFRunLoopCommonModes, CFMachPort, CFRunLoop, CFString};
    use objc2_core_graphics::{
        CGEvent, CGEventField, CGEventFlags, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement, CGEventTapProxy, CGEventType,
    };
    use std::ffi::c_void;
    use std::ptr::NonNull;

    static TAP: AtomicPtr<CFMachPort> = AtomicPtr::new(std::ptr::null_mut());

    #[link(name = "Carbon", kind = "framework")]
    extern "C" {
        fn TISCopyCurrentKeyboardInputSource() -> *mut c_void;
        fn TISGetInputSourceProperty(src: *mut c_void, key: *const c_void) -> *const c_void;
        static kTISPropertyInputSourceID: *const c_void;
    }
    extern "C" { fn CFRelease(p: *const c_void); }

    // 지금 입력기가 영문 자판인지 (com.apple.keylayout.ABC 등). 한글·일본어 입력기면 false
    fn latin_input() -> bool {
        unsafe {
            let src = TISCopyCurrentKeyboardInputSource();
            if src.is_null() { return false; }
            let id = TISGetInputSourceProperty(src, kTISPropertyInputSourceID);
            let ok = !id.is_null() && (*(id as *const CFString)).to_string().starts_with("com.apple.keylayout.");
            CFRelease(src);
            ok
        }
    }

    fn post_key(code: u16, text: Option<&[u16]>) {
        for down in [true, false] {
            let Some(e) = CGEvent::new_keyboard_event(None, code, down) else { return };
            CGEvent::set_integer_value_field(Some(&e), CGEventField::EventSourceUserData, MAGIC);
            if let Some(t) = text { unsafe { CGEvent::keyboard_set_unicode_string(Some(&e), t.len() as _, t.as_ptr()) }; }
            CGEvent::set_flags(Some(&e), CGEventFlags::empty());
            CGEvent::post(CGEventTapLocation::HIDEventTap, Some(&e));
        }
    }

    // 키워드를 지우고 본문 입력. 줄바꿈은 Return 키로
    fn replace(n: usize, text: String) {
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(40)); // 마지막 글자가 앱에 들어간 뒤에 지우기
            for _ in 0..n { post_key(51, None); }
            let text = fill(&text);
            for (i, line) in text.split('\n').enumerate() {
                if i > 0 { post_key(36, None); }
                let u: Vec<u16> = line.encode_utf16().collect();
                for chunk in u.chunks(20) { post_key(0, Some(chunk)); }
            }
        });
    }

    // 키 입력 감시 콜백: 안에서 패닉이 나도 macOS 쪽으로 넘어가 앱이 죽지 않게 잡고, 키 입력은 그대로 통과
    unsafe extern "C-unwind" fn callback(_: CGEventTapProxy, ty: CGEventType, ev: NonNull<CGEvent>, _: *mut c_void) -> *mut CGEvent {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| on_event(ty, ev))).unwrap_or_else(|_| {
            BUF.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clear();
            ev.as_ptr()
        })
    }

    fn on_event(ty: CGEventType, ev: NonNull<CGEvent>) -> *mut CGEvent {
        let e = unsafe { ev.as_ref() };
        if ty == CGEventType::TapDisabledByTimeout || ty == CGEventType::TapDisabledByUserInput {
            let t = TAP.load(Ordering::Relaxed);
            if !t.is_null() { CGEvent::tap_enable(unsafe { &*t }, true); }
            return ev.as_ptr();
        }
        if !ON.load(Ordering::Relaxed) { return ev.as_ptr(); }
        let mut buf = BUF.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if ty != CGEventType::KeyDown { buf.clear(); return ev.as_ptr(); } // 클릭: 커서가 옮겨 갔을 수 있음
        if CGEvent::integer_value_field(Some(e), CGEventField::EventSourceUserData) == MAGIC { return ev.as_ptr(); }
        let flags = CGEvent::flags(Some(e));
        let code = CGEvent::integer_value_field(Some(e), CGEventField::KeyboardEventKeycode);
        if flags.intersects(CGEventFlags::MaskCommand | CGEventFlags::MaskControl)
            || matches!(code, 36 | 48 | 53 | 76 | 115 | 116 | 117 | 119 | 121 | 123 | 124 | 125 | 126) {
            buf.clear();
            return ev.as_ptr();
        }
        if code == 51 { buf.pop(); return ev.as_ptr(); }
        let mut u = [0u16; 8];
        let mut len = 0;
        unsafe { CGEvent::keyboard_get_unicode_string(Some(e), 8, &mut len, u.as_mut_ptr()) };
        let typed = String::from_utf16_lossy(&u[..len as usize]);
        if typed.chars().any(char::is_control) { buf.clear(); return ev.as_ptr(); }
        let list = SNIPPETS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some((n, text)) = feed(&mut buf, &typed, &list) {
            if latin_input() { replace(n, text); }
        }
        ev.as_ptr()
    }

    // 키 입력 감시 시작 (메인 스레드에서 호출). 권한이 없으면 false
    pub fn start() -> bool {
        if !TAP.load(Ordering::Relaxed).is_null() { return true; }
        let mask = (1u64 << CGEventType::KeyDown.0) | (1u64 << CGEventType::LeftMouseDown.0) | (1u64 << CGEventType::RightMouseDown.0);
        let Some(tap) = (unsafe {
            CGEvent::tap_create(CGEventTapLocation::SessionEventTap, CGEventTapPlacement::HeadInsertEventTap,
                CGEventTapOptions::ListenOnly, mask, Some(callback), std::ptr::null_mut())
        }) else { return false };
        let Some(src) = CFMachPort::new_run_loop_source(None, Some(&tap), 0) else { return false };
        let Some(rl) = CFRunLoop::main() else { return false };
        rl.add_source(Some(&src), unsafe { kCFRunLoopCommonModes });
        CGEvent::tap_enable(&tap, true);
        // 앱이 끝날 때까지 유지 (해제하지 않음)
        TAP.store(objc2_core_foundation::CFRetained::into_raw(tap).as_ptr(), Ordering::Relaxed);
        std::mem::forget(src);
        true
    }

    pub fn allowed() -> bool { objc2_core_graphics::CGPreflightListenEventAccess() }
    pub fn request() { objc2_core_graphics::CGRequestListenEventAccess(); }
}

// 켜기: 권한이 있으면 감시 시작. 결과 = 지금 동작 중인지
#[cfg(target_os = "macos")]
pub fn enable(on: bool) -> bool {
    ON.store(on, Ordering::Relaxed);
    BUF.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clear();
    if !on { return false; }
    if !mac::allowed() { mac::request(); return false; }
    mac::start()
}
#[cfg(not(target_os = "macos"))]
pub fn enable(_on: bool) -> bool { false }

#[cfg(test)]
mod tests {
    use super::*;

    fn list() -> Vec<(String, String)> { vec![("today".into(), "{date}".into()), ("thx".into(), "감사합니다".into()), ("thxa".into(), "정말 감사".into())] }

    #[test]
    fn expands_only_after_prefix() {
        let l = list();
        let mut b = String::new();
        let mut got = None;
        for c in "hello today".chars() { got = feed(&mut b, &c.to_string(), &l); }
        assert!(got.is_none()); // ; 없이 친 단어는 그대로
        for c in ";today".chars() { got = feed(&mut b, &c.to_string(), &l); }
        assert_eq!(got, Some((6, "{date}".into())));
        assert!(b.is_empty());
    }

    #[test]
    fn longest_keyword_wins_and_buffer_is_short() {
        let l = list();
        let mut b = String::new();
        let mut got = None;
        for c in ";thx".chars() { got = feed(&mut b, &c.to_string(), &l); }
        assert_eq!(got, Some((4, "감사합니다".into()))); // ;thx를 치는 순간 바뀜
        assert_eq!(matched("x;thxa", &l), Some((5, "정말 감사".into())));
        let mut b = String::new();
        for _ in 0..100 { feed(&mut b, "a", &l); }
        assert_eq!(b.chars().count(), KEEP);
    }
}
