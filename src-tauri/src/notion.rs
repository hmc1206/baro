// 노션 캘린더 합치기: 계정(통합 토큰)마다 공유된 DB 중 날짜 속성이 있는 DB의 일정을 읽어 하나로 합침
// 노션 캘린더 앱은 공개 API가 없어서, 노션 API로 같은 DB를 읽고 쓰면 노션 캘린더에도 그대로 보임
use crate::config::NotionAccount;
use serde::Serialize;
use serde_json::{json, Value};
use std::{sync::Mutex, time::{Duration, Instant}};

const API: &str = "https://api.notion.com/v1";
const VERSION: &str = "2022-06-28";

// 일정 DB: 제목·날짜 속성 이름, 완료 체크박스(없으면 None)
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Db { pub id: String, pub name: String, pub account: String, pub title_prop: String, pub date_prop: String, pub done_prop: Option<String> }

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Event {
    pub id: String, pub title: String,
    pub start: String, pub end: Option<String>, // "2026-11-28" 또는 "2026-11-28T15:00:00.000+09:00"
    pub done: Option<bool>, pub url: String,
    pub account: String, pub color: String, pub db: String, pub db_id: String,
}

static DBS: Mutex<Option<(Instant, String, Vec<Db>)>> = Mutex::new(None);
static EVENTS: Mutex<Option<(Instant, String, Vec<Event>)>> = Mutex::new(None);

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> { m.lock().unwrap_or_else(std::sync::PoisonError::into_inner) }
pub fn invalidate() { *lock(&EVENTS) = None; }
// ⌘R 새로고침: 새로 연결한 DB도 보이게 DB 목록까지 다시 읽기
pub fn invalidate_all() { invalidate(); *lock(&DBS) = None; }

async fn call(token: &str, method: reqwest::Method, path: &str, body: Option<Value>) -> Result<Value, String> {
    let mut req = reqwest::Client::new().request(method, format!("{API}{path}"))
        .bearer_auth(token).header("Notion-Version", VERSION).timeout(Duration::from_secs(15));
    if let Some(b) = body { req = req.json(&b); }
    let res = req.send().await.map_err(|e| format!("노션 연결 실패: {e}"))?;
    let status = res.status();
    let v: Value = res.json().await.map_err(|e| format!("노션 응답 오류: {e}"))?;
    if !status.is_success() {
        let msg = v["message"].as_str().unwrap_or("");
        return Err(match status.as_u16() {
            401 => "노션 토큰이 맞지 않아요. config.json의 토큰을 확인해 주세요.".into(),
            404 => "노션에서 찾을 수 없어요. DB에 통합을 연결했는지 확인해 주세요.".into(),
            _ => format!("노션 오류 {status}: {msg}"),
        });
    }
    Ok(v)
}

fn plain(rich: &Value) -> String {
    rich.as_array().map(|a| a.iter().filter_map(|t| t["plain_text"].as_str()).collect()).unwrap_or_default()
}

// 이름이 이 목록에 있으면 먼저 고름 (예: 날짜 속성이 여러 개일 때 "날짜")
fn pick_prop(props: &serde_json::Map<String, Value>, kind: &str, prefer: &[&str]) -> Option<String> {
    let mut names: Vec<&String> = props.iter().filter(|(_, p)| p["type"] == kind).map(|(n, _)| n).collect();
    names.sort();
    names.iter().find(|n| prefer.iter().any(|p| n.eq_ignore_ascii_case(p))).or(names.first()).map(|n| n.to_string())
}

// 검색 결과의 DB 하나 → 날짜 속성이 있으면 일정 DB
pub fn parse_db(v: &Value, account: &str) -> Option<Db> {
    let props = v["properties"].as_object()?;
    Some(Db {
        id: v["id"].as_str()?.to_string(),
        name: { let t = plain(&v["title"]); if t.is_empty() { "제목 없는 DB".into() } else { t } },
        account: account.to_string(),
        title_prop: pick_prop(props, "title", &[])?,
        date_prop: pick_prop(props, "date", &["날짜", "date", "일정", "마감", "due"])?,
        done_prop: pick_prop(props, "checkbox", &["완료", "done", "체크"]),
    })
}

