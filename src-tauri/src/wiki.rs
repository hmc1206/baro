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

// 할 일 줄("- [ ] 내용", "1. [x] 내용", 인용 안 "> - [ ]" 포함)이면 (괄호 안 글자 위치, 체크 여부, 내용)
fn task_marker(line: &str) -> Option<(usize, bool, &str)> {
    let b = line.as_bytes();
    let mut i = 0;
    let ws = |i: &mut usize| { while *i < b.len() && (b[*i] == b' ' || b[*i] == b'\t') { *i += 1; } };
    ws(&mut i);
    while i < b.len() && b[i] == b'>' { i += 1; ws(&mut i); }
    if i < b.len() && matches!(b[i], b'-' | b'*' | b'+') { i += 1; }
    else {
        let s = i;
        while i < b.len() && b[i].is_ascii_digit() { i += 1; }
        if i == s || i >= b.len() || !matches!(b[i], b'.' | b')') { return None; }
        i += 1;
    }
    let s = i; ws(&mut i);
    if i == s || i + 3 > b.len() || b[i] != b'[' || b[i + 2] != b']' || !matches!(b[i + 1], b' ' | b'x' | b'X') { return None; }
    let pos = i + 1;
    let s = i + 3; let mut j = s; ws(&mut j);
    if j == s { return None; }
    Some((pos, b[pos] != b' ', line[j..].trim()))
}

// index번째 할 일 줄을 체크/해제. 코드 블록 안과 머리말은 세지 않음 (화면의 체크박스 순서와 같게).
// 화면이 본 내용(text)과 파일의 그 줄이 다르면 바뀐 것으로 보고 고치지 않음
pub fn toggle_task(dir: &str, file: &str, index: usize, text: &str, done: bool) -> Result<(), String> {
    let f = inside(dir, file)?;
    let src = std::fs::read_to_string(&f).map_err(|e| e.to_string())?;
    let mut start = 0;
    if src.starts_with("---\n") {
        if let Some(e) = src[4..].find("\n---") { start = src[4 + e + 1..].find('\n').map(|k| 4 + e + 1 + k + 1).unwrap_or(src.len()); }
    }
    let (mut off, mut n, mut fence) = (start, 0usize, "");
    for line in src[start..].split_inclusive('\n') {
        let l = line.trim_end_matches(['\n', '\r']);
        let tr = l.trim_start();
        let f3 = if tr.starts_with("```") { "```" } else if tr.starts_with("~~~") { "~~~" } else { "" };
        if !f3.is_empty() { if fence.is_empty() { fence = f3; } else if f3 == fence { fence = ""; } }
        else if fence.is_empty() {
            if let Some((pos, _, rest)) = task_marker(l) {
                if n == index {
                    if rest != text.trim() { return Err("노트 내용이 바뀌었어요. 목록을 다시 열어 주세요.".into()); }
                    let mut out = src.clone();
                    out.replace_range(off + pos..off + pos + 1, if done { "x" } else { " " });
                    let tmp = f.with_extension("md.baro-tmp");
                    std::fs::write(&tmp, out).map_err(|e| e.to_string())?;
                    return std::fs::rename(&tmp, &f).map_err(|e| e.to_string());
                }
                n += 1;
            }
        }
        off += line.len();
    }
    Err("체크할 항목을 찾지 못했어요. 목록을 다시 열어 주세요.".into())
}

// "### 제목" 칸의 마지막 내용 줄 바로 뒤에 block을 끼워 넣음. 칸이 없으면 노트 끝에 칸을 만들어 추가
fn insert_under(text: &str, heading: &str, block: &str) -> String {
    let lines: Vec<&str> = text.split('\n').collect();
    let want = format!("### {heading}");
    let Some(h) = lines.iter().position(|l| l.trim_end() == want) else {
        let base = text.trim_end_matches('\n');
        return format!("{base}\n\n{want}\n{block}\n");
    };
    let mut end = lines.len(); // 다음 제목(#) 줄 또는 끝
    for (i, l) in lines.iter().enumerate().skip(h + 1) { if l.starts_with('#') { end = i; break; } }
    let last = (h + 1..end).rev().find(|&i| !lines[i].trim().is_empty()).unwrap_or(h);
    let mut out: Vec<&str> = lines[..=last].to_vec();
    out.extend(block.split('\n'));
    if end < lines.len() { out.push(""); out.extend(&lines[end..]); }
    else { out.push(""); } // 파일 끝 줄바꿈
    out.join("\n")
}

