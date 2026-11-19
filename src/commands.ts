import { invoke } from "@tauri-apps/api/core";
import { NoteSearch, KIND_LABELS } from "./notes";

// confirm이 있으면 Enter를 한 번 더 눌러야 실행 (되돌릴 수 없는 동작)
// keep: 실행 후 입력창을 비우지 않음 (예시 입력, AI 질문 등)
// shortcut: ⌘K 없이 바로 실행하는 키 ("⌘↵", "⌘O" 등)
export type Action = { title: string; confirm?: string; keep?: boolean; shortcut?: string; run: () => Promise<unknown> };
export type Kind = "app" | "file" | "calc" | "web" | "ai" | "cmd" | "link" | "snippet" | "ext" | "store" | "wiki";
// actions[0]이 Enter로 실행되는 기본 동작, 나머지는 ⌘K 패널에서 선택
// section: 목록에서 이 항목 위에 보일 묶음 제목 (앞 항목과 다를 때만 표시)
export type Item = { id: string; title: string; subtitle: string; kind: Kind; glyph?: string; path?: string; section?: string; actions: Action[] };
type AppEntry = { name: string; alias: string; path: string };
type Quicklink = { keyword: string; name: string; url: string };
type Snippet = { keyword: string; name: string; text: string };
export type Config = { ai_ready: boolean; ai_model: string; quicklinks: Quicklink[]; snippets: Snippet[]; store_ready: boolean; note_searches: NoteSearch[]; error: string | null };
type ExtCommand = { name: string; title: string; keywords: string; keyword: string; mode: "copy" | "view" | "open" | "silent"; script: string };
export type Manifest = { id: string; name: string; description: string; version: string; author: string; commands: ExtCommand[] };
export type StoreEntry = { id: string; name: string; description: string; version: string; author: string };

// 목록 밖의 화면: 텍스트 결과, 권한 안내
export type View = { kind: "text"; title: string; text: string; error?: boolean } | { kind: "perm"; perm: string };
// 화면(App)이 넘겨주는 동작들
export type Ui = { ask: (q: string) => void; askNotes: (q: string) => void; show: (v: View) => void; openStore: () => void; openNotes: (id: string, graph?: boolean) => void; openGraph: () => void; openFiles: () => void; openMemo: () => void; openClip: () => void; openNoteManager: () => void; openHotkeys: () => void; togglePin: () => void; setQuery: (q: string) => void };

const isMac = navigator.userAgent.includes("Mac");
let config: Config = { ai_ready: false, ai_model: "", quicklinks: [], snippets: [], store_ready: false, note_searches: [], error: null };
export const getConfig = () => config;
let exts: Manifest[] = [];
export async function loadConfig() {
  try { config = await invoke<Config>("get_config"); } catch { /* 이전 설정 유지 */ }
  try { exts = await invoke<Manifest[]>("ext_list"); } catch { exts = []; }
  return config;
}

export async function copy(text: string) {
  await navigator.clipboard.writeText(text);
  await invoke("hide");
}
export async function pasteText(text: string) {
  await navigator.clipboard.writeText(text);
  await invoke("paste");
}
// 비밀번호: "숨김" 표시를 붙여 복사 → 클립보드 기록에 남지 않음
export async function copySecret(text: string) {
  await invoke("copy_secret", { text });
  await invoke("hide");
}
export async function pasteSecret(text: string) {
  await invoke("copy_secret", { text });
  await invoke("paste");
}

// 순서대로 글자가 들어있으면 일치. 앞부분 일치일수록 점수가 높음 (0 = 불일치)
function score(q: string, ...fields: string[]) {
  const s = q.toLowerCase();
  let best = 0;
  for (const f0 of fields) {
    const f = f0.toLowerCase();
    // 전체 또는 단어 하나가 검색어로 시작하면 3 ("extension store"의 store)
    if (f.startsWith(s) || f.split(/\s+/).some(w => w.startsWith(s))) best = Math.max(best, 3);
    else if (f.includes(s)) best = Math.max(best, 2);
    else { let i = 0; for (const c of f) if (c === s[i]) i++; if (i === s.length) best = Math.max(best, 1); }
  }
  return best;
}

