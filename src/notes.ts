// 노트 검색: Obsidian 폴더의 노트를 방식(kind)에 맞게 해석·검색
//  commands: 명령어 사전 (Raycast linux-wiki 확장의 docs.ts를 옮겨 옴) — 머리말 command/category/aliases/summary + 예시
//  notes:    일반 노트 — 제목·태그·본문 검색, 코드 블록을 예시로
//  snippets: 스니펫 모음 — 노트 하나 = 붙여넣을 문구 하나
//  passwords: 비밀번호 모음 — 노트 하나 = 계정 하나. 머리말 password(·login·ssh·key_file)를 가려서 보여 주고 수정
import { invoke } from "@tauri-apps/api/core";

export type NoteKind = "commands" | "notes" | "snippets" | "passwords";
export type NoteSearch = { id: string; name: string; dir: string; kind: NoteKind };
export const KIND_LABELS: Record<NoteKind, { title: string; desc: string; glyph: string }> = {
  commands: { title: "명령어 사전", desc: "머리말(command·category·aliases·summary)과 예시 표·코드를 읽어 예시를 바로 붙여넣기", glyph: "terminal" },
  notes: { title: "일반 노트", desc: "제목·태그·본문으로 찾고 미리보기, 코드 블록은 복사·붙여넣기", glyph: "doc" },
  snippets: { title: "스니펫 모음", desc: "노트 하나가 문구 하나. 고르면 본문을 바로 붙여넣기", glyph: "snippet" },
  passwords: { title: "비밀번호 모음", desc: "머리말 password를 가려서 보여 주고 복사·붙여넣기·수정, 새 노트 추가", glyph: "lock" },
};

export type Example = { cmd: string; desc: string };
export type Doc = {
  name: string; category: string; summary: string; aliases: string[]; related: string[];
  markdown: string; body: string; examples: Example[]; file: string; stub: boolean;
  meta: Record<string, string>; // 머리말의 한 줄 값 (비밀번호 모음: password, login, ssh, key_file …)
};
type Note = { file: string; folder: string; text: string };

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

function toMarkdown(body: string, chapters: Map<string, string>) {
  const out = body.split("\n").map(line => {
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

export async function loadDocs(search: NoteSearch): Promise<Doc[]> {
  const w = await invoke<{ notes: Note[]; chapters: Note[] }>("notes_load", { id: search.id });
  const chapters = new Map([...w.chapters, ...w.notes].map(c => [baseName(c.file), c.text]));
  return w.notes.map(n => {
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
    const name = String(data.title ?? (search.kind === "notes" ? heading : undefined) ?? baseName(n.file));
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
