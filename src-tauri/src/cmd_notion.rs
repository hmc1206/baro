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

// 노션 일정 + TimeTree 일정(읽기 전용, 하루 한 번 받은 저장본)을 합쳐서
#[tauri::command]
pub async fn notion_events(start: String, end: String, fresh: bool, app: AppHandle) -> Result<CalData, String> {
    let c = config::load(&config_file(&app))?;
    let has_notion = c.notion_accounts.iter().any(|x| !x.token.trim().is_empty());
    if !has_notion && !timetree::configured(&c.timetree_accounts) { return Err("NO_ACCOUNT".into()); }
    let (mut events, mut errors, mut dbs) = (vec![], vec![], vec![]);
    if has_notion {
        if fresh { notion::invalidate_all(); }
        match notion::events(&c.notion_accounts, &start, &end).await {
            Ok((e, e1)) => { events = e; errors = e1; }
            Err(e) => errors.push(e),
        }
        let (d, e2) = notion::databases(&c.notion_accounts).await;
        dbs = d;
        errors.extend(e2);
    }
    let (tt, e3) = timetree::events(&c.timetree_accounts, &timetree_file(&app), &start, &end).await;
    events.extend(tt);
    errors.extend(e3);
    events.sort_by(|a, b| a.start.cmp(&b.start).then(a.title.cmp(&b.title)));
    if events.is_empty() && !errors.is_empty() { return Err(errors.join("\n")); }
    Ok(CalData { events, dbs, errors })
}

fn timetree_file(app: &AppHandle) -> PathBuf { data_dir(app).join("timetree.json") }

// "TimeTree 지금 다시 받기" (1시간에 한 번까지). 결과 한 줄
#[tauri::command]
pub async fn timetree_refresh(app: AppHandle) -> Result<String, String> {
    let c = config::load(&config_file(&app))?;
    Ok(timetree::refresh(&c.timetree_accounts, &timetree_file(&app)).await)
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
