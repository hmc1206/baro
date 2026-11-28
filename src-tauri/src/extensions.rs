// 확장: 폴더 하나 = manifest.json + 스크립트들 (Raycast의 Script Command와 비슷한 방식)
// 스크립트는 사용자 권한으로 실행되므로 설치 전에 화면에서 확인을 받음
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[derive(Serialize, Deserialize, Clone)]
pub struct ExtCommand {
    pub name: String,
    pub title: String,
    #[serde(default)]
    pub keywords: String,
    // 입력한 "keyword 내용"에서 내용을 스크립트 인자로 넘김
    #[serde(default)]
    pub keyword: String,
    // copy: 출력 복사, view: 출력 보기, open: 출력을 URL/경로로 열기, silent: 실행만
    pub mode: String,
    pub script: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Manifest {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub author: String,
    pub commands: Vec<ExtCommand>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct StoreEntry {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub author: String,
    // 스토어 index.json 위치 기준 상대 경로
    pub path: String,
}

#[derive(Deserialize)]
struct StoreIndex { extensions: Vec<StoreEntry> }

// 경로 조작을 막기 위해 id·파일 이름은 안전한 글자만 허용
fn safe(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c)) && !s.starts_with('.')
}

fn check(m: &Manifest) -> Result<(), String> {
    if !safe(&m.id) { return Err(format!("확장 id가 올바르지 않아요: {}", m.id)); }
    for c in &m.commands {
        if !safe(&c.name) || !safe(&c.script) { return Err(format!("명령 정의가 올바르지 않아요: {}", c.name)); }
        if !["copy", "view", "open", "silent"].contains(&c.mode.as_str()) { return Err(format!("알 수 없는 mode: {}", c.mode)); }
    }
    Ok(())
}

pub fn list(dir: &Path) -> Vec<Manifest> {
    let Ok(rd) = std::fs::read_dir(dir) else { return vec![] };
    let mut v: Vec<Manifest> = rd.filter_map(Result::ok)
        .filter_map(|e| serde_json::from_slice::<Manifest>(&std::fs::read(e.path().join("manifest.json")).ok()?).ok())
        .filter(|m| check(m).is_ok())
        .collect();
    v.sort_by(|a, b| a.name.cmp(&b.name));
    v
}

