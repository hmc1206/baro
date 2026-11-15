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

// 노트 검색 폴더 안의 파일인지 확인 (다른 위치의 파일은 고치지 않음)
fn inside(dir: &str, file: &str) -> Result<std::path::PathBuf, String> {
    let d = Path::new(dir).canonicalize().map_err(|e| format!("폴더를 찾을 수 없어요: {e}"))?;
    let f = Path::new(file).canonicalize().map_err(|e| format!("노트를 찾을 수 없어요: {e}"))?;
    if !f.starts_with(&d) || f.extension().and_then(|e| e.to_str()) != Some("md") { return Err("노트 검색 폴더 밖의 파일은 고칠 수 없어요.".into()); }
    Ok(f)
}

// YAML 큰따옴표 문자열 ("와 \는 이스케이프)
fn yaml_quote(v: &str) -> String { format!("\"{}\"", v.replace('\\', "\\\\").replace('"', "\\\"")) }

// 노트 머리말의 key 값만 바꿈. 없으면 머리말 끝에 추가. 본문은 그대로
pub fn set_field(dir: &str, file: &str, key: &str, value: &str) -> Result<(), String> {
    if key.is_empty() || !key.chars().all(|c| c.is_ascii_lowercase() || c == '_') { return Err("잘못된 항목 이름".into()); }
    if value.contains('\n') || value.contains('\r') { return Err("값에 줄바꿈은 넣을 수 없어요.".into()); }
    let f = inside(dir, file)?;
    let text = std::fs::read_to_string(&f).map_err(|e| e.to_string())?;
    if !text.starts_with("---\n") { return Err("노트에 머리말(---)이 없어요.".into()); }
    let end = text[4..].find("\n---").map(|i| i + 4).ok_or("머리말 끝(---)을 찾지 못했어요.")?;
    let (head, rest) = text.split_at(end);
    let line = format!("{key}: {}", yaml_quote(value));
    let mut found = false;
    let mut lines: Vec<String> = head.split('\n').map(|l| {
        if !found && l.strip_prefix(key).is_some_and(|r| r.starts_with(':')) { found = true; line.clone() } else { l.to_string() }
    }).collect();
    if !found { lines.push(line); }
    let out = format!("{}{}", lines.join("\n"), rest);
    // 임시 파일에 쓰고 바꿔치기 (쓰는 도중 끊겨도 원본이 깨지지 않게)
    let tmp = f.with_extension("md.baro-tmp");
    std::fs::write(&tmp, out).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &f).map_err(|e| e.to_string())
}

// 노트 검색 폴더에 새 노트 만들기 (같은 이름이 있으면 실패, 덮어쓰지 않음)
pub fn create(dir: &str, name: &str, content: &str) -> Result<String, String> {
    let name = name.trim().trim_end_matches(".md");
    if name.is_empty() || name.starts_with('.') || name.contains(['/', '\\', ':']) { return Err("파일 이름에 / \\ : 는 쓸 수 없어요.".into()); }
    let p = Path::new(dir).join(format!("{name}.md"));
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&p)
        .map_err(|e| if e.kind() == std::io::ErrorKind::AlreadyExists { format!("이미 있는 노트예요: {name}.md") } else { e.to_string() })?;
    f.write_all(content.as_bytes()).map_err(|e| e.to_string())?;
    Ok(p.to_string_lossy().into_owned())
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

    #[test]
    fn set_field_and_create() {
        let dir = std::env::temp_dir().join(format!("baro-pw-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let d = dir.to_string_lossy().to_string();
        let f = super::create(&d, "Level-01", "---\nlevel: 1\npassword: \"old\"\n---\n\n# L1\npassword: body\n").unwrap();
        assert!(super::create(&d, "Level-01", "x").is_err(), "덮어쓰면 안 됨");
        super::set_field(&d, &f, "password", "n\"e\\w").unwrap();
        super::set_field(&d, &f, "key_file", "a.key").unwrap();
        let t = std::fs::read_to_string(&f).unwrap();
        assert_eq!(t, "---\nlevel: 1\npassword: \"n\\\"e\\\\w\"\nkey_file: \"a.key\"\n---\n\n# L1\npassword: body\n");
        // 폴더 밖 파일·이상한 이름 거부
        assert!(super::set_field(&d, "/etc/hosts", "password", "x").is_err());
        assert!(super::create(&d, "../x", "x").is_err());
        assert!(super::set_field(&d, &f, "password", "a\nb").is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
