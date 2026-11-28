// TimeTree 일정 읽기 (읽기 전용). 공식 API가 없어서 웹 앱이 쓰는 비공식 API를 씀 (TimeTree-Exporter 참고)
// 로그인 → 캘린더 목록 → 캘린더마다 일정 전체(events/sync). 막히지 않게 요청을 최소로:
// - 받은 결과·마지막 시도 시각·실패 횟수를 timetree.json에 저장 → 앱을 다시 켜도 다시 받지 않음
// - 자동으로는 하루에 한 번만. ⌘R 새로고침은 TimeTree를 건드리지 않음
// - "TimeTree 지금 다시 받기"는 1시간에 한 번까지
// - 실패하면 1→2→4…시간 뒤에 다시(최대 하루), 비밀번호 오류·로그인 제한이면 하루 뒤에
// - 요청 사이에 1초씩 쉼
use crate::config::TimetreeAccount;
use crate::notion::Event;
use chrono::{DateTime, Datelike, Duration as Days, Local, NaiveDate, NaiveDateTime, TimeZone, Utc, Weekday};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{path::Path, sync::{Mutex, OnceLock}, time::{Duration, SystemTime, UNIX_EPOCH}};

const API: &str = "https://timetreeapp.com/api/v1";
const AGENT: &str = "web/2.1.0/en"; // X-Timetreea 헤더 값 (웹 앱과 같게)
const DAY: u64 = 86_400; // 자동으로 다시 받는 간격
const MANUAL_GAP: u64 = 3_600; // 직접 다시 받기는 1시간에 한 번까지
const PAUSE: Duration = Duration::from_secs(1); // 요청 사이 쉬는 시간

// TimeTree에서 받은 일정 하나 (반복 규칙 그대로, 화면에 보낼 때 기간에 맞게 펼침)
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Raw {
    pub id: String, pub title: String, pub all_day: bool,
    pub start: i64, pub end: i64, // 밀리초
    pub tz: String, pub rules: Vec<String>, // "RRULE:…", "EXDATE:…"
    pub account: String, pub color: String, pub calendar: String, pub calendar_id: String, pub url: String,
}

// fetched: 마지막으로 다 받은 시각, tried: 마지막 시도 시각, fails: 연달아 실패한 횟수, hard: 비밀번호 오류·로그인 제한
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(default)]
struct Store { fetched: u64, key: String, events: Vec<Raw>, tried: u64, fails: u32, hard: bool, error: String }

static STORE: Mutex<Option<Store>> = Mutex::new(None);
static GATE: OnceLock<tauri::async_runtime::Mutex<()>> = OnceLock::new(); // 화면 여러 개가 동시에 불러도 한 번만 받기

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> { m.lock().unwrap_or_else(std::sync::PoisonError::into_inner) }
fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) }
fn active(accts: &[TimetreeAccount]) -> impl Iterator<Item = &TimetreeAccount> { accts.iter().filter(|a| !a.email.trim().is_empty() && !a.password.is_empty()) }
pub fn configured(accts: &[TimetreeAccount]) -> bool { active(accts).next().is_some() }
// 어떤 계정·캘린더를 받는지가 바뀌면 새로 받음 (색은 화면에 보낼 때 입히므로 넣지 않음, 비밀번호도 넣지 않음)
fn key(accts: &[TimetreeAccount]) -> String {
    active(accts).map(|a| format!("{}:{}:{}", a.name, a.email.trim(), a.calendars.join("|"))).collect::<Vec<_>>().join(",")
}
// 이전 형식(색 포함) 저장본도 그대로 쓰기 (업데이트 때문에 다시 받지 않게)
fn old_key(accts: &[TimetreeAccount]) -> String {
    active(accts).map(|a| format!("{}:{}:{}:{}", a.name, a.email.trim(), a.color, a.calendars.join("|"))).collect::<Vec<_>>().join(",")
}

