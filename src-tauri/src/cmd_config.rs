// 설정 명령: 설정 읽기, 스니펫 확장, 확장 기능·스토어, 클립보드 기록, 단축키, 노트 검색 저장·삭제, 폴더 선택
// main.rs에서 그대로 옮김
use super::*;

#[tauri::command]
pub fn get_config(app: AppHandle) -> config::PublicConfig {
    // 스니펫이 바뀌었을 수 있으니 자동 확장 목록도 새로
    if let Ok(c) = config::load(&config_file(&app)) { expand::set_snippets(&c.snippets); }
    config::public(&config_file(&app))
}

// 스니펫 자동 확장 켜기·끄기. 켰는데 권한이 없으면 "PERM:input" (macOS가 권한 창을 띄움)
#[tauri::command]
pub async fn snippet_expand_set(on: bool, app: AppHandle) -> Result<bool, String> {
    let f = config_file(&app);
    let mut c = config::load(&f)?;
    c.snippet_expand = on;
    config::save(&f, &c)?;
    expand::set_snippets(&c.snippets);
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || { let _ = tx.send(expand::enable(on)); }).map_err(|e| e.to_string())?;
    let running = rx.recv().map_err(|e| e.to_string())?;
    if on && !running { return Err("PERM:input".into()); }
    Ok(running)
}
#[tauri::command]
pub fn snippet_expand_state(app: AppHandle) -> bool { config::load(&config_file(&app)).map(|c| c.snippet_expand).unwrap_or(false) }

