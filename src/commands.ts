import { invoke } from "@tauri-apps/api/core";

// confirm이 있으면 Enter를 한 번 더 눌러야 실행 (되돌릴 수 없는 동작)
export type Action = { title: string; confirm?: string; run: () => Promise<unknown> };
export type Kind = "app" | "file" | "calc" | "web" | "ai" | "cmd" | "link" | "snippet" | "ext" | "store";
// actions[0]이 Enter로 실행되는 기본 동작, 나머지는 ⌘K 패널에서 선택
export type Item = { id: string; title: string; subtitle: string; kind: Kind; glyph?: string; path?: string; actions: Action[] };
type AppEntry = { name: string; alias: string; path: string };
type Quicklink = { keyword: string; name: string; url: string };
type Snippet = { keyword: string; name: string; text: string };
export type Config = { ai_ready: boolean; ai_model: string; quicklinks: Quicklink[]; snippets: Snippet[]; store_ready: boolean; error: string | null };
type ExtCommand = { name: string; title: string; keywords: string; keyword: string; mode: "copy" | "view" | "open" | "silent"; script: string };
export type Manifest = { id: string; name: string; description: string; version: string; author: string; commands: ExtCommand[] };
export type StoreEntry = { id: string; name: string; description: string; version: string; author: string };

// 목록 밖의 화면: 텍스트 결과, 권한 안내
export type View = { kind: "text"; title: string; text: string; error?: boolean } | { kind: "perm"; perm: string };
// 화면(App)이 넘겨주는 동작들
export type Ui = { ask: (q: string) => void; show: (v: View) => void; openStore: () => void };

const isMac = navigator.userAgent.includes("Mac");
let config: Config = { ai_ready: false, ai_model: "", quicklinks: [], snippets: [], store_ready: false, error: null };
let exts: Manifest[] = [];
export async function loadConfig() {
  try { config = await invoke<Config>("get_config"); } catch { /* 이전 설정 유지 */ }
  try { exts = await invoke<Manifest[]>("ext_list"); } catch { exts = []; }
  return config;
}

async function copy(text: string) {
  await navigator.clipboard.writeText(text);
  await invoke("hide");
}
async function pasteText(text: string) {
  await navigator.clipboard.writeText(text);
  await invoke("paste");
}

// 순서대로 글자가 들어있으면 일치. 앞부분 일치일수록 점수가 높음 (0 = 불일치)
function score(q: string, ...fields: string[]) {
  const s = q.toLowerCase();
  let best = 0;
  for (const f0 of fields) {
    const f = f0.toLowerCase();
    if (f.startsWith(s)) best = Math.max(best, 3);
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
    return { id: "calc", title: r, subtitle: "계산 결과", kind: "calc", glyph: "=", actions: [
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
  { id: "w-left", title: "창: 왼쪽 절반", keys: "window left half 왼쪽", glyph: "◧", run: layout("left") },
  { id: "w-right", title: "창: 오른쪽 절반", keys: "window right half 오른쪽", glyph: "◨", run: layout("right") },
  { id: "w-top", title: "창: 위쪽 절반", keys: "window top half 위쪽", glyph: "⬒", run: layout("top") },
  { id: "w-bottom", title: "창: 아래쪽 절반", keys: "window bottom half 아래쪽", glyph: "⬓", run: layout("bottom") },
  { id: "w-max", title: "창: 최대화", keys: "window maximize 최대화 전체", glyph: "▣", run: layout("max") },
  { id: "w-center", title: "창: 가운데로", keys: "window center 가운데 중앙", glyph: "◫", run: layout("center") },
  { id: "s-sleep", title: "잠자기", keys: "sleep 잠자기 절전", glyph: "☾", run: sys("sleep") },
  { id: "s-lock", title: "화면 끄기·잠금", keys: "lock screen 잠금 화면", glyph: "⏻", run: sys("lock") },
  { id: "s-trash", title: "휴지통 비우기", keys: "empty trash 휴지통", glyph: "⌫", confirm: "휴지통의 파일이 영구 삭제돼요. Enter를 한 번 더 누르면 비워요.", run: sys("trash") },
  { id: "s-dark", title: "다크 모드 전환", keys: "dark mode appearance 다크 모드", glyph: "◐", run: sys("dark") },
  { id: "s-mute", title: "소리 끄기·켜기", keys: "mute volume 음소거 소리", glyph: "♪", run: sys("mute") },
  { id: "b-store", title: "확장 스토어", keys: "extension store install 확장 스토어 설치", glyph: "⬇", run: async ui => ui.openStore() },
  { id: "b-perm", title: "Baro 권한 확인", keys: "permission accessibility 권한 손쉬운 사용", glyph: "✓",
    run: async ui => ui.show({ kind: "perm", perm: (await invoke<{ accessibility: boolean }>("permissions")).accessibility ? "ok" : "accessibility" }) },
  { id: "b-config", title: "Baro 설정 열기", keys: "settings config preferences 설정 스니펫 퀵링크 api", glyph: "⚙", run: () => invoke("open_config") },
  { id: "b-quit", title: "Baro 종료", keys: "quit exit 종료", glyph: "✕", run: sys("quit") },
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
    return [{ id: `ql-${l.keyword}`, title: term ? `${l.name}: ${term}` : l.name, kind: "link" as const, glyph: "↗",
      subtitle: term ? "퀵링크" : `${l.keyword} 검색어`,
      actions: [{ title: "열기", run: () => invoke("open_url", { url }) }, { title: "URL 복사", run: () => copy(url) }] }];
  });
}

function snippets(q: string): Item[] {
  return config.snippets.filter(s => score(q, s.keyword, s.name) >= 2).map(s => {
    const text = () => expand(s.text);
    return { id: `sn-${s.keyword}`, title: s.name, subtitle: `스니펫 · ${expand(s.text).split("\n")[0].slice(0, 30)}`,
      kind: "snippet" as const, glyph: "¶", actions: [
        { title: "복사", run: () => copy(text()) },
        { title: "앞 앱에 붙여넣기", run: () => pasteText(text()) },
      ] };
  });
}

function commands(q: string, ui: Ui): Item[] {
  if (!isMac) return [];
  return COMMANDS.map(c => ({ c, s: score(q, c.title, c.keys) }))
    .filter(x => x.s >= (q.length < 2 ? 3 : 1)).sort((a, b) => b.s - a.s).slice(0, 5)
    .map(({ c }) => ({ id: c.id, title: c.title, subtitle: c.id.startsWith("w-") ? "창 관리" : "명령", kind: "cmd" as const,
      glyph: c.glyph, actions: [{ title: "실행", confirm: c.confirm, run: () => c.run(ui) }] }));
}

// 설치된 확장의 명령. keyword가 있으면 "keyword 내용"의 내용을 스크립트에 넘김
function extItems(q: string, ui: Ui): Item[] {
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
  })).filter(x => x.s >= (q.length < 2 ? 3 : 1)).sort((a, b) => b.s - a.s).slice(0, 5).map(x => x.item);
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

