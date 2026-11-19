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
    let mut c = CACHE.lock().unwrap();
    if c.is_none() { *c = Some(map); }
}

// 바뀐 게 있으면 파일로 저장
pub fn save() {
    let mut dirty = DIRTY.lock().unwrap();
    if !*dirty { return; }
    let Some(f) = FILE.get() else { return };
    let snapshot: HashMap<String, Entry> = CACHE.lock().unwrap().as_ref()
        .map(|m| m.iter().map(|(k, v)| (k.clone(), (**v).clone())).collect()).unwrap_or_default();
    let Ok(b) = serde_json::to_vec(&snapshot) else { return };
    let tmp = f.with_extension("json.tmp");
    if std::fs::write(&tmp, b).is_err() { return; }
    #[cfg(unix)]
    { use std::os::unix::fs::PermissionsExt; let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600)); }
    if std::fs::rename(&tmp, f).is_ok() { *dirty = false; }
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
    let mut guard = CACHE.lock().unwrap();
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
    if changed || cache.len() != before { *DIRTY.lock().unwrap() = true; }
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
}
