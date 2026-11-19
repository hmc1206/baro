import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { marked } from "marked";
import {
  query, fileItems, storeItems, homeItems, aiItem, notesAiItem, iconFor, loadConfig, getConfig, copy, pasteText, copySecret, pasteSecret,
  Item, Action, View, Ui, StoreEntry,
} from "./commands";
import { loadDocs, rank, byCategory, Doc, NoteSearch, NoteKind, KIND_LABELS } from "./notes";
import { ICONS } from "./icons";
import { NoteGraph, linkInfo } from "./graph";

function Icon({ it }: { it: Item }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setSrc(null);
    if (it.path) iconFor(it.path).then(s => { if (live) setSrc(s); });
    return () => { live = false; };
  }, [it.path]);
  if (src) return <img className="icon" src={src} alt="" />;
  const Svg = it.glyph ? ICONS[it.glyph] : undefined;
  return <span className={`icon glyph ${it.kind}`}>{Svg ? <Svg size={15} strokeWidth={2.2} /> : (it.glyph ?? it.title[0])}</span>;
}

// 권한별 안내 문구
const PERMS: Record<string, { title: string; body: string }> = {
  accessibility: {
    title: "손쉬운 사용 권한이 필요해요",
    body: "창 관리와 붙여넣기는 다른 앱의 창과 키보드를 제어해야 해서 이 권한이 필요해요.\n\n" +
      "Enter를 누르면 시스템 설정 → 개인정보 보호 및 보안 → 손쉬운 사용 화면이 열려요. 목록에서 Baro를 켜 주세요. " +
      "목록에 없으면 + 버튼으로 /Applications/Baro.app을 추가하세요.\n\n" +
      "Baro를 새로 빌드해 설치하면 권한이 풀릴 수 있어요. 그때는 목록에서 Baro를 지웠다가 다시 추가하세요.",
  },
  automation: {
    title: "자동화 권한이 필요해요",
    body: "휴지통 비우기(Finder), 다크 모드 전환·창 관리·붙여넣기(System Events)는 다른 앱에 명령을 보내야 해서 이 권한이 필요해요.\n\n" +
      "처음 실행할 때 macOS가 \"Baro가 Finder를 제어하려고 합니다\"라고 물으면 허용을 누르세요. 이미 거절했다면 " +
      "Enter를 눌러 시스템 설정 → 개인정보 보호 및 보안 → 자동화에서 Baro 아래 항목을 켜 주세요.",
  },
  input: {
    title: "입력 모니터링 권한이 필요해요",
    body: "스니펫 자동 입력은 어느 앱에서든 ;키워드를 알아채야 해서 키 입력을 읽는 권한이 필요해요. " +
      "입력한 글자는 저장하지 않고 마지막 40글자만 잠깐 비교하며, 비밀번호 칸에서는 macOS가 아예 넘겨주지 않아요.\n\n" +
      "Enter를 누르면 시스템 설정 → 개인정보 보호 및 보안 → 입력 모니터링 화면이 열려요. 목록에서 Baro를 켠 뒤 " +
      "\"스니펫 자동 입력 켜기\"를 다시 실행하세요. (켠 뒤에도 안 되면 Baro를 껐다 켜 주세요.)",
  },
  ok: {
    title: "필요한 권한이 모두 있어요",
    body: "손쉬운 사용: 허용됨\n자동화: 휴지통 비우기·다크 모드를 처음 쓸 때 macOS가 따로 물어봐요.",
  },
};

// 단축키를 지정할 수 있는 기능: 고정 기능(Rust config.rs의 HOTKEY_ACTIONS) + 사용자가 만든 노트 검색
const hotkeyLabels = (): [string, string][] => [
  ["baro", "Baro 열기"], ["ai", "AI에게 묻기"], ["store", "확장 스토어"], ["graph", "노트 그래프 (전체)"], ["files", "파일 찾기 (Finder)"], ["memo", "빠른 메모"], ["clipboard", "클립보드 기록"],
  ...getConfig().note_searches.map(n => [`note:${n.id}`, n.name] as [string, string]),
  // 검색어 없는 퀵링크 (예: 아이디어 캔버스 열기). 누르면 Baro 창 없이 바로 열림
  ...getConfig().quicklinks.filter(l => !l.url.includes("{query}")).map(l => [`link:${l.keyword}`, l.name] as [string, string]),
];
const KEY_NAMES: Record<string, string> = {
  Alt: "⌥", Option: "⌥", Shift: "⇧", Control: "⌃", Ctrl: "⌃", Super: "⌘", Cmd: "⌘", Command: "⌘", Meta: "⌘",
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Enter: "↵", Backquote: "`", Minus: "-", Equal: "=",
  Comma: ",", Period: ".", Slash: "/", Semicolon: ";", Quote: "'", BracketLeft: "[", BracketRight: "]", Backslash: "\\",
};
// "Alt+KeyL" → "⌥L"
export const fmtKey = (accel: string) =>
  accel ? accel.split("+").map(k => KEY_NAMES[k] ?? k.replace(/^Key|^Digit/, "")).join("") : "";
