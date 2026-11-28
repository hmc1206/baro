// 실행 명령: 앱 검색·실행, 파일 열기·찾기·미리보기, 시스템 명령, 붙여넣기, 권한, 창 배치
// main.rs에서 그대로 옮김
use super::*;

#[tauri::command]
pub fn search(q: String, st: State<AppState>) -> Vec<indexer::AppEntry> {
    search::rank(&st.apps.lock().unwrap_or_else(std::sync::PoisonError::into_inner), &st.usage.lock().unwrap_or_else(std::sync::PoisonError::into_inner), &q, 8)
}

// 앱 실행 화면: 입력이 없으면 전체 앱(자주 쓴 순 → 이름순), 있으면 일치하는 앱 전부
#[tauri::command]
pub fn apps(q: String, st: State<AppState>) -> Vec<indexer::AppEntry> {
    let list = st.apps.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let usage = st.usage.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if !q.trim().is_empty() { return search::rank(&list, &usage, q.trim(), list.len()); }
    let mut v = list.clone();
    v.sort_by(|a, b| usage.get(&b.path).unwrap_or(&0).cmp(usage.get(&a.path).unwrap_or(&0))
        .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    v
}

// 아이콘을 data URL로 반환. 캐시에 없으면 그 자리에서 만듦 (async라 메인 스레드를 막지 않음)
#[tauri::command]
pub async fn icon(path: String, app: AppHandle) -> Option<String> {
    let dir = icon_dir(&app);
    let f = indexer::icon_file(&dir, &path);
    if !f.exists() { indexer::make_icons(&dir, &[&path]); }
    let bytes = std::fs::read(f).ok()?;
    Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

// Linux .desktop은 open으로 열면 편집기가 뜰 수 있어 gio로 실행
fn start(path: &str) -> std::io::Result<()> {
    #[cfg(target_os = "linux")]
    if path.ends_with(".desktop") {
        return std::process::Command::new("gio").args(["launch", path]).spawn().map(|_| ());
    }
    open::that_detached(path)
}

#[tauri::command]
pub fn launch(path: String, st: State<AppState>, app: AppHandle) -> Result<(), String> {
    start(&path).map_err(|e| e.to_string())?;
    dismiss(&app);
    // 사용 기록은 디스크에 저장해 재시작 후에도 유지
    let mut usage = st.usage.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    *usage.entry(path).or_default() += 1;
    let f = usage_file(&app);
    if let Some(dir) = f.parent() { log::warn("사용 기록 폴더 만들기", std::fs::create_dir_all(dir)); }
    match serde_json::to_vec(&*usage) {
        Ok(b) => { log::warn("사용 기록 저장", std::fs::write(&f, b)); }
        Err(e) => log::write(&format!("실패 사용 기록 직렬화: {e}")),
    }
    Ok(())
}

// 파일 열기 (사용 기록에는 남기지 않음)
#[tauri::command]
pub fn open_path(path: String, app: AppHandle) -> Result<(), String> {
    open::that_detached(&path).map_err(|e| e.to_string())?;
    dismiss(&app);
    Ok(())
}

// 파일 관리자에서 위치 보기
#[tauri::command]
pub fn reveal(path: String, app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").args(["-R", &path]).spawn().map(|_| ());
    #[cfg(target_os = "windows")]
    let r = std::process::Command::new("explorer").arg(format!("/select,{path}")).spawn().map(|_| ());
    #[cfg(target_os = "linux")]
    let r = open::that_detached(std::path::Path::new(&path).parent().unwrap_or(std::path::Path::new("/")));
    r.map_err(|e| e.to_string())?;
    dismiss(&app);
    Ok(())
}

#[tauri::command]
pub fn open_url(url: String, app: AppHandle) -> Result<(), String> {
    open::that_detached(&url).map_err(|e| e.to_string())?;
    dismiss(&app);
    Ok(())
}

#[tauri::command]
pub fn hide(app: AppHandle) { dismiss(&app); }

#[tauri::command]
pub async fn files(q: String) -> Vec<String> {
    tauri::async_runtime::spawn_blocking(move || system::find_files(&q, 6)).await.unwrap_or_else(|e| { log::write(&format!("실패 파일 찾기: {e}")); vec![] })
}

// 파일 찾기 화면 오른쪽 미리보기
#[tauri::command]
pub async fn file_preview(path: String, app: AppHandle) -> Result<system::FilePreview, String> {
    let tmp = app.path().app_cache_dir().unwrap_or_else(|_| std::env::temp_dir().join("baro"));
    tauri::async_runtime::spawn_blocking(move || system::file_preview(&path, &tmp)).await.map_err(|e| e.to_string())?
}

// 파일 찾기 화면, 검색어 없을 때: 최근 바뀐 파일. 화면에는 종류별로 몇 개씩만 보이니 노트가 많아도 다른 종류가 밀려나지 않게 넉넉히
#[tauri::command]
pub async fn files_recent() -> Vec<String> {
    tauri::async_runtime::spawn_blocking(|| system::recent_files(4000)).await.unwrap_or_else(|e| { log::write(&format!("실패 최근 파일: {e}")); vec![] })
}

// 파일 찾기 화면: 홈 + 외장 디스크에서 이름으로 검색
#[tauri::command]
pub async fn files_wide(q: String) -> Vec<String> {
    tauri::async_runtime::spawn_blocking(move || system::find_files_wide(&q, 60)).await.unwrap_or_else(|e| { log::write(&format!("실패 파일 넓게 찾기: {e}")); vec![] })
}

// 설정 파일을 기본 텍스트 편집기로 열기
#[tauri::command]
pub fn open_config(app: AppHandle) -> Result<(), String> {
    let f = config_file(&app);
    let _ = config::load(&f); // 없으면 기본값으로 생성
    #[cfg(target_os = "macos")]
    std::process::Command::new("open").arg("-t").arg(&f).spawn().map_err(|e| e.to_string())?;
    #[cfg(not(target_os = "macos"))]
    open::that_detached(&f).map_err(|e| e.to_string())?;
    dismiss(&app);
    Ok(())
}

// 실행이 끝난 뒤에 숨김: 권한 오류가 나면 창에 안내를 띄울 수 있도록
#[tauri::command]
pub async fn system_cmd(cmd: String, app: AppHandle) -> Result<(), String> {
    if cmd == "quit" { app.exit(0); return Ok(()); }
    system::run(&cmd)?;
    dismiss(&app);
    Ok(())
}

// 클립보드에 복사된 내용을 앞 앱에 붙여넣기
#[tauri::command]
pub async fn paste(app: AppHandle) -> Result<(), String> {
    system::need_ax()?;
    dismiss(&app);
    system::paste()
}

#[tauri::command]
pub fn permissions() -> serde_json::Value { serde_json::json!({ "accessibility": system::ax_trusted() }) }

#[tauri::command]
pub fn open_settings(kind: String) -> Result<(), String> { system::open_settings(&kind) }

// 앞에 있던 앱의 창을 현재 화면 기준으로 배치
#[tauri::command]
pub async fn window_layout(kind: String, app: AppHandle, win: WebviewWindow) -> Result<(), String> {
    system::need_ax()?;
    let pid = (*app.state::<AppState>().prev_pid.lock().unwrap_or_else(std::sync::PoisonError::into_inner)).ok_or("배치할 창이 없어요.")?;
    let m = win.current_monitor().ok().flatten().ok_or("화면 정보를 읽지 못했어요.")?;
    let s = m.scale_factor();
    let wa = m.work_area();
    let area = ((wa.position.x as f64 / s) as i32, (wa.position.y as f64 / s) as i32,
        (wa.size.width as f64 / s) as i32, (wa.size.height as f64 / s) as i32);
    dismiss(&app);
    system::layout(pid, &kind, area)
}