// 클립보드 기록
#[tauri::command]
pub fn clip_list() -> Vec<clip::Clip> { clip::list() }
#[tauri::command]
pub fn clip_remove(at: i64, text: String) { clip::remove(at, &text) }
#[tauri::command]
pub fn clip_clear() { clip::clear() }
#[tauri::command]
pub fn clip_enabled() -> bool { clip::ENABLED.load(std::sync::atomic::Ordering::Relaxed) }
#[tauri::command]
pub fn clip_set_enabled(on: bool, app: AppHandle) -> Result<(), String> {
    let f = config_file(&app);
    let mut c = config::load(&f)?;
    c.clipboard_history = on;
    config::save(&f, &c)?;
    clip::ENABLED.store(on, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}
// 비밀번호 복사: "숨김" 표시를 붙여 클립보드 기록(Baro·다른 앱)에 남지 않게
#[tauri::command]
pub fn copy_secret(text: String) -> Result<(), String> { clip::copy_secret(&text) }

#[tauri::command]
pub fn ext_list(app: AppHandle) -> Vec<extensions::Manifest> { extensions::list(&ext_dir(&app)) }

#[tauri::command]
pub async fn ext_run(id: String, name: String, arg: String, app: AppHandle) -> Result<String, String> {
    // 스크립트는 오래 걸릴 수 있어 별도 스레드에서 실행
    let dir = ext_dir(&app);
    tauri::async_runtime::spawn_blocking(move || extensions::run(&dir, &id, &name, &arg)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn store_list(app: AppHandle) -> Result<Vec<extensions::StoreEntry>, String> {
    let c = config::load(&config_file(&app))?;
    if c.store_url.trim().is_empty() { return Err("설정 파일에 store_url을 넣어 주세요.".into()); }
    extensions::store(c.store_url.trim()).await
}

#[tauri::command]
pub async fn store_install(id: String, app: AppHandle) -> Result<extensions::Manifest, String> {
    let c = config::load(&config_file(&app))?;
    let dir = ext_dir(&app);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    extensions::install(&dir, c.store_url.trim(), &id).await
}

#[tauri::command]
pub fn store_uninstall(id: String, app: AppHandle) -> Result<(), String> { extensions::uninstall(&ext_dir(&app), &id) }

// 새 단축키를 누르는 동안 기존 전역 단축키가 가로채지 않도록 잠시 해제
#[tauri::command]
pub fn suspend_hotkeys(on: bool, app: AppHandle) {
    if on {
        let _ = app.global_shortcut().unregister_all();
        *app.state::<AppState>().suspended.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = true;
    } else {
        register_hotkeys(&app);
    }
}

#[tauri::command]
pub fn get_hotkeys(app: AppHandle) -> std::collections::BTreeMap<String, String> {
    config::hotkeys(&config::load(&config_file(&app)).unwrap_or_else(|_| { log::write("실패 단축키 읽기: 설정을 읽지 못해 기본값 사용"); Default::default() }))
}

// 단축키 바꾸기. 다른 기능과 겹치거나 등록에 실패하면 이전 값으로 되돌림
#[tauri::command]
pub fn set_hotkey(action: String, accel: String, app: AppHandle) -> Result<std::collections::BTreeMap<String, String>, String> {
    if action == "baro" && accel.trim().is_empty() { return Err("Baro 열기 단축키는 비울 수 없어요.".into()); }
    if !accel.is_empty() { accel.parse::<Shortcut>().map_err(|e| format!("단축키 형식 오류: {e}"))?; }
    let path = config_file(&app);
    let mut c = config::load(&path)?;
    let mut keys = config::hotkeys(&c);
    if !keys.contains_key(&action) { return Err(format!("알 수 없는 기능: {action}")); }
    if let Some((other, _)) = keys.iter().find(|(a, k)| **a != action && !accel.is_empty() && k.eq_ignore_ascii_case(&accel)) {
        return Err(format!("이미 다른 기능({other})에 쓰고 있는 단축키예요."));
    }
    let old = keys.insert(action.clone(), accel.clone()).unwrap_or_default();
    c.hotkeys = keys.clone();
    config::save(&path, &c)?;
    if let Some((_, e)) = register_hotkeys(&app).into_iter().find(|(a, _)| *a == action) {
        c.hotkeys.insert(action, old);
        config::save(&path, &c)?;
        register_hotkeys(&app);
        return Err(format!("단축키를 등록하지 못했어요. 다른 앱이 쓰고 있을 수 있어요. ({e})"));
    }
    Ok(keys)
}

#[tauri::command]
pub fn save_note_search(mut search: config::NoteSearch, hotkey: String, app: AppHandle) -> Result<String, String> {
    search.name = search.name.trim().to_string();
    search.dir = search.dir.trim().trim_end_matches('/').to_string();
    if search.name.is_empty() { return Err("이름을 입력하세요.".into()); }
    if !config::NOTE_KINDS.contains(&search.kind.as_str()) { return Err("방식을 선택하세요.".into()); }
    if !std::path::Path::new(&search.dir).is_dir() { return Err(format!("폴더가 없어요: {}", search.dir)); }
    if search.id.is_empty() {
        search.id = format!("n{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0));
    }
    if !search.id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') { return Err("잘못된 id".into()); }
    if !hotkey.is_empty() { hotkey.parse::<Shortcut>().map_err(|e| format!("단축키 형식 오류: {e}"))?; }
    let action = format!("note:{}", search.id);
    let path = config_file(&app);
    let mut c = config::load(&path)?;
    if let Some((other, _)) = config::hotkeys(&c).iter().find(|(a, k)| **a != action && !hotkey.is_empty() && k.eq_ignore_ascii_case(&hotkey)) {
        return Err(format!("이미 다른 기능({other})에 쓰고 있는 단축키예요."));
    }
    match c.note_searches.iter_mut().find(|n| n.id == search.id) {
        Some(n) => *n = search.clone(),
        None => c.note_searches.push(search.clone()),
    }
    c.hotkeys = config::hotkeys(&c);
    c.hotkeys.insert(action.clone(), hotkey);
    config::save(&path, &c)?;
    if let Some((_, e)) = register_hotkeys(&app).into_iter().find(|(a, _)| *a == action) {
        c.hotkeys.insert(action, String::new());
        config::save(&path, &c)?;
        register_hotkeys(&app);
        return Err(format!("노트 검색은 저장했지만 단축키를 등록하지 못했어요. 다른 키로 바꿔 보세요. ({e})"));
    }
    Ok(search.id)
}

#[tauri::command]
pub fn delete_note_search(id: String, app: AppHandle) -> Result<(), String> {
    let path = config_file(&app);
    let mut c = config::load(&path)?;
    c.note_searches.retain(|n| n.id != id);
    c.hotkeys.remove(&format!("note:{id}"));
    if id == "linux" { c.hotkeys.remove("linux_wiki"); }
    config::save(&path, &c)?;
    register_hotkeys(&app);
    Ok(())
}

// Finder 폴더 선택 창. 창이 떠 있는 동안 Baro가 숨지 않고 위에 덮지 않도록 잠시 설정을 바꿈
#[tauri::command]
pub async fn pick_folder(start: String, app: AppHandle, win: WebviewWindow) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    *app.state::<AppState>().dialog_open.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = true;
    let _ = win.set_always_on_top(false);
    let mut d = app.dialog().file().set_title("노트 폴더 선택");
    if std::path::Path::new(&start).is_dir() { d = d.set_directory(&start); }
    let picked = d.blocking_pick_folder();
    let _ = win.set_always_on_top(true);
    *app.state::<AppState>().dialog_open.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = false;
    let _ = win.show(); let _ = win.set_focus();
    picked.map(|p| p.to_string())
}
