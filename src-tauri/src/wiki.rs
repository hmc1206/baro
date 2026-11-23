// 노트 검색용 Obsidian 노트 읽기. 해석은 화면(TS) 쪽에서 하고 여기선 파일 내용만 NFC로 넘김
use serde::Serialize;
use std::path::Path;
use unicode_normalization::UnicodeNormalization;

#[derive(Serialize)]
pub struct Note {
    pub file: String,
    pub folder: String, // 검색 폴더 기준 하위 폴더 경로 (분류 대신 사용)
    pub text: String,
}

#[derive(Serialize)]
// reviews: 커리큘럼 허브일 때 폴더 안 노트의 [이름, 머리말 next_review] (날짜가 있는 노트만)
pub struct Notes { pub notes: Vec<Note>, pub chapters: Vec<Note>, pub reviews: Vec<[String; 2]> }

// 하위 폴더까지 .md 읽기 (vault.rs 캐시: 바뀐 파일만 다시 읽음)
fn read_md(dir: &Path) -> Vec<Note> {
    let base: String = dir.to_string_lossy().nfc().collect();
    crate::vault::scan(dir).into_iter().map(|e| {
        let parent = Path::new(&e.path).parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
        let folder = parent.strip_prefix(&base).unwrap_or("").trim_start_matches('/').to_string();
        Note { file: e.path.clone(), folder, text: e.text.to_string() }
    }).collect()
}

// 명령어 사전은 "![[다른 노트#절]]" 임베드를 풀기 위해 상위 폴더의 노트도 함께 읽음.
// 커리큘럼 폴더에 허브 노트(머리말 type: curriculum-hub)가 있으면 허브만 넘기고(허브의 "### 단계"가 단계 하나),
// 허브가 가리키는 단계 노트("단계 노트: [[이름|…]]")는 Vault에서 찾아 chapters로 (빠른 메모 기록용)
pub fn load(dir: &str, kind: &str, vault: &str) -> Result<Notes, String> {
    let d = Path::new(dir);
    if !d.is_dir() {
        return Err(format!("폴더를 읽을 수 없어요. 외장 디스크 연결이나 노트 검색의 폴더 경로를 확인하세요.\n{dir}"));
    }
    let mut notes = read_md(d);
    let mut chapters = if kind == "commands" { d.parent().map(read_md).unwrap_or_default() } else { vec![] };
    let mut reviews = vec![];
    if kind == "curriculum" && notes.iter().any(|n| is_hub(&n.text)) {
        reviews = notes.iter().filter_map(|n| next_review(&n.text).map(|d| [note_name(&n.file).nfc().collect(), d])).collect();
        notes.retain(|n| is_hub(&n.text));
        let want: Vec<String> = notes.iter().flat_map(|n| stage_links(&n.text)).collect();
        chapters = named(dir, vault, &want);
    }
    Ok(Notes { notes, chapters, reviews })
}

// 이름(파일 이름에서 .md 뺀 것)으로 Vault에서 노트 찾기. 같은 이름이면 dir 안의 노트 먼저, 이름마다 하나
pub fn named(dir: &str, vault: &str, names: &[String]) -> Vec<Note> {
    let want: std::collections::HashSet<String> = names.iter().map(|n| n.nfc().collect()).collect();
    if want.is_empty() { return vec![]; }
    let root = Path::new(if vault.is_empty() { dir } else { vault });
    let base: String = Path::new(dir).to_string_lossy().nfc().collect();
    let mut found: Vec<Note> = read_md(root).into_iter().filter(|n| want.contains(note_name(&n.file))).collect();
    found.sort_by_key(|n| !n.file.starts_with(&base)); // 같은 이름이면 커리큘럼 폴더 안의 노트 먼저
    let mut seen = std::collections::HashSet::new();
    found.retain(|n| seen.insert(note_name(&n.file).to_string()));
    found
}

