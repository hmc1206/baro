// 노트 검색: Obsidian 폴더의 노트를 방식(kind)에 맞게 해석·검색
//  commands: 명령어 사전 (Raycast linux-wiki 확장의 docs.ts를 옮겨 옴) — 머리말 command/category/aliases/summary + 예시
//  notes:    일반 노트 — 제목·태그·본문 검색, 코드 블록을 예시로
//  snippets: 스니펫 모음 — 노트 하나 = 붙여넣을 문구 하나
//  passwords: 비밀번호 모음 — 노트 하나 = 계정 하나. 머리말 password(·login·ssh·key_file)를 가려서 보여 주고 수정
//  curriculum: 커리큘럼 — 노트 하나 = 단계 하나. 머리말 status·week와 체크박스 진도, 미리보기에서 바로 체크
import { invoke } from "@tauri-apps/api/core";

export type NoteKind = "commands" | "notes" | "snippets" | "passwords" | "curriculum";
export type NoteSearch = { id: string; name: string; dir: string; kind: NoteKind };
export const KIND_LABELS: Record<NoteKind, { title: string; desc: string; glyph: string }> = {
  commands: { title: "명령어 사전", desc: "머리말(command·category·aliases·summary)과 예시 표·코드를 읽어 예시를 바로 붙여넣기", glyph: "terminal" },
  notes: { title: "일반 노트", desc: "제목·태그·본문으로 찾고 미리보기, 코드 블록은 복사·붙여넣기", glyph: "doc" },
  snippets: { title: "스니펫 모음", desc: "노트 하나가 문구 하나. 고르면 본문을 바로 붙여넣기", glyph: "snippet" },
  passwords: { title: "비밀번호 모음", desc: "머리말 password를 가려서 보여 주고 복사·붙여넣기·수정, 새 노트 추가", glyph: "lock" },
  curriculum: { title: "커리큘럼", desc: "단계별 상태(status)·기간(week)·체크박스 진도를 보고, 미리보기에서 바로 체크, ⌘D로 상태 바꾸기", glyph: "curriculum" },
};

