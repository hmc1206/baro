// 빠른 메모 스크린샷: 방금 찍은 스크린샷을 Vault에 이름을 붙여 저장
// - 가져올 곳: 복사한 이미지(⌘⌃⇧4)가 있으면 그것, 없으면 스크린샷 폴더의 30분 안 파일(⌘⇧4, 기본 데스크탑)
// - 저장할 곳: 메모를 적는 노트 옆 attachments/ 폴더, 이름은 "날짜-이름.확장자" (같은 이름이 있으면 -2, -3…)
// - 파일에서 가져왔으면 원본은 휴지통으로 (Finder에서 "되돌려 놓기" 가능)
use base64::Engine;
use serde::Serialize;
use std::path::{Path, PathBuf};

const RECENT_MS: i64 = 30 * 60 * 1000;
const EXTS: &[&str] = &["png", "jpg", "jpeg", "heic", "tiff"];

#[derive(Serialize, Clone)]
pub struct Shot {
    pub source: String,       // "clip" | "file"
    pub path: Option<String>, // 파일일 때 원본 경로
    pub at: i64,              // 찍은 시각 (ms)
    pub preview: String,      // data URL
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

// macOS 스크린샷 저장 폴더 (설정에서 바꿨으면 그 폴더)
pub fn shot_dir() -> PathBuf {
    let set = std::process::Command::new("defaults").args(["read", "com.apple.screencapture", "location"]).output().ok()
        .filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).filter(|s| !s.is_empty());
    let home = std::env::var("HOME").unwrap_or_default();
    match set {
        Some(s) => PathBuf::from(s.strip_prefix('~').map(|r| format!("{home}{r}")).unwrap_or(s)),
        None => Path::new(&home).join("Desktop"),
    }
}

// 스크린샷 파일 이름인지 (스크린샷 2026-11-19 오후 6.41.02.png, Screenshot …, Screen Shot …)
pub fn is_shot_name(name: &str) -> bool {
    use unicode_normalization::UnicodeNormalization;
    let n: String = name.nfc().collect();
    let ext = Path::new(&n).extension().and_then(|e| e.to_str()).map(str::to_lowercase).unwrap_or_default();
    (n.starts_with("스크린샷") || n.starts_with("Screenshot") || n.starts_with("Screen Shot")) && EXTS.contains(&ext.as_str())
}

// 폴더에서 가장 최근 스크린샷 파일 (경로, 수정 시각 ms)
fn latest_file(dir: &Path) -> Option<(PathBuf, i64)> {
    std::fs::read_dir(dir).ok()?.filter_map(Result::ok)
        .filter(|e| is_shot_name(&e.file_name().to_string_lossy()))
        .filter_map(|e| {
            let t = e.metadata().ok()?.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as i64;
            Some((e.path(), t))
        })
        .max_by_key(|(_, t)| *t)
}

fn mime(ext: &str) -> &'static str {
    match ext { "jpg" | "jpeg" => "image/jpeg", "heic" => "image/heic", "tiff" => "image/tiff", _ => "image/png" }
}

fn data_url(bytes: &[u8], ext: &str) -> String {
    format!("data:{};base64,{}", mime(ext), base64::engine::general_purpose::STANDARD.encode(bytes))
}

// 방금 찍은 스크린샷. 없으면 Err(안내 문구)
pub fn latest() -> Result<Shot, String> {
    let now = now_ms();
    let clip_at = crate::clip::IMAGE_AT.load(std::sync::atomic::Ordering::Relaxed);
    // 복사한 이미지가 먼저 (이때는 데스크탑을 읽지 않음 → 폴더 접근 확인 창도 안 뜸). 시각 0 = Baro가 켜지기 전에 복사돼 시각을 모름 → 그래도 사용
    if clip_at == 0 || now - clip_at <= RECENT_MS {
        if let Some(png) = clip_png() {
            return Ok(Shot { source: "clip".into(), path: None, at: clip_at, preview: data_url(&png, "png") });
        }
    }
    if let Some((p, t)) = latest_file(&shot_dir()).filter(|(_, t)| now - t <= RECENT_MS) {
        let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("png").to_lowercase();
        let b = std::fs::read(&p).map_err(|e| format!("스크린샷을 읽지 못했어요: {e}"))?;
        return Ok(Shot { source: "file".into(), path: Some(p.to_string_lossy().into_owned()), at: t, preview: data_url(&b, &ext) });
    }
    Err("복사한 스크린샷이 없어요. ⌘⌃⇧4로 찍으면 클립보드에 복사돼요. (⌘⇧4로 찍은 파일은 30분 안의 것만)".into())
}