// 머리말의 next_review 날짜 (YYYY-MM-DD, 따옴표 허용). 비었거나 형식이 다르면 None
fn next_review(text: &str) -> Option<String> {
    let head = text.strip_prefix("---\n")?.split("\n---").next()?;
    let v = head.lines().find_map(|l| l.strip_prefix("next_review:"))?.trim().trim_matches(|c| c == '"' || c == '\'');
    let ok = v.len() == 10 && v.chars().enumerate().all(|(i, c)| if i == 4 || i == 7 { c == '-' } else { c.is_ascii_digit() });
    ok.then(|| v.to_string())
}

fn note_name(file: &str) -> &str { file.rsplit('/').next().unwrap_or(file).trim_end_matches(".md") }

// 머리말에 type: curriculum-hub, 또는 "## 단계별 학습" 칸과 "**단계 상태**:" 줄이 있는 노트 (CS 허브는 원본 머리말 type: curriculum)
fn is_hub(text: &str) -> bool {
    let typed = text.strip_prefix("---\n").is_some_and(|rest| rest.split("\n---").next().unwrap_or("").lines()
        .any(|l| matches!(l.trim(), "type: curriculum-hub" | "type: \"curriculum-hub\"" | "type: 'curriculum-hub'")));
    typed || (text.lines().any(|l| l.starts_with("## 단계별 학습")) && text.lines().any(|l| l.starts_with("**단계 상태**:")))
}

// 허브의 "**단계 상태**: … 단계 노트: [[이름|…]]" 줄에서 단계 노트 이름들
fn stage_links(text: &str) -> Vec<String> {
    text.lines().filter(|l| l.starts_with("**단계 상태**")).filter_map(|l| {
        let s = &l[l.find("단계 노트: [[")? + "단계 노트: [[".len()..];
        let e = s.find(|c| c == '|' || c == ']' || c == '#')?;
        Some(s[..e].trim().to_string())
    }).collect()
}

pub const STAGE_STATES: &[&str] = &["학습 전", "학습 중", "복습 필요", "완료"];

// 커리큘럼 허브의 "### 단계" 상태 바꾸기: 그 칸의 "**단계 상태**: 값 · …" 줄과 "한눈에 보기" 표의 그 단계 줄(마지막 칸)
pub fn set_stage_status(dir: &str, file: &str, heading: &str, value: &str) -> Result<(), String> {
    if !STAGE_STATES.contains(&value) { return Err("상태 이름이 잘못됐어요.".into()); }
    let f = inside(dir, file)?;
    let text = std::fs::read_to_string(&f).map_err(|e| e.to_string())?;
    let out = with_stage_status(&text, heading, value)?;
    let tmp = f.with_extension("md.baro-tmp");
    std::fs::write(&tmp, out).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &f).map_err(|e| e.to_string())
}

fn with_stage_status(text: &str, heading: &str, value: &str) -> Result<String, String> {
    let mut lines: Vec<String> = text.split('\n').map(String::from).collect();
    let want = format!("### {}", heading.trim());
    let h = lines.iter().position(|l| l.trim_end() == want).ok_or("허브에서 그 단계를 찾지 못했어요. 목록을 다시 열어 주세요.")?;
    const P: &str = "**단계 상태**:";
    let s = (h + 1..lines.len()).take_while(|&i| !lines[i].starts_with('#')).find(|&i| lines[i].starts_with(P))
        .ok_or("그 단계에 '단계 상태' 줄이 없어요.")?;
    let r = lines[s][P.len()..].trim_start().to_string();
    let end = [r.find(" ·"), r.find(" (")].into_iter().flatten().min().unwrap_or(r.len());
    lines[s] = format!("{P} {value}{}", &r[end..]);
    let (a, b) = (format!("[[#{}\\|", heading.trim()), format!("[[#{}|", heading.trim()));
    for l in lines.iter_mut().filter(|l| l.starts_with('|') && (l.contains(&a) || l.contains(&b))) {
        let t = l.trim_end();
        if let Some(k) = t.strip_suffix('|').and_then(|i| i.rfind('|')) { *l = format!("{}| {value} |", &t[..k]); }
    }
    Ok(lines.join("\n"))
}