pub fn parse_page(p: &Value, db: &Db, color: &str) -> Option<Event> {
    let props = &p["properties"];
    let date = &props[&db.date_prop]["date"];
    Some(Event {
        id: p["id"].as_str()?.to_string(),
        title: { let t = plain(&props[&db.title_prop]["title"]); if t.is_empty() { "(제목 없음)".into() } else { t } },
        start: date["start"].as_str()?.to_string(),
        end: date["end"].as_str().map(str::to_string),
        done: db.done_prop.as_ref().and_then(|d| props[d]["checkbox"].as_bool()),
        url: p["url"].as_str().unwrap_or_default().to_string(),
        account: db.account.clone(), color: color.to_string(), db: db.name.clone(), db_id: db.id.clone(),
    })
}

fn accounts_key(accts: &[NotionAccount]) -> String { accts.iter().map(|a| format!("{}:{}", a.name, a.token.len())).collect::<Vec<_>>().join(",") }

// 계정마다 공유된 일정 DB (10분 캐시). 실패한 계정은 오류 목록으로
pub async fn databases(accts: &[NotionAccount]) -> (Vec<Db>, Vec<String>) {
    let key = accounts_key(accts);
    if let Some((t, k, d)) = lock(&DBS).as_ref() { if *k == key && t.elapsed() < Duration::from_secs(600) { return (d.clone(), vec![]); } }
    let mut all = vec![];
    let mut errs = vec![];
    for a in accts.iter().filter(|a| !a.token.trim().is_empty()) {
        let body = json!({ "filter": { "property": "object", "value": "database" }, "page_size": 100 });
        match call(a.token.trim(), reqwest::Method::POST, "/search", Some(body)).await {
            Ok(v) => all.extend(v["results"].as_array().into_iter().flatten().filter_map(|d| parse_db(d, &a.name))
                .filter(|d| a.databases.is_empty() || a.databases.iter().any(|x| x.replace('-', "") == d.id.replace('-', "")))),
            Err(e) => errs.push(format!("{}: {e}", a.name)),
        }
    }
    if errs.is_empty() { *lock(&DBS) = Some((Instant::now(), key, all.clone())); }
    (all, errs)
}

// start~end(YYYY-MM-DD) 사이 일정. 두 계정 결과를 합쳐 시작 순으로 (1분 캐시)
pub async fn events(accts: &[NotionAccount], start: &str, end: &str) -> Result<(Vec<Event>, Vec<String>), String> {
    let key = format!("{}|{start}|{end}", accounts_key(accts));
    if let Some((t, k, e)) = lock(&EVENTS).as_ref() { if *k == key && t.elapsed() < Duration::from_secs(60) { return Ok((e.clone(), vec![])); } }
    let (dbs, mut errs) = databases(accts).await;
    let mut out = vec![];
    // 노션 날짜 필터는 시작일만 비교함 → 지난달에 시작해 이번 달까지 이어지는 일정이 빠지지 않게
    // 앞쪽을 넉넉히 넓혀 읽고, 끝나는 날(없으면 시작일)이 범위 안에 닿는 것만 남김
    let from = days_before(start, LOOKBACK_DAYS);
    for db in &dbs {
        let Some(a) = accts.iter().find(|a| a.name == db.account) else { continue };
        let filter = json!({ "and": [
            { "property": db.date_prop, "date": { "on_or_after": from } },
            { "property": db.date_prop, "date": { "on_or_before": end } } ] });
        let mut cursor: Option<String> = None;
        for _ in 0..5 { // 최대 500개
            let mut body = json!({ "filter": filter, "page_size": 100 });
            if let Some(c) = &cursor { body["start_cursor"] = json!(c); }
            match call(a.token.trim(), reqwest::Method::POST, &format!("/databases/{}/query", db.id), Some(body)).await {
                Ok(v) => {
                    out.extend(v["results"].as_array().into_iter().flatten().filter_map(|p| parse_page(p, db, &a.color)));
                    cursor = v["next_cursor"].as_str().map(str::to_string);
                    if !v["has_more"].as_bool().unwrap_or(false) || cursor.is_none() { break; }
                }
                Err(e) => { errs.push(format!("{} · {}: {e}", a.name, db.name)); break; }
            }
        }
    }
    out.retain(|e| reaches(e, start));
    out.sort_by(|a, b| a.start.cmp(&b.start).then(a.title.cmp(&b.title)));
    if errs.is_empty() { *lock(&EVENTS) = Some((Instant::now(), key, out.clone())); }
    if out.is_empty() && !errs.is_empty() { return Err(errs.join("\n")); }
    Ok((out, errs))
}