// 커리큘럼 단계 노트의 "내 기록" 칸(배운 점·막힌 점과 해결·사용한 명령어)에 기록 추가
pub fn add_record(dir: &str, file: &str, section: &str, block: &str) -> Result<(), String> {
    if !["배운 점", "막힌 점과 해결", "사용한 명령어"].contains(&section) { return Err("기록할 칸 이름이 잘못됐어요.".into()); }
    if block.trim().is_empty() { return Err("기록할 내용이 없어요.".into()); }
    let f = inside(dir, file)?;
    let text = std::fs::read_to_string(&f).map_err(|e| e.to_string())?;
    let tmp = f.with_extension("md.baro-tmp");
    std::fs::write(&tmp, insert_under(&text, section, block.trim_end())).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &f).map_err(|e| e.to_string())
}

// 오늘 Daily 노트(03_Daily/날짜.md) 끝에 "- 시각 내용" 추가. 여러 줄이면 둘째 줄부터 들여써서 같은 항목으로. 없으면 머리말과 함께 만듦
pub fn append_daily(vault: &str, date: &str, time: &str, text: &str) -> Result<String, String> {
    let ok = |s: &str, pat: &[bool]| s.len() == pat.len() && s.chars().zip(pat).all(|(c, d)| if *d { c.is_ascii_digit() } else { !c.is_ascii_digit() });
    if !ok(date, &[true, true, true, true, false, true, true, false, true, true]) || !ok(time, &[true, true, false, true, true]) { return Err("날짜·시각 형식이 잘못됐어요.".into()); }
    let lines: Vec<&str> = text.lines().map(str::trim_end).collect();
    let (Some(a), Some(b)) = (lines.iter().position(|l| !l.trim().is_empty()), lines.iter().rposition(|l| !l.trim().is_empty())) else {
        return Err("메모가 비어 있어요.".into());
    };
    let line = lines[a..=b].iter().enumerate().map(|(i, l)| if i == 0 { l.trim_start().to_string() } else { format!("  {l}") })
        .collect::<Vec<_>>().join("\n");
    let dir = Path::new(vault).join("03_Daily");
    if !dir.is_dir() { return Err(format!("Daily 폴더가 없어요. 외장 디스크 연결을 확인하세요.\n{}", dir.display())); }
    let f = dir.join(format!("{date}.md"));
    let mut text = std::fs::read_to_string(&f).unwrap_or_else(|_| format!("---\ncreated: {date}\ntype: daily\ntags: daily\n---\n\n"));
    if !text.ends_with('\n') { text.push('\n'); }
    text.push_str(&format!("- {time} {line}\n"));
    std::fs::write(&f, text).map_err(|e| e.to_string())?;
    Ok(f.to_string_lossy().into_owned())
}

// 오늘 Daily 노트 내용 (없으면 빈 글자). 빠른 메모 화면에서 이미 적은 메모 보기용
pub fn read_daily(vault: &str, date: &str) -> String {
    if date.len() != 10 || !date.chars().all(|c| c.is_ascii_digit() || c == '-') { return String::new(); }
    std::fs::read_to_string(Path::new(vault).join("03_Daily").join(format!("{date}.md"))).unwrap_or_default()
}

// 목록 항목 범위 [시작, 끝): "- " 줄 + 들여쓴 이어지는 줄, 또는 ``` 코드 블록 하나
fn items_in(lines: &[&str], start: usize, end: usize) -> Vec<(usize, usize)> {
    let mut out = vec![];
    let mut i = start;
    while i < end {
        if lines[i].starts_with("```") {
            let mut j = i + 1;
            while j < end && !lines[j].starts_with("```") { j += 1; }
            out.push((i, (j + 1).min(end)));
            i = j + 1;
        } else if lines[i].starts_with("- ") {
            let mut j = i + 1;
            while j < end && !lines[j].trim().is_empty() && (lines[j].starts_with(' ') || lines[j].starts_with('\t')) { j += 1; }
            out.push((i, j));
            i = j;
        } else { i += 1; }
    }
    out
}

// 지울 범위: section이 있으면 "### section" 칸 안, 없으면(Daily) 머리말 뒤 전체
fn record_bounds(lines: &[&str], section: Option<&str>) -> Result<(usize, usize), String> {
    match section {
        Some(s) => {
            let want = format!("### {s}");
            let h = lines.iter().position(|l| l.trim_end() == want).ok_or("기록 칸을 찾지 못했어요.")?;
            let end = lines.iter().enumerate().skip(h + 1).find(|(_, l)| l.starts_with('#')).map(|(i, _)| i).unwrap_or(lines.len());
            Ok((h + 1, end))
        }
        None => {
            let mut start = 0;
            if lines.first() == Some(&"---") { start = lines.iter().skip(1).position(|l| *l == "---").map(|i| i + 2).unwrap_or(0); }
            Ok((start, lines.len()))
        }
    }
}