fn load_store(path: &Path) -> Option<Store> {
    let mut m = lock(&STORE);
    if m.is_none() { *m = std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()); }
    m.clone()
}
fn save_store(path: &Path, s: &Store) {
    if let Some(b) = crate::log::warn("TimeTree 저장본 직렬화", serde_json::to_vec(s)) { crate::log::warn("TimeTree 저장본 쓰기", std::fs::write(path, b)); }
    *lock(&STORE) = Some(s.clone());
}

// 실패 뒤 기다리는 시간: 1, 2, 4, 8, 16시간 … 최대 하루. 비밀번호 오류·로그인 제한은 바로 하루
fn backoff(fails: u32, hard: bool) -> u64 {
    if hard { return DAY; }
    (3_600u64 << fails.saturating_sub(1).min(5)).min(DAY)
}

// 지금 TimeTree에 요청해도 되나
fn due(s: &Store, now: u64, force: bool) -> bool {
    let since_try = now.saturating_sub(s.tried);
    if force { return since_try >= MANUAL_GAP; }
    if s.fails > 0 { return since_try >= backoff(s.fails, s.hard); }
    now.saturating_sub(s.fetched) >= DAY
}

// 받기 (due일 때만). 결과·시도 기록을 저장. 돌려주는 값: 이번에 요청했나
async fn sync(accts: &[TimetreeAccount], path: &Path, force: bool) -> (Store, bool) {
    let _g = GATE.get_or_init(|| tauri::async_runtime::Mutex::new(())).lock().await;
    let k = key(accts);
    let mut s = load_store(path).filter(|s| s.key == k || s.key == old_key(accts)).unwrap_or_default();
    if !due(&s, now(), force) { return (s, false); }
    s.key = k;
    s.tried = now();
    let (fresh, err) = fetch_all(accts, &s.events).await;
    s.events = fresh;
    match err {
        None => { s.fetched = now(); s.fails = 0; s.hard = false; s.error.clear(); }
        Some((e, hard)) => { s.fails += 1; s.hard = hard; s.error = e; }
    }
    save_store(path, &s);
    (s, true)
}

// start~end(YYYY-MM-DD)에 닿는 TimeTree 일정. 하루가 지났을 때만 새로 받고, 아니면 저장본
pub async fn events(accts: &[TimetreeAccount], path: &Path, start: &str, end: &str) -> (Vec<Event>, Vec<String>) {
    if !configured(accts) { return (vec![], vec![]); }
    let (s, _) = sync(accts, path, false).await;
    let errs = if s.error.is_empty() { vec![] } else { vec![format!("{} · 다음 자동 시도: {}시간 뒤", s.error, backoff(s.fails, s.hard).saturating_sub(now().saturating_sub(s.tried)).div_ceil(3_600))] };
    // 색은 지금 설정 값으로
    let raws: Vec<Raw> = s.events.into_iter().map(|mut r| {
        if let Some(a) = accts.iter().find(|a| a.name == r.account) { r.color = a.color.clone(); }
        r
    }).collect();
    (expand(&raws, start, end), errs)
}

// "TimeTree 지금 다시 받기": 1시간에 한 번까지. 결과를 한 줄로
pub async fn refresh(accts: &[TimetreeAccount], path: &Path) -> String {
    if !configured(accts) { return "TimeTree 계정이 설정되지 않았어요".into(); }
    let (s, asked) = sync(accts, path, true).await;
    if !asked {
        let wait = MANUAL_GAP.saturating_sub(now().saturating_sub(s.tried)).div_ceil(60);
        return format!("TimeTree는 막히지 않게 1시간에 한 번만 다시 받아요 ({wait}분 뒤 가능)");
    }
    if s.error.is_empty() { format!("✓ TimeTree 일정 {}개 받음", s.events.len()) } else { format!("TimeTree 받기 실패: {}", s.error) }
}