// 개념 상태가 바뀐 뒤 그 줄이 속한 "### 단계" 상태 맞추기:
// 개념이 모두 완료 → 완료, 완료였는데 덜 끝난 개념이 생김 → 학습 중, 학습 전인데 시작한 개념이 있음 → 학습 중. 그 밖(복습 필요 등)은 그대로
fn roll_up(text: &str, line: usize) -> String {
    let lines: Vec<&str> = text.split('\n').collect();
    let Some(h) = (0..=line.min(lines.len().saturating_sub(1))).rev().find(|&i| lines[i].starts_with('#')) else { return text.into() };
    if !lines[h].starts_with("### ") { return text.into(); }
    let end = (h + 1..lines.len()).find(|&i| lines[i].starts_with('#')).unwrap_or(lines.len());
    let states: Vec<&str> = lines[h + 1..end].iter().filter(|l| task_marker(l).is_some())
        .filter_map(|l| STAGE_STATES.iter().copied().find(|s| l.trim_end().ends_with(&format!(" · {s}")))).collect();
    let Some(cur) = lines[h + 1..end].iter().find_map(|l| l.strip_prefix("**단계 상태**:")).map(|r| r.trim_start()) else { return text.into() };
    if states.is_empty() { return text.into(); }
    let cur = STAGE_STATES.iter().copied().find(|s| cur.starts_with(s)).unwrap_or("");
    let next = if states.iter().all(|s| *s == "완료") { "완료" }
        else if cur == "완료" || (cur == "학습 전" && states.iter().any(|s| *s != "학습 전")) { "학습 중" }
        else { cur };
    if next == cur || next.is_empty() { return text.into(); }
    with_stage_status(text, lines[h].trim_start_matches("### ").trim(), next).unwrap_or_else(|_| text.into())
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
pub fn inside(dir: &str, file: &str) -> Result<std::path::PathBuf, String> {
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

// 개념 노트 만들기: 아직 없는 [[링크]] 이름으로 틀에 맞춘 노트를 만듦
// - Vault 어디에든 같은 이름 노트가 이미 있으면 만들지 않고 그 노트를 돌려줌 (중복 방지)
// - 위치: 링크를 건 노트가 02_Knowledge/<분야>/… 안이면 그 분야 폴더, 아니면 00_Inbox
// 돌려주는 값: (파일 경로, 새로 만들었는지)
pub fn concept_dir(vault: &Path, src: &Path) -> std::path::PathBuf {
    let rel: Vec<String> = src.strip_prefix(vault).map(|r| r.iter().map(|c| c.to_string_lossy().into_owned()).collect()).unwrap_or_default();
    if rel.len() >= 3 && rel[0] == "02_Knowledge" { vault.join(&rel[0]).join(&rel[1]) } else { vault.join("00_Inbox") }
}

pub fn create_concept(vault: &str, src: &str, name: &str, date: &str) -> Result<(String, bool), String> {
    use unicode_normalization::UnicodeNormalization;
    let v = Path::new(vault);
    if !v.is_dir() { return Err(format!("Vault를 읽을 수 없어요. 외장 디스크 연결을 확인하세요.\n{vault}")); }
    let name = name.trim().trim_end_matches(".md").trim();
    if name.is_empty() || name.starts_with('.') || name.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|', '#', '^', '[', ']']) {
        return Err(format!("노트 이름으로 쓸 수 없는 글자가 있어요: {name}"));
    }
    let key = name.nfc().collect::<String>().to_lowercase();
    for e in crate::vault::scan(v) {
        let stem = Path::new(&e.path).file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
        if stem == key { return Ok((e.path.clone(), false)); }
    }
    let src_p = Path::new(src);
    if !src_p.starts_with(v) { return Err("Vault 밖의 노트예요.".into()); }
    let dir = concept_dir(v, src_p);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let from = src_p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let area = dir.file_name().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
    let tags = if area == "00_inbox" { "[concept]".to_string() } else { format!("[concept, {area}]") };
    let content = format!("---\ncreated: {date}\ntype: knowledge\ntags: {tags}\nsource: baro\n---\n\n# {name}\n\n## 요약\n- \n\n## 내용\n- \n\n## 예시\n- \n\n## 관련\n[[{from}]]\n");
    create(&dir.to_string_lossy(), name, &content).map(|p| (p, true))
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
// 화면이 본 내용(text)과 파일의 그 줄이 다르면 바뀐 것으로 보고 고치지 않음.
// 허브 항목 끝의 " · 학습 전" 같은 상태 글자도 함께 (체크 → 완료, 해제 → 학습 전)
pub fn toggle_task(dir: &str, file: &str, index: usize, text: &str, done: bool) -> Result<(), String> {
    edit_task(dir, file, index, text, |line, pos| {
        let mut l = line.to_string();
        l.replace_range(pos..pos + 1, if done { "x" } else { " " });
        match STAGE_STATES.iter().find_map(|s| l.strip_suffix(&format!(" · {s}"))) {
            Some(base) => format!("{base} · {}", if done { "완료" } else { "학습 전" }),
            None => l,
        }
    })
}

// 허브 개념 항목의 상태 바꾸기: 줄 끝 " · 학습 전" 등을 value로, 완료면 체크·아니면 해제
pub fn set_task_state(dir: &str, file: &str, index: usize, text: &str, value: &str) -> Result<(), String> {
    if !STAGE_STATES.contains(&value) { return Err("상태 이름이 잘못됐어요.".into()); }
    edit_task(dir, file, index, text, |line, pos| {
        let mut l = line.to_string();
        l.replace_range(pos..pos + 1, if value == "완료" { "x" } else { " " });
        match STAGE_STATES.iter().find_map(|s| l.strip_suffix(&format!(" · {s}"))) {
            Some(base) => format!("{base} · {value}"),
            None => format!("{l} · {value}"),
        }
    })
}

// index번째 할 일 줄 찾기 → (줄 시작 위치, 줄 길이(줄바꿈 제외), 체크 글자 위치)
fn find_task(src: &str, index: usize, text: &str) -> Result<(usize, usize, usize), String> {
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
                    return Ok((off, l.len(), pos));
                }
                n += 1;
            }
        }
        off += line.len();
    }
    Err("체크할 항목을 찾지 못했어요. 목록을 다시 열어 주세요.".into())
}