// 스크립트 실행 (최대 15초). 표준 출력을 돌려줌
pub fn run(dir: &Path, id: &str, name: &str, arg: &str) -> Result<String, String> {
    if !safe(id) { return Err("잘못된 확장 id".into()); }
    let root = dir.join(id);
    let m: Manifest = serde_json::from_slice(&std::fs::read(root.join("manifest.json")).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    check(&m)?;
    let c = m.commands.iter().find(|c| c.name == name).ok_or("명령을 찾지 못했어요.")?;
    let path = std::env::var("PATH").unwrap_or_default();
    let mut child = Command::new(root.join(&c.script)).arg(arg).current_dir(&root)
        .env("PATH", format!("/opt/homebrew/bin:/usr/local/bin:{path}"))
        .env("LANG", "en_US.UTF-8") // GUI 앱은 로캘이 비어 있어 한글 글자 수가 바이트로 셈
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn().map_err(|e| format!("스크립트를 실행하지 못했어요: {e}"))?;
    let start = Instant::now();
    loop {
        if child.try_wait().map_err(|e| e.to_string())?.is_some() { break; }
        if start.elapsed() > Duration::from_secs(15) {
            let _ = child.kill();
            return Err("스크립트가 15초 안에 끝나지 않아 중단했어요.".into());
        }
        std::thread::sleep(Duration::from_millis(30));
    }
    let o = child.wait_with_output().map_err(|e| e.to_string())?;
    if !o.status.success() {
        return Err(format!("스크립트 오류: {}", String::from_utf8_lossy(&o.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&o.stdout).trim_end().to_string())
}

// file:// 또는 https:// 주소에서 읽기
async fn fetch(url: &str) -> Result<Vec<u8>, String> {
    if let Some(p) = url.strip_prefix("file://") {
        return std::fs::read(p).map_err(|e| format!("{p}: {e}"));
    }
    if !url.starts_with("https://") { return Err("스토어 주소는 https:// 또는 file:// 이어야 해요.".into()); }
    let r = reqwest::get(url).await.map_err(|e| format!("네트워크 오류: {e}"))?;
    if !r.status().is_success() { return Err(format!("{url}: HTTP {}", r.status())); }
    r.bytes().await.map(|b| b.to_vec()).map_err(|e| e.to_string())
}

fn base_of(index_url: &str) -> &str { index_url.rsplit_once('/').map(|(b, _)| b).unwrap_or(index_url) }

pub async fn store(index_url: &str) -> Result<Vec<StoreEntry>, String> {
    let idx: StoreIndex = serde_json::from_slice(&fetch(index_url).await?).map_err(|e| format!("스토어 목록 형식 오류: {e}"))?;
    Ok(idx.extensions.into_iter().filter(|e| safe(&e.id) && safe(&e.path)).collect())
}

// manifest와 스크립트를 내려받아 임시 폴더에 받은 뒤, 모두 성공하면 교체
pub async fn install(dir: &Path, index_url: &str, id: &str) -> Result<Manifest, String> {
    let entry = store(index_url).await?.into_iter().find(|e| e.id == id).ok_or("스토어에 없는 확장이에요.")?;
    let base = format!("{}/{}", base_of(index_url), entry.path);
    let m: Manifest = serde_json::from_slice(&fetch(&format!("{base}/manifest.json")).await?)
        .map_err(|e| format!("manifest 형식 오류: {e}"))?;
    check(&m)?;
    if m.id != id { return Err("스토어 정보와 확장 id가 달라요.".into()); }
    let tmp: PathBuf = dir.join(format!(".tmp-{id}"));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    std::fs::write(tmp.join("manifest.json"), serde_json::to_vec_pretty(&m).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    for c in &m.commands {
        let f = tmp.join(&c.script);
        if f.exists() { continue; }
        std::fs::write(&f, fetch(&format!("{base}/{}", c.script)).await?).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o755)).map_err(|e| format!("실행 권한을 주지 못했어요: {e}"))?;
        }
    }
    let dest = dir.join(id);
    let _ = std::fs::remove_dir_all(&dest);
    std::fs::rename(&tmp, &dest).map_err(|e| e.to_string())?;
    Ok(m)
}

pub fn uninstall(dir: &Path, id: &str) -> Result<(), String> {
    if !safe(id) { return Err("잘못된 확장 id".into()); }
    let p = dir.join(id);
    if !p.exists() { return Err("설치되지 않은 확장이에요.".into()); }
    std::fs::remove_dir_all(p).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    // 프로젝트의 store/ 폴더로 설치 → 목록 → 실행 → 삭제까지 확인
    #[test]
    fn install_run_uninstall() {
        let store = format!("file://{}/../store/index.json", env!("CARGO_MANIFEST_DIR"));
        let dir = std::env::temp_dir().join(format!("baro-ext-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let entries = tauri::async_runtime::block_on(super::store(&store)).unwrap();
        assert_eq!(entries.len(), 3);
        for e in &entries {
            let m = tauri::async_runtime::block_on(install(&dir, &store, &e.id)).unwrap();
            assert_eq!(m.id, e.id);
        }
        assert_eq!(list(&dir).len(), 3);
        assert_eq!(run(&dir, "text-tools", "upper", "hello").unwrap(), "HELLO");
        assert_eq!(run(&dir, "text-tools", "count", "안녕 hi").unwrap(), "글자 수: 5 (공백 제외 4)");
        assert_eq!(run(&dir, "dev-tools", "uuid", "").unwrap().len(), 36);
        assert!(run(&dir, "../etc", "x", "").is_err()); // 경로 조작 차단
        uninstall(&dir, "dev-tools").unwrap();
        assert_eq!(list(&dir).len(), 2);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