// 기록 항목 하나 지우기. 화면이 본 첫 줄(first)과 다르면 지우지 않음. (지운 줄 번호, 지운 내용)을 돌려줘 되돌리기에 씀
fn remove_item_at(f: &Path, section: Option<&str>, index: usize, first: &str) -> Result<(usize, String), String> {
    let text = std::fs::read_to_string(f).map_err(|e| e.to_string())?;
    let lines: Vec<&str> = text.split('\n').collect();
    let (a, b) = record_bounds(&lines, section)?;
    let &(s, e) = items_in(&lines, a, b).get(index).ok_or("지울 기록을 찾지 못했어요. 다시 열어 주세요.")?;
    if lines[s].trim() != first.trim() { return Err("노트 내용이 바뀌었어요. 다시 열어 주세요.".into()); }
    let removed = lines[s..e].join("\n");
    let mut out: Vec<&str> = lines[..s].to_vec();
    out.extend(&lines[e..]);
    let tmp = f.with_extension("md.baro-tmp");
    std::fs::write(&tmp, out.join("\n")).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, f).map_err(|e| e.to_string())?;
    Ok((s, removed))
}

// 되돌리기: 지운 내용을 그 줄 번호에 다시 넣음
fn insert_at(f: &Path, line: usize, block: &str) -> Result<(), String> {
    let text = std::fs::read_to_string(f).map_err(|e| e.to_string())?;
    let mut lines: Vec<&str> = text.split('\n').collect();
    if line > lines.len() { return Err("되돌릴 위치를 찾지 못했어요.".into()); }
    lines.splice(line..line, block.split('\n'));
    let tmp = f.with_extension("md.baro-tmp");
    std::fs::write(&tmp, lines.join("\n")).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, f).map_err(|e| e.to_string())
}

fn daily_file(vault: &str, date: &str) -> Result<std::path::PathBuf, String> {
    if date.len() != 10 || !date.chars().all(|c| c.is_ascii_digit() || c == '-') { return Err("날짜 형식이 잘못됐어요.".into()); }
    Ok(Path::new(vault).join("03_Daily").join(format!("{date}.md")))
}
fn record_section(section: &str) -> Result<&str, String> {
    if ["배운 점", "막힌 점과 해결", "사용한 명령어"].contains(&section) { Ok(section) } else { Err("기록할 칸 이름이 잘못됐어요.".into()) }
}

pub fn remove_record(dir: &str, file: &str, section: &str, index: usize, first: &str) -> Result<(usize, String), String> {
    remove_item_at(&inside(dir, file)?, Some(record_section(section)?), index, first)
}
pub fn restore_record(dir: &str, file: &str, line: usize, block: &str) -> Result<(), String> { insert_at(&inside(dir, file)?, line, block) }
pub fn remove_daily(vault: &str, date: &str, index: usize, first: &str) -> Result<(usize, String), String> {
    remove_item_at(&daily_file(vault, date)?, None, index, first)
}
pub fn restore_daily(vault: &str, date: &str, line: usize, block: &str) -> Result<(), String> { insert_at(&daily_file(vault, date)?, line, block) }