// 계정마다 받기. 실패한 계정은 이전 저장본을 그대로 씀. 오류는 (내용, 하루 쉴 오류인가)
async fn fetch_all(accts: &[TimetreeAccount], old: &[Raw]) -> (Vec<Raw>, Option<(String, bool)>) {
    // User-Agent가 없으면 로그인이 -401로 거부됨
    let c = reqwest::Client::builder().user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)").build().unwrap_or_default();
    let (mut out, mut errs, mut hard) = (vec![], vec![], false);
    for a in active(accts) {
        match fetch_account(&c, a).await {
            Ok(v) => out.extend(v),
            Err((e, h)) => {
                hard |= h;
                errs.push(format!("TimeTree {}: {e}", a.name));
                out.extend(old.iter().filter(|r| r.account == a.name).cloned());
            }
        }
    }
    (out, (!errs.is_empty()).then(|| (errs.join(" · "), hard)))
}

async fn fetch_account(c: &reqwest::Client, a: &TimetreeAccount) -> Result<Vec<Raw>, (String, bool)> {
    let session = login(c, a).await?;
    let soft = |e: String| (e, false);
    tokio::time::sleep(PAUSE).await;
    let cals = get(c, &session, "/calendars?since=0").await.map_err(soft)?;
    let mut out = vec![];
    for cal in cals["calendars"].as_array().into_iter().flatten() {
        let id = match &cal["id"] { Value::String(s) => s.clone(), Value::Number(n) => n.to_string(), _ => continue };
        let name = cal["name"].as_str().unwrap_or("TimeTree").to_string();
        if !a.calendars.is_empty() && !a.calendars.iter().any(|x| x.trim() == name || x.trim() == id) { continue; }
        let url = format!("https://timetreeapp.com/calendars/{}", cal["alias_code"].as_str().unwrap_or(&id));
        let mut path = format!("/calendar/{id}/events/sync");
        for _ in 0..50 { // 묶음(chunk)으로 나눠 옴
            tokio::time::sleep(PAUSE).await;
            let v = get(c, &session, &path).await.map_err(soft)?;
            out.extend(v["events"].as_array().into_iter().flatten().filter_map(|e| parse_event(e, a, &name, &id, &url)));
            match (v["chunk"].as_bool(), v["since"].as_i64()) {
                (Some(true), Some(s)) => path = format!("/calendar/{id}/events/sync?since={s}"),
                _ => break,
            }
        }
    }
    Ok(out)
}

// 로그인할 때 보내는 기기 id (32자리 16진수, 매번 새로)
fn device_id() -> String {
    use std::hash::{BuildHasher, Hasher};
    let s = std::collections::hash_map::RandomState::new();
    let t = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    (0..2u128).map(|i| { let mut h = s.build_hasher(); h.write_u128(t + i); format!("{:016x}", h.finish()) }).collect()
}

async fn login(c: &reqwest::Client, a: &TimetreeAccount) -> Result<String, (String, bool)> {
    let r = c.put(format!("{API}/auth/email/signin")).header("X-Timetreea", AGENT).timeout(Duration::from_secs(15))
        .json(&json!({ "uid": a.email.trim(), "password": a.password, "uuid": device_id() }))
        .send().await.map_err(|e| (format!("연결 실패 ({e})"), false))?;
    let status = r.status();
    let session = r.headers().get_all(reqwest::header::SET_COOKIE).iter().filter_map(|v| v.to_str().ok())
        .find_map(|v| v.strip_prefix("_session_id=").map(|s| s.split(';').next().unwrap_or("").to_string()));
    if !status.is_success() {
        let body = r.text().await.unwrap_or_default();
        let v: Value = serde_json::from_str(&body).unwrap_or_default();
        return Err(match v["error"]["code"].as_i64() {
            Some(-702) => ("이메일 또는 비밀번호가 맞지 않아요 (계정 잠김을 막으려고 하루 동안 다시 시도하지 않아요)".into(), true),
            Some(-495) => ("로그인 시도가 너무 많아 막혔어요 (하루 동안 다시 시도하지 않아요)".into(), true),
            _ => (format!("로그인 실패 ({status})"), false),
        });
    }
    session.filter(|s| !s.is_empty()).ok_or_else(|| ("로그인 응답에 세션이 없어요".into(), false))
}

