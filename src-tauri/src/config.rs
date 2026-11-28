// 사용자 설정 파일 (~/Library/Application Support/dev.hmc.baro/config.json)
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Serialize, Deserialize, Clone)]
pub struct Quicklink { pub keyword: String, pub name: String, pub url: String }

#[derive(Serialize, Deserialize, Clone)]
pub struct Snippet { pub keyword: String, pub name: String, pub text: String }

// 사용자가 만드는 노트 검색: Obsidian 폴더 하나를 정해진 방식으로 검색
// kind: "commands"(명령어 사전) | "notes"(일반 노트) | "snippets"(스니펫 모음) | "passwords"(비밀번호 모음: 머리말 password) | "curriculum"(커리큘럼: 머리말 status·week + 체크박스 진도)
#[derive(Serialize, Deserialize, Clone)]
pub struct NoteSearch { pub id: String, pub name: String, pub dir: String, pub kind: String }

pub const NOTE_KINDS: &[&str] = &["commands", "notes", "snippets", "passwords", "curriculum", "write"];

// 노션 계정: 내부 통합 토큰(notion.so/my-integrations)과 캘린더 색. databases가 비면 통합에 연결된 날짜 DB 전부
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default)]
pub struct NotionAccount { pub name: String, pub token: String, pub color: String, pub databases: Vec<String> }

// TimeTree 계정 (읽기 전용): 이메일·비밀번호로 로그인해 일정을 하루 한 번 받아옴. calendars가 비면 모든 캘린더 (이름 또는 id)
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default)]
pub struct TimetreeAccount { pub name: String, pub email: String, pub password: String, pub color: String, pub calendars: Vec<String> }

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct Config {
    // "ollama"(내 Mac에서 무료 실행) 또는 "claude"(API 키 필요)
    pub ai_provider: String,
    pub ollama_url: String,
    pub ollama_model: String,
    pub anthropic_api_key: String,
    pub ai_model: String,
    pub quicklinks: Vec<Quicklink>,
    pub snippets: Vec<Snippet>,
    // 확장 스토어 목록(index.json) 주소. https:// 또는 file://
    pub store_url: String,
    // 노트 검색 목록 (Baro의 "노트 검색 관리"에서 추가·수정)
    pub note_searches: Vec<NoteSearch>,
    // 기능별 전역 단축키 (예: "Alt+Space"). 노트 검색은 "note:<id>". 빈 값이면 사용 안 함
    pub hotkeys: BTreeMap<String, String>,
    // AI 답변을 Obsidian 노트로 저장할 폴더 (AI 화면에서 ⌘S)
    pub ai_save_dir: String,
    // 전체 노트 그래프로 볼 Obsidian Vault 폴더
    pub vault_dir: String,
    // 클립보드 기록 (복사한 글 최근 200개, 비밀번호·키처럼 보이는 글은 제외)
    pub clipboard_history: bool,
    // 스니펫 자동 확장: 어느 앱에서든 ";키워드" 입력 → 본문 (입력 모니터링 권한 필요, 기본 꺼짐)
    pub snippet_expand: bool,
    // 캘린더·할 일: 노션 계정 여러 개의 일정 DB를 합쳐 보기
    pub notion_accounts: Vec<NotionAccount>,
    // 캘린더: TimeTree 일정도 함께 보기 (읽기 전용)
    pub timetree_accounts: Vec<TimetreeAccount>,
}

// 고정 기능의 단축키 기본값
pub const HOTKEY_ACTIONS: &[(&str, &str)] = &[("baro", "Alt+Space"), ("ai", ""), ("store", ""), ("graph", ""), ("files", ""), ("memo", ""), ("clipboard", ""), ("calendar", "")];

fn ql(k: &str, n: &str, u: &str) -> Quicklink { Quicklink { keyword: k.into(), name: n.into(), url: u.into() } }
fn sn(k: &str, n: &str, t: &str) -> Snippet { Snippet { keyword: k.into(), name: n.into(), text: t.into() } }

impl Default for Config {
    fn default() -> Self {
        Config {
            ai_provider: "ollama".into(),
            ollama_url: "http://localhost:11434".into(),
            ollama_model: "qwen3.5:9b".into(),
            anthropic_api_key: String::new(),
            ai_model: "claude-opus-5-5".into(),
            quicklinks: vec![
                ql("yt", "YouTube 검색", "https://www.youtube.com/results?search_query={query}"),
                ql("nv", "네이버 검색", "https://search.naver.com/search.naver?query={query}"),
                ql("gh", "GitHub 검색", "https://github.com/search?q={query}"),
                ql("map", "네이버 지도 검색", "https://map.naver.com/p/search/{query}"),
            ],
            snippets: vec![
                sn("today", "오늘 날짜", "{date}"),
                sn("thx", "감사 인사", "확인 감사합니다. 좋은 하루 보내세요!"),
            ],
            store_url: String::new(),
            note_searches: vec![NoteSearch {
                id: "linux".into(), name: "리눅스 명령어 검색".into(), kind: "commands".into(),
                dir: "/Volumes/Disk/MyBrain/02_Knowledge/Linux/01_명령어".into(),
            }],
            hotkeys: [("note:linux", "Alt+L")].iter().map(|(a, k)| (a.to_string(), k.to_string())).collect(),
            ai_save_dir: "/Volumes/Disk/MyBrain/00_Inbox/AI".into(),
            vault_dir: "/Volumes/Disk/MyBrain".into(),
            clipboard_history: true,
            snippet_expand: false,
            notion_accounts: vec![],
            timetree_accounts: vec![],
        }
    }
}