// 계산기: 숫자/연산자만 허용 후 평가
function calc(q: string): Item | null {
  if (!/^[\d+\-*/().%\s^]+$/.test(q) || !/[+\-*/%^]/.test(q)) return null;
  try {
    const v = Function(`"use strict";return (${q.replace(/\^/g, "**")})`)();
    if (typeof v !== "number" || !isFinite(v)) return null;
    const r = String(+v.toFixed(10));
    return { id: "calc", title: r, subtitle: "계산 결과", kind: "calc", glyph: "calc", actions: [
      { title: "결과 복사", run: () => copy(r) },
      { title: "수식과 결과 복사", run: () => copy(`${q} = ${r}`) },
    ] };
  } catch { return null; }
}

// 창 관리·시스템 명령 (macOS)
type Cmd = { id: string; title: string; keys: string; glyph: string; confirm?: string; run: (ui: Ui) => Promise<unknown> };
const layout = (kind: string) => () => invoke("window_layout", { kind });
const sys = (cmd: string) => () => invoke("system_cmd", { cmd });
const COMMANDS: Cmd[] = [
  { id: "w-left", title: "창: 왼쪽 절반", keys: "window left half 왼쪽", glyph: "left", run: layout("left") },
  { id: "w-right", title: "창: 오른쪽 절반", keys: "window right half 오른쪽", glyph: "right", run: layout("right") },
  { id: "w-top", title: "창: 위쪽 절반", keys: "window top half 위쪽", glyph: "top", run: layout("top") },
  { id: "w-bottom", title: "창: 아래쪽 절반", keys: "window bottom half 아래쪽", glyph: "bottom", run: layout("bottom") },
  { id: "w-max", title: "창: 최대화", keys: "window maximize 최대화 전체", glyph: "max", run: layout("max") },
  { id: "w-center", title: "창: 가운데로", keys: "window center 가운데 중앙", glyph: "center", run: layout("center") },
  { id: "s-sleep", title: "잠자기", keys: "sleep 잠자기 절전", glyph: "moon", run: sys("sleep") },
  { id: "s-lock", title: "화면 끄기·잠금", keys: "lock screen 잠금 화면", glyph: "lock", run: sys("lock") },
  { id: "s-trash", title: "휴지통 비우기", keys: "empty trash 휴지통", glyph: "trash", confirm: "휴지통의 파일이 영구 삭제돼요. Enter를 한 번 더 누르면 비워요.", run: sys("trash") },
  { id: "s-dark", title: "다크 모드 전환", keys: "dark mode appearance 다크 모드", glyph: "contrast", run: sys("dark") },
  { id: "s-mute", title: "소리 끄기·켜기", keys: "mute volume 음소거 소리", glyph: "mute", run: sys("mute") },
  { id: "b-notes", title: "노트 검색 관리", keys: "note search obsidian 옵시디언 노트 검색 만들기 추가 관리", glyph: "folder", run: async ui => ui.openNoteManager() },
  { id: "b-pin", title: "창 고정·해제", keys: "pin float always on top 고정 항상 위", glyph: "pin", run: async ui => ui.togglePin() },
  { id: "b-files", title: "파일 찾기 (Finder)", keys: "files finder find 파일 찾기 위치 폴더", glyph: "file", run: async ui => ui.openFiles() },
  { id: "b-memo", title: "빠른 메모", keys: "memo note 메모 기록 적기 daily 데일리 공부 기록", glyph: "memo", run: async ui => ui.openMemo() },
  { id: "b-clip", title: "클립보드 기록", keys: "clipboard history 클립보드 기록 복사 붙여넣기 paste", glyph: "clip", run: async ui => ui.openClip() },
  { id: "b-expand", title: "스니펫 자동 입력 켜기·끄기", keys: "snippet expand text expansion 스니펫 자동 입력 확장 치환 세미콜론", glyph: "snippet",
    run: async ui => {
      const on = !(await invoke<boolean>("snippet_expand_state"));
      await invoke("snippet_expand_set", { on });
      ui.show({ kind: "text", title: on ? "스니펫 자동 입력을 켰어요" : "스니펫 자동 입력을 껐어요",
        text: on ? `어느 앱에서든 ;키워드를 치면 본문으로 바뀌어요 (영문 입력 상태에서).\n${config.snippets.map(s => `;${s.keyword} → ${s.name}`).join("\n")}\n\n스니펫은 Baro 설정(config.json)의 snippets에서 고쳐요.`
          : "이제 ;키워드를 쳐도 바뀌지 않아요." });
    } },
  { id: "b-embed", title: "노트 뜻 색인 만들기", keys: "embedding index semantic 임베딩 뜻 의미 색인 노트 검색 bge", glyph: "notesAi",
    run: async ui => {
      const n = await invoke<number>("notes_embed_build");
      ui.show({ kind: "text", title: n ? "노트 뜻 색인 만드는 중" : "노트 뜻 색인이 이미 최신이에요",
        text: n ? `단락 ${n}개를 로컬 Ollama(bge-m3)로 계산해요. 몇 분 걸리고 그동안 CPU·GPU를 써요.\n창을 닫아도 계속 만들어요.`
          : "내 노트에게 묻기가 단어 검색과 뜻 검색을 함께 써요. 노트가 바뀌면 질문할 때 바뀐 단락만 다시 계산해요." });
    } },
  { id: "b-graph", title: "노트 그래프", keys: "graph vault 그래프 전체 노트 연결 링크 obsidian 옵시디언", glyph: "graph", run: async ui => ui.openGraph() },
  { id: "b-center", title: "Baro 창 위치 초기화", keys: "center reset window position 가운데 위치 초기화 창", glyph: "center", run: () => invoke("set_placed", { on: false }) },
  { id: "b-hotkeys", title: "단축키 설정", keys: "hotkey shortcut keyboard 단축키", glyph: "keyboard", run: async ui => ui.openHotkeys() },
  { id: "b-store", title: "확장 스토어", keys: "extension store install 확장 스토어 설치", glyph: "download", run: async ui => ui.openStore() },
  { id: "b-perm", title: "Baro 권한 확인", keys: "permission accessibility 권한 손쉬운 사용", glyph: "shield",
    run: async ui => ui.show({ kind: "perm", perm: (await invoke<{ accessibility: boolean }>("permissions")).accessibility ? "ok" : "accessibility" }) },
  { id: "b-config", title: "Baro 설정 열기", keys: "settings config preferences 설정 스니펫 퀵링크 api", glyph: "settings", run: () => invoke("open_config") },
  { id: "b-quit", title: "Baro 종료", keys: "quit exit 종료", glyph: "power", run: sys("quit") },
];

