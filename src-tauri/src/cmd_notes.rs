// 노트·메모 명령: 노트 읽기, 상태·체크·증거, 빠른 메모 기록(쓰기·지우기·되돌리기·고치기), 사진, 개념 노트 만들기
// main.rs에서 그대로 옮김
use super::*;

// 노트 검색 하나의 노트 읽기
#[tauri::command]
pub async fn notes_load(id: String, app: AppHandle) -> Result<wiki::Notes, String> {
    let c = config::load(&config_file(&app))?;
    // "__vault": 전체 노트 그래프용. Vault 전체를 일반 노트 방식으로 읽음
    let s = if id == "__vault" { config::NoteSearch { id, name: String::new(), dir: c.vault_dir.clone(), kind: "notes".into() } }
        else { c.note_searches.into_iter().find(|n| n.id == id).ok_or("노트 검색을 찾지 못했어요.")? };
    tauri::async_runtime::spawn_blocking(move || { let r = wiki::load(&s.dir, &s.kind, &c.vault_dir); vault::save(); r }).await.map_err(|e| e.to_string())?
}

fn note_dir(app: &AppHandle, id: &str) -> Result<String, String> {
    let c = config::load(&config_file(app))?;
    c.note_searches.into_iter().find(|n| n.id == id).map(|n| n.dir).ok_or("노트 검색을 찾지 못했어요.".into())
}

// 빠른 메모 기록·사진을 쓸 수 있는 폴더: 노트 검색 폴더. 커리큘럼은 허브가 가리키는 단계 노트가
// 다른 폴더(예: Network-Security/Hacking-Curriculum)에 있을 수 있어 Vault 전체
fn record_dir(app: &AppHandle, id: &str) -> Result<String, String> {
    let c = config::load(&config_file(app))?;
    if id == "__vault" { return Ok(c.vault_dir); } // 빠른 메모에서 고른 아무 노트
    let n = c.note_searches.into_iter().find(|n| n.id == id).ok_or("노트 검색을 찾지 못했어요.")?;
    Ok(if n.kind == "curriculum" && !c.vault_dir.is_empty() { c.vault_dir } else { n.dir })
}

// 커리큘럼 허브: "### 단계"의 상태 바꾸기 (학습 전·학습 중·복습 필요·완료)
#[tauri::command]
pub fn note_stage_status(id: String, file: String, heading: String, value: String, app: AppHandle) -> Result<(), String> {
    wiki::set_stage_status(&note_dir(&app, &id)?, &file, &heading, &value)
}

// 커리큘럼: 이름으로 노트 읽기 (단계의 개념 노트들). Vault 어디에 있든, 커리큘럼 폴더 안 노트 먼저
#[tauri::command]
pub async fn notes_named(id: String, names: Vec<String>, app: AppHandle) -> Result<Vec<wiki::Note>, String> {
    let c = config::load(&config_file(&app))?;
    let s = c.note_searches.into_iter().find(|n| n.id == id).ok_or("노트 검색을 찾지 못했어요.")?;
    if s.kind != "curriculum" { return Err("커리큘럼에서만 쓸 수 있어요.".into()); }
    let vault = c.vault_dir;
    tauri::async_runtime::spawn_blocking(move || { let r = wiki::named(&s.dir, &vault, &names); vault::save(); r }).await.map_err(|e| e.to_string())
}

// 커리큘럼 허브: 개념 항목(index번째 체크박스 줄)의 상태 바꾸기
#[tauri::command]
pub fn note_task_state(id: String, file: String, index: usize, text: String, value: String, app: AppHandle) -> Result<(), String> {
    wiki::set_task_state(&note_dir(&app, &id)?, &file, index, &text, &value)
}

// 노트 머리말 값 바꾸기 (비밀번호 모음의 비밀번호 수정 등). 해당 노트 검색 폴더 안의 파일만
#[tauri::command]
pub fn note_set_field(id: String, file: String, key: String, value: String, app: AppHandle) -> Result<(), String> {
    // 커리큘럼은 Vault 어디든 있는 개념 노트에도 (last_studied)
    wiki::set_field(&record_dir(&app, &id)?, &file, &key, &value)
}

// 커리큘럼: 노트의 index번째 체크박스 체크/해제
#[tauri::command]
pub fn note_toggle_task(id: String, file: String, index: usize, text: String, done: bool, app: AppHandle) -> Result<(), String> {
    wiki::toggle_task(&record_dir(&app, &id)?, &file, index, &text, done)
}

// 커리큘럼 개념: 완료 기준(index번째 체크박스)에 증거를 달고 체크. field가 있으면 머리말 evidence에도
#[tauri::command]
pub fn note_add_evidence(id: String, file: String, index: usize, text: String, date: String, body: String, field: Option<String>, app: AppHandle) -> Result<(), String> {
    wiki::add_evidence(&record_dir(&app, &id)?, &file, index, &text, &date, &body, field.as_deref())
}