// 파일 이름으로 쓸 수 있게: 금지 글자 빼고, 공백은 -, 최대 50글자
pub fn clean_name(name: &str) -> String {
    let s: String = name.lines().next().unwrap_or("").chars()
        .filter(|c| !"/\\:*?\"<>|#^[]".contains(*c) && !c.is_control())
        .collect::<String>().split_whitespace().collect::<Vec<_>>().join("-");
    s.trim_matches(['-', '.']).chars().take(50).collect()
}

// 같은 이름이 있으면 -2, -3…
fn free_path(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let mut p = dir.join(format!("{stem}.{ext}"));
    let mut i = 2;
    while p.exists() { p = dir.join(format!("{stem}-{i}.{ext}")); i += 1; }
    p
}

// 저장하고 파일 이름(확장자 포함)을 돌려줌. dir: 저장할 attachments 폴더
pub fn save(source: &str, path: Option<&str>, name: &str, date: &str, dir: &Path) -> Result<String, String> {
    let name = clean_name(name);
    if name.is_empty() { return Err("스크린샷 이름이 비어 있어요.".into()); }
    if date.len() != 10 || !date.chars().all(|c| c.is_ascii_digit() || c == '-') { return Err("날짜 형식이 잘못됐어요.".into()); }
    std::fs::create_dir_all(dir).map_err(|e| format!("attachments 폴더를 만들지 못했어요: {e}"))?;
    let stem = format!("{date}-{name}");
    let out = match source {
        "clip" => {
            let png = clip_png().ok_or("클립보드에 이미지가 없어요. 다시 찍어 주세요.")?;
            let out = free_path(dir, &stem, "png");
            std::fs::write(&out, png).map_err(|e| e.to_string())?;
            out
        }
        "file" => {
            // 스크린샷 폴더 안의 스크린샷 파일만 (다른 파일을 옮기거나 지우지 않게)
            let src = PathBuf::from(path.ok_or("원본 경로가 없어요.")?);
            let ok = src.parent().and_then(|p| p.canonicalize().ok()) == shot_dir().canonicalize().ok()
                && src.file_name().is_some_and(|n| is_shot_name(&n.to_string_lossy()));
            if !ok { return Err("스크린샷 폴더의 스크린샷 파일만 저장할 수 있어요.".into()); }
            let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("png").to_lowercase();
            let out = free_path(dir, &stem, &ext);
            std::fs::copy(&src, &out).map_err(|e| format!("스크린샷을 복사하지 못했어요: {e}"))?;
            trash(&src); // 실패해도 저장은 된 상태
            out
        }
        _ => return Err("알 수 없는 스크린샷 종류예요.".into()),
    };
    Ok(out.file_name().unwrap().to_string_lossy().into_owned())
}

// 첨부 목록 노트: 노트 폴더의 "…-첨부목록.md"(없으면 "<폴더>-첨부목록.md"를 새로 만듦)에
// "### 빠른 메모 스크린샷" 아래로 "- [[Vault 기준 경로|파일 이름]]" 한 줄 추가, 제목의 "(N개)"도 하나 늘림. 돌려주는 값: 목록 노트 이름
const LIST_HEAD: &str = "### 빠른 메모 스크린샷";