// 눌린 키 → "Alt+Shift+KeyL" (물리 키 이름이라 한글 자판에서도 같음)
function accelOf(e: KeyboardEvent) {
  if (["Shift", "Alt", "Control", "Meta", "CapsLock"].includes(e.key)) return null;
  const mods = [e.ctrlKey && "Control", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Super"].filter(Boolean);
  // 수정 키 없이 쓸 수 있는 건 F1~F20만
  if (!mods.length && !/^F\d+$/.test(e.code)) return null;
  return [...mods, e.code].join("+");
}

// notes: 내 노트에게 묻기 (sources = 찾은 노트, 답변 아래 출처로 표시)
type Source = { title: string; file: string };
type Ai = { id: number; q: string; text: string; busy: boolean; error: string | null; saved?: string; saveError?: string; notes?: boolean; sources?: Source[] };
type Store = { entries: StoreEntry[]; loading: boolean; error: string | null };
type Notes = { search: NoteSearch | null; docs: Doc[]; loading: boolean; error: string | null };
// 노트 검색 추가·수정 화면의 입력값
type Draft = { id: string; name: string; dir: string; kind: NoteKind; hotkey: string; recording: boolean; error: string | null; saving: boolean };
type Hk = { keys: Record<string, string>; recording: string | null; error: string | null };
// 비밀번호 모음: 수정(doc 있음) 또는 새 노트 추가(doc 없음)
type PwDraft = { doc: Doc | null; name: string; title: string; password: string; error: string | null; saving: boolean };
const MASK = "••••••••";
// 커리큘럼 상태: 머리말 status 값 → 표시 이름, ⌘D로 다음 상태
const STATUS: Record<string, string> = { todo: "할 일", doing: "진행 중", "in-progress": "진행 중", done: "완료" };
const nextStatus = (s: string) => s === "todo" || !s ? "doing" : s === "done" ? "todo" : "done";
const weekLabel = (w?: string) => !w ? "" : /^[\d\s~-]+$/.test(w) ? `${w.replace(/-/g, "~")}주` : w;
// 노트 검색별로 읽은 노트 (창을 다시 열 때 바로 보여 주기용). sig: 내용이 바뀌었는지 비교
const docCache = new Map<string, { docs: Doc[]; sig: string }>();
function docsSig(docs: Doc[]) {
  let h = 0;
  for (const d of docs) for (const s of [d.file, d.body]) for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `${docs.length}:${h}`;
}
const lastDoc = (docs: Doc[]) => { const d = byCategory(docs); return d[d.length - 1]; };
const yamlQuote = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const baseOf = (file: string) => file.split("/").pop()!.replace(/\.md$/, "");
// 새 노트 이름 제안: 마지막 노트 이름의 끝 숫자 + 1 (자릿수 유지). 예: Bandit-Level-23 → Bandit-Level-24
function nextName(last?: Doc) {
  const b = last ? baseOf(last.file) : "새-항목-1";
  const m = b.match(/^(.*?)(\d+)$/);
  return m ? m[1] + String(Number(m[2]) + 1).padStart(m[2].length, "0") : `${b}-2`;
}
// 새 노트 내용: 마지막 노트의 머리말을 이어받아 번호만 바꿈 (level·login·ssh 등), 비밀번호는 입력값
function newPwNote(last: Doc | undefined, name: string, title: string, password: string) {
  const oldNum = last?.meta.level ?? baseOf(last?.file ?? "").match(/(\d+)$/)?.[1];
  const newNum = name.match(/(\d+)$/) ? String(Number(name.match(/(\d+)$/)![1])) : undefined;
  const lines = ["---", `created: ${today()}`];
  for (const [k, v0] of Object.entries(last?.meta ?? {})) {
    if (["created", "updated", "password", "key_file"].includes(k)) continue;
    let v = last?.meta.key_file ? v0.replace(`-i ${last.meta.key_file} `, "") : v0;
    if (oldNum && newNum) v = v.replace(new RegExp(`(?<!\\d)${Number(oldNum)}(?!\\d)`, "g"), newNum);
    lines.push(`${k}: ${/^[\w.-]+$/.test(v) ? v : yamlQuote(v)}`);
  }
  if (last?.aliases.length) lines.push(`tags: [${last.aliases.join(", ")}]`);
  lines.push(`password: ${yamlQuote(password)}`, "---");
  const prefix = last ? baseOf(last.file).replace(/\d+$/, "") : "";
  const keep = [...(last?.body.split(/^## 관련\s*$/m)[1] ?? "").matchAll(/\[\[([^\]|#]+)/g)].map(m => m[1]).filter(l => !prefix || !l.startsWith(prefix));
  const links = [...new Set([...keep, ...(last ? [baseOf(last.file)] : [])])].map(l => `[[${l}]]`).join(" · ");
  return `${lines.join("\n")}\n\n# ${title || name}\n\n## 풀이\n- \n\n## 배운 점\n- \n\n## 관련\n${links}\n`;
}
// 화면 종류: null(기본 검색) | 파일 찾기 | 확장 스토어 | 노트 검색 | 예시 고르기 | 단축키 설정 | AI 질문 | 노트 검색 관리 | 노트 검색 추가·수정
type Mode = null | "store" | "note" | "examples" | "hotkeys" | "ask" | "noteManage" | "noteEdit" | "pwEdit" | "files" | "memo" | "clip";
// 클립보드 기록 (Rust clip.rs): at = 복사한 시각(ms), app = 그때 앞에 있던 앱
type Clip = { text: string; at: number; app: string };
const dayOf = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
function clipDay(ms: number) {
  const t = dayOf(Date.now()), y = dayOf(Date.now() - 86400000), d = dayOf(ms);
  return d === t ? "오늘" : d === y ? "어제" : d;
}
const clipTime = (ms: number) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
// 빠른 메모: 기록할 커리큘럼 단계(없으면 Daily만), 어디서 왔는지(Esc로 돌아갈 곳), 결과 문구
type Stage = { search: NoteSearch; doc: Doc };
type Memo = { stage: Stage | null; from: Mode; saved: string | null; error: string | null; finding?: boolean; daily?: string; dailyDate?: string };
// 지운 기록 (⌘Z로 되돌리기): sec는 "daily" 또는 칸 이름
type Removed = { sec: string; id: string; file: string; date: string; line: number; text: string };
const RECORD = { learn: "배운 점", stuck: "막힌 점과 해결", cmd: "사용한 명령어" } as const;
const pad = (n: number) => String(n).padStart(2, "0");
const now = () => { const d = new Date(); return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` }; };
// 명령어 기록: 한 줄이면 "- `cmd`", 여러 줄이거나 `가 있으면 코드 블록
const cmdBlock = (s: string) => !s.includes("\n") && !s.includes("`") ? `- \`${s}\`` : "```bash\n" + s + "\n```";
// 여러 줄 메모 → 목록 한 항목 (둘째 줄부터 들여쓰기)
const listBlock = (s: string) => "- " + s.split("\n").map(l => l.trimEnd()).join("\n  ");
// 기록 항목: "- " 줄 + 들여쓴 이어지는 줄, 또는 ``` 코드 블록 하나 (Rust wiki::items_in과 같은 규칙 — 지울 때 번호가 맞아야 함)
type RecItem = { i: number; first: string; text: string };
function itemsOf(lines: string[]): RecItem[] {
  const out: RecItem[] = [];
  for (let i = 0; i < lines.length;) {
    let j = i + 1;
    if (lines[i].startsWith("```")) { while (j < lines.length && !lines[j].startsWith("```")) j++; j = Math.min(j + 1, lines.length); }
    else if (lines[i].startsWith("- ")) { while (j < lines.length && lines[j].trim() && /^[ \t]/.test(lines[j])) j++; }
    else { i++; continue; }
    out.push({ i: out.length, first: lines[i], text: lines.slice(i, j).join("\n") });
    i = j;
  }
  return out;
}
const sectionRaw = (body: string, name: string) => {
  const lines = body.split("\n"), h = lines.findIndex(l => l.trimEnd() === `### ${name}`);
  if (h < 0) return [];
  const end = lines.findIndex((l, i) => i > h && l.startsWith("#"));
  return lines.slice(h + 1, end < 0 ? undefined : end);
};
const dailyRaw = (text: string) => { const m = text.match(/^---\n[\s\S]*?\n---\n/); return (m ? text.slice(m[0].length) : text).split("\n"); };

export default function App() {
  const [q, setQ] = useState("");
  const [top, setTop] = useState<Item[]>([]);
  const [bottom, setBottom] = useState<Item[]>([]);
  const [files, setFiles] = useState<Item[]>([]);
  const [memo, setMemo] = useState<Memo>({ stage: null, from: null, saved: null, error: null });
  const [delPending, setDelPending] = useState<string | null>(null); // 한 번 누른 × ("칸:번호")
  const [removed, setRemoved] = useState<Removed | null>(null);
  const [found, setFound] = useState<{ items: Item[]; loading: boolean }>({ items: [], loading: false }); // 파일 찾기 화면 결과
  const [sel, setSel] = useState(0);
  const [menu, setMenu] = useState(false); // ⌘K 액션 패널
  const [asel, setAsel] = useState(0);
  // 확인 대기 중인 동작 (항목은 매번 새로 만들어지므로 "항목 id:동작 이름"으로 구분)
  const [pending, setPending] = useState<{ key: string; confirm: string } | null>(null);
  const [ai, setAi] = useState<Ai | null>(null); // AI 답변 화면
  const [view, setView] = useState<View | null>(null); // 텍스트 결과·권한 안내 화면
  const [mode, setMode] = useState<Mode>(null);
  const [store, setStore] = useState<Store>({ entries: [], loading: false, error: null });
  const [notes, setNotes] = useState<Notes>({ search: null, docs: [], loading: false, error: null });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pinned, setPinned] = useState(false); // 창 고정: 다른 앱을 눌러도 화면에 남음
  const togglePin = () => invoke<boolean>("set_pinned", { on: !pinned }).then(setPinned);
  const [exDoc, setExDoc] = useState<{ doc: Doc; prevQ: string } | null>(null); // 예시 고르기 대상
  const [reveal, setReveal] = useState(false); // 비밀번호 모음: 비밀번호 보이기 (⌘R)
  const [pw, setPw] = useState<PwDraft | null>(null);
  const [graph, setGraph] = useState(false); // 노트 검색을 그래프로 보기 (⌘G)
  const [pick, setPick] = useState<Doc | null>(null); // 그래프에서 클릭한 노트
  const [local, setLocal] = useState(0); // 로컬 그래프: 0 끔, 1·2 = 고른 노트에서 몇 단계까지 (⌘L)
  const [clips, setClips] = useState<{ list: Clip[]; enabled: boolean }>({ list: [], enabled: true });
  const [hk, setHk] = useState<Hk>({ keys: {}, recording: null, error: null });
  const aiSeq = useRef(0);
  const input = useRef<HTMLInputElement & HTMLTextAreaElement>(null); // 메모 화면에서는 여러 줄 입력칸(textarea)
  const recRef = useRef<HTMLElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const seq = useRef(0);
  const [rev, setRev] = useState(0);

  const ask = (question: string) => {
    const id = ++aiSeq.current;
    setView(null);
    setAi({ id, q: question, text: "", busy: true, error: null });
    setMenu(false);
    invoke("ask_ai", { id, prompt: question })
      .catch(e => setAi(a => a && a.id === id ? { ...a, busy: false, error: String(e) } : a));
  };
  const askNotes = (question: string) => {
    const id = ++aiSeq.current;
    setView(null);
    setAi({ id, q: question, text: "", busy: true, error: null, notes: true, sources: [] });
    setMenu(false);
    invoke<Source[]>("ask_notes", { id, question })
      .then(sources => setAi(a => a && a.id === id ? { ...a, sources } : a))
      .catch(e => setAi(a => a && a.id === id ? { ...a, busy: false, error: String(e) } : a));
  };
  // 아직 없는 [[링크]] → 개념 노트 만들기 (Vault에 같은 이름이 있으면 그 노트를 엶). 만든 뒤 Obsidian에서 열기
  const createConcept = async (src: Doc, name: string) => {
    try {
      const [path, made] = await invoke<[string, boolean]>("concept_create", { src: src.file, name, date: today() });
      docCache.delete("__vault");
      if (made) await reloadDocs().catch(() => {});
      await openObsidian(path);
    } catch (e) { failNote("개념 노트를 만들지 못했어요")(e); }
  };
  const openObsidian = (file: string) => invoke("open_url", { url: `obsidian://open?path=${encodeURIComponent(file)}` });
  // AI 답변을 Obsidian 노트로 저장 (⌘S). 날짜는 내 Mac의 오늘 날짜
  const saveAi = async () => {
    if (!ai || ai.busy || !ai.text.trim() || ai.saved) return;
    const d = new Date();
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const id = ai.id;
    try {
      const src = ai.sources?.length ? `\n\n## 출처 노트\n${ai.sources.map((s, i) => `${i + 1}. [[${s.title}]]`).join("\n")}` : "";
      const saved = await invoke<string>("save_ai", { date, question: ai.q, answer: ai.text + src });
      setAi(a => a && a.id === id ? { ...a, saved, saveError: undefined } : a);
      loadConfig().then(() => setRev(r => r + 1));
    } catch (e) { setAi(a => a && a.id === id ? { ...a, saveError: String(e) } : a); }
  };
  const enter = (m: Mode) => { setQ(""); setView(null); setAi(null); setMode(m); input.current?.focus(); };
  const openStore = () => {
    enter("store");
    setStore(s => ({ ...s, loading: true, error: null }));
    invoke<StoreEntry[]>("store_list")
      .then(entries => setStore({ entries, loading: false, error: null }))
      .catch(e => setStore({ entries: [], loading: false, error: String(e) }));
  };
  const openNotes = async (id: string, asGraph = false) => {
    // "__vault": Obsidian 전체 노트 (그래프용)
    let search: NoteSearch | undefined = id === "__vault" ? { id, name: "전체 노트", dir: "", kind: "notes" } : getConfig().note_searches.find(n => n.id === id);
    if (!search) search = (await loadConfig()).note_searches.find(n => n.id === id);
    if (!search) return;
    enter("note");
    setGraph(asGraph); setPick(null); setReveal(false); setLocal(0);
    // 전에 읽은 노트가 있으면 바로 보여 주고, 뒤에서 다시 읽어 바뀐 경우에만 갱신 (외장 디스크 첫 읽기 몇 초)
    const cached = docCache.get(id);
    setNotes({ search, docs: cached?.docs ?? [], loading: !cached, error: null });
    const mine = (n: Notes) => n.search?.id === id;
    loadDocs(search)
      .then(docs => {
        const sig = docsSig(docs);
        if (docCache.get(id)?.sig === sig) { setNotes(n => mine(n) ? { ...n, loading: false } : n); return; }
        docCache.set(id, { docs, sig });
        setNotes(n => mine(n) ? { search: search!, docs, loading: false, error: null } : n);
      })
      .catch(e => setNotes(n => mine(n) ? { ...n, loading: false, error: cached ? null : String(e) } : n));
  };
  const openGraph = () => openNotes("__vault", true);
  // 지금 노트 검색을 화면 상태는 그대로 두고 다시 읽기 (체크·상태 변경 뒤)
  const reloadDocs = async () => {
    const s = notes.search;
    if (!s) return;
    const docs = await loadDocs(s);
    docCache.set(s.id, { docs, sig: docsSig(docs) });
    setNotes(n => n.search?.id === s.id ? { ...n, docs } : n);
  };
  const failNote = (title: string) => (e: unknown) => { setAi(null); setView({ kind: "text", title, text: String(e), error: true }); };
  const setStatus = (d: Doc, value: string) => invoke("note_set_field", { id: notes.search!.id, file: d.file, key: "status", value })
    .then(reloadDocs).catch(failNote("상태를 바꾸지 못했어요"));
  // 커리큘럼 미리보기의 체크박스 클릭 → 노트 파일에 체크/해제
  const onPreviewClick = (e: MouseEvent<HTMLElement>) => {
    const el = e.target as HTMLElement;
    if (!(el instanceof HTMLInputElement) || el.type !== "checkbox" || notes.search?.kind !== "curriculum" || !curDoc?.tasks) return;
    e.preventDefault(); // 화면은 파일을 고친 뒤 다시 읽어서 바꿈
    const boxes = Array.from(e.currentTarget.querySelectorAll("input[type=checkbox]"));
    const i = boxes.indexOf(el), task = curDoc.tasks[i];
    if (!task || boxes.length !== curDoc.tasks.length) return;
    invoke("note_toggle_task", { id: notes.search.id, file: curDoc.file, index: i, text: task.text, done: !task.done })
      .then(reloadDocs).catch(failNote("체크하지 못했어요"));
  };
  const loadClips = () => Promise.all([invoke<Clip[]>("clip_list"), invoke<boolean>("clip_enabled")])
    .then(([list, enabled]) => setClips({ list, enabled })).catch(() => {});
  const openClip = () => { enter("clip"); loadClips(); };
  // 클립보드 기록 목록: 검색어가 있으면 글 안에서 찾기. 맨 끝에 기록 끄기·모두 지우기
  const clipItems = (): Item[] => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const shown = clips.list.filter(c => words.every(w => c.text.toLowerCase().includes(w))).slice(0, 100);
    const rows: Item[] = shown.map(c => ({
      id: `clip-${c.at}`, title: c.text.trim().split("\n")[0].slice(0, 120), kind: "snippet", glyph: "clip", section: clipDay(c.at),
      subtitle: [clipTime(c.at), c.app, c.text.includes("\n") ? `${c.text.split("\n").length}줄` : ""].filter(Boolean).join(" · "),
      actions: [
        { title: "앞 앱에 붙여넣기", run: () => pasteText(c.text) },
        { title: "복사", shortcut: "⌘C", run: () => copy(c.text) },
        { title: "빠른 메모로 보내기", shortcut: "⌘N", keep: true, run: async () => { openMemo(undefined, "clip"); setQ(c.text); } },
        { title: "이 기록 지우기", shortcut: "⌘D", keep: true, run: async () => { await invoke("clip_remove", { at: c.at, text: c.text }); await loadClips(); } },
      ],
    }));
    if (q.trim()) return rows;
    return [...rows,
      { id: "clip-toggle", title: clips.enabled ? "클립보드 기록 멈추기" : "클립보드 기록 다시 켜기", kind: "cmd", glyph: clips.enabled ? "pause" : "clip", section: "설정",
        subtitle: clips.enabled ? "멈춘 동안 복사한 글은 저장하지 않아요" : "지금은 기록하지 않고 있어요",
        actions: [{ title: clips.enabled ? "멈추기" : "켜기", keep: true, run: async () => { await invoke("clip_set_enabled", { on: !clips.enabled }); await loadClips(); } }] },
      ...(clips.list.length ? [{ id: "clip-clear", title: "모두 지우기", kind: "cmd" as const, glyph: "trash", section: "설정", subtitle: `기록 ${clips.list.length}개`,
        actions: [{ title: "모두 지우기", keep: true, confirm: "클립보드 기록을 모두 지울까요? 되돌릴 수 없어요. Enter를 한 번 더 누르세요.",
          run: async () => { await invoke("clip_clear"); await loadClips(); } }] }] : []),
    ];
  };
  const openFiles = () => { setFound({ items: [], loading: false }); enter("files"); };
  // 빠른 메모 열기. stage가 없으면 커리큘럼에서 "진행 중"(없으면 아직 안 끝난 첫) 단계를 찾음 (목차 노트 제외)
  const openMemo = (stage?: Stage, from: Mode = null) => {
    setMemo({ stage: stage ?? null, from, saved: null, error: null, finding: !stage });
    setDelPending(null); setRemoved(null);
    enter("memo");
    loadDaily();
    if (stage) return;
    (async () => {
      for (const s of getConfig().note_searches.filter(n => n.kind === "curriculum")) {
        let docs = docCache.get(s.id)?.docs;
        if (!docs) { docs = await loadDocs(s).catch(() => [] as Doc[]); docCache.set(s.id, { docs, sig: docsSig(docs) }); }
        const stages = docs.filter(d => !d.aliases.includes("moc")).sort((a, b) => a.file.localeCompare(b.file, undefined, { numeric: true }));
        const doc = stages.find(d => STATUS[d.meta.status] === "진행 중") ?? stages.find(d => d.meta.status !== "done");
        if (doc) { setMemo(m => ({ ...m, stage: { search: s, doc }, finding: false })); return; }
      }
      setMemo(m => ({ ...m, finding: false }));
    })();
  };
  const loadDaily = () => { const date = now().date; return invoke<string>("memo_daily_read", { date }).then(daily => setMemo(m => ({ ...m, daily, dailyDate: date }))).catch(() => {}); };
  // 단계 노트를 다시 읽어 오른쪽 기록을 새로 (커리큘럼 화면도)
  const refreshStage = (st: Stage) => {
    docCache.delete(st.search.id);
    if (notes.search?.id === st.search.id) reloadDocs();
    loadDocs(st.search).then(docs => {
      const doc = docs.find(d => d.file === st.doc.file);
      if (doc) setMemo(m => m.stage?.doc.file === doc.file ? { ...m, stage: { ...m.stage, doc } } : m);
    }).catch(() => {});
  };
  // 기록 지우기 (×를 두 번). 지운 내용은 ⌘Z로 되돌릴 수 있게 보관
  const removeRecord = async (sec: string, i: number) => {
    setDelPending(null);
    const st = memo.stage, daily = sec === "daily";
    const list = daily ? itemsOf(dailyRaw(memo.daily ?? "")) : itemsOf(sectionRaw(st?.doc.body ?? "", sec));
    const item = list[i];
    if (!item || (!daily && !st)) return;
    const args = { id: st?.search.id ?? "", file: st?.doc.file ?? "", date: memo.dailyDate ?? now().date, section: sec };
    await invoke<{ line: number; text: string }>("memo_remove", { ...args, index: i, first: item.first })
      .then(r => {
        setRemoved({ sec, id: args.id, file: args.file, date: args.date, line: r.line, text: r.text });
        setMemo(m => ({ ...m, saved: "지웠어요 · ⌘Z로 되돌리기", error: null }));
        if (daily) loadDaily(); else refreshStage(st!);
      }).catch(memoFail);
  };
  const undoRemove = async () => {
    const r = removed;
    if (!r) return;
    await invoke("memo_restore", { id: r.id, file: r.file, date: r.date, section: r.sec, line: r.line, text: r.text })
      .then(() => {
        setRemoved(null);
        setMemo(m => ({ ...m, saved: "되돌렸어요", error: null }));
        if (r.sec === "daily") loadDaily(); else if (memo.stage) refreshStage(memo.stage);
      }).catch(memoFail);
  };
  const onRecClick = (e: MouseEvent<HTMLElement>) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>(".rec-del");
    if (!b) { setDelPending(null); return; }
    const key = `${b.dataset.sec}:${b.dataset.i}`;
    if (delPending === key) removeRecord(b.dataset.sec!, Number(b.dataset.i));
    else setDelPending(key);
  };
  const memoDone = (saved: string) => { setMemo(m => ({ ...m, saved, error: null })); setQ(""); };
  const memoFail = (e: unknown) => setMemo(m => ({ ...m, saved: null, error: String(e) }));
  const saveDaily = async (text: string) => {
    if (!text) return;
    const { date, time } = now();
    await invoke("memo_daily", { date, time, text }).then(() => { memoDone(`오늘 Daily에 적었어요 · ${time}`); loadDaily(); }).catch(memoFail);
  };
  const saveRecord = async (section: string, block: string) => {
    const st = memo.stage;
    if (!st || !block.trim()) return;
    await invoke("note_add_record", { id: st.search.id, file: st.doc.file, section, block })
      .then(() => {
        memoDone(`${st.doc.name.split(":")[0]} · ${section}에 기록했어요`);
        refreshStage(st); // 오른쪽 기록과 커리큘럼 화면을 새 내용으로
      }).catch(memoFail);
  };
  const saveClipboard = async () => {
    const clip = (await invoke<string>("clipboard_text").catch(() => "")).trim();
    if (!clip) return memoFail("클립보드가 비어 있어요.");
    await saveRecord(RECORD.cmd, cmdBlock(clip));
  };
  // 메모 화면 목록: 저장할 곳 (순서 고정). "!"·"$"로 시작하면 막힌 점·명령어로 선택이 옮겨 가고 그 글자는 빼고 저장
  const memoItems = (): Item[] => {
    const raw = q.trim(), pre = raw[0] === "!" || raw[0] === "$";
    const text = pre ? raw.slice(1).trim() : raw;
    const st = memo.stage, short = st?.doc.name.split(":")[0] ?? "";
    const rec = (section: string, glyph: string): Item => ({ id: `memo-${section}`, title: `${short} · ${section}`, subtitle: st!.doc.name, kind: "wiki", glyph,
      actions: [{ title: "기록", keep: true, run: async () => { if (text) await saveRecord(section, section === RECORD.cmd ? cmdBlock(text) : listBlock(text)); } }] });
    const recs = st ? [rec(RECORD.learn, "learn"), rec(RECORD.stuck, "stuck"), rec(RECORD.cmd, "cmdlog")] : [];
    const daily: Item = { id: "memo-daily", title: "오늘 Daily에 메모", subtitle: `03_Daily/${now().date}.md`, kind: "wiki", glyph: "daily",
      actions: [{ title: "메모", keep: true, run: () => saveDaily(raw) }] };
    // 클립보드 기록은 입력이 비어 있을 때만 (입력한 메모 대신 클립보드가 저장되는 실수 방지). 맨 끝이라 다른 칸 순서는 그대로
    const clip: Item[] = st && !raw ? [{ id: "memo-clip", title: "클립보드를 명령어로 기록", subtitle: `${short} · ${RECORD.cmd}`, kind: "wiki", glyph: "clip",
      actions: [{ title: "기록", keep: true, run: saveClipboard }] }] : [];
    return [...recs, daily, ...clip];
  };
  // 비밀번호 수정·새 노트 저장 후 노트 다시 읽기
  const savePw = async () => {
    const search = notes.search;
    if (!pw || pw.saving || !search) return;
    setPw({ ...pw, saving: true, error: null });
    try {
      if (pw.doc) await invoke("note_set_field", { id: search.id, file: pw.doc.file, key: "password", value: pw.password });
      else {
        if (!pw.name.trim()) throw "파일 이름을 입력하세요.";
        const last = lastDoc(notes.docs);
        await invoke("note_create", { id: search.id, name: pw.name.trim(), content: newPwNote(last, pw.name.trim(), pw.title.trim(), pw.password) });
      }
      setPw(null);
      openNotes(search.id);
    } catch (e) { setPw(d => d && { ...d, saving: false, error: String(e) }); }
  };
  const openPw = (doc: Doc | null) => {
    const last = lastDoc(notes.docs);
    const name = doc ? baseOf(doc.file) : nextName(last);
    setPw({ doc, name, title: doc ? doc.name : name.replace(/-/g, " "), password: doc?.meta.password ?? "", error: null, saving: false });
    setQ(""); setMenu(false); setMode("pwEdit");
  };
  const openNoteManager = () => {
    enter("noteManage");
    loadConfig().then(() => setRev(r => r + 1));
    invoke<Record<string, string>>("get_hotkeys").then(keys => setHk(h => ({ ...h, keys: keys ?? {} })));
  };
  const openEdit = (s?: NoteSearch) => {
    setDraft({ id: s?.id ?? "", name: s?.name ?? "", dir: s?.dir ?? "", kind: s?.kind ?? "notes",
      hotkey: s ? hk.keys[`note:${s.id}`] ?? "" : "", recording: false, error: null, saving: false });
    setQ(""); setMode("noteEdit");
  };
  const saveDraft = async () => {
    if (!draft || draft.saving) return;
    setDraft({ ...draft, saving: true, error: null });
    try {
      await invoke("save_note_search", { search: { id: draft.id, name: draft.name, dir: draft.dir, kind: draft.kind }, hotkey: draft.hotkey });
      setDraft(null);
      openNoteManager();
    } catch (e) { setDraft(d => d && { ...d, saving: false, error: String(e) }); }
  };
  const pickFolder = async () => {
    const dir = await invoke<string | null>("pick_folder", { start: draft?.dir || "/Volumes/Disk/MyBrain" });
    if (dir) setDraft(d => d && { ...d, dir, name: d.name || dir.split("/").pop()!.replace(/^\d+_/, "") });
  };
  const openHotkeys = () => {
    enter("hotkeys");
    invoke<Record<string, string>>("get_hotkeys").then(keys => setHk({ keys: keys ?? {}, recording: null, error: null }));
  };
  const openExamples = (doc: Doc) => { setExDoc({ doc, prevQ: q }); setQ(""); setMode("examples"); };
  const ui: Ui = {
    ask, askNotes, openStore, openNotes, openGraph, openFiles, openMemo: () => openMemo(), openClip, openNoteManager, openHotkeys, togglePin,
    show: v => { setAi(null); setView(v); },
    setQuery: text => { setQ(text); input.current?.focus(); },
  };

  // 노트 검색: 검색어가 없으면 분류(폴더)별 전체, 있으면 점수순
  const noteList = useMemo(
    () => mode === "note" ? (q.trim() ? rank(notes.docs, q).slice(0, 80)
      : notes.search?.kind === "curriculum" ? [...notes.docs].sort((a, b) => a.file.localeCompare(b.file, undefined, { numeric: true }))
      : byCategory(notes.docs)) : [],
    [mode, notes.docs, q, notes.search?.kind]);
  const noteItem = (d: Doc): Item => {
    const kind = notes.search?.kind ?? "notes";
    const obsidian: Action = { title: "Obsidian에서 열기", shortcut: "⌘O",
      run: () => invoke("open_url", { url: `obsidian://open?path=${encodeURIComponent(d.file)}` }) };
    const finder: Action = { title: "Finder에서 보기", shortcut: "⌘F", run: () => invoke("reveal", { path: d.file }) };
    if (kind === "passwords") {
      const p = d.meta.password ?? "", ssh = d.meta.ssh;
      return { id: `n-${d.file}`, title: d.name, kind: "wiki", glyph: "lock", section: q.trim() ? undefined : d.category,
        subtitle: p ? (reveal ? p : MASK) : d.meta.key_file ? `키 파일 ${d.meta.key_file}` : "비밀번호 없음",
        actions: [
          ...(p ? [{ title: "비밀번호 복사", run: () => copySecret(p) },
            { title: "앞 앱에 비밀번호 붙여넣기", shortcut: "⌘↵", run: () => pasteSecret(p) }] : []),
          { title: "비밀번호 수정", shortcut: "⌘E", keep: true, run: async () => openPw(d) },
          ...(ssh ? [{ title: "접속 명령 복사", run: () => copy(ssh) }, { title: "접속 명령 붙여넣기", run: () => pasteText(ssh) }] : []),
          obsidian, finder,
        ] };
    }
    if (kind === "curriculum") {
      const tasks = d.tasks ?? [], n = tasks.filter(x => x.done).length, st = d.meta.status || "todo", next = nextStatus(st);
      return { id: `n-${d.file}`, title: d.name, kind: "wiki",
        glyph: st === "done" ? "done" : STATUS[st] === "진행 중" ? "doing" : "todo",
        subtitle: [STATUS[st] ?? st, weekLabel(d.meta.week), tasks.length ? `${n}/${tasks.length}` : ""].filter(Boolean).join(" · "),
        actions: [obsidian, { title: "이 단계에 기록하기", shortcut: "⌘N", keep: true, run: async () => openMemo({ search: notes.search!, doc: d }, "note") },
          { title: `상태를 "${STATUS[next]}"(으)로`, shortcut: "⌘D", keep: true, run: () => setStatus(d, next) },
          finder, { title: "이름 복사", run: () => copy(d.name) }] };
    }
    const pick = kind === "commands" ? "예시 골라서 쓰기" : "코드 골라서 쓰기";
    const actions: Action[] = kind === "snippets" ? [
      { title: "앞 앱에 붙여넣기", run: () => pasteText(d.body) },
      { title: "복사", run: () => copy(d.body) },
      obsidian, finder,
    ] : [
      ...(d.examples.length ? [{ title: pick, keep: true, run: async () => openExamples(d) }] : [obsidian]),
      ...(d.examples[0] ? [{ title: kind === "commands" ? "대표 예시 붙여넣기" : "첫 코드 붙여넣기", shortcut: "⌘↵", run: () => pasteText(d.examples[0].cmd) }] : []),
      { title: "이름 복사", run: () => copy(d.name) },
      ...(d.examples.length ? [obsidian] : []),
      finder,
      ...d.related.map(r => ({ title: `관련: ${r}`, keep: true, run: async () => setQ(r) })),
    ];
    const sub = q.trim() ? d.category
      : kind === "commands" ? (d.stub ? "요약" : `예시 ${d.examples.length}개`)
      : kind === "notes" && d.examples.length ? `코드 ${d.examples.length}개` : d.summary;
    return { id: `n-${d.file}`, title: d.name, subtitle: sub, kind: "wiki", section: q.trim() ? undefined : d.category, actions,
      glyph: kind === "commands" ? (d.stub ? "doc" : "terminal") : KIND_LABELS[kind].glyph };
  };
  // 노트 검색 관리 목록
  const manageItems = (): Item[] => [
    ...getConfig().note_searches.map(n => ({
      id: `nm-${n.id}`, title: n.name, kind: "wiki" as const, glyph: KIND_LABELS[n.kind]?.glyph ?? "doc", section: "내 노트 검색",
      subtitle: `${KIND_LABELS[n.kind]?.title ?? n.kind} · ${fmtKey(hk.keys[`note:${n.id}`] ?? "") || "단축키 없음"}`,
      actions: [
        { title: "열기", keep: true, run: async () => openNotes(n.id) },
        { title: "그래프로 보기", keep: true, run: async () => openNotes(n.id, true) },
        { title: "수정", keep: true, run: async () => openEdit(n) },
        { title: "삭제", keep: true, confirm: `"${n.name}" 노트 검색을 삭제할까요? 노트 파일은 지워지지 않아요. Enter를 한 번 더 누르세요.`,
          run: async () => { await invoke("delete_note_search", { id: n.id }); await loadConfig(); setRev(r => r + 1); } },
      ],
    })),
    { id: "nm-new", title: "새 노트 검색 만들기", subtitle: "Obsidian 폴더 · 방식 · 단축키 지정", kind: "cmd", glyph: "plus",
      section: "추가", actions: [{ title: "만들기", keep: true, run: async () => openEdit() }] },
  ];
  const exampleItems = (doc: Doc): Item[] => doc.examples
    .filter(e => !q.trim() || `${e.cmd} ${e.desc}`.toLowerCase().includes(q.trim().toLowerCase()))
    .map((e, i) => ({ id: `ex-${i}-${e.cmd}`, title: e.cmd, subtitle: e.desc, kind: "wiki", glyph: "terminal",
      section: `${doc.name} 예시`, actions: [
        { title: "앞 앱에 붙여넣기", run: () => pasteText(e.cmd) },
        { title: "복사", run: () => copy(e.cmd) },
      ] }));
  const startRecording = async (action: string) => {
    await invoke("suspend_hotkeys", { on: true });
    setHk(h => ({ ...h, recording: action, error: null }));
  };
  const saveHotkey = (action: string, accel: string) =>
    invoke<Record<string, string>>("set_hotkey", { action, accel })
      .then(keys => setHk({ keys, recording: null, error: null }))
      .catch(e => setHk(h => ({ ...h, recording: null, error: String(e) })));
  const hotkeyItems = (): Item[] => hotkeyLabels().map(([action, label]) => ({
    id: `hk-${action}`, title: label, kind: "cmd", glyph: "keyboard", section: "전역 단축키",
    subtitle: hk.recording === action ? "새 단축키를 누르세요 · Esc 취소" : fmtKey(hk.keys[action] ?? "") || "없음",
    actions: [
      { title: "단축키 바꾸기", keep: true, run: () => startRecording(action) },
      ...(action === "baro" ? [] : [{ title: "단축키 지우기", keep: true, run: () => saveHotkey(action, "") }]),
    ],
  }));

  const home = mode === null && !q.trim();
  const items: Item[] =
    mode === "examples" && exDoc ? exampleItems(exDoc.doc)
    : mode === "note" ? [...noteList.map(noteItem), ...(notes.search?.kind === "passwords" && !notes.loading && !notes.error ? [{
        id: "pw-new", title: "새 항목 추가", subtitle: `${nextName(lastDoc(notes.docs))} · 비밀번호 입력`, kind: "cmd" as const, glyph: "plus",
        section: "추가", actions: [{ title: "추가", keep: true, run: async () => openPw(null) }] }] : [])]
    : mode === "pwEdit" ? []
    : mode === "noteManage" ? manageItems()
    : mode === "noteEdit" ? []
    : mode === "hotkeys" ? hotkeyItems()
    : mode === "store" ? storeItems(q, store.entries, () => setRev(r => r + 1), ui)
    : mode === "ask" ? (q.trim() ? [aiItem(q.trim(), ask, askNotes), ...[notesAiItem(q.trim(), askNotes)].filter((x): x is Item => !!x)] : [])
    : mode === "files" ? found.items
    : mode === "memo" ? memoItems()
    : mode === "clip" ? clipItems()
    : home ? homeItems(ui) : [...top, ...files, ...bottom];
  const graphOn = mode === "note" && graph;
  const curClip = mode === "clip" ? clips.list.find(c => `clip-${c.at}` === items[sel]?.id) : undefined;
  const curDoc = mode === "note" ? (graphOn && pick ? pick : noteList[sel]) : undefined;
  // 미리보기: 가는·오는 링크, 아직 없는 링크 (비밀번호 모음 제외)
  const linksOn = mode === "note" && notes.search?.kind !== "passwords";
  const links = useMemo(() => linksOn ? linkInfo(notes.docs) : null, [linksOn, notes.docs]);
  const curLinks = curDoc && links?.get(curDoc.file);
  const graphMatches = useMemo(() => graphOn && q.trim() ? new Set(noteList.map(d => d.file)) : null, [graphOn, q, noteList]);
  // 빠른 메모 오른쪽: 단계의 "내 기록" 세 칸과 오늘 Daily 메모 (칸마다 최근 6개)
  const memoSel = mode === "memo" ? items[sel]?.id ?? "" : "";
  const memoHtml = useMemo(() => {
    if (mode !== "memo") return "";
    const box = (on: boolean, title: string, sub: string, sec: string, items: RecItem[]) => {
      const shown = items.slice(-6), n = items.length;
      return `<section class="rec${on ? " on" : ""}"><h4>${title} <span>${n ? `${n}개${n > 6 ? " · 최근 6개" : ""}` : ""}</span></h4>`
        + (shown.length ? shown.map(it => {
          const ask = delPending === `${sec}:${it.i}`;
          return `<div class="rec-item">${marked.parse(it.text, { async: false }) as string}`
            + `<button class="rec-del${ask ? " ask" : ""}" data-sec="${sec}" data-i="${it.i}" title="지우기">${ask ? "지우기?" : "×"}</button></div>`;
        }).join("") : `<p class="none">${sub}</p>`) + "</section>";
    };
    const st = memo.stage, body = st?.doc.body ?? "";
    return [
      ...(st ? [RECORD.learn, RECORD.stuck, RECORD.cmd].map(s => box(memoSel === `memo-${s}` || (memoSel === "memo-clip" && s === RECORD.cmd),
        `${st.doc.name.split(":")[0]} · ${s}`, "아직 없음", s, itemsOf(sectionRaw(body, s)))) : []),
      box(memoSel === "memo-daily", "오늘 Daily", "오늘 적은 메모가 없어요", "daily", itemsOf(dailyRaw(memo.daily ?? ""))),
    ].join("");
  }, [mode, memo.stage, memo.daily, memoSel, delPending]);
  // 고른 칸이 보이게 스크롤
  useEffect(() => { recRef.current?.querySelector(".rec.on")?.scrollIntoView({ block: "nearest" }); }, [memoHtml]);

  const previewHtml = useMemo(() => {
    if (!curDoc) return "";
    let md = curDoc.markdown;
    // 비밀번호 모음: 맨 위에 비밀번호·접속 명령, 가리기 상태면 본문에 나온 비밀번호도 가림
    if (notes.search?.kind === "passwords") {
      const p = curDoc.meta.password ?? "";
      if (p && !reveal) md = md.split(p).join(MASK);
      const info = [p ? `**비밀번호** \`${reveal ? p : MASK}\`` : curDoc.meta.key_file ? `**키 파일** \`${curDoc.meta.key_file}\`` : "",
        curDoc.meta.ssh ? `**접속** \`${curDoc.meta.ssh}\`` : ""].filter(Boolean).join("  \n");
      if (info) md = `> ${info.replace(/\n/g, "\n> ")}\n\n${md}`;
    }
    if (notes.search?.kind === "curriculum") {
      const tasks = curDoc.tasks ?? [], n = tasks.filter(x => x.done).length, st = curDoc.meta.status || "todo";
      const info = [tasks.length ? `**진도** ${n}/${tasks.length} (${Math.round(n / tasks.length * 100)}%)` : "",
        `**상태** ${STATUS[st] ?? st}`, curDoc.meta.week ? `**기간** ${weekLabel(curDoc.meta.week)}` : ""].filter(Boolean).join(" · ");
      const bar = tasks.length ? `<progress value="${n}" max="${tasks.length}"></progress>\n\n` : "";
      return bar + (marked.parse(`> ${info}\n\n${md}`, { async: false }) as string).replace(/<input disabled="" type="checkbox"/g, '<input type="checkbox"')
        .replace(/<input checked="" disabled="" type="checkbox"/g, '<input checked="" type="checkbox"');
    }
    return marked.parse(md, { async: false }) as string;
  }, [curDoc, reveal, notes.search?.kind]);

  // 단축키로 열렸을 때: 기능에 맞는 화면으로 전환
  const onShown = (action: string) => {
    setMenu(false); setPending(null);
    loadConfig().then(() => setRev(r => r + 1));
    if (action.startsWith("note:")) openNotes(action.slice(5));
    else if (action === "store") openStore();
    else if (action === "ai") enter("ask");
    else if (action === "graph") openGraph();
    else if (action === "files") openFiles();
    else if (action === "memo") openMemo();
    else if (action === "clipboard") openClip();
    else if (mode !== null && mode !== "store" && mode !== "noteEdit") enter(null);
    input.current?.focus(); input.current?.select();
  };
  const shownRef = useRef(onShown);
  shownRef.current = onShown;

  // 미리보기·답변 안의 링크는 Baro 창 안에서 열지 않고 기본 브라우저(로그인·쿠키 그대로)로
  useEffect(() => {
    const onLink = (e: globalThis.MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.("a[href]");
      if (!a) return;
      const href = a.getAttribute("href") ?? "";
      if (href.startsWith("#")) return; // 같은 문서 안 이동은 그대로
      e.preventDefault();
      if (/^(https?|mailto|obsidian):/i.test(href)) invoke("open_url", { url: href });
    };
    document.addEventListener("click", onLink, true);
    return () => document.removeEventListener("click", onLink, true);
  }, []);

  useEffect(() => {
    const uns = [
      listen<string>("shown", e => shownRef.current(e.payload || "baro")),
      // 인덱싱이 끝나면 현재 검색어로 다시 조회
      listen("indexed", () => setRev(r => r + 1)),
      listen<{ id: number; text: string }>("ai-chunk", e =>
        setAi(a => a && a.id === e.payload.id ? { ...a, text: a.text + e.payload.text } : a)),
      listen<{ id: number; error: string | null }>("ai-done", e =>
        setAi(a => a && a.id === e.payload.id ? { ...a, busy: false, error: e.payload.error } : a)),
    ];
    loadConfig().then(() => setRev(r => r + 1));
    return () => { uns.forEach(u => u.then(f => f())); };
  }, []);

  // 기본 검색 결과: 최신 요청 결과만 반영
  useEffect(() => {
    const id = ++seq.current;
    setMenu(false); setPending(null); setPick(null);
    if (mode !== "memo") setSel(0);
    else if (memo.stage && /^\s*!/.test(q)) setSel(1); // 막힌 점과 해결
    else if (memo.stage && /^\s*\$/.test(q)) setSel(2); // 사용한 명령어
    else if (q.trim()) setSel(s => s > 3 ? 0 : s); // 클립보드 칸에 있다가 입력을 시작하면 (그 칸이 사라지므로) 첫 칸으로
    if (mode !== null) return;
    query(q, ui).then(r => {
      if (id !== seq.current) return;
      setTop(r.top); setBottom(r.bottom);
    });
  }, [q, rev, mode]);

  // 파일 검색: 입력이 멈추면 실행
  useEffect(() => {
    setFiles([]);
    if (mode !== null) return;
    const t = setTimeout(() => {
      const id = seq.current;
      fileItems(q).then(f => { if (id === seq.current) setFiles(f); });
    }, 180);
    return () => clearTimeout(t);
  }, [q, mode]);

  // 파일 찾기 화면: 입력이 멈추면 홈 + 외장 디스크 검색
  useEffect(() => {
    if (mode !== "files") return;
    if (!q.trim()) { setFound({ items: [], loading: false }); return; }
    setFound(f => ({ ...f, loading: true }));
    let live = true;
    const t = setTimeout(() => fileItems(q, true).then(items => { if (live) { setFound({ items, loading: false }); setSel(0); } }), 150);
    return () => { live = false; clearTimeout(t); };
  }, [q, mode]);

  // 선택 항목이 보이도록 스크롤
  useEffect(() => { list.current?.querySelectorAll("[role=option]")[sel]?.scrollIntoView({ block: "nearest" }); }, [sel, mode]);

  const fail = (e: unknown) => {
    const msg = String(e);
    setAi(null);
    setView(msg.startsWith("PERM:") ? { kind: "perm", perm: msg.slice(5) } : { kind: "text", title: "실행하지 못했어요", text: msg, error: true });
  };
  const cur = graphOn && pick ? noteItem(pick) : items[sel];
  const run = (a?: Action, it: Item | undefined = cur) => {
    if (!a || !it) return;
    const key = `${it.id}:${a.title}`;
    if (a.confirm && pending?.key !== key) { setPending({ key, confirm: a.confirm }); setMenu(false); return; }
    setPending(null); setMenu(false);
    a.run().catch(fail);
    if (!a.keep && mode === null) setQ("");
  };
  const back = () => {
    if (mode === "examples") { setMode("note"); setQ(exDoc?.prevQ ?? ""); }
    else if (graphOn) { setGraph(false); setPick(null); }
    else if (mode === "memo" && memo.from) setMode(memo.from); // 커리큘럼에서 왔으면 그 화면으로
    else setMode(null);
  };

  // 키 입력은 창 전체에서 받음: 마우스로 클릭해 입력창 포커스가 빠져도 Esc·Enter·방향키가 동작
  const onKey = (e: KeyboardEvent) => {
    // 노트 검색 추가·수정 화면: 입력칸은 그대로 두고 Esc(취소)·⌘↵(저장)·단축키 입력만 처리
    if (mode === "noteEdit" && draft) {
      if (draft.recording) {
        e.preventDefault();
        if (e.key === "Escape") { invoke("suspend_hotkeys", { on: false }); setDraft({ ...draft, recording: false }); return; }
        const accel = accelOf(e);
        if (accel) { invoke("suspend_hotkeys", { on: false }); setDraft({ ...draft, hotkey: accel, recording: false }); }
        return;
      }
      if (e.key === "Escape") { e.preventDefault(); setDraft(null); openNoteManager(); }
      else if (e.key === "Enter" && e.metaKey) { e.preventDefault(); saveDraft(); }
      return;
    }
    // 비밀번호 수정·추가 화면: Esc(취소)·⌘↵(저장)
    if (mode === "pwEdit" && pw) {
      if (e.key === "Escape") { e.preventDefault(); setPw(null); setMode("note"); }
      else if (e.key === "Enter" && e.metaKey) { e.preventDefault(); savePw(); }
      return;
    }
    // 단축키 입력 중: 다음에 누른 조합을 저장
    if (hk.recording) {
      e.preventDefault();
      if (e.key === "Escape") { invoke("suspend_hotkeys", { on: false }); setHk(h => ({ ...h, recording: null })); return; }
      const accel = accelOf(e);
      if (accel) saveHotkey(hk.recording, accel);
      return;
    }
    if (document.activeElement !== input.current && !(view || ai)) input.current?.focus();
    // ⌘K: 한글 자판에선 e.key가 "ㅏ"라서 물리 키(e.code)로 판별
    // ⌘P: 창 고정·해제
    if (e.metaKey && e.code === "KeyP") { e.preventDefault(); togglePin(); return; }
    if ((e.metaKey || e.ctrlKey) && e.code === "KeyK") {
      e.preventDefault();
      if (ai || view) return;
      if (cur) { setMenu(m => !m); setAsel(0); }
      return;
    }
    // 한글 조합 중 키 입력은 무시 (WebKit은 isComposing 대신 keyCode 229를 줌)
    if (e.isComposing || e.keyCode === 229) return;
    if (view) {
      // 결과·권한 화면: Enter는 (권한이면) 설정 열기 / 결과 복사, Esc는 돌아가기
      if (e.key === "Escape") { setView(null); input.current?.select(); }
      else if (e.key === "Enter") {
        e.preventDefault();
        if (view.kind === "perm" && view.perm !== "ok") invoke("open_settings", { kind: view.perm });
        else if (view.kind === "text") navigator.clipboard.writeText(view.text);
      }
      return;
    }
    if (mode === "memo" && !view && !menu) {
      if (e.metaKey && e.code === "KeyZ" && !q && removed) { e.preventDefault(); undoRemove(); return; }
      if (e.key === "Escape" && delPending) { e.preventDefault(); setDelPending(null); return; }
      if (e.key === "Enter" && e.shiftKey) return; // 줄바꿈
      if (e.key === "Tab") { e.preventDefault(); const n = items.length || 1; setSel(s => (s + (e.shiftKey ? n - 1 : 1)) % n); return; }
      if (q.includes("\n") && (e.key === "ArrowUp" || e.key === "ArrowDown")) return; // 여러 줄: 커서 이동
    }
    if (e.key === "Tab" && (mode === null || mode === "ask")) { e.preventDefault(); if (q.trim()) ask(q.trim()); return; }
    if (ai) {
      // AI 화면: Enter는 입력한 내용으로 다시 질문, ⇧Enter로 답변 복사
      if (e.key === "Escape") { setAi(null); input.current?.select(); }
      else if (e.metaKey && e.code === "KeyS") { e.preventDefault(); saveAi(); }
      else if (e.metaKey && e.code === "KeyO" && ai.saved) { e.preventDefault(); invoke("open_url", { url: `obsidian://open?path=${encodeURIComponent(ai.saved)}` }); }
      else if (e.key === "Enter" && e.shiftKey) { e.preventDefault(); navigator.clipboard.writeText(ai.text); }
      else if (e.key === "Enter" && e.metaKey) { e.preventDefault(); if (q.trim() && !ai.busy) askNotes(q.trim()); }
      else if (e.key === "Enter") { e.preventDefault(); if (q.trim() && !ai.busy) (ai.notes ? askNotes : ask)(q.trim()); }
      return;
    }
    // ⌘R: 비밀번호 보이기·가리기
    if (mode === "note" && notes.search?.kind === "passwords" && e.metaKey && e.code === "KeyR") { e.preventDefault(); setReveal(v => !v); return; }
    // ⌘G: 노트 목록 ↔ 그래프
    if (mode === "note" && e.metaKey && e.code === "KeyG") { e.preventDefault(); setGraph(v => !v); setPick(null); setMenu(false); return; }
    // ⌘L: 로컬 그래프 끔 → 1단계 → 2단계 → 끔
    if (graphOn && e.metaKey && e.code === "KeyL") { e.preventDefault(); setLocal(v => (v + 1) % 3); setMenu(false); return; }
    // ⌥+방향키(이웃 노트로 이동)와 ⌘0(맞춤)은 그래프가 처리
    if (graphOn && !menu && ((e.altKey && e.key.startsWith("Arrow")) || (e.metaKey && e.code === "Digit0"))) return;
    // ⌘↵, ⌘O 같은 동작별 단축키
    if (e.metaKey && cur && !menu) {
      const sc = e.code === "Enter" ? "⌘↵" : e.code.startsWith("Key") ? `⌘${e.code.slice(3)}` : "";
      const typed = input.current && input.current.selectionStart !== input.current.selectionEnd;
      const a = sc === "⌘C" && typed ? undefined : cur.actions.find(x => x.shortcut === sc); // 입력창에서 글자를 골랐으면 ⌘C는 그 글자 복사
      if (a) { e.preventDefault(); run(a); return; }
      // ⌘↵: 고른 항목에 ⌘↵ 동작이 없으면 기본 검색·AI 화면에서는 "내 노트에게 묻기", 그 밖에는 아무것도 안 함 (Enter 동작으로 넘어가지 않게)
      if (e.key === "Enter") {
        e.preventDefault();
        if ((mode === null || mode === "ask") && q.trim()) askNotes(q.trim());
        return;
      }
    }
    const n = menu ? cur?.actions.length ?? 0 : items.length;
    const move = menu ? setAsel : setSel;
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !menu && pick) setPick(null);
    if (e.key === "ArrowDown") { e.preventDefault(); setPending(null); move(s => Math.min(s + 1, n - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setPending(null); move(s => Math.max(s - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); run(menu ? cur?.actions[asel] : cur?.actions[0]); }
    // Esc: 확인 취소 → 액션 패널 닫기 → 입력 지우기 → 이전 화면 → 창 닫기
    else if (e.key === "Escape") {
      if (pending) setPending(null); else if (menu) setMenu(false); else if (q) setQ("");
      else if (mode !== null) back(); else invoke("close_window");
    }
  };

  const keyRef = useRef(onKey);
  keyRef.current = onKey;
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const perm = view?.kind === "perm" ? PERMS[view.perm] ?? PERMS.accessibility : null;
  const quick = graphOn && pick ? cur?.actions.find(a => a.shortcut === "⌘F") // 그래프: 고른 노트의 위치 보기
    : cur?.actions.find((a, i) => i > 0 && a.shortcut); // 기본 동작과 겹치면 하단에 두 번 보이지 않게
  const footerKeys: [string, string[]][] = view
    ? [[view.kind === "perm" ? (view.perm === "ok" ? "" : "시스템 설정 열기") : "결과 복사", ["↵"]], ["돌아가기", ["esc"]]]
    : ai ? [["답변 복사", ["⇧", "↵"]], ...(ai.notes ? [] : [["노트에서 다시 묻기", ["⌘", "↵"]] as [string, string[]]]), ai.saved ? ["Obsidian에서 열기", ["⌘", "O"]] : ["Obsidian에 저장", ["⌘", "S"]], ["돌아가기", ["esc"]]]
    : hk.recording ? [["취소", ["esc"]]]
    : cur ? [[cur.actions[0].title, ["↵"]], ...(quick ? [[quick.title, [...quick.shortcut!]] as [string, string[]]] : []),
      ...(mode === "note" && notes.search?.kind === "passwords" ? [[reveal ? "가리기" : "보기", ["⌘", "R"]] as [string, string[]]] : []),
      ...(mode === "note" ? [[graph ? "목록" : "그래프", ["⌘", "G"]] as [string, string[]]] : []),
      ...(graphOn ? [[local ? `로컬 ${local}단계` : "로컬", ["⌘", "L"]] as [string, string[]]] : []), ["액션", ["⌘", "K"]]] : [];
  const placeholder = ai ? "다시 물어보기"
    : mode === "store" ? "확장 검색"
    : mode === "note" ? (notes.search?.kind === "commands" ? "명령어 또는 하고 싶은 작업 (예: 포트 확인, 권한 변경)" : `${notes.search?.name ?? "노트"} 검색`)
    : mode === "noteManage" ? "노트 검색 관리"
    : mode === "examples" ? `${exDoc?.doc.name ?? ""} 예시 검색`
    : mode === "hotkeys" ? "단축키 설정"
    : mode === "ask" ? "AI에게 물어보기 (Enter · ⌘↵ 내 노트에서 찾아 묻기)"
    : mode === "files" ? "파일 이름 (홈 · 외장 디스크)"
    : mode === "clip" ? "복사했던 글 검색"
    : mode === "memo" ? "메모 입력 · ⇧Enter 줄바꿈 · Tab 저장할 곳 · ! 막힌 점 · $ 명령어"
    : "앱, 파일, 명령, 계산, AI에게 묻기";
  const header = home ? "Baro로 할 수 있는 일"
    : mode === "store" ? `확장 스토어${store.loading ? " · 불러오는 중…" : ""}`
    : mode === "files" ? (found.loading ? "찾는 중…" : q.trim() ? `파일 ${found.items.length}개` : "파일 이름을 입력하세요 · Enter로 Finder에서 보기")
    : mode === "clip" ? (q.trim() ? `찾은 기록 ${items.filter(i => i.id.startsWith("clip-") && !["clip-toggle", "clip-clear"].includes(i.id)).length}개` : clips.enabled ? null : "기록을 멈춘 상태예요")
    : mode === "memo" ? (memo.saved ? `✓ ${memo.saved}` : memo.finding ? "공부 중인 단계 찾는 중…" : memo.stage ? `지금 단계: ${memo.stage.doc.name}` : "공부 중인 커리큘럼 단계가 없어 Daily에 적어요")
    : mode === "note" && (notes.loading || q.trim()) ? (notes.loading ? "노트 불러오는 중…" : `검색 결과 ${noteList.length}개`)
    : null;
  const empty = mode === "store" ? store.error
    : mode === "note" ? notes.error ?? (!notes.loading && !items.length ? (q ? "일치하는 노트가 없어요." : "폴더에 노트(.md)가 없어요.") : null)
    : mode === "hotkeys" ? hk.error
    : mode === "files" ? (q.trim() && !found.loading && !found.items.length ? "일치하는 파일이 없어요." : null)
    : mode === "memo" ? memo.error
    : mode === "clip" ? (!clips.list.length ? "아직 기록이 없어요. 글을 복사하면 여기에 쌓여요 (비밀번호·키처럼 보이는 글은 빼요)." : q.trim() && !items.length ? "일치하는 기록이 없어요." : null)
    : mode === null && q && !items.length ? "결과가 없습니다. 다른 이름으로 검색해 보세요." : null;

  // 아직 노트가 없는 [[링크]]: 누르면 개념 노트를 만들어 Obsidian에서 열기
  const missingEl = curDoc && curLinks?.missing.length ? (
    <section>
      <div className="links-head">{notes.search?.id === "__vault" ? "아직 없는 노트" : "이 폴더에 없는 노트"} {curLinks.missing.length} · 누르면 {notes.search?.id === "__vault" ? "개념 노트를 만들어요" : "Vault에서 찾아 열고, 없으면 개념 노트를 만들어요"}</div>
      <div className="links-list">{curLinks.missing.map(n =>
        <button key={n} className="link-item missing" title={`${n}.md 만들기`} onClick={() => createConcept(curDoc, n)}>+ {n}</button>)}</div>
    </section>
  ) : null;

  const listEl = (
    // 목록을 클릭해도 입력창 포커스를 유지
    <ul className="list" role="listbox" ref={list} onMouseDown={e => e.preventDefault()}>
      {header && <li className="section">{header}</li>}
      {mode === "hotkeys" && hk.error && <li className="empty warn">{hk.error}</li>}
      {items.map((it, i) => [
        it.section && it.section !== items[i - 1]?.section && <li key={`s-${i}`} className="section">{it.section}</li>,
        <li key={it.id} role="option" aria-selected={i === sel} className={i === sel ? "row on" : "row"}
          onMouseMove={() => !menu && sel !== i && (setSel(i), setPending(null))} onClick={() => run(it.actions[0], it)}>
          <Icon it={it} />
          <span className="title">{it.title}</span><span className="sub">{it.subtitle}</span>
        </li>,
      ])}
      {empty && mode !== "hotkeys" && <li className="empty">{empty}</li>}
    </ul>
  );

  return (
    <main className="panel">
      {/* 위쪽 끌기 막대: 잡고 끌면 창이 움직이고, 옮긴 자리는 다음에 열 때도 유지 */}
      <div className="grip" data-tauri-drag-region title="끌어서 창 이동 · 가운데로 되돌리기: '창 위치 초기화'"
        onMouseDown={() => invoke("set_placed", { on: true })}><span data-tauri-drag-region /></div>
      {mode === "memo" ? <textarea ref={input} className="search memo-input" value={q} autoFocus spellCheck={false} placeholder={placeholder}
        rows={Math.min(6, q.split("\n").length)} onChange={e => setQ(e.target.value)} />
        : mode !== "noteEdit" && mode !== "pwEdit" && <input ref={input} className="search" value={q} autoFocus spellCheck={false} placeholder={placeholder}
        onChange={e => setQ(e.target.value)} />}
      {view ? (
        <section className="ai-view">
          {perm ? <>
            <div className="view-title">{perm.title}</div>
            <p className="ai-a">{perm.body}</p>
          </> : view.kind === "text" && <>
            <div className="view-title">{view.title}</div>
            <p className={view.error ? "ai-err" : "ai-a mono"}>{view.text}</p>
          </>}
        </section>
      ) : ai ? (
        <section className="ai-view">
          <div className="ai-q"><span className="icon glyph ai">{(() => { const S = ICONS[ai.notes ? "notesAi" : "ai"]; return <S size={15} strokeWidth={2.2} />; })()}</span>{ai.q}</div>
          {ai.error ? <p className="ai-err">{ai.error}</p>
            : <p className="ai-a">{ai.text}{ai.busy && <span className="caret" />}</p>}
          {ai.notes && !!ai.sources?.length && (
            <div className="links ai-sources">
              <div className="links-head">찾은 노트 {ai.sources.length} · 클릭하면 Obsidian에서 열기</div>
              <div className="links-list">{ai.sources.map((s, i) =>
                <button key={s.file} className="link-item" title={s.file} onClick={() => openObsidian(s.file)}>[{i + 1}] {s.title}</button>)}</div>
            </div>
          )}
          {ai.notes && ai.busy && !ai.sources?.length && !ai.text && <p className="ai-saved">노트에서 찾는 중…</p>}
          {ai.saved && <p className="ai-saved">저장했어요: {ai.saved.replace(/^.*\/MyBrain\//, "")}</p>}
          {ai.saveError && <p className="ai-err">{ai.saveError}</p>}
        </section>
      ) : mode === "pwEdit" && pw ? (
        <form className="form" onSubmit={e => { e.preventDefault(); savePw(); }}>
          <div className="view-title">{pw.doc ? `${pw.doc.name} 비밀번호 수정` : "새 항목 추가"}</div>
          {!pw.doc && <>
            <label>파일 이름 <span className="hint">{notes.search?.name} 폴더에 만들어요. 앞 노트의 머리말(level·login·ssh)을 번호만 바꿔 이어받아요</span>
              <input autoFocus value={pw.name} onChange={e => setPw({ ...pw, name: e.target.value })} />
            </label>
            <label>제목
              <input value={pw.title} placeholder="예: Bandit Level 24 — 쉘 스크립트 작성" onChange={e => setPw({ ...pw, title: e.target.value })} />
            </label>
          </>}
          <label>비밀번호 <span className="hint">노트 머리말 password만 바뀌고 본문은 그대로예요</span>
            <input autoFocus={!!pw.doc} className="mono" value={pw.password} spellCheck={false} autoComplete="off" onFocus={e => e.target.select()}
              onChange={e => setPw({ ...pw, password: e.target.value })} />
          </label>
          {pw.error && <p className="ai-err">{pw.error}</p>}
          <div className="form-actions">
            <button type="button" onClick={() => { setPw(null); setMode("note"); }}>취소 <kbd>esc</kbd></button>
            <button type="submit" className="primary" disabled={pw.saving}>{pw.saving ? "저장 중…" : "저장"} <kbd>⌘</kbd><kbd>↵</kbd></button>
          </div>
        </form>
      ) : mode === "noteEdit" && draft ? (
        <form className="form" onSubmit={e => { e.preventDefault(); saveDraft(); }}>
          <div className="view-title">{draft.id ? "노트 검색 수정" : "새 노트 검색"}</div>
          <label>이름
            <input autoFocus value={draft.name} placeholder="예: 쿠버네티스 명령어" onChange={e => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <label>Obsidian 폴더 <span className="hint">하위 폴더까지 읽어요</span>
            <span className="inline">
              <input value={draft.dir} placeholder="/Volumes/Disk/MyBrain/..." onChange={e => setDraft({ ...draft, dir: e.target.value })} />
              <button type="button" onClick={pickFolder}>폴더 선택…</button>
            </span>
          </label>
          <div className="field">방식
            <div className="kinds">
              {(Object.keys(KIND_LABELS) as NoteKind[]).map(k => {
                const K = ICONS[KIND_LABELS[k].glyph];
                return (
                  <button type="button" key={k} className={draft.kind === k ? "kind on" : "kind"} onClick={() => setDraft({ ...draft, kind: k })}>
                    <span className="kind-title">{K && <K size={14} />} {KIND_LABELS[k].title}</span>
                    <span className="hint">{KIND_LABELS[k].desc}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="field">단축키
            <span className="inline">
              <button type="button" className={draft.recording ? "rec on" : "rec"}
                onClick={async () => { await invoke("suspend_hotkeys", { on: true }); setDraft({ ...draft, recording: true }); }}>
                {draft.recording ? "새 단축키를 누르세요 · Esc 취소" : fmtKey(draft.hotkey) || "지정 안 함 (클릭해서 지정)"}
              </button>
              {draft.hotkey && !draft.recording && <button type="button" onClick={() => setDraft({ ...draft, hotkey: "" })}>지우기</button>}
            </span>
          </div>
          {draft.error && <p className="ai-err">{draft.error}</p>}
          <div className="form-actions">
            <button type="button" onClick={() => { setDraft(null); openNoteManager(); }}>취소 <kbd>esc</kbd></button>
            <button type="submit" className="primary" disabled={draft.saving}>{draft.saving ? "저장 중…" : "저장"} <kbd>⌘</kbd><kbd>↵</kbd></button>
          </div>
        </form>
      ) : graphOn ? (
        // 노트 그래프: 왼쪽 그래프 + 오른쪽 미리보기. 검색어는 맞는 노트만 진하게
        <div className="split">
          <NoteGraph docs={notes.docs} matches={graphMatches} selected={curDoc} loading={notes.loading} cacheKey={notes.search?.id ?? ""} local={local}
            onSelect={d => { setPick(d); setMenu(false); }}
            onOpen={d => invoke("open_url", { url: `obsidian://open?path=${encodeURIComponent(d.file)}` })} />
          <div className="preview" key={curDoc?.file /* 다른 노트로 바뀌면 맨 위부터 */}>
            <article className="md" dangerouslySetInnerHTML={{ __html: previewHtml }} />
            {curLinks && (
              <div className="links">
                {([["이 노트로 오는 링크", curLinks.inn], ["이 노트에서 가는 링크", curLinks.out]] as [string, Doc[]][]).map(([title, ds]) => (
                  <section key={title}>
                    <div className="links-head">{title} {ds.length}</div>
                    {ds.length ? <div className="links-list">{ds.map(d =>
                      <button key={d.file} className="link-item" title={d.file} onClick={() => { setPick(d); setMenu(false); }}>{d.name}</button>)}</div>
                      : <div className="links-none">없음</div>}
                  </section>
                ))}
                {missingEl}
              </div>
            )}
          </div>
        </div>
      ) : mode === "memo" ? (
        // 빠른 메모: 왼쪽 저장할 곳 + 오른쪽 이미 적은 기록 (고른 칸 강조)
        <div className="split">
          {listEl}
          <article ref={recRef} className="preview md memo-rec" onClick={onRecClick} dangerouslySetInnerHTML={{ __html: memoHtml }} />
        </div>
      ) : mode === "clip" ? (
        // 클립보드 기록: 왼쪽 목록 + 오른쪽 전체 내용
        <div className="split">
          {listEl}
          <article className="preview clip-view">
            {curClip ? <>
              <pre>{curClip.text}</pre>
              <p className="clip-meta">{clipDay(curClip.at)} {clipTime(curClip.at)}{curClip.app && ` · ${curClip.app}`} · {curClip.text.length.toLocaleString()}자</p>
            </> : <p className="clip-meta">{cur?.subtitle}</p>}
          </article>
        </div>
      ) : mode === "note" ? (
        // 노트 검색: 왼쪽 목록 + 오른쪽 노트 미리보기 (+ 아직 없는 링크로 개념 노트 만들기)
        <div className="split">
          {listEl}
          <div className="preview" key={curDoc?.file}>
            <article className={`md${notes.search?.kind === "curriculum" ? " tasks" : ""}`} onClick={onPreviewClick}
              dangerouslySetInnerHTML={{ __html: previewHtml }} />
            {missingEl && <div className="links">{missingEl}</div>}
          </div>
        </div>
      ) : listEl}
      {menu && cur && !ai && !view && (
        <div className="menu" role="menu">
          <div className="menu-head">{cur.title}</div>
          {cur.actions.map((a, i) => (
            <div key={a.title} role="menuitem" className={i === asel ? "act on" : "act"}
              onMouseMove={() => setAsel(i)} onMouseDown={e => { e.preventDefault(); run(a); }}>
              <span>{a.title}</span>
              <span>{i === 0 ? <kbd>↵</kbd> : a.shortcut && [...a.shortcut].map(k => <kbd key={k}>{k}</kbd>)}</span>
            </div>
          ))}
        </div>
      )}
      {/* 하단 막대: 끌어서 창을 옮김. "deep"이라 막대 안 글자·키 표시 위를 눌러도 끌림 (핀 버튼은 제외) */}
      <footer className="foot" data-tauri-drag-region="deep" title={pinned ? "하단 막대를 끌어 창 이동 · 가장자리를 끌어 크기 조절" : undefined}>
        {pending ? <span className="warn">{pending.confirm}</span> : <span className="brand">
          <button className={pinned ? "pin on" : "pin"} title={pinned ? "고정 해제 (⌘P)" : "창 고정 (⌘P)"}
            onMouseDown={e => e.preventDefault()} onClick={togglePin}>
            {(() => { const P = ICONS[pinned ? "pin" : "pinOff"]; return <P size={13} strokeWidth={2.2} />; })()}
          </button>
          Baro{pinned && <span className="pinned-hint"> · 고정됨</span>}
        </span>}
        {!pending && <span className="keys">
          {footerKeys.filter(([label]) => label).map(([label, keys], i) => (
            <span key={label} className={label === "액션" && menu ? "on" : ""}>
              {i > 0 && <span className="sep" />}{label} {keys.map(k => <kbd key={k}>{k}</kbd>)}
            </span>
          ))}
        </span>}
      </footer>
    </main>
  );
}