// 커리큘럼 개념: 완료 기준 아래 n번째 증거 고치기 (체크·상태는 그대로)
#[tauri::command]
pub fn note_edit_evidence(id: String, file: String, index: usize, text: String, n: usize, first: String, body: String, field: Option<String>, app: AppHandle) -> Result<(), String> {
    wiki::edit_evidence(&record_dir(&app, &id)?, &file, index, &text, n, &first, &body, field.as_deref())
}

// 빠른 메모: 오늘 Daily 노트에 한 줄 추가
#[tauri::command]
pub fn memo_daily(date: String, time: String, text: String, app: AppHandle) -> Result<String, String> {
    let c = config::load(&config_file(&app))?;
    wiki::append_daily(&c.vault_dir, &date, &time, &text)
}

// 빠른 메모 기록 지우기·되돌리기. section이 "daily"면 오늘 Daily(date), 아니면 커리큘럼 단계 노트(id·file)의 그 칸
#[derive(serde::Serialize)]
pub struct Removed { line: usize, text: String }

#[tauri::command]
pub fn memo_remove(id: String, file: String, date: String, section: String, index: usize, first: String, app: AppHandle) -> Result<Removed, String> {
    let (line, text) = if section == "daily" {
        wiki::remove_daily(&config::load(&config_file(&app))?.vault_dir, &date, index, &first)?
    } else { wiki::remove_record(&record_dir(&app, &id)?, &file, &section, index, &first)? };
    Ok(Removed { line, text })
}

#[tauri::command]
pub fn memo_restore(id: String, file: String, date: String, section: String, line: usize, text: String, app: AppHandle) -> Result<(), String> {
    if section == "daily" { wiki::restore_daily(&config::load(&config_file(&app))?.vault_dir, &date, line, &text) }
    else { wiki::restore_record(&record_dir(&app, &id)?, &file, line, &text) }
}

// 빠른 메모 기록 고치기: 그 항목을 지운 자리에 고친 내용을 넣음
#[tauri::command]
pub fn memo_replace(id: String, file: String, date: String, section: String, index: usize, first: String, text: String, app: AppHandle) -> Result<(), String> {
    if text.trim().is_empty() { return Err("고친 내용이 비어 있어요.".into()); }
    if section == "daily" {
        let vault = config::load(&config_file(&app))?.vault_dir;
        let (line, _) = wiki::remove_daily(&vault, &date, index, &first)?;
        wiki::restore_daily(&vault, &date, line, &text)
    } else {
        let dir = record_dir(&app, &id)?;
        let (line, _) = wiki::remove_record(&dir, &file, &section, index, &first)?;
        wiki::restore_record(&dir, &file, line, &text)
    }
}

// 빠른 메모 스크린샷: 방금 찍은 것 (클립보드 이미지 또는 스크린샷 파일, 30분 이내)
#[tauri::command]
pub async fn shot_latest(app: AppHandle) -> Result<shot::Shot, String> {
    // 처음 데스크탑을 읽을 때 macOS 폴더 접근 확인 창이 뜨면 Baro가 초점을 잃음 → 그동안은 숨기지 않음
    let st = app.state::<AppState>();
    *st.dialog_open.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = true;
    let r = tauri::async_runtime::spawn_blocking(shot::latest).await.map_err(|e| e.to_string());
    *st.dialog_open.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = false;
    r?
}

// 메모할 노트의 폴더. id가 비면 오늘 Daily(03_Daily)
fn memo_note_dir(app: &AppHandle, vault: &Path, id: &str, file: &str) -> Result<PathBuf, String> {
    if id.is_empty() { return Ok(vault.join("03_Daily")); }
    Ok(wiki::inside(&record_dir(app, id)?, file)?.parent().ok_or("노트 폴더를 찾지 못했어요.")?.to_path_buf())
}

// 메모 기록에 붙은 사진(![[파일]])을 미리보기용 data URL로
#[tauri::command]
pub async fn shot_read(id: String, file: String, name: String, app: AppHandle) -> Result<String, String> {
    let vault = PathBuf::from(config::load(&config_file(&app))?.vault_dir);
    let dir = memo_note_dir(&app, &vault, &id, &file)?.join("attachments");
    tauri::async_runtime::spawn_blocking(move || shot::read(&dir, &name)).await.map_err(|e| e.to_string())?
}

// 스크린샷을 메모할 노트 옆 attachments/에 "날짜-이름"으로 저장하고, 그 폴더의 첨부 목록 노트에 링크 추가.
// id가 비면 오늘 Daily(03_Daily). 돌려주는 값: 파일 이름, 첨부 목록 노트 이름(추가 실패면 빈 글자)
#[tauri::command]
pub async fn shot_save(source: String, path: Option<String>, name: String, date: String, id: String, file: String, app: AppHandle) -> Result<(String, String), String> {
    let vault = PathBuf::from(config::load(&config_file(&app))?.vault_dir);
    let note_dir = memo_note_dir(&app, &vault, &id, &file)?;
    tauri::async_runtime::spawn_blocking(move || {
        let f = shot::save(&source, path.as_deref(), &name, &date, &note_dir.join("attachments"))?;
        let list = shot::add_to_list(&vault, &note_dir, &note_dir.join("attachments").join(&f))
            .unwrap_or_else(|e| { log::write(&format!("첨부 목록 추가 실패: {e}")); String::new() });
        Ok((f, list))
    }).await.map_err(|e| e.to_string())?
}

