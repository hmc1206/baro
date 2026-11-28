// 캘린더·할 일 명령: 노션 계정들의 일정 DB 읽기·쓰기
// main.rs에서 그대로 옮김
use super::*;

// 캘린더·할 일: 노션 계정들의 일정 DB를 합쳐 읽기·쓰기
#[derive(serde::Serialize)]
pub struct CalData { events: Vec<notion::Event>, dbs: Vec<notion::Db>, errors: Vec<String> }

fn notion_accounts(app: &AppHandle) -> Result<Vec<config::NotionAccount>, String> {
    let a = config::load(&config_file(app))?.notion_accounts;
    if a.iter().all(|x| x.token.trim().is_empty()) { return Err("NO_ACCOUNT".into()); }
    Ok(a)
}

#[tauri::command]
pub async fn notion_events(start: String, end: String, fresh: bool, app: AppHandle) -> Result<CalData, String> {
    let accts = notion_accounts(&app)?;
    if fresh { notion::invalidate_all(); }
    let (events, mut errors) = notion::events(&accts, &start, &end).await?;
    let (dbs, e2) = notion::databases(&accts).await;
    errors.extend(e2);
    Ok(CalData { events, dbs, errors })
}

// 홈 ⌘T 할 일 저장용: 일정 DB 목록만 (10분 캐시)
#[tauri::command]
pub async fn notion_dbs(app: AppHandle) -> Result<Vec<notion::Db>, String> {
    let accts = notion_accounts(&app)?;
    Ok(notion::databases(&accts).await.0)
}

#[tauri::command]
pub async fn notion_create(db_id: String, title: String, start: String, end: Option<String>, app: AppHandle) -> Result<(), String> {
    let accts = notion_accounts(&app)?;
    let db = notion::find_db(&accts, &db_id).await?;
    notion::create(&accts, &db, &title, &start, end.as_deref()).await
}

#[tauri::command]
pub async fn notion_done(account: String, page: String, prop: String, done: bool, app: AppHandle) -> Result<(), String> {
    notion::set_done(&notion_accounts(&app)?, &account, &page, &prop, done).await
}

#[tauri::command]
pub async fn notion_edit(account: String, page: String, db_id: String, title: String, start: String, end: Option<String>, app: AppHandle) -> Result<(), String> {
    let accts = notion_accounts(&app)?;
    let db = notion::find_db(&accts, &db_id).await?;
    notion::edit(&accts, &account, &page, &db, &title, &start, end.as_deref()).await
}

#[tauri::command]
pub async fn notion_trash(account: String, page: String, restore: bool, app: AppHandle) -> Result<(), String> {
    notion::trash(&notion_accounts(&app)?, &account, &page, restore).await
}