fn write_atomic(f: &Path, out: &str) -> Result<(), String> {
    let tmp = f.with_extension("md.baro-tmp");
    std::fs::write(&tmp, out).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, f).map_err(|e| e.to_string())
}

fn edit_task(dir: &str, file: &str, index: usize, text: &str, edit: impl FnOnce(&str, usize) -> String) -> Result<(), String> {
    let f = inside(dir, file)?;
    let src = std::fs::read_to_string(&f).map_err(|e| e.to_string())?;
    let (off, len, pos) = find_task(&src, index, text)?;
    let mut out = src.clone();
    out.replace_range(off..off + len, &edit(&src[off..off + len], pos));
    // 커리큘럼 허브면 그 단계 상태도 개념 진행에 맞춤
    if is_hub(&out) { out = roll_up(&out, out[..off].matches('\n').count()); }
    write_atomic(&f, &out)
}

// 완료 기준 증거: index번째 할 일 줄을 체크하고, 그 줄(과 이미 단 증거) 바로 아래에 "  - 날짜 내용"을 붙임.
// 여러 줄이면 둘째 줄부터 더 들여써서 같은 항목으로. field가 있으면 머리말 evidence 목록에도 "날짜 field: 첫 줄" 추가
pub fn add_evidence(dir: &str, file: &str, index: usize, text: &str, date: &str, body: &str, field: Option<&str>) -> Result<(), String> {
    let ok_date = date.len() == 10 && date.chars().enumerate().all(|(i, c)| if i == 4 || i == 7 { c == '-' } else { c.is_ascii_digit() });
    if !ok_date { return Err("날짜 형식이 잘못됐어요.".into()); }
    let f = inside(dir, file)?;
    let src = std::fs::read_to_string(&f).map_err(|e| e.to_string())?;
    let out = with_evidence(&src, index, text, date, body, field)?;
    write_atomic(&f, &out)
}