// 여러 날 일정이 이만큼 앞에서 시작했어도 보이게 (학기 단위 일정까지)
const LOOKBACK_DAYS: i64 = 120;

// 일정이 start 날짜 이후까지 이어지나 (끝나는 날이 없으면 시작일 기준)
fn reaches(e: &Event, start: &str) -> bool {
    let last = e.end.as_deref().unwrap_or(&e.start);
    last.get(..10).unwrap_or(last) >= start.get(..10).unwrap_or(start)
}

// "YYYY-MM-DD"에서 n일 전 (형식이 다르면 그대로)
fn days_before(d: &str, n: i64) -> String {
    let p: Vec<i64> = d.get(..10).unwrap_or(d).split('-').filter_map(|s| s.parse().ok()).collect();
    let [y, m, day] = p[..] else { return d.to_string() };
    // 그레고리력 날짜 ↔ 일수 (Howard Hinnant의 days_from_civil)
    let (y2, m2) = if m <= 2 { (y - 1, m + 9) } else { (y, m - 3) };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * m2 + 2) / 5 + day - 1;
    let z = era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - n;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let dd = doy - (153 * mp + 2) / 5 + 1;
    let mm = if mp < 10 { mp + 3 } else { mp - 9 };
    let yy = yoe + era * 400 + i64::from(mm <= 2);
    format!("{yy:04}-{mm:02}-{dd:02}")
}

#[cfg(test)]
mod range_tests {
    use super::*;
    fn ev(start: &str, end: Option<&str>) -> Event {
        Event { id: String::new(), title: String::new(), start: start.into(), end: end.map(Into::into), done: None, url: String::new(),
          account: String::new(), color: String::new(), db: String::new(), db_id: String::new() }
    }
    #[test]
    fn days_before_crosses_months_and_years() {
        assert_eq!(days_before("2026-11-29", 120), "2026-08-01");
        assert_eq!(days_before("2026-03-01", 1), "2026-02-28");
        assert_eq!(days_before("2024-03-01", 1), "2024-02-29");
        assert_eq!(days_before("2027-01-02", 5), "2026-12-28");
        assert_eq!(days_before("junk", 3), "junk");
    }
    #[test]
    fn keeps_events_that_run_into_the_range() {
        assert!(reaches(&ev("2026-11-28", Some("2026-12-17")), "2026-11-29")); // 지난달 시작, 이번 달까지
        assert!(reaches(&ev("2026-12-03T15:00:00.000+09:00", None), "2026-11-29"));
        assert!(!reaches(&ev("2026-11-20", Some("2026-11-25")), "2026-11-29")); // 범위 전에 끝남
        assert!(!reaches(&ev("2026-11-20", None), "2026-11-29"));
    }
}

fn token<'a>(accts: &'a [NotionAccount], account: &str) -> Result<&'a str, String> {
    accts.iter().find(|a| a.name == account).map(|a| a.token.trim()).filter(|t| !t.is_empty())
        .ok_or_else(|| format!("노션 계정 '{account}'의 토큰이 없어요"))
}

