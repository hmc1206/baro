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

// AI 답변을 노트로 저장. 파일 이름은 "날짜-질문 앞부분.md", 같은 이름이 있으면 -2, -3… (덮어쓰지 않음)
pub fn save_ai(dir: &str, date: &str, question: &str, answer: &str, model: &str) -> Result<String, String> {
    let d = Path::new(dir);
    std::fs::create_dir_all(d).map_err(|e| format!("폴더를 만들 수 없어요. 외장 디스크 연결을 확인하세요.\n{dir} ({e})"))?;
    let title: String = question.lines().next().unwrap_or("").chars()
        .map(|c| if "/\\:*?\"<>|#^[]".contains(c) || c.is_control() { ' ' } else { c })
        .collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ");
    let short: String = title.chars().take(40).collect::<String>().trim().replace(' ', "-");
    let base = format!("{date}-{}", if short.is_empty() { "AI-답변".into() } else { short });
    let text = format!("---\ncreated: {date}\ntype: knowledge\ntags: [ai, baro]\nsource: baro-ai\nmodel: \"{}\"\n---\n\n# {}\n\n## 질문\n{}\n\n## 답변\n{}\n",
        model.replace('"', ""), if title.is_empty() { "AI 답변".into() } else { title.chars().take(80).collect::<String>() },
        question.trim(), answer.trim());
    for i in 1..100 {
        let name = if i == 1 { format!("{base}.md") } else { format!("{base}-{i}.md") };
        let path = d.join(&name);
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut f) => {
                use std::io::Write;
                f.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
                return Ok(path.to_string_lossy().into_owned());
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
    Err("같은 이름의 노트가 너무 많아요.".into())
}

#[cfg(test)]
mod tests {
    #[test]
    fn save_ai_never_overwrites() {
        let dir = std::env::temp_dir().join(format!("baro-ai-test-{}", std::process::id()));
        let d = dir.to_string_lossy().to_string();
        let a = super::save_ai(&d, "2026-11-15", "ls 옵션/뜻이 뭐야?\n둘째 줄", "답변", "qwen").unwrap();
        let b = super::save_ai(&d, "2026-11-15", "ls 옵션/뜻이 뭐야?", "답변2", "qwen").unwrap();
        assert!(a.ends_with("2026-11-15-ls-옵션-뜻이-뭐야.md"), "{a}");
        assert!(b.ends_with("2026-11-15-ls-옵션-뜻이-뭐야-2.md"), "{b}");
        let t = std::fs::read_to_string(&a).unwrap();
        assert!(t.starts_with("---\ncreated: 2026-11-15\n") && t.contains("## 답변\n답변\n"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