fn with_evidence(src: &str, index: usize, text: &str, date: &str, body: &str, field: Option<&str>) -> Result<String, String> {
    let lines: Vec<&str> = body.lines().map(str::trim_end).collect();
    let (Some(a), Some(b)) = (lines.iter().position(|l| !l.trim().is_empty()), lines.iter().rposition(|l| !l.trim().is_empty())) else {
        return Err("기록할 내용이 없어요.".into());
    };
    let (off, len, pos) = find_task(src, index, text)?;
    let indent: String = src[off..].chars().take_while(|c| *c == ' ' || *c == '\t').collect();
    let block = lines[a..=b].iter().enumerate()
        .map(|(i, l)| if i == 0 { format!("{indent}  - {date} {}", l.trim_start()) } else { format!("{indent}    {l}") })
        .collect::<Vec<_>>().join("\n");
    let mut out = src.to_string();
    out.replace_range(pos + off..pos + off + 1, "x");
    // 기준 줄 다음, 이미 단 증거(더 들여쓴 줄) 뒤에 넣음
    let mut at = off + len;
    if out[at..].starts_with('\n') { at += 1; }
    else { out.push('\n'); at = out.len(); }
    while at < out.len() {
        let end = out[at..].find('\n').map(|k| at + k + 1).unwrap_or(out.len());
        let l = &out[at..end];
        if l.trim().is_empty() || !l.starts_with(&format!("{indent} ")) && !l.starts_with(&format!("{indent}\t")) { break; }
        at = end;
    }
    let tail = if at == out.len() && !out.ends_with('\n') { "\n" } else { "" };
    out.insert_str(at, &format!("{tail}{block}\n"));
    if let Some(name) = field { out = push_list(&out, "evidence", &format!("{date} {name}: {}", lines[a].trim())); }
    Ok(out)
}

// 머리말의 목록 항목(key)에 한 줄 추가. "key: []"나 빈 값이면 목록으로 바꿈, 없으면 머리말 끝에 만듦
fn push_list(text: &str, key: &str, item: &str) -> String {
    if !text.starts_with("---\n") { return text.to_string(); }
    let Some(end) = text[4..].find("\n---").map(|i| i + 4) else { return text.to_string() };
    let (head, rest) = text.split_at(end);
    let mut lines: Vec<String> = head.split('\n').map(String::from).collect();
    let entry = format!("  - {}", yaml_quote(item));
    match lines.iter().position(|l| l.strip_prefix(key).is_some_and(|r| r.starts_with(':'))) {
        Some(i) => {
            let v = lines[i][key.len() + 1..].trim().to_string();
            if v.starts_with('[') && v.ends_with(']') && v != "[]" {
                lines[i] = format!("{key}: {}, {}]", &v[..v.len() - 1], yaml_quote(item));
            } else {
                lines[i] = format!("{key}:");
                let mut j = i + 1;
                while j < lines.len() && lines[j].trim_start().starts_with("- ") && lines[j].starts_with(' ') { j += 1; }
                lines.insert(j, entry);
            }
        }
        None => { lines.push(format!("{key}:")); lines.push(entry); }
    }
    format!("{}{}", lines.join("\n"), rest)
}