// 빠른 메모: 오늘 Daily 노트 경로 (Obsidian에서 열기용). 아직 없으면 Err
#[tauri::command]
pub fn memo_daily_path(date: String, app: AppHandle) -> Result<String, String> {
    if date.len() != 10 || !date.chars().all(|c| c.is_ascii_digit() || c == '-') { return Err("날짜 형식이 잘못됐어요.".into()); }
    let f = PathBuf::from(config::load(&config_file(&app))?.vault_dir).join("03_Daily").join(format!("{date}.md"));
    if !f.is_file() { return Err("오늘 Daily 노트가 아직 없어요. 메모를 하나 저장하면 만들어져요.".into()); }
    Ok(f.to_string_lossy().into_owned())
}

// 빠른 메모: 오늘 Daily 노트 읽기 (이미 적은 메모 보기)
#[tauri::command]
pub fn memo_daily_read(date: String, app: AppHandle) -> String {
    match config::load(&config_file(&app)) {
        Ok(c) => wiki::read_daily(&c.vault_dir, &date),
        Err(_) => { log::write("실패 오늘 메모 읽기: 설정을 읽지 못함"); String::new() } // 오류 문구에 토큰이 섞일 수 있어 원인은 남기지 않음
    }
}

// 빠른 메모: 커리큘럼 단계 노트의 "내 기록" 칸에 추가
#[tauri::command]
pub fn note_add_record(id: String, file: String, section: String, block: String, app: AppHandle) -> Result<(), String> {
    wiki::add_record(&record_dir(&app, &id)?, &file, &section, &block)
}

// 클립보드 글자 (명령어 기록용)
#[tauri::command]
pub fn clipboard_text() -> Result<String, String> {
    let out = std::process::Command::new("pbpaste").output().map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

// 노트 검색 폴더에 새 노트 만들기
#[tauri::command]
pub fn note_create(id: String, name: String, content: String, app: AppHandle) -> Result<String, String> {
    wiki::create(&note_dir(&app, &id)?, &name, &content)
}

// 노트 검색 추가·수정. id가 비어 있으면 새로 만듦. 저장한 id를 돌려줌
// 아직 없는 [[링크]]로 개념 노트 만들기 (있으면 그 노트). 돌려주는 값: (경로, 새로 만들었는지)
#[tauri::command]
pub fn concept_create(src: String, name: String, date: String, app: AppHandle) -> Result<(String, bool), String> {
    let c = config::load(&config_file(&app))?;
    wiki::create_concept(&c.vault_dir, &src, &name, &date)
}

// Baro 안에서 노트 편집: 원문 읽기
#[tauri::command]
pub fn note_read(id: String, file: String, app: AppHandle) -> Result<String, String> {
    std::fs::read_to_string(wiki::inside(&record_dir(&app, &id)?, &file)?).map_err(|e| e.to_string())
}

// 편집한 원문 저장. base(열 때 읽은 원문)와 지금 파일이 다르면 Obsidian 등에서 바뀐 것이라 덮어쓰지 않음.
// name(제목 = 파일 이름)이 바뀌었으면 같은 폴더에서 이름도 바꿈. 돌려주는 값: 저장한 파일 경로
#[tauri::command]
pub fn note_write(id: String, file: String, base: String, content: String, name: String, app: AppHandle) -> Result<String, String> {
    let f = wiki::inside(&record_dir(&app, &id)?, &file)?;
    let now = std::fs::read_to_string(&f).map_err(|e| e.to_string())?;
    if now != base { return Err("연 뒤에 다른 곳(Obsidian 등)에서 이 노트가 바뀌었어요. 닫고 다시 열어 주세요. 고친 내용은 복사해 두세요.".into()); }
    let name = name.trim().trim_end_matches(".md").trim();
    let to = if name.is_empty() || f.file_stem().is_some_and(|s| s.to_string_lossy() == name) { f.clone() } else {
        if name.starts_with('.') || name.contains(['/', '\\', ':']) { return Err("제목(파일 이름)에 / \\ : 는 쓸 수 없어요.".into()); }
        let t = f.with_file_name(format!("{name}.md"));
        if t.exists() { return Err(format!("같은 이름의 노트가 이미 있어요: {name}.md")); }
        t
    };
    let tmp = f.with_extension("md.baro-tmp");
    std::fs::write(&tmp, content).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &to).map_err(|e| e.to_string())?;
    if to != f { crate::log::warn("옛 노트 파일 지우기", std::fs::remove_file(&f)); }
    Ok(to.to_string_lossy().into_owned())
}