async fn get(c: &reqwest::Client, session: &str, path: &str) -> Result<Value, String> {
    let r = c.get(format!("{API}{path}")).header("X-Timetreea", AGENT).header("Content-Type", "application/json")
        .header(reqwest::header::COOKIE, format!("_session_id={session}")).timeout(Duration::from_secs(30))
        .send().await.map_err(|e| format!("연결 실패 ({e})"))?;
    if !r.status().is_success() { return Err(format!("일정 읽기 실패 ({})", r.status())); }
    r.json().await.map_err(|e| format!("응답 형식 오류 ({e})"))
}

// 생일(type 1)·메모(category 2)는 날짜 일정이 아니라서 뺌
pub fn parse_event(e: &Value, a: &TimetreeAccount, calendar: &str, calendar_id: &str, url: &str) -> Option<Raw> {
    if e["type"].as_i64() == Some(1) || e["category"].as_i64() == Some(2) { return None; }
    let start = e["start_at"].as_i64()?;
    Some(Raw {
        id: e["uuid"].as_str().or(e["id"].as_str())?.to_string(),
        title: e["title"].as_str().unwrap_or("").trim().to_string(),
        all_day: e["all_day"].as_bool().unwrap_or(false),
        start, end: e["end_at"].as_i64().unwrap_or(start).max(start),
        tz: e["start_timezone"].as_str().unwrap_or("UTC").to_string(),
        rules: e["recurrences"].as_array().into_iter().flatten().filter_map(|r| r.as_str().map(str::to_string)).collect(),
        account: a.name.clone(), color: a.color.clone(), calendar: calendar.into(), calendar_id: calendar_id.into(), url: url.into(),
    })
}

// 밀리초 → 이 Mac 시간대의 날짜·시각. 하루 종일 일정은 UTC 자정으로 오는 경우가 많아 UTC로 읽음
fn local(ms: i64, all_day: bool, tz: &str) -> Option<NaiveDateTime> {
    let utc = DateTime::<Utc>::from_timestamp_millis(ms)?;
    Some(if all_day && (tz.is_empty() || tz == "UTC") { utc.naive_utc() } else { utc.with_timezone(&Local).naive_local() })
}

// "20261201", "20261201T010000Z" → 이 Mac 날짜
fn rule_date(s: &str) -> Option<NaiveDate> {
    let s = s.trim();
    if s.len() >= 16 && s.ends_with('Z') {
        let t = NaiveDateTime::parse_from_str(&s[..15], "%Y%m%dT%H%M%S").ok()?;
        return Some(Utc.from_utc_datetime(&t).with_timezone(&Local).date_naive());
    }
    NaiveDate::parse_from_str(s.get(..8)?, "%Y%m%d").ok()
}

fn weekday(s: &str) -> Option<Weekday> {
    Some(match s { "MO" => Weekday::Mon, "TU" => Weekday::Tue, "WE" => Weekday::Wed, "TH" => Weekday::Thu, "FR" => Weekday::Fri, "SA" => Weekday::Sat, "SU" => Weekday::Sun, _ => return None })
}

// 그 달의 n번째(음수면 뒤에서) 요일
fn nth_weekday(y: i32, m: u32, n: i32, w: Weekday) -> Option<NaiveDate> {
    if n > 0 { return NaiveDate::from_weekday_of_month_opt(y, m, w, n as u8); }
    let last = NaiveDate::from_ymd_opt(y + i32::from(m == 12), if m == 12 { 1 } else { m + 1 }, 1)?.pred_opt()?;
    let back = (7 + last.weekday().num_days_from_monday() - w.num_days_from_monday()) % 7;
    let d = last - Days::days(i64::from(back) + 7 * i64::from(-n - 1));
    (d.month() == m).then_some(d)
}