// 체크박스 할 일. 순서는 미리보기의 체크박스 순서와 같음 (코드 블록 안은 제외 — Rust wiki::toggle_task와 같은 규칙)
export type Task = { done: boolean; text: string };
const TASK = /^\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s+(.*)$/;
export function tasksOf(body: string): Task[] {
  const out: Task[] = [];
  let fence = "";
  for (const line of body.split("\n")) {
    const f = line.trim().match(/^(```|~~~)/)?.[1];
    if (f) { if (!fence) fence = f; else if (f === fence) fence = ""; continue; }
    if (fence) continue;
    const m = line.replace(/\r$/, "").match(TASK);
    if (m) out.push({ done: m[1] !== " ", text: m[2].trim() });
  }
  return out;
}

export type Example = { cmd: string; desc: string };
export type Doc = {
  name: string; category: string; summary: string; aliases: string[]; related: string[];
  markdown: string; body: string; examples: Example[]; file: string; stub: boolean;
  meta: Record<string, string>; // 머리말의 한 줄 값 (비밀번호 모음: password, login, ssh, key_file …)
  tasks?: Task[]; // 커리큘럼: 체크박스
  // 커리큘럼 허브의 단계: 허브 안 "### 제목", 허브 전체에서 이 단계 첫 체크박스의 순서, 분야·단계 순서, 연결된 단계 노트(빠른 메모 기록용)
  heading?: string; taskBase?: number; order?: number; record?: Doc;
  concept?: Concept; // 단계 안의 개념 하나 (허브 항목 + 개념 노트)
  taskMap?: number[]; // 공부 카드의 체크박스 → 노트 전체 체크박스 순서
  next?: { concept: Concept; why: string; section: string }; // 단계 목록 위 개념 칸(다음 할 일·복습·개념 검색): 이 단계의 개념 하나
  reviews?: Map<string, string>; // 허브 단계: 개념 노트 이름 → 머리말 next_review
  expect?: Expect; // 개념: GUIDE 노트 "답을 확인한 뒤 변형하기" 표의 기대 관찰·변형
};
export type Expect = { see: string; vary: string };
// 허브 단계의 개념 항목. hubIndex: 허브 파일 전체에서 그 체크박스 줄의 순서(-1이면 체크박스 아님)
export type Concept = { name: string; link: string; hubFile: string; hubIndex: number; hubText: string;
  status: string; priority: string; prereq: string; desc: string; stage: string; review?: string }; // review: 개념 노트의 next_review
export type Note = { file: string; folder: string; text: string };

// 명령어 사전의 분류 순서 (리눅스 노트 기준). 목록에 없는 분류는 뒤에 이름순
const CATEGORY_ORDER = [
  "터미널 기초", "디렉터리 및 파일 관리", "파일 검색", "텍스트 처리", "권한 및 사용자", "프로세스 관리",
  "서비스 및 로그", "예약 작업", "네트워크", "SSH", "패키지 관리", "디스크 및 시스템 관리", "리눅스 보안", "기타 유용한 명령어",
];

const unesc = (s: string) => s.replace(/\\\|/g, "|");
// 따옴표 벗기기. 큰따옴표는 \" \\ 이스케이프도 풂 (Baro가 비밀번호를 저장할 때 쓰는 형식)
const unquote = (s: string) => {
  const t = s.trim();
  if (/^"(.*)"$/.test(t)) return t.slice(1, -1).replace(/\\(["\\])/g, "$1");
  return t.replace(/^'(.*)'$/, "$1");
};
const stripLink = (s: string) => s.replace(/^\[\[|\]\]$/g, "").split("|")[0].split("/").pop() ?? s;
const baseName = (file: string) => file.split("/").pop()!.replace(/\.md$/, "");

// 노트 머리말(YAML)의 간단한 부분만 해석: key: 값 / [a, "b"] / 다음 줄의 "- 항목"
function frontmatter(raw: string): { data: Record<string, string | string[]>; body: string } {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { data: {}, body: raw };
  const data: Record<string, string | string[]> = {};
  let listKey = "";
  for (const line of m[1].split("\n")) {
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && listKey) { (data[listKey] as string[]).push(unquote(item[1])); continue; }
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (!kv) continue;
    const [, k, v] = kv;
    listKey = "";
    if (v.startsWith("[") && v.endsWith("]")) {
      data[k] = (v.slice(1, -1).match(/"[^"]*"|'[^']*'|[^,]+/g) ?? []).map(unquote).filter(Boolean);
    } else if (v === "") { data[k] = []; listKey = k; }
    else data[k] = unquote(v);
  }
  return { data, body: raw.slice(m[0].length) };
}
const toList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v ? [String(v)] : []);

// 명령어 사전 예시: "여러 옵션 조합" 코드블록(→ 설명) + 옵션 표의 예시 열
function commandExamples(body: string): Example[] {
  const out: Example[] = [];
  for (const m of body.matchAll(/```bash\n([^`]*?)\n```\n+→ (.+)/g)) out.push({ cmd: m[1].trim(), desc: m[2].trim() });
  for (const m of body.matchAll(/^\| `(.+?)` \| (.+?) \| `(.+?)` \|$/gm)) out.push({ cmd: unesc(m[3]), desc: `${unesc(m[2])} (${unesc(m[1])})` });
  return dedupe(out);
}
// 일반 노트 예시: 모든 코드 블록. 설명은 바로 위 제목
function codeBlocks(body: string): Example[] {
  const out: Example[] = [];
  let heading = "";
  const re = /^(#{1,6}) (.+)$|^```[^\n]*\n([\s\S]*?)\n```/gm;
  for (const m of body.matchAll(re)) {
    if (m[2]) heading = m[2].trim();
    else if (m[3]?.trim()) out.push({ cmd: m[3].trim(), desc: heading });
  }
  return dedupe(out);
}
function dedupe(xs: Example[]) {
  const seen = new Set<string>();
  return xs.filter(e => !seen.has(e.cmd) && seen.add(e.cmd));
}

// 다른 노트의 해당 절만 잘라오기 (Obsidian 임베드 대신)
function section(chapters: Map<string, string>, file: string, heading: string) {
  const lines = (chapters.get(file) ?? "").split("\n");
  const i = lines.findIndex(l => /^#{1,6} /.test(l) && l.replace(/^#+\s*/, "").trim() === heading.trim());
  if (i < 0) return "";
  const lvl = lines[i].match(/^#+/)![0].length;
  const stop = new RegExp(`^#{1,${lvl}} `);
  let j = i + 1;
  while (j < lines.length && !stop.test(lines[j])) j++;
  return lines.slice(i, j).join("\n").replace(/^(#{1,5}) /gm, (_, h: string) => `${h}# `);
}

// Obsidian 콜아웃("> [!tip]- 제목" + "> 내용")을 미리보기용으로: 접히는 것(-/+)은 <details>, 아니면 굵은 제목 인용
export function callouts(md: string): string {
  const lines = md.split("\n"), out: string[] = [];
  let fence = "";
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i], f = l.trim().match(/^(```|~~~)/)?.[1];
    if (f && !l.startsWith(">")) fence = !fence ? f : f === fence ? "" : fence;
    const m = !fence && l.match(/^>\s*\[!([\w-]+)\]([-+]?)\s*(.*)$/);
    if (!m) { out.push(l); continue; }
    const body: string[] = [];
    while (i + 1 < lines.length && lines[i + 1].startsWith(">")) body.push(lines[++i].replace(/^>\s?/, ""));
    const title = m[3].trim() || m[1];
    out.push(m[2] ? `<details${m[2] === "+" ? " open" : ""}><summary>${title}</summary>\n\n${body.join("\n")}\n\n</details>\n`
      : [`> **${title}**`, ...body.map(b => `> ${b}`)].join("\n"));
  }
  return out.join("\n");
}

function toMarkdown(body: string, chapters: Map<string, string>) {
  const out = callouts(body).split("\n").map(line => {
    const m = line.match(/^!\[\[([^#\]]+)#([^\]]+)\]\]$/) || line.match(/^원본 위치: \[\[([^\]]+)\]\] → \*\*(.+)\*\* 절$/);
    const sec = m ? section(chapters, m[1], m[2]) : "";
    return sec ? `> 출처: ${m![1]}\n\n${sec}` : line;
  });
  // 위키링크는 굵은 글씨로
  return out.join("\n").replace(/!?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g,
    (_, a: string, b?: string) => `**${b ?? a.split("/").pop()}**`);
}

// 본문 첫 문단 (요약이 없을 때)
function firstLine(body: string) {
  return body.split("\n").map(l => l.trim()).find(l => l && !/^(#|```|>|\||---|!\[)/.test(l))?.slice(0, 80) ?? "";
}

// 커리큘럼 허브(머리말 type: curriculum-hub): "## 단계별 학습" 아래 "### 단계"가 단계 하나.
// 상태는 "**단계 상태**: 학습 전 · 약 18시간 · 단계 노트: [[이름|…]]" 줄. 분야 순서: 프론트엔드 → 백엔드 → CS → 보안
const FIELDS: Record<string, [number, string]> = { frontend: [0, "프론트엔드"], backend: [1, "백엔드"], cs: [2, "CS"], security: [3, "보안"] };
export function hubStages(hubs: Note[], stageNotes: Note[], chapters: Map<string, string>, reviews = new Map<string, string>()): Doc[] {
  const byName = new Map(stageNotes.map(n => [baseName(n.file), n]));
  const out: Doc[] = [];
  for (const h of hubs) {
    const { data, body } = frontmatter(h.text);
    const [rank, field] = FIELDS[String(data.field)] ?? [9, baseName(h.file)];
    const lines = body.split("\n");
    const start = lines.findIndex(l => /^##\s+단계별 학습/.test(l));
    if (start < 0) continue;
    let end = lines.findIndex((l, k) => k > start && /^##\s/.test(l));
    if (end < 0) end = lines.length;
    const heads = lines.map((l, k) => k > start && k < end && /^###\s/.test(l) ? k : -1).filter(k => k >= 0);
    heads.forEach((k, j) => {
      const sec = lines.slice(k, heads[j + 1] ?? end).join("\n");
      const heading = lines[k].replace(/^###\s+/, "").trim();
      const line = sec.match(/^\*\*단계 상태\*\*:\s*(.*)$/m)?.[1] ?? "";
      const parts = line.split("·").map(x => x.trim());
      const meta: Record<string, string> = { status: parts[0].replace(/\s*\(.*$/, "").trim() || "학습 전" };
      const week = parts.find(x => /^\d[\d~-]*주$/.test(x)), hours = parts.find(x => /시간$/.test(x));
      if (week) meta.week = week.replace(/주$/, "");
      if (hours) meta.hours = hours;
      const link = line.match(/단계 노트:\s*\[\[([^\]|#]+)/)?.[1]?.trim();
      const rn = link ? byName.get(link) : undefined;
      let record: Doc | undefined;
      if (rn) {
        const r = frontmatter(rn.text), text = r.body.trim();
        record = { name: text.match(/^# (.+)$/m)?.[1]?.trim() ?? heading, category: field, summary: "", aliases: [], related: [],
          markdown: toMarkdown(text, chapters), body: text, examples: [], file: rn.file, stub: false, meta: {}, tasks: tasksOf(r.body) };
      }
      out.push({
        name: heading, category: field, summary: line, aliases: [field, ...toList(data.tags)], related: [],
        markdown: toMarkdown(sec, chapters), body: sec, examples: [], file: h.file, stub: false, meta,
        tasks: tasksOf(sec), heading, taskBase: tasksOf(lines.slice(0, k).join("\n")).length, order: rank * 1000 + j, record, reviews,
      });
    });
  }
  return out;
}
// 커리큘럼 순서: 허브 단계는 분야·단계 순서, 단계 노트는 파일 이름 순서
export const byStage = (a: Doc, b: Doc) => (a.order ?? 0) - (b.order ?? 0) || a.file.localeCompare(b.file, undefined, { numeric: true });

export async function loadDocs(search: NoteSearch): Promise<Doc[]> {
  const w = await invoke<{ notes: Note[]; chapters: Note[]; reviews?: [string, string][] }>("notes_load", { id: search.id });
  const chapters = new Map([...w.chapters, ...w.notes].map(c => [baseName(c.file), c.text]));
  const isHub = (t: string) => frontmatter(t).data.type === "curriculum-hub" || (/^## 단계별 학습/m.test(t) && /^\*\*단계 상태\*\*:/m.test(t));
  const hubs = search.kind === "curriculum" ? w.notes.filter(n => isHub(n.text)) : [];
  if (hubs.length) return hubStages(hubs, w.chapters, chapters, new Map(w.reviews ?? []));
  // 커리큘럼: 첨부 목록 같은 목록 노트(type: index)는 단계가 아님
  const notes = search.kind === "curriculum" ? w.notes.filter(n => frontmatter(n.text).data.type !== "index") : w.notes;
  return notes.map(n => {
    const { data, body } = frontmatter(n.text);
    const text = body.trim();
    const heading = text.match(/^# (.+)$/m)?.[1]?.trim();
    if (search.kind === "commands") {
      const level = String(data.level ?? "stub");
      return {
        name: String(data.command ?? baseName(n.file)), category: String(data.category ?? "기타 유용한 명령어"),
        summary: String(data.summary ?? ""), aliases: toList(data.aliases), related: toList(data.related).map(stripLink),
        markdown: toMarkdown(text, chapters), body: text, examples: commandExamples(body), file: n.file, stub: level === "stub", meta: {},
      };
    }
    const meta = Object.fromEntries(Object.entries(data).filter(([, v]) => typeof v === "string")) as Record<string, string>;
    if (search.kind === "passwords") {
      return {
        name: heading ?? baseName(n.file), category: n.folder || search.name, aliases: toList(data.tags), related: [],
        summary: meta.key_file ? `키 파일 ${meta.key_file}` : meta.login ?? "",
        markdown: toMarkdown(text, chapters), body: text, examples: [], file: n.file, stub: false, meta,
      };
    }
    const name = String(data.title ?? (search.kind === "notes" || search.kind === "curriculum" ? heading : undefined) ?? baseName(n.file));
    const aliases = [...toList(data.aliases), ...toList(data.tags).map(t => t.replace(/^#/, ""))];
    // 스니펫은 머리말과 맨 위 제목(파일 이름과 같을 때)을 뺀 본문이 붙여넣을 문구
    const snippet = heading && heading === name && text.startsWith(`# ${heading}`) ? text.slice(heading.length + 2).trim() : text;
    return {
      name, category: String(data.category ?? (n.folder || "노트")),
      summary: String(data.summary ?? data.description ?? (search.kind === "snippets" ? snippet.split("\n")[0].slice(0, 80) : firstLine(text))),
      aliases, related: toList(data.related).map(stripLink),
      markdown: toMarkdown(search.kind === "snippets" ? snippet : text, chapters),
      body: search.kind === "snippets" ? snippet : text,
      examples: search.kind === "notes" ? codeBlocks(text) : [], file: n.file, stub: false, meta,
      tasks: search.kind === "curriculum" ? tasksOf(body) : undefined,
    };
  });
}

// 점수: 이름 일치 > 별칭·태그 > 요약 > 본문. 상세 문서에 가산점
export function score(d: Doc, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const name = d.name.toLowerCase();
  const aliases = d.aliases.map(a => a.toLowerCase());
  const summary = d.summary.toLowerCase();
  let s = 0;
  if (name === q) s = 1000;
  else if (name.startsWith(q)) s = 500;
  else if (aliases.includes(q)) s = 400;
  else if (name.includes(q)) s = 350;
  else if (aliases.some(a => a.includes(q))) s = 300;
  else if (summary.includes(q)) s = 150;
  else {
    const tokens = q.split(/\s+/);
    const hay = [name, ...aliases, summary].join(" ");
    const md = d.body.toLowerCase();
    if (tokens.every(t => hay.includes(t))) s = 100;
    else if (md.includes(q)) s = 20;
    else if (tokens.every(t => md.includes(t))) s = 10;
  }
  return s > 0 && !d.stub ? s + 5 : s;
}

export function rank(docs: Doc[], query: string): Doc[] {
  return docs.map(d => ({ d, s: score(d, query) })).filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s || a.d.name.localeCompare(b.d.name, undefined, { numeric: true })).map(x => x.d);
}

// 검색어가 없을 때: 분류(명령어 사전은 정해진 순서, 그 외는 폴더 이름순) → 상세 문서 먼저 → 이름순
export function byCategory(docs: Doc[]): Doc[] {
  const order = (c: string) => { const i = CATEGORY_ORDER.indexOf(c); return i < 0 ? CATEGORY_ORDER.length : i; };
  return [...docs].sort((a, b) => order(a.category) - order(b.category) || a.category.localeCompare(b.category)
    || Number(a.stub) - Number(b.stub) || a.name.localeCompare(b.name, undefined, { numeric: true }));
}


// ── 개념 단위 공부 ──
// 단계(허브 칸)의 개념 목록: "- [ ] [[링크|이름]] · 필수 · 선행: … · 학습 전" 줄, 보안처럼 "- 이름 — 설명 (→ [[링크]])" 줄
export function conceptsOf(stage: Doc): Concept[] {
  const out: Concept[] = [];
  let fence = "", n = 0, inKey = false;
  for (const raw of stage.body.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const f = line.trim().match(/^(```|~~~)/)?.[1];
    if (f) { if (!fence) fence = f; else if (f === fence) fence = ""; continue; }
    if (fence) continue;
    if (/^\s*-\s+\*\*/.test(line)) inKey = /핵심 개념/.test(line); // "- **핵심 개념(원본)**:" 아래만
    const m = line.match(TASK);
    if (m) {
      const idx = (stage.taskBase ?? 0) + n++;
      const lm = m[2].match(/^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\](.*)$/);
      if (!lm) continue;
      const parts = lm[3].split("·").map(x => x.trim()).filter(Boolean);
      const state = parts.find(x => ["학습 전", "학습 중", "복습 필요", "완료"].includes(x)) ?? (m[1] !== " " ? "완료" : "학습 전");
      const review = stage.reviews?.get(lm[1].trim().normalize("NFC"));
      out.push({ name: (lm[2] ?? lm[1]).trim(), link: lm[1].trim(), hubFile: stage.file, hubIndex: idx, hubText: m[2].trim(), status: state,
        priority: parts.find(x => /^(필수|선택|심화)/.test(x)) ?? "", prereq: parts.find(x => x.startsWith("선행"))?.replace(/^선행:\s*/, "") ?? "",
        desc: "", stage: stage.name, ...(review ? { review } : {}) });
      continue;
    }
    const b = inKey && line.match(/^\s+-\s+(.+?)\s+—\s+(.*)$/);
    if (b) {
      const link = b[2].match(/\[\[([^\]|#]+)/)?.[1]?.trim() ?? "";
      out.push({ name: b[1].trim(), link, hubFile: stage.file, hubIndex: -1, hubText: "", status: "", priority: "", prereq: "",
        desc: b[2].replace(/\s*→.*$/, "").replace(/\*\(.*?\)\*/g, "").trim(), stage: stage.name });
    }
  }
  return out;
}

// 다음 할 일: 분야마다 하나. 학습 중인 개념이 있으면 그것(이어서), 없으면 순서상 첫 미완료 개념 중 선행 개념이 모두 완료인 것.
// 선행은 같은 분야 개념 번호(이름 첫 단어). 허브에 없는 번호는 막지 않음
export const conceptId = (name: string) => name.trim().split(/\s+/)[0];
export const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
export function nextUp(stages: Doc[], today = localDate()): Doc[] {
  const fields = new Map<string, { stage: Doc; c: Concept }[]>(), plain = new Map<string, Doc[]>();
  for (const st of [...stages].filter(d => d.heading).sort(byStage)) {
    const cs = conceptsOf(st), list = fields.get(st.category) ?? [];
    for (const c of cs) if (c.hubIndex >= 0) list.push({ stage: st, c });
    fields.set(st.category, list);
    plain.set(st.category, [...plain.get(st.category) ?? [], st]);
  }
  const out: Doc[] = [];
  for (const [field, list] of fields) {
    // 보안처럼 개념 체크박스가 없는 분야: 단계 상태로 첫 미완료 단계
    if (!list.length) {
      const st = plain.get(field)!.find(x => x.meta.status !== "완료");
      const c = st && conceptsOf(st)[0];
      if (st && c) out.push({ ...st, next: { concept: c, why: st.meta.status === "학습 중" ? "이어서 공부" : "단계 시작", section: "다음 할 일" } });
      continue;
    }
    const status = new Map(list.map(x => [conceptId(x.c.name), x.c.status]));
    const prereqs = (c: Concept) => c.prereq.split(/[,，]/).map(x => x.trim()).filter(x => x && x !== "없음");
    const open = (c: Concept) => prereqs(c).every(p => !status.has(p) || status.get(p) === "완료");
    const doing = list.find(x => x.c.status === "학습 중");
    const pick = doing ?? list.find(x => x.c.status !== "완료" && x.c.status !== "복습 필요" && open(x.c));
    if (!pick) continue;
    const pre = prereqs(pick.c);
    const why = doing ? "이어서 공부" : pre.length ? `선행 ${pre.join(", ")} 완료` : "선행 없음";
    out.push({ ...pick.stage, next: { concept: pick.c, why, section: "다음 할 일" } });
  }
  // 복습 큐: 복습 필요로 표시한 개념 + 개념 노트 next_review가 오늘이거나 지난 개념 (학습 전 제외).
  // 오래 밀린 것부터, 날짜가 없는 "복습 필요"는 그 뒤에 분야·단계 순서로. 이미 "다음 할 일"에 나온 개념은 빼기
  const shown = new Set(out.map(d => `${d.next!.concept.hubFile}#${d.next!.concept.hubIndex}`));
  const due: { d: Doc; late: number }[] = [];
  for (const list of fields.values())
    for (const x of list) {
      if (shown.has(`${x.c.hubFile}#${x.c.hubIndex}`)) continue;
      const late = x.c.review && x.c.status !== "학습 전" ? daysBetween(x.c.review, today) : -1;
      if (late < 0 && x.c.status !== "복습 필요") continue;
      const why = late > 0 ? `복습일 ${late}일 지남` : late === 0 ? "오늘 복습" : "복습 필요";
      due.push({ d: { ...x.stage, next: { concept: x.c, why, section: "복습할 개념" } }, late });
    }
  return [...out, ...due.sort((a, b) => b.late - a.late).map(x => x.d)];
}

// 분야를 넘는 개념 검색: 모든 허브 단계의 개념 이름·번호에서 찾기 (이름 시작 일치 먼저)
export function conceptHits(stages: Doc[], query: string, limit = 30): Doc[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: { d: Doc; s: number }[] = [];
  for (const st of [...stages].filter(d => d.heading).sort(byStage))
    for (const c of conceptsOf(st)) {
      const name = c.name.toLowerCase(), words = q.split(/\s+/);
      const s = name.startsWith(q) ? 3 : name.includes(q) ? 2 : words.every(w => `${name} ${c.desc.toLowerCase()}`.includes(w)) ? 1 : 0;
      if (s) hits.push({ d: { ...st, next: { concept: c, why: c.status, section: "개념" } }, s });
    }
  return hits.sort((a, b) => b.s - a.s).slice(0, limit).map(x => x.d);
}

// 단계의 개념들을 개념 노트와 함께 읽기 (노트가 없는 개념은 file 빈 값)
export async function conceptDocs(search: NoteSearch, stage: Doc): Promise<Doc[]> {
  const cs = conceptsOf(stage);
  const notes = await invoke<Note[]>("notes_named", { id: search.id, names: [...new Set([...cs.map(c => c.link).filter(Boolean), GUIDE])] });
  const byName = new Map(notes.map(n => [baseName(n.file).normalize("NFC"), n]));
  const guide = byName.get(GUIDE.normalize("NFC"));
  const exp = guide ? expectations(guide.text) : new Map<string, Expect>();
  return cs.map((c, i) => {
    const n = c.link ? byName.get(c.link.normalize("NFC")) : undefined;
    const { data, body } = n ? frontmatter(n.text) : { data: {} as Record<string, string | string[]>, body: "" };
    const text = body.trim();
    return {
      name: c.name, category: c.stage, summary: c.desc || String(data.summary ?? firstLine(text)), aliases: toList(data.aliases), related: [],
      markdown: "", body: text, examples: [], file: n?.file ?? "", stub: !n,
      meta: { status: c.status, ...(data.last_studied ? { last: String(data.last_studied) } : {}),
        ...(data.status ? { note_status: String(data.status) } : {}), ...(data.next_review ? { review: String(data.next_review) } : {}) },
      tasks: n ? tasksOf(body) : [], order: i, concept: c, ...(c.link && exp.has(c.link.normalize("NFC")) ? { expect: exp.get(c.link.normalize("NFC")) } : {}),
    };
  });
}

// 실행 가이드 노트: "| [[개념 링크|이름]] | 기대 관찰 | 변형 |" 표 → 개념 링크별 답
const GUIDE = "GUIDE-실행과-복습";
export function expectations(text: string): Map<string, Expect> {
  const out = new Map<string, Expect>();
  for (const l of text.split("\n")) {
    const cells = l.trim().replace(/\[\[[^\]]*\]\]|\\\|/g, m => m.replace(/\\?\|/g, "\u0000")).split("|").slice(1, -1).map(x => x.replace(/\u0000/g, "|").trim());
    const link = cells[0]?.match(/^\[\[([^\]|#]+)/)?.[1];
    if (link && cells.length >= 3 && cells[1]) out.set(link.trim().normalize("NFC"), { see: cells[1], vary: cells[2] });
  }
  return out;
}

// 완료 기준 하나를 답할 질문들로 쪼개기 (노트 공통 문장 틀 기준)
// "…하고 …한다" → 두 질문, "…는지, …는지 답한다" → 질문마다 하나, evidence·속성 갱신 문장은 Baro가 하므로 뺌
export function questionsOf(c: Criterion): string[] {
  const out: string[] = [];
  for (const sen of c.desc.split(/(?<=\.)\s+/).map(x => x.trim().replace(/\.$/, "")).filter(Boolean)) {
    if (/`evidence`|속성을 갱신/.test(sen)) continue;
    const ask = sen.match(/^(.*는지)\s*답한다$/);
    if (ask) { out.push(...ask[1].split(/,\s*/).map(x => x.replace(/는지$/, "나요?"))); continue; }
    const parts = sen.split(/(?<=\S)하고\s+/);
    if (parts.length > 1 && parts.every(x => x.length >= 6)) out.push(...parts.map((x, i) => i < parts.length - 1 ? `${x}한다` : x));
    else out.push(sen);
  }
  return out.map(x => x.replace(/했다$/, "한다"));
}

// 증거를 단 뒤 바꿀 상태 (00 커리큘럼 전체의 상태·복습 간격 규칙)
// 처음 증거 → doing·학습 중, 노트별 검증까지 → review·다음날 복습, 셋 다 → done·완료·7일 뒤 복습. 이미 앞선 상태면 그대로
// 시간을 들이는 복습: done 개념의 복습일이 되면 복습할 개념 목록에 나오고, 증거를 기록하면 다음 복습일로
export const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
export function evidencePlan(crit: Criterion[], c: Criterion, d: Doc, today: string): { status?: string; hub?: string; review?: string } {
  const done = crit.map(x => x.done || x.index === c.index);
  const all = done.length > 0 && done.every(Boolean), checked = crit.some((x, i) => done[i] && /검증/.test(x.label));
  const cur = d.meta.note_status ?? "", hub = d.concept?.status ?? "";
  const rank = (s: string) => ["todo", "doing", "review", "done"].indexOf(s);
  const status = all ? "done" : checked ? "review" : "doing";
  // 끝낸 개념의 복습일에 다시 기록하면 = 복습함 → 다음 간격 (지난 간격 7일 → 21일 → 60일)
  const due = !!d.meta.review && d.meta.review <= today;
  const gap = d.meta.review && d.meta.last ? (Date.parse(d.meta.review) - Date.parse(d.meta.last)) / 86400000 : 0;
  return {
    ...(rank(status) > rank(cur) ? { status } : {}),
    ...(d.concept && d.concept.hubIndex >= 0 && (all ? hub !== "완료" : hub === "학습 전" || !hub) ? { hub: all ? "완료" : "학습 중" } : {}),
    ...(all && cur !== "done" ? { review: addDays(today, 7) } : checked && !all && !d.meta.review ? { review: addDays(today, 1) }
      : cur === "done" && due ? { review: addDays(today, gap >= 21 ? 60 : gap >= 7 ? 21 : 7) } : {}),
  };
}

// 공부 카드: 개념 노트의 칸들을 모든 개념에 같은 5단계 순서로 다시 배치.
// ① 목표 → ② 읽고 이해하기 → ③ 예측하고 직접 해 보기 → ④ 문서를 닫고 설명하기 → ⑤ 완료 기준·증거
export const STUDY_STEPS = ["목표 확인", "읽고 이해하기", "예측하고 직접 해 보기", "문서를 닫고 설명하기", "완료 기준 체크·증거 남기기"];
// 개념 노트의 완료 기준: "## … 완료 기준"(또는 Explain) 칸의 체크박스와 그 아래 들여쓴 증거 줄.
// index는 노트 전체에서의 체크박스 순서 (코드 블록 제외, tasksOf와 같은 규칙)
export type Criterion = { index: number; label: string; desc: string; text: string; done: boolean; evidence: string[] };
export function criteriaOf(d: Doc): Criterion[] {
  const out: Criterion[] = [];
  let fence = "", n = 0, inSec = false, cur: Criterion | null = null;
  for (const raw of d.body.split("\n")) {
    const l = raw.replace(/\r$/, "");
    const f = l.trim().match(/^(```|~~~)/)?.[1];
    if (f) { if (!fence) fence = f; else if (f === fence) fence = ""; cur = null; continue; }
    if (fence) continue;
    if (/^#{1,2}\s/.test(l)) { inSec = /완료 기준|^##\s+Explain\b/.test(l); cur = null; continue; }
    const m = l.match(TASK);
    if (m) {
      const index = n++;
      if (inSec && !/^\s/.test(l)) {
        const lm = m[2].trim().match(/^\*\*(.+?)\*\*\s*[:：]?\s*(.*)$/);
        cur = { index, label: lm ? lm[1].trim() : m[2].trim().slice(0, 20), desc: lm ? lm[2] : m[2].trim(), text: m[2].trim(), done: m[1] !== " ", evidence: [] };
        out.push(cur);
      } else cur = null;
      continue;
    }
    if (cur && /^\s+[-*+]\s+/.test(l)) cur.evidence.push(l.replace(/^\s+[-*+]\s+/, ""));
    else if (cur && /^\s{3,}\S/.test(l) && cur.evidence.length) cur.evidence[cur.evidence.length - 1] += "\n" + l.trim();
    else if (cur && /^\s{3,}$/.test(l) && cur.evidence.length) cur.evidence[cur.evidence.length - 1] += "\n"; // 증거 안 빈 줄 유지
    else if (cur && l.trim() && !/^\s/.test(l)) cur = null;
  }
  return out;
}

// 완료 기준에 답할 때 볼 노트 본문 칸 (정답 모음이 따로 없으므로 근거가 되는 칸을 보여 줌)
// 검증: 핵심·예제·실습 / 설명: 핵심·실무(자주 발생하는 오류) / 재현: 예제·실습
export function criterionHints(d: Doc, label: string): string {
  const lines = d.body.split("\n");
  const secs: { title: string; body: string }[] = [];
  let fence = "";
  lines.forEach(l => {
    const f = l.trim().match(/^(```|~~~)/)?.[1];
    if (f) fence = !fence ? f : f === fence ? "" : fence;
    if (!fence && !f && /^##\s/.test(l)) secs.push({ title: l.replace(/^##\s+/, "").trim(), body: "" });
    else if (secs.length) secs[secs.length - 1].body += l + "\n";
  });
  const want = /검증/.test(label) ? /^(What|Why|How|Syntax|Example|Code|Practice)\b/
    : /설명/.test(label) ? /^(What|Why|How|Real World)\b/
    : /재현/.test(label) ? /^(Syntax|Example|Code|Practice)\b/ : /^(What|Why|How)\b/;
  return callouts(secs.filter(s => want.test(s.title) && s.body.trim()).map(s => `**${s.title}**\n\n${s.body.trim()}`).join("\n\n"));
}

export function studyCard(d: Doc): { md: string; taskMap: number[] } {
  const c = d.concept!;
  const lines = d.body.split("\n");
  // 줄마다 노트 전체에서의 체크박스 순서 (코드 블록 제외, tasksOf와 같은 규칙)
  const taskAt: number[] = [];
  let fence = "", n = 0;
  for (const l of lines) {
    const f = l.trim().match(/^(```|~~~)/)?.[1];
    if (f) { if (!fence) fence = f; else if (f === fence) fence = ""; taskAt.push(-1); continue; }
    taskAt.push(!fence && TASK.test(l.replace(/\r$/, "")) ? n++ : -1);
  }
  type Sec = { title: string; from: number; to: number };
  const secs: Sec[] = [];
  lines.forEach((l, i) => { if (/^##\s/.test(l)) { if (secs.length) secs[secs.length - 1].to = i; secs.push({ title: l.replace(/^##\s+/, ""), from: i + 1, to: lines.length }); } });
  const pick = (re: RegExp) => secs.filter(x => re.test(x.title));
  const taskMap: number[] = [];
  // 칸 내용 꺼내기. tasks: "only"면 체크박스 줄만, "skip"이면 체크박스 줄 빼고
  // 체크박스 줄 아래 더 들여쓴 줄(완료 기준에 단 증거)은 그 체크박스와 한 묶음
  const take = (ss: Sec[], tasks: "all" | "only" | "skip" = "all", label = false) => ss.map(x => {
    const out: string[] = [];
    let under = false;
    for (let i = x.from; i < x.to; i++) {
      const isTask = taskAt[i] >= 0;
      under = isTask || (under && (/^\s/.test(lines[i]) || !lines[i].trim()));
      const child = !isTask && under;
      if ((tasks === "only" && !isTask && !child) || (tasks === "skip" && (isTask || child))) continue;
      if (isTask) taskMap.push(taskAt[i]);
      out.push(lines[i].replace(/^#{3,6}\s+(.*)$/, "**$1**"));
    }
    const t = out.join("\n").trim();
    const name = `**${x.title.replace(/[:|·].*$/, "").trim()}**`;
    return t && label ? (/^(-|\d+\.|```|>|\|)/.test(t) ? `${name}\n\n${t}` : `${name} — ${t}`) : t;
  }).filter(Boolean).join("\n\n");
  // "- **목표**: …" 줄이 있으면 그 줄만 (위치·선행 안내는 목록에 이미 보임)
  const goalOnly = (t: string) => t.split("\n").some(l => /\*\*목표\*\*/.test(l)) ? t.split("\n").filter(l => /\*\*목표\*\*/.test(l)).join("\n") : t;
  const step = (i: number, body: string, hint: string) => `#### ${"①②③④⑤"[i]} ${STUDY_STEPS[i]}\n\n${body || `> ${hint}`}`;
  if (!d.file) {
    return { taskMap, md: [
      `**${c.name}** — ${c.desc || c.stage}`,
      "> 이 개념은 아직 노트가 없어요. **Enter**로 개념 노트를 만들고, 아래 순서로 채우면서 공부하세요.",
      ...STUDY_STEPS.map((s, i) => `${"①②③④⑤"[i]} ${s}`),
    ].join("\n\n") };
  }
  const read = pick(/^(What|Why|How|Structure|History)\b/);
  // ③ 끝: 먼저 예측해 적게 하고, 기대 관찰(가이드 표)은 펼쳐야 보이게
  const crits = criteriaOf(d), say = crits.find(x => /설명/.test(x.label));
  const predict = [
    "> **먼저 예측** — 실행하기 전에 결과를 ⌘N 메모의 **노트별 검증** 칸에 한 줄로 적고, 실행한 뒤 차이를 덧붙이세요.",
    d.expect ? `<details><summary>답 확인 (예측한 뒤 펼치기)</summary>\n\n**기대 관찰** — ${d.expect.see}\n\n**변형 도전** — ${d.expect.vary}\n\n</details>` : "",
  ].filter(Boolean).join("\n\n");
  // ④: 말로 설명 기준을 질문으로 + 설명 채점 (정의·이유·흐름·예·반례 중 4개 이상)
  const ask = say ? [...questionsOf(say).map((x, i) => `${i + 1}. ${x}`),
    "", "> 채점: 정의 · 필요한 이유 · 내부 흐름 · 직접 만든 예 · 반례·제약 — 5개 중 4개 이상이면 통과"].join("\n") : "";
  const md = [
    step(0, goalOnly(take(pick(/목표/), "skip")), "이 개념으로 무엇을 할 수 있어야 하는지 한 줄로 적어 보세요."),
    step(1, [take(read, "skip", read.length > 1), take(pick(/자료|더 읽기/))].filter(Boolean).join("\n\n"),
      "공식 문서나 강의에서 정의·필요한 이유·동작 원리를 찾아 읽으세요."),
    // 실습 칸의 체크박스도 그대로 (완료 기준 칸과 겹치지 않음)
    step(2, [take(pick(/^(Syntax|Example|Code)\b/)), take(pick(/^Practice\b/)), take(pick(/^Debugging\b/), "all", true), predict].filter(Boolean).join("\n\n"),
      "결과를 먼저 예측해 적고, 직접 실행해서 맞는지 확인하세요."),
    step(3, [take(pick(/^Explain\b/), "skip"), ask].filter(Boolean).join("\n\n"), "노트를 닫고 60초 동안 문제 → 동작 → 실패하는 경우 순서로 말해 보세요."),
    step(4, take(pick(/^Explain\b|완료 기준/), "only"), "실습 결과·커밋·스크린샷 중 하나를 증거로 남기세요."),
    "> ⌘N 이 개념 노트에 배운 점·막힌 점 기록 · ⌘D 상태 바꾸기 · ⌘O 노트 전체 열기",
  ].join("\n\n");
  return { md: toMarkdown(md, new Map()), taskMap };
}
