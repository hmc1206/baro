// 노트 검색용 Obsidian 노트 읽기. 해석은 화면(TS) 쪽에서 하고 여기선 파일 내용만 NFC로 넘김
use serde::Serialize;
use std::path::Path;
use unicode_normalization::UnicodeNormalization;
use walkdir::WalkDir;

#[derive(Serialize)]
pub struct Note {
    pub file: String,
    pub folder: String, // 검색 폴더 기준 하위 폴더 경로 (분류 대신 사용)
    pub text: String,
}

#[derive(Serialize)]
pub struct Notes { pub notes: Vec<Note>, pub chapters: Vec<Note> }

const MAX_FILES: usize = 5000;

// 하위 폴더까지 .md 읽기. .obsidian·.trash 같은 숨김 폴더와 macOS의 ._ 파일은 건너뜀
fn read_md(dir: &Path) -> Vec<Note> {
    WalkDir::new(dir).max_depth(8).into_iter()
        .filter_entry(|e| e.depth() == 0 || !e.file_name().to_string_lossy().starts_with('.'))
        .filter_map(Result::ok)
        .filter(|e| {
            let n = e.file_name().to_string_lossy();
            e.file_type().is_file() && n.ends_with(".md") && !n.starts_with("._")
        })
        .take(MAX_FILES)
        .filter_map(|e| {
            let text = std::fs::read_to_string(e.path()).ok()?;
            let folder = e.path().parent()?.strip_prefix(dir).ok()?.to_string_lossy().nfc().collect();
            Some(Note { file: e.path().to_string_lossy().nfc().collect(), folder, text: text.nfc().collect() })
        })
        .collect()
}

// 명령어 사전은 "![[다른 노트#절]]" 임베드를 풀기 위해 상위 폴더의 노트도 함께 읽음
pub fn load(dir: &str, kind: &str) -> Result<Notes, String> {
    let d = Path::new(dir);
    if !d.is_dir() {
        return Err(format!("폴더를 읽을 수 없어요. 외장 디스크 연결이나 노트 검색의 폴더 경로를 확인하세요.\n{dir}"));
    }
    let chapters = if kind == "commands" { d.parent().map(read_md).unwrap_or_default() } else { vec![] };
    Ok(Notes { notes: read_md(d), chapters })
}