fn add_months(y: i32, m: u32, n: i64) -> (i32, u32) {
    let t = i64::from(y) * 12 + i64::from(m) - 1 + n;
    (t.div_euclid(12) as i32, t.rem_euclid(12) as u32 + 1)
}

// 반복 일정의 시작 날짜들 (first부터, last 이하). 지원: FREQ DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, COUNT, UNTIL, BYDAY, BYMONTHDAY, EXDATE
pub fn occurrences(first: NaiveDate, rules: &[String], last: NaiveDate) -> Vec<NaiveDate> {
    let Some(rrule) = rules.iter().find_map(|r| r.strip_prefix("RRULE:")) else { return vec![first] };
    let mut freq = ""; let mut interval = 1i64; let mut count: Option<usize> = None; let mut until: Option<NaiveDate> = None;
    let mut byday: Vec<(i32, Weekday)> = vec![]; let mut bymonthday: Vec<i32> = vec![];
    for part in rrule.split(';') {
        let (k, v) = part.split_once('=').unwrap_or((part, ""));
        match k {
            "FREQ" => freq = v,
            "INTERVAL" => interval = v.parse().unwrap_or(1).max(1),
            "COUNT" => count = v.parse().ok(),
            "UNTIL" => until = rule_date(v),
            "BYDAY" => byday = v.split(',').filter_map(|d| { let (n, w) = d.split_at(d.len().saturating_sub(2)); Some((n.parse().unwrap_or(0), weekday(w)?)) }).collect(),
            "BYMONTHDAY" => bymonthday = v.split(',').filter_map(|d| d.parse().ok()).collect(),
            _ => {}
        }
    }
    let ex: Vec<NaiveDate> = rules.iter().filter_map(|r| r.strip_prefix("EXDATE").and_then(|r| r.split_once(':')))
        .flat_map(|(_, v)| v.split(',').filter_map(rule_date).collect::<Vec<_>>()).collect();
    let stop = until.map_or(last, |u| u.min(last));
    let mut out = vec![]; let mut n = 0usize;
    // 한 주기(일·주·달·해)씩 넘기며 그 주기 안의 날짜를 차례로
    for k in 0..20_000i64 {
        let step = k * interval;
        let mut days: Vec<NaiveDate> = match freq {
            "DAILY" => vec![first + Days::days(step)],
            "WEEKLY" => {
                let monday = first - Days::days(i64::from(first.weekday().num_days_from_monday())) + Days::weeks(step);
                let ws: Vec<Weekday> = if byday.is_empty() { vec![first.weekday()] } else { byday.iter().map(|b| b.1).collect() };
                ws.iter().map(|w| monday + Days::days(i64::from(w.num_days_from_monday()))).collect()
            }
            "MONTHLY" => {
                let (y, m) = add_months(first.year(), first.month(), step);
                if !byday.is_empty() { byday.iter().filter_map(|&(i, w)| nth_weekday(y, m, if i == 0 { 1 } else { i }, w)).collect() }
                else if !bymonthday.is_empty() { bymonthday.iter().filter_map(|&d| if d > 0 { NaiveDate::from_ymd_opt(y, m, d as u32) } else { nth_last_day(y, m, -d) }).collect() }
                else { NaiveDate::from_ymd_opt(y, m, first.day()).into_iter().collect() }
            }
            "YEARLY" => NaiveDate::from_ymd_opt(first.year() + step as i32, first.month(), first.day()).into_iter().collect(),
            _ => return vec![first],
        };
        days.sort();
        if days.first().is_some_and(|d| *d > stop) { break; }
        for d in days.into_iter().filter(|d| *d >= first) {
            if d > stop || count.is_some_and(|c| n >= c) { return out; }
            n += 1;
            if !ex.contains(&d) { out.push(d); }
        }
    }
    out
}