#[cfg(test)]
mod tests {
    #[test]
    fn remove_and_restore_items() {
        let dir = std::env::temp_dir().join(format!("baro-rm-test-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("03_Daily")).unwrap();
        let f = dir.join("단계.md");
        let src = "---\nstatus: todo\n---\n### 배운 점\n- 하나\n  이어지는 줄\n- 둘\n\n### 사용한 명령어\n- `ls`\n```bash\nnmap -sV x\n```\n\n## 관련\n";
        std::fs::write(&f, src).unwrap();
        let (d, p) = (dir.to_string_lossy().to_string(), f.to_string_lossy().to_string());
        assert!(super::remove_record(&d, &p, "배운 점", 0, "- 다른 글").is_err());
        let (line, block) = super::remove_record(&d, &p, "배운 점", 0, "- 하나").unwrap();
        assert_eq!(block, "- 하나\n  이어지는 줄");
        assert!(std::fs::read_to_string(&f).unwrap().contains("### 배운 점\n- 둘\n"));
        super::restore_record(&d, &p, line, &block).unwrap();
        assert_eq!(std::fs::read_to_string(&f).unwrap(), src);
        let (_, code) = super::remove_record(&d, &p, "사용한 명령어", 1, "```bash").unwrap();
        assert_eq!(code, "```bash\nnmap -sV x\n```");
        let daily = dir.join("03_Daily/2026-11-18.md");
        std::fs::write(&daily, "---\ncreated: 2026-11-18\n---\n\n- 10:00 첫째\n- 11:00 둘째\n  둘째의 둘째 줄\n").unwrap();
        let (l, b) = super::remove_daily(&d, "2026-11-18", 1, "- 11:00 둘째").unwrap();
        assert_eq!(std::fs::read_to_string(&daily).unwrap(), "---\ncreated: 2026-11-18\n---\n\n- 10:00 첫째\n");
        super::restore_daily(&d, "2026-11-18", l, &b).unwrap();
        assert!(std::fs::read_to_string(&daily).unwrap().ends_with("- 11:00 둘째\n  둘째의 둘째 줄\n"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn insert_under_heading() {
        let t = "# 단계\n## 내 기록\n### 배운 점\n\n### 막힌 점과 해결\n- 예전 것\n\n### 사용한 명령어\n\n## 관련\n[[목차]]\n";
        let a = super::insert_under(t, "배운 점", "- 새로 배움");
        assert_eq!(a, "# 단계\n## 내 기록\n### 배운 점\n- 새로 배움\n\n### 막힌 점과 해결\n- 예전 것\n\n### 사용한 명령어\n\n## 관련\n[[목차]]\n");
        let b = super::insert_under(&a, "막힌 점과 해결", "- 둘째");
        assert!(b.contains("- 예전 것\n- 둘째\n\n### 사용한 명령어"), "{b}");
        let c = super::insert_under("# 노트\n본문\n", "사용한 명령어", "- `ls`");
        assert_eq!(c, "# 노트\n본문\n\n### 사용한 명령어\n- `ls`\n");
        let d = super::insert_under("### 배운 점\n- 하나", "배운 점", "- 둘");
        assert_eq!(d, "### 배운 점\n- 하나\n- 둘\n");
    }

    #[test]
    fn append_daily_creates_and_appends() {
        let v = std::env::temp_dir().join(format!("baro-daily-test-{}", std::process::id()));
        std::fs::create_dir_all(v.join("03_Daily")).unwrap();
        let vs = v.to_string_lossy().to_string();
        let f = super::append_daily(&vs, "2026-11-18", "14:32", "\n첫 메모\n  들여쓴 줄\n\n").unwrap();
        super::append_daily(&vs, "2026-11-18", "14:40", "둘째").unwrap();
        assert!(super::append_daily(&vs, "2026/11/18", "14:40", "x").is_err());
        assert!(super::append_daily(&vs, "2026-11-18", "14:40", "  ").is_err());
        assert_eq!(std::fs::read_to_string(f).unwrap(), "---\ncreated: 2026-11-18\ntype: daily\ntags: daily\n---\n\n- 14:32 첫 메모\n    들여쓴 줄\n- 14:40 둘째\n");
        assert!(super::read_daily(&vs, "2026-11-18").contains("- 14:40 둘째"));
        assert_eq!(super::read_daily(&vs, "../x"), "");
        std::fs::remove_dir_all(&v).ok();
    }

    #[test]
    fn toggle_task_skips_code_and_checks_text() {
        let dir = std::env::temp_dir().join(format!("baro-task-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("단계.md");
        std::fs::write(&f, "---\nstatus: todo\n---\n# 단계\n```\n- [ ] 코드 안\n```\n- [ ] 첫째\n  - [x] 둘째\n1. [ ] 셋째\n> - [ ] 넷째\n").unwrap();
        let (d, p) = (dir.to_string_lossy().to_string(), f.to_string_lossy().to_string());
        super::toggle_task(&d, &p, 1, "둘째", false).unwrap();
        super::toggle_task(&d, &p, 2, "셋째", true).unwrap();
        super::toggle_task(&d, &p, 3, "넷째", true).unwrap();
        assert!(super::toggle_task(&d, &p, 0, "다른 글", true).is_err());
        assert!(super::toggle_task(&d, &p, 9, "없음", true).is_err());
        let t = std::fs::read_to_string(&f).unwrap();
        assert_eq!(t, "---\nstatus: todo\n---\n# 단계\n```\n- [ ] 코드 안\n```\n- [ ] 첫째\n  - [ ] 둘째\n1. [x] 셋째\n> - [x] 넷째\n");
        std::fs::remove_dir_all(&dir).ok();
    }

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