function expand(text: string) {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return text.replace(/\{date\}/g, `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`)
    .replace(/\{time\}/g, `${p(d.getHours())}:${p(d.getMinutes())}`);
}

function quicklinks(q: string): Item[] {
  const [kw, ...rest] = q.split(/\s+/);
  const arg = rest.join(" ");
  return config.quicklinks.flatMap(l => {
    const exact = kw.toLowerCase() === l.keyword.toLowerCase();
    if (!exact && !(rest.length === 0 && score(q, l.keyword, l.name) >= 2)) return [];
    const term = exact ? arg : "";
    const url = l.url.replace(/\{query\}/g, encodeURIComponent(term));
    return [{ id: `ql-${l.keyword}`, title: term ? `${l.name}: ${term}` : l.name, kind: "link" as const, glyph: "link",
      subtitle: term ? "퀵링크" : `${l.keyword} 검색어`,
      actions: [{ title: "열기", run: () => invoke("open_url", { url }) }, { title: "URL 복사", run: () => copy(url) }] }];
  });
}

function snippets(q: string): Item[] {
  return config.snippets.filter(s => score(q, s.keyword, s.name) >= 2).map(s => {
    const text = () => expand(s.text);
    return { id: `sn-${s.keyword}`, title: s.name, subtitle: `스니펫 · ${expand(s.text).split("\n")[0].slice(0, 30)}`,
      kind: "snippet" as const, glyph: "snippet", actions: [
        { title: "복사", run: () => copy(text()) },
        { title: "앞 앱에 붙여넣기", run: () => pasteText(text()) },
      ] };
  });
}

