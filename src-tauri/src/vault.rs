// 노트 파일 캐시 (Vault 색인의 바탕)
// - 노트 검색·그래프·내 노트에게 묻기·개념 노트가 모두 이 캐시로 읽음 → 외장 디스크를 매번 다시 읽지 않음
// - 폴더를 훑을 때 파일의 수정 시각·크기만 보고, 바뀐 파일만 다시 읽음 (지운 파일은 캐시에서 뺌)
// - 캐시는 note-cache.json(나만 읽기 권한)에도 저장 → 앱을 다시 켜도 처음부터 읽지 않음
// - 파일 감시 스레드 없음: 쓸 때만 훑으므로 쉬는 동안 CPU 0
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use unicode_normalization::UnicodeNormalization;
use walkdir::WalkDir;

#[derive(Serialize, Deserialize, Clone)]
pub struct Entry {
    pub path: String, // NFC
    pub mtime: u64,   // 수정 시각 (ns)
    pub len: u64,
    pub text: Arc<str>, // NFC
}

const MAX_FILES: usize = 5000;

static CACHE: Mutex<Option<HashMap<String, Arc<Entry>>>> = Mutex::new(None); // 키: 실제(NFD일 수 있는) 경로
static FILE: OnceLock<PathBuf> = OnceLock::new();
static DIRTY: Mutex<bool> = Mutex::new(false);

// Rust 버전이 바뀌어도 같은 값이 나오는 해시 (FNV-1a 64). 파일에 남는 키는 이것만 씀
// (std DefaultHasher는 Rust 버전마다 알고리즘이 바뀔 수 있어 저장용으로 쓰면 안 됨)
pub fn hash64(parts: &[&[u8]]) -> u64 {
    const P: u64 = 0x100000001b3;
    let mut h: u64 = 0xcbf29ce484222325;
    for p in parts {
        for &b in *p { h ^= b as u64; h = h.wrapping_mul(P); }
        h ^= 0xff; h = h.wrapping_mul(P); // 조각 구분 ("ab","c" ≠ "a","bc")
    }
    h
}

// 비밀번호가 든 노트: 머리말에 password·key_file이 있거나, 본문에 비밀번호처럼 보이는 단어가 있음
// → note-cache.json에 본문을 남기지 않음 (앱을 켤 때 이 노트들만 디스크에서 다시 읽음)
fn secret(text: &str) -> bool {
    if let Some(rest) = text.strip_prefix("---\n") {
        let front = rest.find("\n---").map_or("", |e| &rest[..e]);
        if front.lines().any(|l| l.starts_with("password:") || l.starts_with("key_file:")) { return true; }
    }
    text.contains("PRIVATE KEY-----")
        || text.split(|c: char| !(c.is_ascii_alphanumeric() || "+=_-".contains(c))).any(crate::clip::looks_secret)
}

fn stamp(m: &std::fs::Metadata) -> u64 {
    m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_nanos() as u64).unwrap_or(0)
}

// 저장해 둔 캐시 읽기 (앱 시작 시 한 번)
pub fn init(file: &Path) {
    let _ = FILE.set(file.to_path_buf());
    let map: HashMap<String, Arc<Entry>> = std::fs::read(file).ok()
        .and_then(|b| serde_json::from_slice::<HashMap<String, Entry>>(&b).ok())
        .map(|m| m.into_iter().map(|(k, v)| (k, Arc::new(v))).collect())
        .unwrap_or_default();
    // 예전 캐시에 비밀번호 노트 본문이 남아 있으면 다음 저장 때 지우도록
    if map.values().any(|e| secret(&e.text)) { *DIRTY.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = true; }
    let mut c = CACHE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if c.is_none() { *c = Some(map); }
}

// 바뀐 게 있으면 파일로 저장
pub fn save() {
    let mut dirty = DIRTY.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if !*dirty { return; }
    let Some(f) = FILE.get() else { return };
    let snapshot: HashMap<String, Entry> = CACHE.lock().unwrap_or_else(std::sync::PoisonError::into_inner).as_ref()
        .map(|m| m.iter().filter(|(_, v)| !secret(&v.text)).map(|(k, v)| (k.clone(), (**v).clone())).collect()).unwrap_or_default();
    let Some(b) = crate::log::warn("노트 색인 직렬화", serde_json::to_vec(&snapshot)) else { return };
    let tmp = f.with_extension("json.tmp");
    if crate::log::warn("노트 색인 쓰기", std::fs::write(&tmp, b)).is_none() { return; }
    #[cfg(unix)]
    { use std::os::unix::fs::PermissionsExt; crate::log::warn("노트 색인 권한 설정", std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))); }
    if crate::log::warn("노트 색인 저장", std::fs::rename(&tmp, f)).is_some() { *dirty = false; }
}