fn nth_last_day(y: i32, m: u32, n: i32) -> Option<NaiveDate> {
    let (ny, nm) = add_months(y, m, 1);
    let d = NaiveDate::from_ymd_opt(ny, nm, 1)? - Days::days(i64::from(n));
    (d.month() == m).then_some(d)
}

fn fmt(t: NaiveDateTime, all_day: bool) -> String {
    if all_day { return t.format("%Y-%m-%d").to_string(); }
    match Local.from_local_datetime(&t).earliest() {
        Some(d) => d.format("%Y-%m-%dT%H:%M:%S%.3f%:z").to_string(),
        None => t.format("%Y-%m-%dT%H:%M:%S%.3f").to_string(),
    }
}

// 저장본 → start~end에 닿는 일정 (반복은 펼침). 노션 일정과 같은 모양, done은 None(읽기 전용)
pub fn expand(raws: &[Raw], start: &str, end: &str) -> Vec<Event> {
    let (Ok(from), Ok(to)) = (NaiveDate::parse_from_str(start.get(..10).unwrap_or(start), "%Y-%m-%d"), NaiveDate::parse_from_str(end.get(..10).unwrap_or(end), "%Y-%m-%d")) else { return vec![] };
    let mut out = vec![];
    for r in raws {
        let (Some(s), Some(e)) = (local(r.start, r.all_day, &r.tz), local(r.end, r.all_day, &r.tz)) else { continue };
        let len = e - s;
        let repeat = r.rules.iter().any(|x| x.starts_with("RRULE:"));
        for d in occurrences(s.date(), &r.rules, to) {
            let os = d.and_time(s.time());
            let oe = os + len;
            if oe.date() < from || os.date() > to { continue; }
            let end = if r.all_day { (oe.date() != os.date()).then(|| fmt(oe, true)) } else { (oe != os).then(|| fmt(oe, false)) };
            out.push(Event {
                id: if repeat { format!("{}:{d}", r.id) } else { r.id.clone() },
                title: if r.title.is_empty() { "(제목 없음)".into() } else { r.title.clone() },
                start: fmt(os, r.all_day), end, done: None, url: r.url.clone(),
                account: r.account.clone(), color: r.color.clone(), db: r.calendar.clone(), db_id: format!("timetree:{}", r.calendar_id),
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    fn d(s: &str) -> NaiveDate { NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap() }
    fn rules(r: &[&str]) -> Vec<String> { r.iter().map(|s| s.to_string()).collect() }
    fn acct() -> TimetreeAccount { TimetreeAccount { name: "가족".into(), color: "#f80".into(), ..Default::default() } }

    #[test]
    fn birthdays_and_memos_are_skipped() {
        let base = json!({ "uuid": "a", "title": "x", "start_at": 0, "end_at": 0 });
        assert!(parse_event(&base, &acct(), "c", "1", "u").is_some());
        let mut b = base.clone(); b["type"] = json!(1);
        assert!(parse_event(&b, &acct(), "c", "1", "u").is_none());
        let mut m = base.clone(); m["category"] = json!(2);
        assert!(parse_event(&m, &acct(), "c", "1", "u").is_none());
    }

    #[test]
    fn all_day_event_becomes_dates() {
        // 2026-12-01 ~ 2026-12-03 하루 종일 (UTC 자정)
        let e = json!({ "uuid": "a", "title": "여행", "all_day": true, "start_at": 1_796_083_200_000i64, "end_at": 1_796_256_000_000i64, "start_timezone": "UTC" });
        let r = parse_event(&e, &acct(), "우리집", "7", "https://timetreeapp.com/calendars/x").unwrap();
        let ev = expand(&[r], "2026-11-01", "2026-12-31");
        assert_eq!(ev.len(), 1);
        assert_eq!((ev[0].start.as_str(), ev[0].end.as_deref()), ("2026-12-01", Some("2026-12-03")));
        assert_eq!((ev[0].done, ev[0].db.as_str(), ev[0].db_id.as_str()), (None, "우리집", "timetree:7"));
        assert!(expand(&ev_raw(), "2027-01-01", "2027-01-31").is_empty());
        assert!(expand(&ev_raw(), "2026-11-01", "2026-11-30").is_empty()); // 범위 뒤 일정도 빠짐
    }
    fn ev_raw() -> Vec<Raw> {
        vec![parse_event(&json!({ "uuid": "a", "title": "t", "all_day": true, "start_at": 1_796_083_200_000i64, "end_at": 1_796_083_200_000i64 }), &acct(), "c", "1", "u").unwrap()]
    }

    #[test]
    fn weekly_byday_with_count_and_exdate() {
        // 2026-11-02(월)부터 월·수, 5번, 11/4 제외
        let got = occurrences(d("2026-11-02"), &rules(&["RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=5", "EXDATE:20261104"]), d("2026-12-31"));
        assert_eq!(got, vec![d("2026-11-02"), d("2026-11-09"), d("2026-11-11"), d("2026-11-16")]);
    }

    #[test]
    fn monthly_and_yearly_and_until() {
        assert_eq!(occurrences(d("2026-01-31"), &rules(&["RRULE:FREQ=MONTHLY;UNTIL=20260430"]), d("2026-12-31")), vec![d("2026-01-31"), d("2026-03-31")]);
        assert_eq!(occurrences(d("2026-11-10"), &rules(&["RRULE:FREQ=MONTHLY;BYDAY=-1FR"]), d("2027-01-31")), vec![d("2026-11-27"), d("2026-12-25"), d("2027-01-29")]);
        assert_eq!(occurrences(d("2024-03-01"), &rules(&["RRULE:FREQ=YEARLY;INTERVAL=2"]), d("2028-12-31")), vec![d("2024-03-01"), d("2026-03-01"), d("2028-03-01")]);
        assert_eq!(occurrences(d("2026-11-28"), &rules(&["RRULE:FREQ=DAILY;INTERVAL=3"]), d("2026-12-05")), vec![d("2026-11-28"), d("2026-12-01"), d("2026-12-04")]);
    }

    #[test]
    fn repeats_get_unique_ids_inside_range() {
        let r = Raw { id: "r".into(), title: "운동".into(), all_day: true, start: 1_796_083_200_000, end: 1_796_083_200_000, tz: "UTC".into(),
            rules: rules(&["RRULE:FREQ=DAILY"]), account: "a".into(), color: "".into(), calendar: "c".into(), calendar_id: "1".into(), url: "u".into() };
        let ev = expand(&[r], "2026-12-03", "2026-12-04");
        assert_eq!(ev.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), vec!["r:2026-12-03", "r:2026-12-04"]);
    }

    #[test]
    fn asks_timetree_rarely() {
        let t = 10 * DAY;
        let ok = Store { fetched: t - 3_600, tried: t - 3_600, ..Default::default() };
        assert!(!due(&ok, t, false)); // 한 시간 전에 받음 → 자동 X
        assert!(due(&ok, t - 3_600 + DAY, false)); // 하루 지남 → 자동 O
        assert!(due(&ok, t, true)); // 직접: 1시간 지났으면 O
        assert!(!due(&Store { tried: t - 600, ..ok.clone() }, t, true)); // 10분 전 → 직접도 X
        assert!(due(&Store::default(), t, false)); // 처음 → O
        let failed = Store { tried: t - 3_000, fails: 1, ..ok.clone() };
        assert!(!due(&failed, t, false) && due(&failed, t + 600, false)); // 1번 실패 → 1시간 뒤
        assert_eq!((backoff(2, false), backoff(3, false), backoff(9, false)), (7_200, 14_400, DAY));
        let locked = Store { tried: t - 7 * 3_600, fails: 1, hard: true, ..ok };
        assert!(!due(&locked, t, false)); // 비밀번호 오류 → 하루
    }
}