type Scored = { s: number; item: Item };
function commands(q: string, ui: Ui): Scored[] {
  if (!isMac) return [];
  // 사용자가 만든 노트 검색도 명령처럼 찾을 수 있게
  const notes: Cmd[] = config.note_searches.map(n => ({ id: `note-${n.id}`, title: n.name, glyph: KIND_LABELS[n.kind]?.glyph ?? "doc",
    keys: `노트 note obsidian 옵시디언 ${KIND_LABELS[n.kind]?.title ?? ""}`, run: async u => u.openNotes(n.id) }));
  return [...notes, ...COMMANDS].map(c => ({ c, s: score(q, c.title, c.keys) }))
    .filter(x => x.s >= (q.length < 2 ? 3 : 1)).sort((a, b) => b.s - a.s).slice(0, 5)
    .map(({ c, s }) => ({ s, item: { id: c.id, title: c.title, kind: c.id.startsWith("note-") ? "wiki" as const : "cmd" as const,
      subtitle: c.id.startsWith("w-") ? "창 관리" : c.id.startsWith("note-") ? "노트 검색" : "명령",
      glyph: c.glyph, actions: [{ title: "실행", confirm: c.confirm, run: () => c.run(ui) }] } }));
}

// 설치된 확장의 명령. keyword가 있으면 "keyword 내용"의 내용을 스크립트에 넘김
function extItems(q: string, ui: Ui): Scored[] {
  const [kw, ...rest] = q.split(/\s+/);
  return exts.flatMap(m => m.commands.map(c => {
    const exact = !!c.keyword && kw.toLowerCase() === c.keyword.toLowerCase();
    const s = exact ? 4 : score(q, c.title, c.keywords, m.name);
    const arg = exact ? rest.join(" ") : "";
    const exec = async () => {
      const out = await invoke<string>("ext_run", { id: m.id, name: c.name, arg });
      if (c.mode === "copy") return copy(out);
      if (c.mode === "open") return invoke("open_url", { url: out.trim() });
      if (c.mode === "view") return ui.show({ kind: "text", title: c.title, text: out || "(출력 없음)" });
      return invoke("hide");
    };
    const item: Item = { id: `ext-${m.id}-${c.name}`, title: arg ? `${c.title}: ${arg}` : c.title,
      subtitle: c.keyword && !exact ? `${m.name} · ${c.keyword} 내용` : m.name, kind: "ext", glyph: m.name[0],
      actions: [{ title: { copy: "실행 후 복사", view: "실행", open: "실행 후 열기", silent: "실행" }[c.mode], run: exec }] };
    return { s, item };
  })).filter(x => x.s >= (q.length < 2 ? 3 : 1)).sort((a, b) => b.s - a.s).slice(0, 5);
}

// 확장 스토어 화면의 항목
export function storeItems(q: string, entries: StoreEntry[], refresh: () => void, ui: Ui): Item[] {
  const installed = new Map(exts.map(m => [m.id, m]));
  return entries.filter(e => !q.trim() || score(q.trim(), e.name, e.description, e.id) > 0).map(e => {
    const have = installed.get(e.id);
    const install = async () => {
      const m = await invoke<Manifest>("store_install", { id: e.id });
      await loadConfig(); refresh();
      ui.show({ kind: "text", title: `${m.name} 설치 완료`, text: m.commands.map(c => `• ${c.title}${c.keyword ? `  (${c.keyword} 내용)` : ""}`).join("\n") });
    };
    const warn = `${e.name}의 스크립트가 내 Mac에서 실행돼요. 믿을 수 있는 확장이면 Enter를 한 번 더 누르세요.`;
    return { id: `store-${e.id}`, title: e.name, kind: "store" as const, glyph: e.name[0],
      subtitle: have ? `설치됨 · v${have.version}` : `${e.description} · v${e.version}`,
      actions: have ? [
        { title: "다시 설치(업데이트)", confirm: warn, run: install },
        { title: "삭제", confirm: `${e.name}을(를) 삭제할까요? Enter를 한 번 더 누르면 삭제해요.`,
          run: async () => { await invoke("store_uninstall", { id: e.id }); await loadConfig(); refresh(); } },
      ] : [{ title: "설치", confirm: warn, run: install }] };
  });
}

