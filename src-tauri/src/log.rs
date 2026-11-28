// 로그 파일: ~/Library/Logs/Baro/baro.log
// 실패 메시지와 패닉(어디서 왜 죽었는지)을 남겨, 앱이 꺼지거나 기능이 안 될 때 원인을 볼 수 있게 함
use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

const MAX: u64 = 1024 * 1024; // 1MB를 넘으면 baro.log.1로 돌림

pub fn path() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join("Library/Logs/Baro/baro.log"))
}

// UTC 시각 "2026-11-27 03:04:05Z"
fn stamp() -> String {
    let s = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) as i64;
    let (days, rem) = (s.div_euclid(86_400), s.rem_euclid(86_400));
    // 1970-01-01부터의 일수 → 연·월·일 (Howard Hinnant의 civil_from_days)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

// 한 줄 기록 (실패해도 앱 동작에는 영향 없음). 개발 중에는 터미널에도 출력
pub fn write(msg: &str) {
    eprintln!("{msg}");
    let Some(p) = path() else { return };
    if let Some(dir) = p.parent() { let _ = std::fs::create_dir_all(dir); }
    if std::fs::metadata(&p).map(|m| m.len() > MAX).unwrap_or(false) {
        let _ = std::fs::rename(&p, p.with_extension("log.1"));
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        let _ = writeln!(f, "{} {msg}", stamp());
    }
}

// 실패한 결과의 원인을 "무엇을 하다가: 이유"로 남기고 Ok 값만 돌려줌 (비밀 값이 든 오류는 넘기지 말 것)
pub fn warn<T, E: std::fmt::Display>(what: &str, r: Result<T, E>) -> Option<T> {
    match r {
        Ok(v) => Some(v),
        Err(e) => { write(&format!("실패 {what}: {e}")); None }
    }
}

// 패닉이 나면 위치와 메시지를 로그 파일에 남김 (기본 출력도 그대로 유지)
pub fn init() {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let at = info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_default();
        let msg = info.payload().downcast_ref::<&str>().map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_default();
        write(&format!("PANIC {at}: {msg}"));
        prev(info);
    }));
    write(&format!("시작 v{}", env!("CARGO_PKG_VERSION")));
}

#[cfg(test)]
mod tests {
    #[test]
    fn stamp_looks_like_utc_time() {
        let s = super::stamp();
        assert_eq!(s.len(), 20, "{s}");
        assert!(s.starts_with("20") && s.ends_with('Z'), "{s}");
    }
}