// "### 제목" 칸의 마지막 내용 줄 바로 뒤에 block을 끼워 넣음. 칸이 없으면 노트 끝에 칸을 만들어 추가
fn insert_under(text: &str, heading: &str, block: &str) -> String {
    let lines: Vec<&str> = text.split('\n').collect();
    let want = format!("### {heading}");
    let Some(h) = lines.iter().position(|l| l.trim_end() == want) else {
        let base = text.trim_end_matches('\n');
        // "## 내 기록" 칸도 없으면 함께 만듦 (허브에서 연결된 단계 노트)
        let top = if lines.iter().any(|l| l.trim_end() == "## 내 기록") { "" } else { "## 내 기록\n\n" };
        return format!("{base}\n\n{top}{want}\n{block}\n");
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
    fn curriculum_hub_stages() {
        let v = std::env::temp_dir().join(format!("baro-hub-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&v);
        let cur = v.join("Curriculum");
        std::fs::create_dir_all(cur.join("Frontend")).unwrap();
        std::fs::create_dir_all(v.join("Sec")).unwrap();
        let hub = "---\ntype: curriculum-hub\nfield: frontend\n---\n# FE\n\n| 단계 | 상태 |\n|---|---|\n| [[#P01 웹\\|P01 웹]] | 학습 전 |\n\n## 단계별 학습\n\n### P01 웹\n\n**단계 상태**: 학습 전 · 약 18시간 · 단계 노트: [[P01-web|열기]]\n\n- [ ] [[a]] · 필수 · 학습 전\n\n### 1단계 보안\n\n**단계 상태**: 학습 전 (메모) · 단계 노트: [[01-sec|열기]]\n";
        std::fs::write(cur.join("FE-Curriculum.md"), hub).unwrap();
        std::fs::write(cur.join("Master.md"), "---\ntype: master-roadmap\n---\n# M").unwrap();
        std::fs::write(cur.join("Frontend/P01-web.md"), "# P01").unwrap();
        std::fs::write(v.join("Sec/01-sec.md"), "# 1단계").unwrap();
        let (d, vs) = (cur.to_string_lossy().into_owned(), v.to_string_lossy().into_owned());
        let n = super::load(&d, "curriculum", &vs).unwrap();
        // 허브만 단계 목록으로, 단계 노트는 Vault 어디에 있든 chapters로
        assert_eq!(n.notes.len(), 1);
        let mut ch: Vec<&str> = n.chapters.iter().map(|c| super::note_name(&c.file)).collect();
        ch.sort();
        assert_eq!(ch, ["01-sec", "P01-web"]);
        let f = cur.join("FE-Curriculum.md").to_string_lossy().into_owned();
        super::set_stage_status(&d, &f, "P01 웹", "학습 중").unwrap();
        super::set_stage_status(&d, &f, "1단계 보안", "완료").unwrap();
        let t = std::fs::read_to_string(&f).unwrap();
        assert!(t.contains("**단계 상태**: 학습 중 · 약 18시간"), "{t}");
        assert!(t.contains("| [[#P01 웹\\|P01 웹]] | 학습 중 |"), "{t}");
        assert!(t.contains("**단계 상태**: 완료 (메모)"), "{t}");
        assert!(super::set_stage_status(&d, &f, "P01 웹", "아무거나").is_err());
        assert!(super::set_stage_status(&d, &f, "없는 단계", "완료").is_err());
        // 체크하면 항목 끝 상태도 완료로, 해제하면 학습 전
        super::toggle_task(&d, &f, 0, "[[a]] · 필수 · 학습 전", true).unwrap();
        assert!(std::fs::read_to_string(&f).unwrap().contains("- [x] [[a]] · 필수 · 완료"));
        super::toggle_task(&d, &f, 0, "[[a]] · 필수 · 완료", false).unwrap();
        assert!(std::fs::read_to_string(&f).unwrap().contains("- [ ] [[a]] · 필수 · 학습 전"));
        // 개념 항목 상태: 학습 중이면 체크 해제, 완료면 체크
        super::set_task_state(&d, &f, 0, "[[a]] · 필수 · 학습 전", "학습 중").unwrap();
        assert!(std::fs::read_to_string(&f).unwrap().contains("- [ ] [[a]] · 필수 · 학습 중"));
        super::set_task_state(&d, &f, 0, "[[a]] · 필수 · 학습 중", "완료").unwrap();
        assert!(std::fs::read_to_string(&f).unwrap().contains("- [x] [[a]] · 필수 · 완료"));
        assert!(super::set_task_state(&d, &f, 0, "[[a]] · 필수 · 완료", "엉뚱").is_err());
        // 단계의 개념이 모두 완료면 단계도 완료, 하나라도 다시 풀리면 학습 중
        let t = std::fs::read_to_string(&f).unwrap();
        assert!(t.contains("**단계 상태**: 완료 · 약 18시간") && t.contains("| [[#P01 웹\\|P01 웹]] | 완료 |"), "{t}");
        super::set_task_state(&d, &f, 0, "[[a]] · 필수 · 완료", "복습 필요").unwrap();
        assert!(std::fs::read_to_string(&f).unwrap().contains("**단계 상태**: 학습 중 · 약 18시간"));
        assert_eq!(super::named(&d, &vs, &["01-sec".into()]).len(), 1);
        // 허브가 없는 폴더는 예전처럼 노트 하나 = 단계 하나
        assert_eq!(super::load(&v.join("Sec").to_string_lossy(), "curriculum", &vs).unwrap().notes.len(), 1);
        // 내 기록 칸이 없는 단계 노트엔 칸을 만들어 기록
        assert_eq!(super::insert_under("# P01\n", "배운 점", "- 새로"), "# P01\n\n## 내 기록\n\n### 배운 점\n- 새로\n");
        let _ = std::fs::remove_dir_all(&v);
    }

    #[test]
    fn evidence_under_criterion() {
        let src = "---\ntype: concept\nevidence: []\nlast_studied:\n---\n\n# 개념\n\n```\n- [ ] 코드 안\n```\n## Explain · 학습 완료 기준\n- [ ] **노트별 검증**: 검증하기\n- [ ] **독립 재현**: 다시 만들기\n\n## 끝\n";
        // 첫 기준: 체크하고 바로 아래에 증거
        let a = super::with_evidence(src, 0, "**노트별 검증**: 검증하기", "2026-11-23", "메일은 웹이 아님\n둘째 줄", None).unwrap();
        assert!(a.contains("- [x] **노트별 검증**: 검증하기\n  - 2026-11-23 메일은 웹이 아님\n    둘째 줄\n- [ ] **독립 재현**"));
        assert!(a.contains("evidence: []"));
        // 같은 기준에 또 달면 앞 증거 뒤에
        let b = super::with_evidence(&a, 0, "**노트별 검증**: 검증하기", "2026-11-24", "두 번째", None).unwrap();
        assert!(b.contains("    둘째 줄\n  - 2026-11-24 두 번째\n- [ ] **독립 재현**"));
        // 재현: 머리말 evidence 목록에도
        let c = super::with_evidence(&b, 1, "**독립 재현**: 다시 만들기", "2026-11-24", "커밋 abc123", Some("독립 재현")).unwrap();
        assert!(c.contains("- [x] **독립 재현**: 다시 만들기\n  - 2026-11-24 커밋 abc123\n\n## 끝"));
        assert!(c.contains("evidence:\n  - \"2026-11-24 독립 재현: 커밋 abc123\"\nlast_studied:"));
        let d = super::push_list(&c, "evidence", "또");
        assert!(d.contains("커밋 abc123\"\n  - \"또\"\nlast_studied:"));
        // 노트가 바뀌었거나 내용이 없으면 거부
        assert!(super::with_evidence(src, 0, "다른 글", "2026-11-23", "x", None).is_err());
        assert!(super::with_evidence(src, 0, "**노트별 검증**: 검증하기", "2026-11-23", "  \n ", None).is_err());
        // 파일 끝 기준 (줄바꿈 없음)
        let e = super::with_evidence("- [ ] 마지막", 0, "마지막", "2026-11-23", "끝", None).unwrap();
        assert_eq!(e, "- [x] 마지막\n  - 2026-11-23 끝\n");
    }

    #[test]
    fn insert_under_heading() {
        let t = "# 단계\n## 내 기록\n### 배운 점\n\n### 막힌 점과 해결\n- 예전 것\n\n### 사용한 명령어\n\n## 관련\n[[목차]]\n";
        let a = super::insert_under(t, "배운 점", "- 새로 배움");
        assert_eq!(a, "# 단계\n## 내 기록\n### 배운 점\n- 새로 배움\n\n### 막힌 점과 해결\n- 예전 것\n\n### 사용한 명령어\n\n## 관련\n[[목차]]\n");
        let b = super::insert_under(&a, "막힌 점과 해결", "- 둘째");
        assert!(b.contains("- 예전 것\n- 둘째\n\n### 사용한 명령어"), "{b}");
        let c = super::insert_under("# 노트\n본문\n", "사용한 명령어", "- `ls`");
        assert_eq!(c, "# 노트\n본문\n\n## 내 기록\n\n### 사용한 명령어\n- `ls`\n");
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
    fn next_review_from_frontmatter() {
        assert_eq!(super::next_review("---\nstatus: done\nnext_review: \"2026-11-24\"\n---\n# x"), Some("2026-11-24".into()));
        assert_eq!(super::next_review("---\nnext_review: 2026-12-01\n---\n"), Some("2026-12-01".into()));
        assert_eq!(super::next_review("---\nnext_review:\n---\n"), None);
        assert_eq!(super::next_review("# 머리말 없음\nnext_review: 2026-12-01"), None);
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

    #[test]
    fn concept_notes_go_to_area_and_never_duplicate() {
        let v = std::env::temp_dir().join(format!("baro-concept-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&v);
        let area = v.join("02_Knowledge/Network-Security/Hacking-Curriculum");
        std::fs::create_dir_all(&area).unwrap();
        std::fs::create_dir_all(v.join("01_Projects/X")).unwrap();
        std::fs::write(area.join("01-기초.md"), "[[OSI-7계층]]").unwrap();
        std::fs::write(v.join("01_Projects/X/있는노트.md"), "# 있음").unwrap();
        let vs = v.to_string_lossy().into_owned();
        let src = area.join("01-기초.md").to_string_lossy().into_owned();
        let (p, made) = super::create_concept(&vs, &src, "OSI-7계층", "2026-11-19").unwrap();
        assert!(made && p.ends_with("02_Knowledge/Network-Security/OSI-7계층.md"), "{p}");
        let t = std::fs::read_to_string(&p).unwrap();
        assert!(t.contains("# OSI-7계층") && t.contains("[[01-기초]]") && t.contains("tags: [concept, network-security]"));
        // 다시 만들면 새로 만들지 않고 있는 노트
        assert_eq!(super::create_concept(&vs, &src, "osi-7계층", "2026-11-19").unwrap(), (p.clone(), false));
        // 다른 폴더에 같은 이름이 있으면 그 노트
        let (q, made) = super::create_concept(&vs, &src, "있는노트", "2026-11-19").unwrap();
        assert!(!made && q.ends_with("01_Projects/X/있는노트.md"));
        // 분야 밖 노트에서 만들면 00_Inbox
        let src2 = v.join("01_Projects/X/있는노트.md").to_string_lossy().into_owned();
        assert!(super::create_concept(&vs, &src2, "새개념", "2026-11-19").unwrap().0.ends_with("00_Inbox/새개념.md"));
        assert!(super::create_concept(&vs, &src, "../탈출", "2026-11-19").is_err());
        let _ = std::fs::remove_dir_all(&v);
    }
}

#[cfg(test)]
mod bench {
    // 실제 Vault로 커리큘럼 첫 열기 시간 재기: cargo test --release bench_curriculum -- --ignored --nocapture
    #[test]
    #[ignore]
    fn bench_curriculum() {
        let v = "/Volumes/Disk/MyBrain";
        let d = format!("{v}/02_Knowledge/Curriculum");
        if let Ok(c) = std::env::var("BARO_CACHE") { crate::vault::init(std::path::Path::new(&c)); }
        for round in 0..3 {
            let t = std::time::Instant::now();
            let n = super::load(&d, "curriculum", v).unwrap();
            let a = t.elapsed();
            let t = std::time::Instant::now();
            let names: Vec<String> = (1..=11).map(|i| format!("P01-{i:03}")).collect();
            let m = super::named(&d, v, &names);
            println!("round {round}: load {:?} (hubs {}, chapters {}) · named {:?} ({})", a, n.notes.len(), n.chapters.len(), t.elapsed(), m.len());
        }
    }
}
