// macOS 시스템 연동: 앞 앱 찾기, 창 배치, 시스템 명령, 파일 검색, 붙여넣기
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};

// 권한 오류는 "PERM:종류" 형태로 돌려주고 화면에서 안내함
fn osascript(script: &str) -> Result<(), String> {
    let o = Command::new("osascript").args(["-e", script]).output().map_err(|e| e.to_string())?;
    if o.status.success() { return Ok(()); }
    let err = String::from_utf8_lossy(&o.stderr).to_string();
    if err.contains("-1743") { return Err("PERM:automation".into()); }        // 자동화 권한 없음
    if err.contains("-1719") || err.contains("-25211") { return Err("PERM:accessibility".into()); } // 손쉬운 사용 권한 없음
    Err(err.trim().to_string())
}

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" { fn AXIsProcessTrusted() -> bool; }

// 손쉬운 사용 권한이 있는지 (창 관리·붙여넣기에 필요)
pub fn ax_trusted() -> bool {
    #[cfg(target_os = "macos")]
    return unsafe { AXIsProcessTrusted() };
    #[cfg(not(target_os = "macos"))]
    true
}

pub fn need_ax() -> Result<(), String> { if ax_trusted() { Ok(()) } else { Err("PERM:accessibility".into()) } }

// 시스템 설정의 해당 권한 화면 열기
pub fn open_settings(kind: &str) -> Result<(), String> {
    let pane = match kind { "automation" => "Privacy_Automation", "input" => "Privacy_ListenEvent", _ => "Privacy_Accessibility" };
    Command::new("open").arg(format!("x-apple.systempreferences:com.apple.preference.security?{pane}"))
        .spawn().map(|_| ()).map_err(|e| e.to_string())
}

// Baro를 띄우기 직전에 앞에 있던 앱의 pid와 번들 ID
pub fn frontmost() -> (Option<i32>, Option<String>) {
    let Ok(asn) = Command::new("lsappinfo").arg("front").output() else { return (None, None) };
    let asn = String::from_utf8_lossy(&asn.stdout).trim().to_string();
    let field = |key: &str| -> Option<String> {
        let o = Command::new("lsappinfo").args(["info", "-only", key, &asn]).output().ok()?;
        Some(String::from_utf8_lossy(&o.stdout).trim().rsplit('=').next()?.trim_matches('"').to_string())
    };
    (field("pid").and_then(|p| p.parse().ok()), field("bundleid").filter(|b| !b.is_empty() && b != "[ NULL ]"))
}

// 앱을 앞으로 가져오기 (권한 필요 없음)
pub fn activate(bundle: &str) {
    let _ = Command::new("open").args(["-b", bundle]).spawn();
}

// area: 작업 영역(메뉴 막대·Dock 제외) x, y, w, h (포인트 단위)
pub fn layout(pid: i32, kind: &str, area: (i32, i32, i32, i32)) -> Result<(), String> {
    let (x, y, w, h) = area;
    let rect = match kind {
        "left" => Some((x, y, w / 2, h)),
        "right" => Some((x + w / 2, y, w - w / 2, h)),
        "top" => Some((x, y, w, h / 2)),
        "bottom" => Some((x, y + h / 2, w, h - h / 2)),
        "max" => Some((x, y, w, h)),
        "center" => None,
        _ => return Err(format!("알 수 없는 배치: {kind}")),
    };
    let body = match rect {
        // 일부 앱은 크기 변경 후 위치가 밀려서 위치를 한 번 더 지정
        Some((rx, ry, rw, rh)) => format!(
            "set position of window 1 to {{{rx}, {ry}}}\nset size of window 1 to {{{rw}, {rh}}}\nset position of window 1 to {{{rx}, {ry}}}"),
        None => format!(
            "set {{ww, hh}} to size of window 1\nset position of window 1 to {{{x} + ({w} - ww) div 2, {y} + ({h} - hh) div 2}}"),
    };
    osascript(&format!(
        "tell application \"System Events\" to tell (first process whose unix id is {pid})\n{body}\nend tell"))
}

pub fn run(cmd: &str) -> Result<(), String> {
    match cmd {
        "sleep" => Command::new("pmset").arg("sleepnow").spawn().map(|_| ()).map_err(|e| e.to_string()),
        "lock" => Command::new("pmset").arg("displaysleepnow").spawn().map(|_| ()).map_err(|e| e.to_string()),
        "trash" => osascript("tell application \"Finder\" to empty trash"),
        "dark" => osascript("tell application \"System Events\" to tell appearance preferences to set dark mode to not dark mode"),
        "mute" => osascript("set volume output muted (not (output muted of (get volume settings)))"),
        _ => Err(format!("알 수 없는 명령: {cmd}")),
    }
}