// 처음 화면: Baro로 할 수 있는 일. Enter를 누르면 예시를 입력하거나 바로 실행
export function homeItems(ui: Ui): Item[] {
  const ex = (id: string, glyph: string, kind: Kind, title: string, subtitle: string, example: string): Item =>
    ({ id: `home-${id}`, title, subtitle, kind, glyph, actions: [{ title: "예시 입력", keep: true, run: async () => ui.setQuery(example) }] });
  const go = (id: string, glyph: string, kind: Kind, title: string, subtitle: string, label: string, run: () => Promise<unknown>, keep = false): Item =>
    ({ id: `home-${id}`, title, subtitle, kind, glyph, actions: [{ title: label, keep, run }] });
  return [
    ex("apps", "app", "app", "앱 실행", "앱 이름 입력 · 예: 사파리", "사파리"),
    go("files", "file", "cmd", "파일 찾기", "홈 · 외장 디스크에서 이름으로 찾고 Finder로 위치 보기", "열기", async () => ui.openFiles(), true),
    go("memo", "memo", "cmd", "빠른 메모", "오늘 Daily나 공부 중인 단계의 내 기록에 한 줄 적기", "열기", async () => ui.openMemo(), true),
    go("clip", "clip", "cmd", "클립보드 기록", "복사했던 글을 다시 찾아 붙여넣기", "열기", async () => ui.openClip(), true),
    ex("calc", "calc", "calc", "계산기", "수식 입력 · 예: 12*3+4", "12*3+4"),
    ex("notesAi", "notesAi", "ai", "내 노트에게 묻기", config.ai_ready ? "질문 입력 후 ⌘↵ · 내 Obsidian 노트에서 찾아 출처와 함께 답해요" : "설정에서 AI 연결 필요", "Tauri에서 링크를 기본 브라우저로 여는 방법"),
    ex("ai", "ai", "ai", "AI에게 묻기", config.ai_ready ? `질문 입력 후 Tab · ${config.ai_model}` : "설정에서 AI 연결 필요", "맥북 생산성 단축키 3개 추천해줘"),
    ex("window", "left", "cmd", "창 관리", "창 · 왼쪽/오른쪽 절반, 최대화", "창"),
    ex("links", "link", "link", "퀵링크", config.quicklinks.map(l => l.keyword).join(", ") + " + 검색어", config.quicklinks[0] ? `${config.quicklinks[0].keyword} ` : "yt "),
    ex("snippets", "snippet", "snippet", "스니펫", config.snippets.map(s => s.keyword).join(", "), config.snippets[0]?.keyword ?? "today"),
    ex("system", "moon", "cmd", "시스템 명령", "잠자기, 화면 잠금, 휴지통 비우기, 다크 모드", "휴지통"),
    ...config.note_searches.map(n => go(`note-${n.id}`, KIND_LABELS[n.kind]?.glyph ?? "doc", "wiki", n.name,
      `노트 검색 · ${KIND_LABELS[n.kind]?.title ?? n.kind}`, "열기", async () => ui.openNotes(n.id), true)),
    go("graph", "graph", "wiki", "노트 그래프", "Obsidian 전체 노트의 연결을 그래프로", "열기", async () => ui.openGraph(), true),
    go("notes", "folder", "cmd", "노트 검색 만들기·관리", "Obsidian 폴더를 골라 나만의 검색 기능 추가", "열기", async () => ui.openNoteManager(), true),
    go("store", "download", "store", "확장 스토어", exts.length ? `확장 ${exts.length}개 설치됨` : "확장 검색·설치", "열기", async () => ui.openStore(), true),
    go("hotkeys", "keyboard", "cmd", "단축키 설정", "기능별 단축키를 직접 지정", "열기", async () => ui.openHotkeys(), true),
    go("config", "settings", "cmd", "Baro 설정", "퀵링크·스니펫·AI 모델 편집", "열기", () => invoke("open_config")),
  ];
}

export function aiItem(q: string, ask: (q: string) => void, askNotes?: (q: string) => void): Item {
  return config.ai_ready
    ? { id: "ai", title: `AI에게 묻기: ${q}`, subtitle: `${config.ai_model} · Tab`, kind: "ai", glyph: "ai",
        actions: [{ title: "AI에게 묻기", keep: true, run: async () => ask(q) },
          ...(askNotes ? [{ title: "내 노트에서 찾아 묻기", shortcut: "⌘↵", keep: true, run: async () => askNotes(q) }] : [])] }
    : { id: "ai", title: "AI에게 묻기 (API 키 필요)", subtitle: "설정 열기", kind: "ai", glyph: "ai",
        actions: [{ title: "설정 파일 열기", run: () => invoke("open_config") }] };
}

