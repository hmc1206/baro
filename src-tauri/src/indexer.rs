use serde::Serialize;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

// name: 화면에 보이는 이름(macOS는 한글 현지화 이름), alias: 파일 이름(영문 검색용)
#[derive(Serialize, Clone)]
pub struct AppEntry { pub name: String, pub alias: String, pub path: String }

// OS별 앱 위치
fn roots() -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = vec![];
    #[cfg(target_os = "windows")]
    for var in ["ProgramData", "APPDATA"] {
        if let Ok(p) = std::env::var(var) { v.push(PathBuf::from(p).join(r"Microsoft\Windows\Start Menu\Programs")); }
    }
    #[cfg(target_os = "macos")]
    {
        v.push("/Applications".into()); v.push("/System/Applications".into());
        if let Some(h) = dirs::home_dir() { v.push(h.join("Applications")); }
    }
    #[cfg(target_os = "linux")]
    {
        v.push("/usr/share/applications".into());
        if let Some(h) = dirs::home_dir() { v.push(h.join(".local/share/applications")); }
    }
    v
}

const EXTS: &[&str] = &["lnk", "url", "app", "desktop"];

fn ext_of(p: &Path) -> String {
    p.extension().and_then(|x| x.to_str()).unwrap_or("").to_lowercase()
}

pub fn scan() -> Vec<AppEntry> {
    let mut out: Vec<AppEntry> = roots().into_iter().filter(|r| r.exists())
        .flat_map(|r| WalkDir::new(r).max_depth(4).into_iter()
            // .app 번들 내부로는 들어가지 않음
            .filter_entry(|e| e.depth() == 0 || e.path().parent().map_or(true, |p| ext_of(p) != "app"))
            .filter_map(Result::ok))
        .filter(|e| EXTS.contains(&ext_of(e.path()).as_str()))
        .filter_map(|e| {
            let stem: String = e.path().file_stem()?.to_string_lossy().into();
            Some(AppEntry { name: stem.clone(), alias: stem, path: e.path().to_string_lossy().into() })
        })
        .collect();
    #[cfg(target_os = "macos")]
    localize(&mut out);
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out.dedup_by(|a, b| a.name == b.name);
    out
}

// Finder에 보이는 현지화 이름(예: Calculator → 계산기)을 Spotlight 메타데이터에서 한 번에 가져옴
#[cfg(target_os = "macos")]
fn localize(v: &mut [AppEntry]) {
    use unicode_normalization::UnicodeNormalization;
    if v.is_empty() { return; }
    let Ok(o) = std::process::Command::new("mdls")
        .args(["-name", "kMDItemDisplayName", "-raw"])
        .args(v.iter().map(|e| &e.path))
        .output() else { return };
    let names: Vec<&str> = std::str::from_utf8(&o.stdout).unwrap_or("").split('\0').collect();
    if names.len() < v.len() { return; }
    for (e, n) in v.iter_mut().zip(names) {
        // mdls는 한글을 자모 분리형(NFD)으로 주므로 NFC로 합쳐야 입력값과 일치함
        let n: String = n.trim().trim_end_matches(".app").nfc().collect();
        if !n.is_empty() && n != "(null)" { e.name = n; }
    }
}

// 아이콘 캐시 파일 경로 (앱 경로 해시)
pub fn icon_file(cache: &Path, app: &str) -> PathBuf {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    app.hash(&mut h);
    cache.join(format!("{:016x}.png", h.finish()))
}

// NSWorkspace로 아이콘을 PNG로 저장 (캐시에 없는 것만)
#[cfg(target_os = "macos")]
pub fn make_icons(cache: &Path, apps: &[&str]) {
    let _ = std::fs::create_dir_all(cache);
    let args: Vec<String> = apps.iter()
        .map(|a| (a.to_string(), icon_file(cache, a)))
        .filter(|(_, f)| !f.exists())
        .flat_map(|(a, f)| [a, f.to_string_lossy().into_owned()])
        .collect();
    if args.is_empty() { return; }
    let _ = std::process::Command::new("osascript")
        .args(["-l", "JavaScript", "-e", include_str!("icons.js")])
        .args(args)
        .output();
}

#[cfg(not(target_os = "macos"))]
pub fn make_icons(_cache: &Path, _apps: &[&str]) {}