// 폴더 아래 .md 전부 (하위 폴더 포함). 숨김 폴더(.obsidian·.trash)와 macOS의 ._ 파일은 건너뜀
pub fn scan(dir: &Path) -> Vec<Arc<Entry>> {
    let files: Vec<(PathBuf, std::fs::Metadata)> = WalkDir::new(dir).max_depth(8).into_iter()
        .filter_entry(|e| e.depth() == 0 || !e.file_name().to_string_lossy().starts_with('.'))
        .filter_map(Result::ok)
        .filter(|e| {
            let n = e.file_name().to_string_lossy();
            e.file_type().is_file() && n.ends_with(".md") && !n.starts_with("._")
        })
        .take(MAX_FILES)
        .filter_map(|e| Some((e.path().to_path_buf(), e.metadata().ok()?)))
        .collect();
    let mut guard = CACHE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let cache = guard.get_or_insert_with(HashMap::new);
    let mut out = Vec::with_capacity(files.len());
    let mut changed = false;
    let mut seen = std::collections::HashSet::new();
    for (p, m) in files {
        let key = p.to_string_lossy().into_owned();
        let (t, len) = (stamp(&m), m.len());
        seen.insert(key.clone());
        if let Some(e) = cache.get(&key) {
            if e.mtime == t && e.len == len { out.push(e.clone()); continue; }
        }
        let Ok(text) = std::fs::read_to_string(&p) else { continue };
        let e = Arc::new(Entry { path: key.nfc().collect(), mtime: t, len, text: text.nfc().collect::<String>().into() });
        cache.insert(key, e.clone());
        out.push(e);
        changed = true;
    }
    // 이 폴더 아래에서 사라진 파일은 캐시에서 빼기
    let prefix = dir.to_string_lossy().into_owned();
    let before = cache.len();
    cache.retain(|k, _| !Path::new(k).starts_with(&prefix) || seen.contains(k));
    if changed || cache.len() != before { *DIRTY.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = true; }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rereads_only_changed_files_and_drops_deleted() {
        let d = std::env::temp_dir().join(format!("baro-vault-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join(".obsidian")).unwrap();
        std::fs::write(d.join("a.md"), "에이").unwrap();
        std::fs::write(d.join("b.md"), "비").unwrap();
        std::fs::write(d.join(".obsidian/x.md"), "숨김").unwrap();
        let first = scan(&d);
        assert_eq!(first.len(), 2);
        let a1 = first.iter().find(|e| e.path.ends_with("a.md")).unwrap().clone();
        // 바뀌지 않은 파일은 같은 캐시 항목 (다시 읽지 않음)
        let again = scan(&d);
        assert!(Arc::ptr_eq(&a1, again.iter().find(|e| e.path.ends_with("a.md")).unwrap()));
        // 내용이 바뀌면 (크기 다름) 다시 읽음, 지운 파일은 빠짐
        std::fs::write(d.join("a.md"), "에이 수정됨").unwrap();
        std::fs::remove_file(d.join("b.md")).unwrap();
        let third = scan(&d);
        assert_eq!(third.len(), 1);
        assert_eq!(&*third[0].text, "에이 수정됨");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn hash_is_fixed() {
        // 값이 바뀌면 저장된 임베딩·아이콘 캐시가 모두 무효가 됨 → 바꾸지 말 것
        assert_eq!(hash64(&[]), 0xcbf29ce484222325);
        assert_ne!(hash64(&[b"ab", b"c"]), hash64(&[b"a", b"bc"]));
    }

    #[test]
    fn secret_notes_are_not_saved_to_disk() {
        assert!(secret("---\nlevel: 1\npassword: \"x\"\n---\n# L1"));
        assert!(secret("# Bandit\n다음 비번: aB3dE5gH7jK9mN1pQ3\n"));
        assert!(!secret("# 일반 노트\nchmod 755 file.sh, https://example.com/a-b"));
        let d = std::env::temp_dir().join(format!("baro-vault-secret-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("pw.md"), "---\npassword: \"zzSecret\"\n---\nL1").unwrap();
        std::fs::write(d.join("ok.md"), "평범한 노트").unwrap();
        let f = d.join("cache.json");
        init(&f);
        scan(&d);
        *DIRTY.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = true;
        save();
        let saved = std::fs::read_to_string(FILE.get().unwrap()).unwrap_or_default();
        if FILE.get() == Some(&f) { // 다른 테스트가 먼저 FILE을 정하지 않았을 때만 확인
            assert!(saved.contains("평범한 노트") && !saved.contains("zzSecret"));
        }
        let _ = std::fs::remove_dir_all(&d);
    }
}