export function aiItem(q: string, ask: (q: string) => void): Item {
  return config.ai_ready
    ? { id: "ai", title: `AI에게 묻기: ${q}`, subtitle: `${config.ai_model} · Tab`, kind: "ai", glyph: "✦",
        actions: [{ title: "AI에게 묻기", run: async () => ask(q) }] }
    : { id: "ai", title: "AI에게 묻기 (API 키 필요)", subtitle: "설정 열기", kind: "ai", glyph: "✦",
        actions: [{ title: "설정 파일 열기", run: () => invoke("open_config") }] };
}

// 빠른 결과(top) / 마지막에 붙는 항목(bottom). 파일 검색 결과는 그 사이에 따로 들어감
export async function query(q: string, ui: Ui): Promise<{ top: Item[]; bottom: Item[] }> {
  q = q.trim();
  if (!q) return { top: [], bottom: [] };
  const top: Item[] = [];
  if (config.error) top.push({ id: "cfg-err", title: "설정 파일을 읽지 못했어요", subtitle: config.error, kind: "cmd", glyph: "!",
    actions: [{ title: "설정 파일 열기", run: () => invoke("open_config") }] });
  const c = calc(q); if (c) top.push(c);
  top.push(...quicklinks(q));
  const apps = await invoke<AppEntry[]>("search", { q });
  apps.forEach(a => top.push({ id: a.path, title: a.name, subtitle: "앱", kind: "app", path: a.path, actions: [
    { title: "열기", run: () => invoke("launch", { path: a.path }) },
    { title: isMac ? "Finder에서 보기" : "폴더에서 보기", run: () => invoke("reveal", { path: a.path }) },
    { title: "경로 복사", run: () => copy(a.path) },
    { title: "이름 복사", run: () => copy(a.name) },
  ] }));
  top.push(...extItems(q, ui), ...commands(q, ui), ...snippets(q));
  const url = `https://www.google.com/search?q=${encodeURIComponent(q)}`;
  const bottom: Item[] = [{ id: "web", title: `"${q}" 웹에서 검색`, subtitle: "Google", kind: "web", glyph: "G", actions: [
    { title: "Google에서 검색", run: () => invoke("open_url", { url }) },
    { title: "검색어 복사", run: () => copy(q) },
    { title: "검색 URL 복사", run: () => copy(url) },
  ] }, aiItem(q, ui.ask)];
  return { top, bottom };
}

// 파일 검색 (Spotlight)
export async function fileItems(q: string): Promise<Item[]> {
  q = q.trim();
  if (q.length < 2 || !isMac) return [];
  const paths = await invoke<string[]>("files", { q }).catch(() => [] as string[]);
  return paths.map(p0 => {
    const p = p0.normalize("NFC");
    const name = p.split("/").pop() ?? p;
    const dir = p.slice(0, p.length - name.length - 1).replace(/^\/Users\/[^/]+/, "~");
    return { id: `f-${p}`, title: name, subtitle: dir, kind: "file" as const, path: p0, actions: [
      { title: "열기", run: () => invoke("open_path", { path: p0 }) },
      { title: "Finder에서 보기", run: () => invoke("reveal", { path: p0 }) },
      { title: "경로 복사", run: () => copy(p0) },
    ] };
  });
}

// 앱·파일 아이콘 (경로별 캐시)
const icons = new Map<string, Promise<string | null>>();
export function iconFor(path: string) {
  if (!icons.has(path)) icons.set(path, invoke<string | null>("icon", { path }).catch(() => null));
  return icons.get(path)!;
}