// 앞 앱에 ⌘V 보내기 (손쉬운 사용 권한 필요)
pub fn paste() -> Result<(), String> {
    std::thread::sleep(std::time::Duration::from_millis(150));
    osascript("tell application \"System Events\" to keystroke \"v\" using command down")
}

// Spotlight로 홈 폴더 파일 검색. 개발 폴더·숨김 폴더는 제외하고 이름이 검색어로 시작하는 것 우선
pub fn find_files(q: &str, n: usize) -> Vec<String> {
    let Some(home) = dirs::home_dir() else { return vec![] };
    mdfind_name(q, &[home], n)
}

// 파일 찾기 화면: 홈 폴더 + 연결된 외장 디스크(/Volumes/*, 시스템 디스크 바로가기는 제외)
pub fn find_files_wide(q: &str, n: usize) -> Vec<String> {
    let mut roots: Vec<std::path::PathBuf> = dirs::home_dir().into_iter().collect();
    if let Ok(rd) = std::fs::read_dir("/Volumes") {
        roots.extend(rd.flatten().filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false)).map(|e| e.path()));
    }
    mdfind_name(q, &roots, n)
}

// 파일 찾기 화면을 검색어 없이 열 때: 최근 90일에 바뀐 파일을 최근 순으로 (폴더 제외).
// 홈 전체는 느려서(수 초) 사용자 폴더와 외장 디스크만, 각 위치를 동시에 찾고 2분 동안 결과를 재사용
pub fn recent_files(n: usize) -> Vec<String> {
    use std::sync::Mutex;
    use std::time::{Duration, Instant};
    static CACHE: Mutex<Option<(Instant, Vec<String>)>> = Mutex::new(None);
    if let Some((at, v)) = CACHE.lock().unwrap().as_ref() {
        if at.elapsed() < Duration::from_secs(120) { return v.clone(); }
    }
    let mut roots: Vec<std::path::PathBuf> = dirs::home_dir().into_iter()
        .flat_map(|h| ["Desktop", "Downloads", "Documents", "Pictures", "Movies", "Music"].map(|d| h.join(d)))
        .filter(|p| p.is_dir()).collect();
    if let Ok(rd) = std::fs::read_dir("/Volumes") {
        roots.extend(rd.flatten().filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false)).map(|e| e.path()));
    }
    let q = "kMDItemFSContentChangeDate >= $time.today(-90) && kMDItemContentType != public.folder";
    let handles: Vec<_> = roots.into_iter().map(|r| std::thread::spawn(move || {
        Command::new("mdfind").arg("-onlyin").arg(&r).arg(q).stderr(Stdio::null()).output()
            .map(|o| String::from_utf8_lossy(&o.stdout).lines().map(String::from).collect::<Vec<_>>()).unwrap_or_default()
    })).collect();
    let mut seen = std::collections::HashSet::new(); // mdfind가 같은 경로를 두 번 주기도 함
    let mut out: Vec<(std::time::SystemTime, String)> = handles.into_iter().flat_map(|h| h.join().unwrap_or_default())
        .filter(|l| seen.insert(l.clone()))
        .filter(|l| !SKIP.iter().any(|s| l.contains(s)) && !l.rsplit('/').next().unwrap_or("").starts_with("._"))
        .filter_map(|l| std::fs::metadata(&l).ok().filter(|m| m.is_file()).and_then(|m| m.modified().ok()).map(|t| (t, l)))
        .collect();
    out.sort_by(|a, b| b.0.cmp(&a.0));
    let v: Vec<String> = out.into_iter().take(n).map(|(_, l)| l).collect();
    *CACHE.lock().unwrap() = Some((Instant::now(), v.clone()));
    v
}

const SKIP: [&str; 6] = ["/node_modules/", "/Library/", "/.", "/target/", ".app/", "/dist/"];

fn mdfind_name(q: &str, roots: &[std::path::PathBuf], n: usize) -> Vec<String> {
    if roots.is_empty() { return vec![] }
    let mut cmd = Command::new("mdfind");
    for r in roots { cmd.arg("-onlyin").arg(r); }
    let Ok(mut child) = cmd.args(["-name", q])
        .stdout(Stdio::piped()).stderr(Stdio::null()).spawn() else { return vec![] };
    let mut out: Vec<String> = BufReader::new(child.stdout.take().unwrap()).lines()
        .map_while(Result::ok)
        .filter(|l| !SKIP.iter().any(|s| l.contains(s)))
        .take(n.max(200))
        .collect();
    let _ = child.kill();
    let _ = child.wait();
    let ql = q.to_lowercase();
    out.sort_by_key(|p| {
        let name = p.rsplit('/').next().unwrap_or("").to_lowercase();
        (!name.starts_with(&ql), p.len())
    });
    out.truncate(n);
    out
}
