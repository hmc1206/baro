import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { marked } from "marked";
import {
  query, fileItems, storeItems, homeItems, aiItem, iconFor, loadConfig, getConfig, copy, pasteText,
  Item, Action, View, Ui, StoreEntry,
} from "./commands";
import { loadDocs, rank, byCategory, Doc, NoteSearch, NoteKind, KIND_LABELS } from "./notes";
import { ICONS } from "./icons";
import { NoteGraph } from "./graph";

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
  ok: {
    title: "필요한 권한이 모두 있어요",
    body: "손쉬운 사용: 허용됨\n자동화: 휴지통 비우기·다크 모드를 처음 쓸 때 macOS가 따로 물어봐요.",
  },
};

// 단축키를 지정할 수 있는 기능: 고정 기능(Rust config.rs의 HOTKEY_ACTIONS) + 사용자가 만든 노트 검색
const hotkeyLabels = (): [string, string][] => [
  ["baro", "Baro 열기"], ["ai", "AI에게 묻기"], ["store", "확장 스토어"], ["graph", "노트 그래프 (전체)"],
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

type Ai = { id: number; q: string; text: string; busy: boolean; error: string | null; saved?: string; saveError?: string };
type Store = { entries: StoreEntry[]; loading: boolean; error: string | null };
type Notes = { search: NoteSearch | null; docs: Doc[]; loading: boolean; error: string | null };
// 노트 검색 추가·수정 화면의 입력값
type Draft = { id: string; name: string; dir: string; kind: NoteKind; hotkey: string; recording: boolean; error: string | null; saving: boolean };
type Hk = { keys: Record<string, string>; recording: string | null; error: string | null };
// 비밀번호 모음: 수정(doc 있음) 또는 새 노트 추가(doc 없음)
type PwDraft = { doc: Doc | null; name: string; title: string; password: string; error: string | null; saving: boolean };
const MASK = "••••••••";
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
// 화면 종류: null(기본 검색) | 확장 스토어 | 노트 검색 | 예시 고르기 | 단축키 설정 | AI 질문 | 노트 검색 관리 | 노트 검색 추가·수정
type Mode = null | "store" | "note" | "examples" | "hotkeys" | "ask" | "noteManage" | "noteEdit" | "pwEdit";

export default function App() {
  const [q, setQ] = useState("");
  const [top, setTop] = useState<Item[]>([]);
  const [bottom, setBottom] = useState<Item[]>([]);
  const [files, setFiles] = useState<Item[]>([]);
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
  const [hk, setHk] = useState<Hk>({ keys: {}, recording: null, error: null });
  const aiSeq = useRef(0);
  const input = useRef<HTMLInputElement>(null);
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
  // AI 답변을 Obsidian 노트로 저장 (⌘S). 날짜는 내 Mac의 오늘 날짜
  const saveAi = async () => {
    if (!ai || ai.busy || !ai.text.trim() || ai.saved) return;
    const d = new Date();
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const id = ai.id;
    try {
      const saved = await invoke<string>("save_ai", { date, question: ai.q, answer: ai.text });
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
    setGraph(asGraph); setPick(null); setReveal(false);
    setNotes(n => ({ search: search!, docs: n.search?.id === id ? n.docs : [], loading: true, error: null }));
    loadDocs(search)
      .then(docs => setNotes({ search: search!, docs, loading: false, error: null }))
      .catch(e => setNotes({ search: search!, docs: [], loading: false, error: String(e) }));
  };
  const openGraph = () => openNotes("__vault", true);
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
    ask, openStore, openNotes, openGraph, openNoteManager, openHotkeys, togglePin,
    show: v => { setAi(null); setView(v); },
    setQuery: text => { setQ(text); input.current?.focus(); },
  };

  // 노트 검색: 검색어가 없으면 분류(폴더)별 전체, 있으면 점수순
  const noteList = useMemo(
    () => mode === "note" ? (q.trim() ? rank(notes.docs, q).slice(0, 80) : byCategory(notes.docs)) : [],
    [mode, notes.docs, q]);
  const noteItem = (d: Doc): Item => {
    const kind = notes.search?.kind ?? "notes";
    const obsidian: Action = { title: "Obsidian에서 열기", shortcut: "⌘O",
      run: () => invoke("open_url", { url: `obsidian://open?path=${encodeURIComponent(d.file)}` }) };
    if (kind === "passwords") {
      const p = d.meta.password ?? "", ssh = d.meta.ssh;
      return { id: `n-${d.file}`, title: d.name, kind: "wiki", glyph: "lock", section: q.trim() ? undefined : d.category,
        subtitle: p ? (reveal ? p : MASK) : d.meta.key_file ? `키 파일 ${d.meta.key_file}` : "비밀번호 없음",
        actions: [
          ...(p ? [{ title: "비밀번호 복사", run: () => copy(p) },
            { title: "앞 앱에 비밀번호 붙여넣기", shortcut: "⌘↵", run: () => pasteText(p) }] : []),
          { title: "비밀번호 수정", shortcut: "⌘E", keep: true, run: async () => openPw(d) },
          ...(ssh ? [{ title: "접속 명령 복사", run: () => copy(ssh) }, { title: "접속 명령 붙여넣기", run: () => pasteText(ssh) }] : []),
          obsidian,
        ] };
    }
    const pick = kind === "commands" ? "예시 골라서 쓰기" : "코드 골라서 쓰기";
    const actions: Action[] = kind === "snippets" ? [
      { title: "앞 앱에 붙여넣기", run: () => pasteText(d.body) },
      { title: "복사", run: () => copy(d.body) },
      obsidian,
    ] : [
      ...(d.examples.length ? [{ title: pick, keep: true, run: async () => openExamples(d) }] : [obsidian]),
      ...(d.examples[0] ? [{ title: kind === "commands" ? "대표 예시 붙여넣기" : "첫 코드 붙여넣기", shortcut: "⌘↵", run: () => pasteText(d.examples[0].cmd) }] : []),
      { title: "이름 복사", run: () => copy(d.name) },
      ...(d.examples.length ? [obsidian] : []),
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
    : mode === "ask" ? (q.trim() ? [aiItem(q.trim(), ask)] : [])
    : home ? homeItems(ui) : [...top, ...files, ...bottom];
  const graphOn = mode === "note" && graph;
  const curDoc = mode === "note" ? (graphOn && pick ? pick : noteList[sel]) : undefined;
  const graphMatches = useMemo(() => graphOn && q.trim() ? new Set(noteList.map(d => d.file)) : null, [graphOn, q, noteList]);
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
    else if (mode !== null && mode !== "store" && mode !== "noteEdit") enter(null);
    input.current?.focus(); input.current?.select();
  };
  const shownRef = useRef(onShown);
  shownRef.current = onShown;

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
    setSel(0); setMenu(false); setPending(null); setPick(null);
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
    if (e.key === "Tab" && (mode === null || mode === "ask")) { e.preventDefault(); if (q.trim()) ask(q.trim()); return; }
    if (ai) {
      // AI 화면: Enter는 입력한 내용으로 다시 질문, ⇧Enter로 답변 복사
      if (e.key === "Escape") { setAi(null); input.current?.select(); }
      else if (e.metaKey && e.code === "KeyS") { e.preventDefault(); saveAi(); }
      else if (e.metaKey && e.code === "KeyO" && ai.saved) { e.preventDefault(); invoke("open_url", { url: `obsidian://open?path=${encodeURIComponent(ai.saved)}` }); }
      else if (e.key === "Enter" && e.shiftKey) { e.preventDefault(); navigator.clipboard.writeText(ai.text); }
      else if (e.key === "Enter") { e.preventDefault(); if (q.trim() && !ai.busy) ask(q.trim()); }
      return;
    }
    // ⌘R: 비밀번호 보이기·가리기
    if (mode === "note" && notes.search?.kind === "passwords" && e.metaKey && e.code === "KeyR") { e.preventDefault(); setReveal(v => !v); return; }
    // ⌘G: 노트 목록 ↔ 그래프
    if (mode === "note" && e.metaKey && e.code === "KeyG") { e.preventDefault(); setGraph(v => !v); setPick(null); setMenu(false); return; }
    // ⌘↵, ⌘O 같은 동작별 단축키
    if (e.metaKey && cur && !menu) {
      const sc = e.code === "Enter" ? "⌘↵" : e.code.startsWith("Key") ? `⌘${e.code.slice(3)}` : "";
      const a = cur.actions.find(x => x.shortcut === sc);
      if (a) { e.preventDefault(); run(a); return; }
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
  const quick = cur?.actions.find((a, i) => i > 0 && a.shortcut); // 기본 동작과 겹치면 하단에 두 번 보이지 않게
  const footerKeys: [string, string[]][] = view
    ? [[view.kind === "perm" ? (view.perm === "ok" ? "" : "시스템 설정 열기") : "결과 복사", ["↵"]], ["돌아가기", ["esc"]]]
    : ai ? [["답변 복사", ["⇧", "↵"]], ai.saved ? ["Obsidian에서 열기", ["⌘", "O"]] : ["Obsidian에 저장", ["⌘", "S"]], ["돌아가기", ["esc"]]]
    : hk.recording ? [["취소", ["esc"]]]
    : cur ? [[cur.actions[0].title, ["↵"]], ...(quick ? [[quick.title, [...quick.shortcut!]] as [string, string[]]] : []),
      ...(mode === "note" && notes.search?.kind === "passwords" ? [[reveal ? "가리기" : "보기", ["⌘", "R"]] as [string, string[]]] : []),
      ...(mode === "note" ? [[graph ? "목록" : "그래프", ["⌘", "G"]] as [string, string[]]] : []), ["액션", ["⌘", "K"]]] : [];
  const placeholder = ai ? "다시 물어보기"
    : mode === "store" ? "확장 검색"
    : mode === "note" ? (notes.search?.kind === "commands" ? "명령어 또는 하고 싶은 작업 (예: 포트 확인, 권한 변경)" : `${notes.search?.name ?? "노트"} 검색`)
    : mode === "noteManage" ? "노트 검색 관리"
    : mode === "examples" ? `${exDoc?.doc.name ?? ""} 예시 검색`
    : mode === "hotkeys" ? "단축키 설정"
    : mode === "ask" ? "AI에게 물어보기 (Enter)"
    : "앱, 파일, 명령, 계산, AI에게 묻기";
  const header = home ? "Baro로 할 수 있는 일"
    : mode === "store" ? `확장 스토어${store.loading ? " · 불러오는 중…" : ""}`
    : mode === "note" && (notes.loading || q.trim()) ? (notes.loading ? "노트 불러오는 중…" : `검색 결과 ${noteList.length}개`)
    : null;
  const empty = mode === "store" ? store.error
    : mode === "note" ? notes.error ?? (!notes.loading && !items.length ? (q ? "일치하는 노트가 없어요." : "폴더에 노트(.md)가 없어요.") : null)
    : mode === "hotkeys" ? hk.error
    : mode === null && q && !items.length ? "결과가 없습니다. 다른 이름으로 검색해 보세요." : null;

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
      {mode !== "noteEdit" && mode !== "pwEdit" && <input ref={input} className="search" value={q} autoFocus spellCheck={false} placeholder={placeholder}
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
          <div className="ai-q"><span className="icon glyph ai">{(() => { const S = ICONS.ai; return <S size={15} strokeWidth={2.2} />; })()}</span>{ai.q}</div>
          {ai.error ? <p className="ai-err">{ai.error}</p>
            : <p className="ai-a">{ai.text}{ai.busy && <span className="caret" />}</p>}
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
          <NoteGraph docs={notes.docs} matches={graphMatches} selected={curDoc}
            onSelect={d => { setPick(d); setMenu(false); }}
            onOpen={d => invoke("open_url", { url: `obsidian://open?path=${encodeURIComponent(d.file)}` })} />
          <article className="preview md" dangerouslySetInnerHTML={{ __html: previewHtml }} />
        </div>
      ) : mode === "note" ? (
        // 노트 검색: 왼쪽 목록 + 오른쪽 노트 미리보기
        <div className="split">
          {listEl}
          <article className="preview md" dangerouslySetInnerHTML={{ __html: previewHtml }} />
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