// 파일이 없으면 기본값으로 만들고, 형식이 잘못됐으면 덮어쓰지 않고 오류를 돌려줌
pub fn load(path: &Path) -> Result<Config, String> {
    match std::fs::read(path) {
        Ok(b) => serde_json::from_slice(&b).map_err(|e| format!("설정 파일 형식 오류: {e}")),
        Err(_) => {
            let c = Config::default();
            if let Some(dir) = path.parent() { crate::log::warn("설정 폴더 만들기", std::fs::create_dir_all(dir)); }
            if let Some(b) = crate::log::warn("기본 설정 직렬화", serde_json::to_vec_pretty(&c)) { crate::log::warn("기본 설정 파일 만들기", std::fs::write(path, b)); }
            Ok(c)
        }
    }
}

pub fn save(path: &Path, c: &Config) -> Result<(), String> {
    // 직렬화에 실패해도 빈 파일로 덮어쓰지 않음
    let b = serde_json::to_vec_pretty(c).map_err(|e| format!("설정을 저장하지 못했어요: {e}"))?;
    std::fs::write(path, b).map_err(|e| e.to_string())
}

// 지금 있는 기능(고정 기능 + 노트 검색 + 검색어 없는 퀵링크)의 단축키. 저장된 값이 없으면 기본값
pub fn hotkeys(c: &Config) -> BTreeMap<String, String> {
    let fixed = HOTKEY_ACTIONS.iter().map(|(a, k)| (a.to_string(), k.to_string()));
    let notes = c.note_searches.iter().map(|n| (format!("note:{}", n.id), String::new()));
    let links = c.quicklinks.iter().filter(|l| !l.url.contains("{query}")).map(|l| (format!("link:{}", l.keyword), String::new()));
    fixed.chain(notes).chain(links)
        .map(|(a, k)| {
            let v = c.hotkeys.get(&a).cloned()
                .or_else(|| (a == "note:linux").then(|| c.hotkeys.get("linux_wiki").cloned().unwrap_or_else(|| "Alt+L".into())));
            (a, v.unwrap_or(k))
        })
        .collect()
}

// 화면에 넘기는 설정 (API 키는 제외)
#[derive(Serialize)]
pub struct PublicConfig {
    pub ai_ready: bool,
    pub ai_model: String,
    pub quicklinks: Vec<Quicklink>,
    pub snippets: Vec<Snippet>,
    pub store_ready: bool,
    pub note_searches: Vec<NoteSearch>,
    pub notion_accounts: usize, // 토큰을 넣은 노션 계정 수 (토큰은 화면에 넘기지 않음)
    pub timetree_accounts: usize, // 이메일·비밀번호를 넣은 TimeTree 계정 수
    pub error: Option<String>,
}

pub fn public(path: &Path) -> PublicConfig {
    match load(path) {
        Ok(c) => PublicConfig {
            ai_ready: c.ai_provider != "claude" || !c.anthropic_api_key.trim().is_empty(),
            ai_model: if c.ai_provider == "claude" { c.ai_model } else { c.ollama_model },
            store_ready: !c.store_url.trim().is_empty(), quicklinks: c.quicklinks, snippets: c.snippets,
            notion_accounts: c.notion_accounts.iter().filter(|a| !a.token.trim().is_empty()).count(),
            timetree_accounts: c.timetree_accounts.iter().filter(|a| !a.email.trim().is_empty() && !a.password.is_empty()).count(),
            note_searches: c.note_searches, error: None },
        Err(e) => PublicConfig { ai_ready: false, ai_model: String::new(), quicklinks: vec![], snippets: vec![], store_ready: false,
            note_searches: vec![], notion_accounts: 0, timetree_accounts: 0, error: Some(e) },
    }
}

#[cfg(test)]
mod tests {
    use tauri_plugin_global_shortcut::Shortcut;

    // 기본 단축키와 화면에서 만드는 형식(e.code 기반)이 모두 해석되는지
    #[test]
    fn hotkey_strings_parse() {
        for s in ["Alt+Space", "Alt+L", "Alt+KeyL", "Super+Shift+Space", "Control+Alt+Digit1", "Alt+Shift+F5"] {
            assert!(s.parse::<Shortcut>().is_ok(), "{s}");
        }
        assert_eq!("Alt+L".parse::<Shortcut>().unwrap(), "Alt+KeyL".parse::<Shortcut>().unwrap());
    }

    // 검색어 없는 퀵링크만 단축키 대상
    #[test]
    fn quicklinks_without_query_get_hotkeys() {
        let mut c = super::Config::default();
        c.quicklinks.push(super::ql("idea", "아이디어 캔버스 열기", "obsidian://open?path=x"));
        let keys = super::hotkeys(&c);
        assert!(keys.contains_key("link:idea"));
        assert!(!keys.contains_key("link:yt"));
    }
}