// 내 노트에게 묻기: Vault에서 관련 노트를 찾아 그 발췌로 답함 (출처 노트 표시)
export function notesAiItem(q: string, askNotes: (q: string) => void): Item | null {
  if (!config.ai_ready) return null;
  return { id: "ai-notes", title: `내 노트에게 묻기: ${q}`, subtitle: `Obsidian 노트에서 찾아 답해요 · ⌘↵`, kind: "ai", glyph: "notesAi",
    actions: [{ title: "내 노트에게 묻기", keep: true, run: async () => askNotes(q) }] };
}

// 빠른 결과(top) / 마지막에 붙는 항목(bottom). 파일 검색 결과는 그 사이에 따로 들어감
export async function query(q: string, ui: Ui): Promise<{ top: Item[]; bottom: Item[] }> {
  q = q.trim();
  if (!q) return { top: [], bottom: [] };
  const top: Item[] = [];
  if (config.error) top.push({ id: "cfg-err", title: "설정 파일을 읽지 못했어요", subtitle: config.error, kind: "cmd", glyph: "warn",
    actions: [{ title: "설정 파일 열기", run: () => invoke("open_config") }] });
  const c = calc(q); if (c) top.push(c);
  top.push(...quicklinks(q));
  const apps = await invoke<AppEntry[]>("search", { q });
  // Baro 명령·확장이 이름이나 키워드 단어로 시작하면 앱보다 먼저. 단, 앱 이름 자체가 검색어로 시작하면 앱 우선
  const cmds = [...extItems(q, ui), ...commands(q, ui)];
  const appFirst = q.length < 2 || apps.some(a => [a.name, a.alias].some(n => n.toLowerCase().startsWith(q.toLowerCase())));
  const strong = appFirst ? [] : cmds.filter(x => x.s >= 3);
  top.push(...strong.map(x => x.item));
  apps.forEach(a => top.push({ id: a.path, title: a.name, subtitle: "앱", kind: "app", path: a.path, actions: [
    { title: "열기", run: () => invoke("launch", { path: a.path }) },
    { title: isMac ? "Finder에서 보기" : "폴더에서 보기", run: () => invoke("reveal", { path: a.path }) },
    { title: "경로 복사", run: () => copy(a.path) },
    { title: "이름 복사", run: () => copy(a.name) },
  ] }));
  top.push(...cmds.filter(x => !strong.includes(x)).map(x => x.item), ...snippets(q));
  const url = `https://www.google.com/search?q=${encodeURIComponent(q)}`;
  const bottom: Item[] = [{ id: "web", title: `"${q}" 웹에서 검색`, subtitle: "Google", kind: "web", glyph: "globe", actions: [
    { title: "Google에서 검색", run: () => invoke("open_url", { url }) },
    { title: "검색어 복사", run: () => copy(q) },
    { title: "검색 URL 복사", run: () => copy(url) },
  ] }, aiItem(q, ui.ask, ui.askNotes), ...[notesAiItem(q, ui.askNotes)].filter((x): x is Item => !!x)];
  return { top, bottom };
}

// 파일 검색 (Spotlight). wide: 파일 찾기 화면 — 홈 + 외장 디스크, Enter가 Finder에서 보기
export async function fileItems(q: string, wide = false): Promise<Item[]> {
  q = q.trim();
  if (q.length < (wide ? 1 : 2) || !isMac) return [];
  const paths = await invoke<string[]>(wide ? "files_wide" : "files", { q }).catch(() => [] as string[]);
  return paths.map(p0 => {
    const p = p0.normalize("NFC");
    const name = p.split("/").pop() ?? p;
    const dir = p.slice(0, p.length - name.length - 1).replace(/^\/Users\/[^/]+/, "~");
    const open: Action = { title: "열기", shortcut: wide ? "⌘O" : undefined, run: () => invoke("open_path", { path: p0 }) };
    const finder: Action = { title: "Finder에서 보기", run: () => invoke("reveal", { path: p0 }) };
    const path: Action = { title: "경로 복사", shortcut: wide ? "⌘C" : undefined, run: () => copy(p0) };
    return { id: `f-${p}`, title: name, subtitle: dir, kind: "file" as const, path: p0,
      actions: wide ? [finder, open, path] : [open, finder, path] };
  });
}

// 앱·파일 아이콘 (경로별 캐시)
const icons = new Map<string, Promise<string | null>>();
export function iconFor(path: string) {
  if (!icons.has(path)) icons.set(path, invoke<string | null>("icon", { path }).catch(() => null));
  return icons.get(path)!;
}