fn list_note(dir: &Path) -> PathBuf {
    use unicode_normalization::UnicodeNormalization;
    let folder: String = dir.file_name().map(|n| n.to_string_lossy().nfc().collect()).unwrap_or_default();
    let topic = folder.trim_start_matches(|c: char| c.is_ascii_digit() || c == '_').to_string();
    let topic = if topic.is_empty() { folder } else { topic };
    let mut found: Vec<(String, PathBuf)> = std::fs::read_dir(dir).into_iter().flatten().filter_map(Result::ok)
        .map(|e| (e.file_name().to_string_lossy().nfc().collect::<String>(), e.path()))
        .filter(|(n, _)| n.ends_with("-첨부목록.md")).collect();
    found.sort_by_key(|(n, _)| (!n.starts_with(&topic), n.clone())); // 폴더 이름으로 시작하는 것 먼저
    found.into_iter().next().map(|(_, p)| p).unwrap_or_else(|| dir.join(format!("{topic}-첨부목록.md")))
}

pub fn add_to_list(vault: &Path, note_dir: &Path, saved: &Path) -> Result<String, String> {
    use unicode_normalization::UnicodeNormalization;
    let f = list_note(note_dir);
    let stem = f.file_stem().map(|s| s.to_string_lossy().nfc().collect::<String>()).unwrap_or_default();
    let topic = stem.trim_end_matches("-첨부목록").to_string();
    let rel: String = saved.strip_prefix(vault).unwrap_or(saved).to_string_lossy().nfc().collect();
    let name = saved.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let line = format!("- [[{rel}|{name}]]");
    let date = name.get(..10).unwrap_or("");
    let text = std::fs::read_to_string(&f).unwrap_or_else(|_| format!(
        "---\ncreated: {date}\ntype: index\ntags: [attachments]\nsource: baro\n---\n\n# {topic} 첨부 목록 (0개)\n\n"));
    let mut lines: Vec<String> = text.lines().map(String::from).collect();
    // 제목의 개수
    if let Some(h) = lines.iter_mut().find(|l| l.starts_with("# ") && l.ends_with("개)")) {
        if let Some(i) = h.rfind(" (") {
            if let Ok(n) = h[i + 2..h.len() - "개)".len()].parse::<usize>() { *h = format!("{} ({}개)", &h[..i], n + 1); }
        }
    }
    match lines.iter().position(|l| l.trim_end() == LIST_HEAD) {
        Some(h) => {
            // 그 칸의 마지막 줄 다음 (다음 제목 전, 끝의 빈 줄 제외)
            let end = lines[h + 1..].iter().position(|l| l.starts_with('#')).map_or(lines.len(), |i| h + 1 + i);
            let mut at = end;
            while at > h + 1 && lines[at - 1].trim().is_empty() { at -= 1; }
            lines.insert(at, line);
        }
        None => {
            while lines.last().is_some_and(|l| l.trim().is_empty()) { lines.pop(); }
            lines.extend(["".into(), LIST_HEAD.into(), line]);
        }
    }
    let tmp = f.with_extension("md.baro-tmp");
    std::fs::write(&tmp, lines.join("\n") + "\n").map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &f).map_err(|e| e.to_string())?;
    Ok(stem)
}

#[cfg(target_os = "macos")]
fn clip_png() -> Option<Vec<u8>> {
    use objc2_app_kit::NSPasteboard;
    use objc2_foundation::NSString;
    let pb = NSPasteboard::generalPasteboard();
    if let Some(d) = pb.dataForType(&NSString::from_str("public.png")) { return Some(d.to_vec()); }
    // TIFF만 있으면 sips로 PNG 변환
    let tiff = pb.dataForType(&NSString::from_str("public.tiff"))?.to_vec();
    let dir = std::env::temp_dir().join(format!("baro-shot-{}", std::process::id()));
    std::fs::create_dir_all(&dir).ok()?;
    let (a, b) = (dir.join("in.tiff"), dir.join("out.png"));
    std::fs::write(&a, tiff).ok()?;
    let ok = std::process::Command::new("sips").args(["-s", "format", "png"]).arg(&a).arg("--out").arg(&b).output().ok()?.status.success();
    let png = if ok { std::fs::read(&b).ok() } else { None };
    let _ = std::fs::remove_dir_all(&dir);
    png
}
#[cfg(not(target_os = "macos"))]
fn clip_png() -> Option<Vec<u8>> { None }