// 할 일 만들기: 고른 DB에 제목·날짜(필요하면 완료=false)로 페이지 생성
pub async fn create(accts: &[NotionAccount], db: &Db, title: &str, start: &str, end: Option<&str>) -> Result<(), String> {
    let mut props = json!({
        db.title_prop.clone(): { "title": [{ "text": { "content": title } }] },
        db.date_prop.clone(): { "date": { "start": start, "end": end } },
    });
    if let Some(d) = &db.done_prop { props[d] = json!({ "checkbox": false }); }
    call(token(accts, &db.account)?, reqwest::Method::POST, "/pages", Some(json!({ "parent": { "database_id": db.id }, "properties": props }))).await?;
    invalidate();
    Ok(())
}

pub async fn set_done(accts: &[NotionAccount], account: &str, page: &str, prop: &str, done: bool) -> Result<(), String> {
    call(token(accts, account)?, reqwest::Method::PATCH, &format!("/pages/{page}"), Some(json!({ "properties": { prop: { "checkbox": done } } }))).await?;
    invalidate();
    Ok(())
}

// 수정: 제목·날짜를 한 번에 (end가 있으면 기간)
pub async fn edit(accts: &[NotionAccount], account: &str, page: &str, db: &Db, title: &str, start: &str, end: Option<&str>) -> Result<(), String> {
    let props = json!({
        db.title_prop.clone(): { "title": [{ "text": { "content": title } }] },
        db.date_prop.clone(): { "date": { "start": start, "end": end } },
    });
    call(token(accts, account)?, reqwest::Method::PATCH, &format!("/pages/{page}"), Some(json!({ "properties": props }))).await?;
    invalidate();
    Ok(())
}

// 삭제 = 노션 휴지통으로 (restore=true면 되살리기)
pub async fn trash(accts: &[NotionAccount], account: &str, page: &str, restore: bool) -> Result<(), String> {
    call(token(accts, account)?, reqwest::Method::PATCH, &format!("/pages/{page}"), Some(json!({ "archived": !restore }))).await?;
    invalidate();
    Ok(())
}

// 화면에서 DB id로 DB 정보 찾기
pub async fn find_db(accts: &[NotionAccount], id: &str) -> Result<Db, String> {
    let (dbs, _) = databases(accts).await;
    dbs.into_iter().find(|d| d.id == id).ok_or_else(|| "그 DB를 찾을 수 없어요".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db_json() -> Value {
        json!({ "id": "db1", "title": [{ "plain_text": "할 일" }], "properties": {
            "이름": { "type": "title" }, "생성일": { "type": "date" }, "날짜": { "type": "date" }, "완료": { "type": "checkbox" } } })
    }

    #[test]
    fn db_picks_preferred_date_and_checkbox() {
        let d = parse_db(&db_json(), "개인").unwrap();
        assert_eq!((d.name.as_str(), d.title_prop.as_str(), d.date_prop.as_str(), d.done_prop.as_deref()), ("할 일", "이름", "날짜", Some("완료")));
        assert_eq!(d.account, "개인");
    }

    #[test]
    fn db_without_date_is_skipped() {
        let v = json!({ "id": "x", "title": [], "properties": { "이름": { "type": "title" } } });
        assert!(parse_db(&v, "a").is_none());
    }

    #[test]
    fn page_becomes_event() {
        let d = parse_db(&db_json(), "회사").unwrap();
        let p = json!({ "id": "p1", "url": "https://www.notion.so/p1", "properties": {
            "이름": { "title": [{ "plain_text": "회의" }] },
            "날짜": { "date": { "start": "2026-11-28T15:00:00.000+09:00", "end": null } },
            "완료": { "checkbox": true } } });
        let e = parse_page(&p, &d, "#f59e0b").unwrap();
        assert_eq!((e.title.as_str(), e.start.as_str(), e.done, e.account.as_str(), e.color.as_str()), ("회의", "2026-11-28T15:00:00.000+09:00", Some(true), "회사", "#f59e0b"));
        let empty = json!({ "id": "p2", "properties": { "이름": { "title": [] }, "날짜": { "date": null } } });
        assert!(parse_page(&empty, &d, "").is_none());
    }
}