#[cfg(target_os = "macos")]
fn trash(p: &Path) {
    use objc2_foundation::{NSFileManager, NSString, NSURL};
    let url = NSURL::fileURLWithPath(&NSString::from_str(&p.to_string_lossy()));
    let _ = NSFileManager::defaultManager().trashItemAtURL_resultingItemURL_error(&url, None);
}
#[cfg(not(target_os = "macos"))]
fn trash(_p: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert!(is_shot_name("스크린샷 2026-11-19 오후 6.41.02.png"));
        assert!(is_shot_name("Screenshot 2026-11-19 at 18.41.02.PNG"));
        assert!(!is_shot_name("스크린샷 녹화.mov"));
        assert!(!is_shot_name("photo.png"));
        assert_eq!(clean_name("  chmod 권한 / 오류: 화면?\n둘째 줄"), "chmod-권한-오류-화면");
        assert_eq!(clean_name("[[a#b]]"), "ab");
        assert_eq!(clean_name("..."), "");
    }

    #[test]
    fn attachment_list_note_gets_links() {
        let v = std::env::temp_dir().join(format!("baro-shot-list-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&v);
        let d = v.join("02_Knowledge").join("Linux");
        std::fs::create_dir_all(d.join("attachments")).unwrap();
        // 목록 노트가 없으면 "<폴더>-첨부목록.md"를 만듦
        assert_eq!(add_to_list(&v, &d, &d.join("attachments/2026-11-19-a.png")).unwrap(), "Linux-첨부목록");
        add_to_list(&v, &d, &d.join("attachments/2026-11-19-b.png")).unwrap();
        let t = std::fs::read_to_string(d.join("Linux-첨부목록.md")).unwrap();
        assert!(t.contains("# Linux 첨부 목록 (2개)"));
        assert!(t.contains("### 빠른 메모 스크린샷\n- [[02_Knowledge/Linux/attachments/2026-11-19-a.png|2026-11-19-a.png]]\n- [[02_Knowledge/Linux/attachments/2026-11-19-b.png|2026-11-19-b.png]]\n"));
        // 이미 있는 목록 노트(다른 칸 뒤)에 추가, 숫자 앞 폴더 번호는 뺌
        let e = v.join("03_Daily");
        std::fs::create_dir_all(&e).unwrap();
        std::fs::write(e.join("Daily-첨부목록.md"), "# Daily 첨부 목록 (1개)\n\n### 옛것\n- [[x|x]]\n").unwrap();
        assert_eq!(add_to_list(&v, &e, &e.join("attachments/2026-11-19-c.png")).unwrap(), "Daily-첨부목록");
        let t = std::fs::read_to_string(e.join("Daily-첨부목록.md")).unwrap();
        assert_eq!(t, "# Daily 첨부 목록 (2개)\n\n### 옛것\n- [[x|x]]\n\n### 빠른 메모 스크린샷\n- [[03_Daily/attachments/2026-11-19-c.png|2026-11-19-c.png]]\n");
        let _ = std::fs::remove_dir_all(&v);
    }

    #[test]
    fn save_copies_with_date_name_and_never_overwrites() {
        let d = std::env::temp_dir().join(format!("baro-shot-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("2026-11-19-a.png"), "old").unwrap();
        assert_eq!(free_path(&d, "2026-11-19-a", "png"), d.join("2026-11-19-a-2.png"));
        // 스크린샷 폴더 밖 파일은 거부
        std::fs::write(d.join("스크린샷 x.png"), "img").unwrap();
        assert!(save("file", Some(&d.join("스크린샷 x.png").to_string_lossy()), "a", "2026-11-19", &d.join("att")).is_err());
        assert!(save("file", None, "", "2026-11-19", &d).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }
}

// 실제 환경 확인 (저장하지 않음): cargo test shot_probe -- --ignored --nocapture
#[cfg(test)]
#[test]
#[ignore]
fn shot_probe() {
    println!("폴더 {:?}", shot_dir());
    println!("최근 파일 {:?}", latest_file(&shot_dir()).map(|(p, t)| (p.file_name().map(|n| n.to_string_lossy().into_owned()), (now_ms() - t) / 1000)));
    println!("클립보드 PNG {:?}바이트", clip_png().map(|b| b.len()));
}
