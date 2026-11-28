import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { marked } from "marked";
import {
  query, fileItems, recentFileItems, featureItems, FEATURE_TITLES, storeItems, aiItem, notesAiItem, loadConfig, getConfig, copy, pasteText, copySecret, pasteSecret,
  Item, Action, View, Ui, StoreEntry, Feature,
  appList, saveTodo,
} from "./commands";
import { loadDocs, rank, byCategory, byStage, nextUp, conceptHits, studyCard, Doc, NoteSearch, KIND_LABELS } from "./notes";
import { NoteGraph, linkInfo } from "./graph";
import { PERMS, hotkeyLabels, fmtKey, accelOf } from "./app/keys";
import type { Source, Ai, Store, Notes, Draft, Hk, PwDraft, Mode, Clip, DocEd } from "./app/types";
import { STATUS, weekLabel, docCache, docsSig, lastDoc } from "./app/status";
import { MASK, nextName, newPwNote, today, baseOf } from "./app/passwords";
import { useMemoScreen } from "./app/useMemoScreen";
import { useStudy, studyItem } from "./app/useStudy";
import { clipDay, clipTime, now } from "./app/memo";
import { parseDoc, serializeDoc, titleOf, type DocFields } from "./app/docfields";
import { groupByKind } from "./app/filekinds";
import { useCalendar } from "./app/useCalendar";
import { MonthGrid } from "./app/MonthGrid";
import { DateBar } from "./app/DateBar";
import { ItemList, ResultView, AiView, PwForm, SearchForm, MissingLinks, LinksPanel, MemoSide, ClipPreview, FilePreviewPane, type FilePrev, ActionMenu, Footer, DocEditor } from "./app/views";

export default function App() {
  const [q, setQ] = useState("");
  const [top, setTop] = useState<Item[]>([]);
  const [bottom, setBottom] = useState<Item[]>([]);
  const [files, setFiles] = useState<Item[]>([]);
  const [found, setFound] = useState<{ items: Item[]; loading: boolean }>({ items: [], loading: false }); // 파일 찾기 화면 결과
  const [feature, setFeature] = useState<Feature>("window"); // 기능 목록 화면에서 보는 기능
  const [filePrev, setFilePrev] = useState<{ path: string; prev: FilePrev | null; loading: boolean } | null>(null); // 파일 찾기 오른쪽 미리보기
  const prevCache = useRef(new Map<string, FilePrev>());
  const [fileOpen, setFileOpen] = useState<string | null>(null); // 파일 찾기 화면에서 한 종류만 펼쳐 보는 중
  const [appRows, setAppRows] = useState<Item[]>([]); // 앱 실행 화면 결과
  const [hint, setHint] = useState(""); // 처음 화면 기능을 고르면 입력창에 흐리게 보이는 예시
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
  // 커리큘럼 단계 안의 개념 목록 (Enter로 들어가고 Esc로 단계 목록으로)
  const restoreSel = useRef<number | null>(null);
  const [reveal, setReveal] = useState(false); // 비밀번호 모음: 비밀번호 보이기 (⌘R)
  const [pw, setPw] = useState<PwDraft | null>(null);
  const [docEd, setDocEd] = useState<DocEd | null>(null); // Baro 안에서 노트 편집 중
  const [graph, setGraph] = useState(false); // 노트 검색을 그래프로 보기 (⌘G)
  const [pick, setPick] = useState<Doc | null>(null); // 그래프에서 클릭한 노트
  const [local, setLocal] = useState(0); // 로컬 그래프: 0 끔, 1·2 = 고른 노트에서 몇 단계까지 (⌘L)
  const [clips, setClips] = useState<{ list: Clip[]; enabled: boolean }>({ list: [], enabled: true });
  const [hk, setHk] = useState<Hk>({ keys: {}, recording: null, error: null });
  const aiSeq = useRef(0);
  const input = useRef<HTMLInputElement & HTMLTextAreaElement>(null); // 메모 화면에서는 여러 줄 입력칸(textarea)
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
  const enter = (m: Mode) => { setQ(""); setHint(""); setView(null); setAi(null); setMode(m); input.current?.focus(); };
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
    setGraph(asGraph); setPick(null); setReveal(false); setLocal(0); setConc(null);
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
  const failNote = (title: string) => (e: unknown) => { invoke("log_error", { msg: `${title}: ${e}` }).catch(() => {}); setAi(null); setView({ kind: "text", title, text: String(e), error: true }); };
  const { conc, setConc, reloadDocs, openConcepts, stampStudied, setConceptStatus, setStatus, onPreviewClick: togglePreviewTask, fieldLabel } =
    useStudy({ q, setQ, sel, setSel, setMenu, mode, notes, setNotes, failNote });
  // 커리큘럼 미리보기의 체크박스 클릭 → 노트 파일에 체크/해제
  const onPreviewClick = (e: MouseEvent<HTMLElement>) => togglePreviewTask(e, curDoc, card);
  const { memo, crit, removed, delPending, setDelPending, editing, recRef, memoHtml,
    openMemo, memoItems, onRecClick, undoRemove, cancelEdit, toggleShot, shotName, picking, cancelPick, upDir } =
    useMemoScreen({ q, setQ, sel, setSel, mode, enter, input, notes, reloadDocs, conc, stampStudied });
  const loadClips = () => Promise.all([invoke<Clip[]>("clip_list"), invoke<boolean>("clip_enabled")])
    .then(([list, enabled]) => setClips({ list, enabled })).catch(() => {});
  const openClip = () => { enter("clip"); loadClips(); };
  const { cal, redate, cancelRedate, draft: calDraft, setPick: setCalPick, target: calTarget, setTarget: setCalTarget, pickDay, month, moveMonth, loadCal, calItems } = useCalendar({ q, setQ });
  const openCal = (text = "") => { enter("cal"); cancelRedate(); loadCal(); if (text) setQ(text); };
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
  const openFiles = () => { setFound({ items: [], loading: false }); setFileOpen(null); enter("files"); };
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
  // 런처는 검색 막대만: 검색 결과·명령에서 고르는 캘린더·메모·클립보드·파일·창 명령·노트(일반·명령어·스니펫)·그래프는 바탕화면 패널로
  // (패널의 ↗ 버튼이나 커리큘럼·비밀번호 노트는 지금처럼 런처 화면으로. 단축키로 열 때(onShown)는 위 함수들을 그대로 씀)
  const toPanel = (panel: string) => { invoke("open_panel", { panel }).catch(fail); setQ(""); };
  const panelNotes = (id: string) => ["notes", "commands", "snippets"].includes(getConfig().note_searches.find(n => n.id === id)?.kind ?? "");
  const ui: Ui = {
    ask, askNotes, openStore, openNoteManager, openHotkeys, togglePin,
    openNotes: (id, asGraph) => id === "__vault" || panelNotes(id) ? toPanel(id === "__vault" ? "graph" : `notes:${id}`) : openNotes(id, asGraph),
    openGraph: () => toPanel("graph"), openFiles: () => toPanel("files"), openMemo: () => toPanel("memo"), openClip: () => toPanel("clipboard"),
    openCal: text => text ? openCal(text) : toPanel("calendar"),
    show: v => { setAi(null); setView(v); },
    setQuery: text => { setMode(null); setHint(""); setQ(text); input.current?.focus(); }, // 처음 검색 화면으로 가서 입력
    openApps: () => enter("apps"),
    openFeature: f => { if (f === "window" || f === "system") toPanel("window"); else { setFeature(f); enter("feature"); } },
    setHint: text => { setQ(""); setHint(text); input.current?.focus(); },
  };

  // 노트 검색: 검색어가 없으면 분류(폴더)별 전체, 있으면 점수순
  const noteList = useMemo(
    () => mode === "note" && conc ? conc.docs.filter(d => !q.trim() || `${d.name} ${d.summary}`.toLowerCase().includes(q.trim().toLowerCase()))
      : mode === "note" ? (q.trim() ? [...(notes.search?.kind === "curriculum" ? conceptHits(notes.docs, q) : []), ...rank(notes.docs, q).slice(0, 80)]
      : notes.search?.kind === "curriculum" ? [...nextUp(notes.docs), ...[...notes.docs].sort(byStage)]
      : byCategory(notes.docs)) : [],
    [mode, notes.docs, q, notes.search?.kind, conc]);
  // Baro 안에서 노트 편집 (비밀번호 모음은 비밀번호 수정 화면을 씀)
  // 편집칸 값은 편집기 안에서만 바뀌고(입력할 때 App 전체를 다시 그리지 않게), 저장·닫기 때 여기서 읽음
  const docFields = useRef<DocFields | null>(null);
  const docDirty = () => !!docEd && !!docFields.current && serializeDoc(docFields.current) !== docEd.start;
  const startDocEdit = (ed: Omit<DocEd, "start" | "ask" | "msg" | "err">) => {
    docFields.current = ed.init;
    setDocEd({ ...ed, start: ed.isNew ? "" : serializeDoc(ed.init), ask: false, msg: null, err: null });
    setView(null); setAi(null); setMode("docEdit");
  };
  const openDocEdit = (d: Doc) => {
    const search = notes.search;
    if (!search) return;
    invoke<string>("note_read", { id: search.id, file: d.file })
      .then(text => startDocEdit({ search, doc: d, base: text, init: parseDoc(text, titleOf(d.file)), q }))
      .catch(failNote);
  };
  // 닫을 때: 폴더를 새로 읽고, 방금 고친(만든) 글을 목록에서 골라 둠
  const pickFile = useRef<string | null>(null);
  const closeDocEdit = () => {
    const back = docEd?.isNew ? "" : docEd?.q ?? "";
    pickFile.current = docEd?.doc.file || null;
    setTimeout(() => { pickFile.current = null; }, 3000); // 목록에 안 나오면 (검색어에 안 맞는 등) 그냥 둠
    if (docEd) docCache.delete(docEd.search.id);
    setDocEd(null); docFields.current = null; setMode("note"); setQ(back); reloadDocs();
    requestAnimationFrame(() => input.current?.focus());
  };
  const saveDocEdit = async () => {
    const ed = docEd, f = docFields.current;
    if (!ed || !f) return;
    const name = f.title.trim(), content = serializeDoc(f);
    if (!name) { setDocEd({ ...ed, err: "제목을 써 주세요. 제목이 파일 이름이 돼요.", msg: null }); return; }
    if (!ed.isNew && content === ed.start && name === titleOf(ed.doc.file)) { setDocEd({ ...ed, msg: "바뀐 내용이 없어요", err: null, ask: false }); return; }
    const done = (file: string, msg: string) => {
      setDocEd(d => d && { ...d, isNew: false, doc: { ...d.doc, name, file }, base: content, start: content, ask: false, msg, err: null });
      docCache.delete(ed.search.id); reloadDocs(); // 목록에도 바로 반영
    };
    const call = ed.isNew ? invoke<string>("note_create", { id: ed.search.id, name, content })
      : invoke<string>("note_write", { id: ed.search.id, file: ed.doc.file, base: ed.base, content, name });
    await call.then(file => done(file, `✓ ${ed.isNew ? "만들었어요" : file !== ed.doc.file ? "이름 바꿔 저장했어요" : "저장했어요"} · ${now().time}`))
      .catch(e => setDocEd(d => d && { ...d, err: String(e), msg: null }));
  };
  // 글쓰기 노트 검색: 새 글. 입력한 검색어가 있으면 그걸 제목으로
  const newWriteItem = (): Item => {
    const title = q.trim();
    return { id: "w-new", title: title ? `새 글 쓰기: ${title}` : "새 글 쓰기", subtitle: `${notes.search?.name ?? ""} 폴더에 만들어요 · 제목이 파일 이름`,
      kind: "cmd", glyph: "plus", section: "쓰기", actions: [{ title: "쓰기", keep: true, run: async () => openNewDoc(title) }] };
  };
  const openNewDoc = (title: string) => {
    const search = notes.search;
    if (!search) return;
    startDocEdit({ search, doc: { name: title || "새 글", file: "" } as Doc, isNew: true, base: "",
      init: { title, props: [{ key: "created", value: now().date }], body: "" }, q });
  };
  const withEdit = (it: Item, d: Doc): Item => notes.search?.kind === "passwords" || notes.search?.kind === "write" ? it
    : { ...it, actions: [...it.actions, { title: "Baro에서 편집", shortcut: "⌘E", keep: true, run: async () => openDocEdit(d) }] };
  const noteItem = (d: Doc): Item => {
    const kind = notes.search?.kind ?? "notes";
    const obsidian: Action = { title: "Obsidian에서 열기", shortcut: "⌘O",
      run: () => invoke("open_url", { url: `obsidian://open?path=${encodeURIComponent(d.file)}` }) };
    const finder: Action = { title: "Finder에서 보기", shortcut: "⌘F", run: () => invoke("reveal", { path: d.file }) };
    if (kind === "write") return { id: `n-${d.file}`, title: d.name, kind: "wiki", glyph: "doc", section: q.trim() ? undefined : "이 폴더의 글",
      subtitle: d.summary, actions: [{ title: "Baro에서 고치기", keep: true, run: async () => openDocEdit(d) }, obsidian, finder] };
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
    const s = studyItem(d, { q, kind, notes, conc, obsidian, finder, createConcept, reloadDocs, openObsidian, openMemo,
      openConcepts, setConceptStatus, setStatus, fieldLabel });
    if (s) return s;
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
    : mode === "note" ? [...(notes.search?.kind === "write" && !conc ? [newWriteItem()] : []), ...noteList.map(d => withEdit(noteItem(d), d)), ...(notes.search?.kind === "passwords" && !notes.loading && !notes.error ? [{
        id: "pw-new", title: "새 항목 추가", subtitle: `${nextName(lastDoc(notes.docs))} · 비밀번호 입력`, kind: "cmd" as const, glyph: "plus",
        section: "추가", actions: [{ title: "추가", keep: true, run: async () => openPw(null) }] }] : [])]
    : mode === "pwEdit" ? []
    : mode === "noteManage" ? manageItems()
    : mode === "noteEdit" ? []
    : mode === "hotkeys" ? hotkeyItems()
    : mode === "store" ? storeItems(q, store.entries, () => setRev(r => r + 1), ui)
    : mode === "ask" ? (q.trim() ? [aiItem(q.trim(), ask, askNotes), ...[notesAiItem(q.trim(), askNotes)].filter((x): x is Item => !!x)] : [])
    : mode === "files" ? groupByKind(found.items, q.trim() ? 6 : 8, fileOpen, (kind, rest): Item => ({
        id: `fk-${kind}`, title: `${kind} ${rest}개 더 보기`, subtitle: "Esc로 전체 종류로 돌아오기", kind: "cmd", glyph: "plus",
        actions: [{ title: "더 보기", keep: true, run: async () => { setFileOpen(kind); setSel(0); } }] }))
    : mode === "apps" ? appRows
    : mode === "feature" ? featureItems(feature, q, ui)
    : mode === "memo" ? memoItems()
    : mode === "clip" ? clipItems()
    : mode === "cal" ? calItems()
    : home ? [] : [...top, ...files, ...bottom]; // 처음 화면: 목록 없이 검색 막대만
  const graphOn = mode === "note" && graph;
  useEffect(() => {
    if (!pickFile.current || mode !== "note") return;
    const i = items.findIndex(it => it.id === `n-${pickFile.current}`);
    if (i >= 0) { setSel(i); pickFile.current = null; }
  });
  const memoPickAt = mode === "memo" ? items.findIndex(i => i.id === "memo-pick") : -1; // 빠른 메모: 저장할 곳 칸 수 (그 뒤는 고르기·사진·클립보드)
  // 창 크기 종류: 그래프는 가장 크게, 미리보기가 있는 화면·AI 답변은 넓게. 종류마다 사용자가 맞춘 크기를 기억
  const bar = home && !view && !ai; // 검색어가 없으면 창을 입력 막대 높이로
  const sizeKind = bar ? "bar" : graphOn ? "graph" : ai || mode === "note" || mode === "docEdit" || mode === "memo" || mode === "clip" ? "wide" : mode === "cal" ? "graph" : "normal";
  useEffect(() => { invoke("set_view", { kind: sizeKind }); }, [sizeKind]);
  const curClip = mode === "clip" ? clips.list.find(c => `clip-${c.at}` === items[sel]?.id) : undefined;
  // 커리큘럼 허브: 그래프에는 단계 대신 연결된 단계 노트를 보여 주고, 고르면 허브 단계로
  const hubMode = notes.docs.some(d => d.heading);
  const graphDocs = useMemo(() => hubMode ? notes.docs.flatMap(d => d.record ? [d.record] : []) : notes.docs, [notes.docs, hubMode]);
  const curDoc: Doc | undefined = mode === "note" ? (graphOn && pick ? (notes.docs.find(d => d.record?.file === pick.file) ?? pick) : noteList[sel]) : undefined;
  const card = useMemo(() => curDoc?.concept ? studyCard(curDoc) : null, [curDoc]);
  // 미리보기: 가는·오는 링크, 아직 없는 링크 (비밀번호 모음 제외)
  const linksOn = mode === "note" && notes.search?.kind !== "passwords";
  const links = useMemo(() => linksOn ? linkInfo(notes.docs) : null, [linksOn, notes.docs]);
  const curLinks = curDoc && links?.get(curDoc.file);
  const graphMatches = useMemo(() => graphOn && q.trim() ? new Set(noteList.map(d => (d.record ?? d).file)) : null, [graphOn, q, noteList]);

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
    // 개념: 공부 카드 (진도는 카드에 보이는 완료 기준 기준)
    if (curDoc.concept && card) {
      const c = curDoc.concept, tasks = card.taskMap.map(k => curDoc.tasks?.[k]).filter(Boolean), n = tasks.filter(x => x!.done).length;
      const info = [c.status ? `**상태** ${c.status}` : "", c.priority, c.prereq && c.prereq !== "없음" ? `**선행** ${c.prereq}` : "",
        tasks.length ? `**완료 기준** ${n}/${tasks.length}` : "", `${c.stage}`].filter(Boolean).join(" · ");
      const bar = tasks.length ? `<progress value="${n}" max="${tasks.length}"></progress>\n\n` : "";
      return bar + (marked.parse(`> ${info}\n\n### ${curDoc.name}\n\n${card.md}`, { async: false }) as string)
        .replace(/<input disabled="" type="checkbox"/g, '<input type="checkbox"').replace(/<input checked="" disabled="" type="checkbox"/g, '<input checked="" type="checkbox"');
    }
    if (notes.search?.kind === "curriculum") {
      const tasks = curDoc.tasks ?? [], n = tasks.filter(x => x.done).length, st = curDoc.meta.status || "todo";
      const info = [tasks.length ? `**진도** ${n}/${tasks.length} (${Math.round(n / tasks.length * 100)}%)` : "",
        `**상태** ${STATUS[st] ?? st}`, curDoc.meta.week ? `**기간** ${weekLabel(curDoc.meta.week)}` : curDoc.meta.hours ? `**시간** ${curDoc.meta.hours}` : ""].filter(Boolean).join(" · ");
      const bar = tasks.length ? `<progress value="${n}" max="${tasks.length}"></progress>\n\n` : "";
      return bar + (marked.parse(`> ${info}\n\n${md}`, { async: false }) as string).replace(/<input disabled="" type="checkbox"/g, '<input type="checkbox"')
        .replace(/<input checked="" disabled="" type="checkbox"/g, '<input checked="" type="checkbox"');
    }
    return marked.parse(md, { async: false }) as string;
  }, [curDoc, card, reveal, notes.search?.kind]);

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
    else if (action === "calendar") openCal();
    else if (mode !== null && mode !== "store" && mode !== "noteEdit" && mode !== "docEdit") enter(null); // 편집 중인 노트는 창을 다시 열어도 그대로
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
      // 노트 뜻 색인 만들기 진행 (그 결과 화면이 떠 있을 때만 갱신)
      listen<{ done: number; total: number }>("embed-progress", e => setView(v => v?.kind === "text" && v.title.startsWith("노트 뜻 색인")
        ? { ...v, title: "노트 뜻 색인 만드는 중", text: `${e.payload.done} / ${e.payload.total} 단락 (${Math.round(e.payload.done / Math.max(1, e.payload.total) * 100)}%)\n창을 닫아도 계속 만들어요.` } : v)),
      listen<{ total: number; count: number; error: string | null }>("embed-done", e => setView(v => v?.kind === "text" && v.title.startsWith("노트 뜻 색인")
        ? e.payload.error ? { kind: "text", title: "노트 뜻 색인을 만들지 못했어요", text: e.payload.error, error: true }
          : { kind: "text", title: "노트 뜻 색인을 만들었어요", text: `단락 ${e.payload.count}개. 이제 내 노트에게 묻기가 단어 검색과 뜻 검색을 함께 써요.` } : v)),
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
    if (mode !== "memo") { setSel(restoreSel.current ?? 0); restoreSel.current = null; }
    else if (picking) setSel(0); // 노트 고르기: 검색할 때마다 첫 결과
    else if (memo.stage && /^\s*!/.test(q)) setSel(crit.length + 1); // 막힌 점과 해결 (개념이면 완료 기준 칸 다음)
    else if (memo.stage && /^\s*\$/.test(q)) setSel(crit.length + 2); // 사용한 명령어
    else if (q.trim()) setSel(s => s >= memoPickAt ? 0 : s); // 고르기·사진·클립보드 칸에 있다가 입력을 시작하면 첫 칸으로
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

  // 앱 실행 화면: 입력이 없으면 전체 앱, 있으면 일치하는 앱
  useEffect(() => {
    if (mode !== "apps") return;
    let live = true;
    appList(q.trim()).then(items => { if (live) { setAppRows(items); setSel(0); } });
    return () => { live = false; };
  }, [q, mode]);

  // 파일 찾기 화면: 입력이 없으면 최근 바뀐 파일, 입력이 멈추면 홈 + 외장 디스크 검색 (둘 다 종류별 구역으로 보여 줌)
  useEffect(() => {
    if (mode !== "files") return;
    setFound(f => ({ ...f, loading: true }));
    let live = true;
    const load = q.trim() ? () => fileItems(q, true) : recentFileItems;
    const t = setTimeout(() => load().then(items => { if (live) { setFound({ items, loading: false }); setSel(0); } }), q.trim() ? 150 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [q, mode]);

  // 파일 찾기: 고른 파일 내용 불러오기 (방향키로 빨리 지나가면 건너뛰고, 본 파일은 기억)
  const curPath = mode === "files" ? items[sel]?.path : undefined;
  useEffect(() => {
    if (!curPath) return;
    const hit = prevCache.current.get(curPath);
    if (hit) { setFilePrev({ path: curPath, prev: hit, loading: false }); return; }
    setFilePrev({ path: curPath, prev: null, loading: true });
    let live = true;
    const t = setTimeout(() => invoke<FilePrev>("file_preview", { path: curPath })
      .then(p => { if (prevCache.current.size > 60) prevCache.current.clear(); prevCache.current.set(curPath, p); return p; }, () => null)
      .then(p => { if (live) setFilePrev({ path: curPath, prev: p, loading: false }); }), 120);
    return () => { live = false; clearTimeout(t); };
  }, [curPath]);

  // 선택 항목이 보이도록 스크롤
  useEffect(() => { list.current?.querySelectorAll("[role=option]")[sel]?.scrollIntoView({ block: "nearest" }); }, [sel, mode]);

  const fail = (e: unknown) => {
    const msg = String(e);
    invoke("log_error", { msg }).catch(() => {});
    setAi(null);
    setView(msg.startsWith("PERM:") ? { kind: "perm", perm: msg.slice(5) } : { kind: "text", title: "실행하지 못했어요", text: msg, error: true });
  };
  const cur = graphOn && pick ? noteItem(curDoc ?? pick) : items[sel];
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
    else if (mode === "note" && conc && !graphOn) { restoreSel.current = conc.prevSel; setSel(conc.prevSel); setQ(conc.prevQ); setConc(null); }
    else if (graphOn) { setGraph(false); setPick(null); }
    else if (mode === "memo" && memo.from) setMode(memo.from); // 커리큘럼에서 왔으면 그 화면으로
    else setMode(null);
  };

  // 키 입력은 창 전체에서 받음: 마우스로 클릭해 입력창 포커스가 빠져도 Esc·Enter·방향키가 동작
  // 화면별 함수가 차례로 받아 보고, 처리했으면 true를 돌려 다음 함수로 넘기지 않음 (순서가 곧 우선순위)

  // 입력 화면(노트 검색 추가·수정, 비밀번호 수정·추가, 단축키 입력 중): 다른 키 처리보다 먼저
  const keyForms = (e: KeyboardEvent): boolean => {
    // 노트 편집: ⌘S 저장, Esc 닫기 (안 저장한 변경이 있으면 한 번 더), ⌘O Obsidian. 나머지 키는 편집칸으로
    if (mode === "docEdit" && docEd) {
      if (e.metaKey && e.code === "KeyS") { e.preventDefault(); saveDocEdit(); }
      else if (e.metaKey && e.code === "KeyO") { e.preventDefault(); if (docEd.doc.file) openObsidian(docEd.doc.file); }
      else if (e.key === "Escape") {
        e.preventDefault();
        if (docDirty() && !docEd.ask) setDocEd({ ...docEd, ask: true });
        else closeDocEdit();
      }
      return true;
    }
    // 노트 검색 추가·수정 화면: 입력칸은 그대로 두고 Esc(취소)·⌘↵(저장)·단축키 입력만 처리
    if (mode === "noteEdit" && draft) {
      if (draft.recording) {
        e.preventDefault();
        if (e.key === "Escape") { invoke("suspend_hotkeys", { on: false }); setDraft({ ...draft, recording: false }); return true; }
        const accel = accelOf(e);
        if (accel) { invoke("suspend_hotkeys", { on: false }); setDraft({ ...draft, hotkey: accel, recording: false }); }
        return true;
      }
      if (e.key === "Escape") { e.preventDefault(); setDraft(null); openNoteManager(); }
      else if (e.key === "Enter" && e.metaKey) { e.preventDefault(); saveDraft(); }
      return true;
    }
    // 비밀번호 수정·추가 화면: Esc(취소)·⌘↵(저장)
    if (mode === "pwEdit" && pw) {
      if (e.key === "Escape") { e.preventDefault(); setPw(null); setMode("note"); }
      else if (e.key === "Enter" && e.metaKey) { e.preventDefault(); savePw(); }
      return true;
    }
    // 단축키 입력 중: 다음에 누른 조합을 저장
    if (hk.recording) {
      e.preventDefault();
      if (e.key === "Escape") { invoke("suspend_hotkeys", { on: false }); setHk(h => ({ ...h, recording: null })); return true; }
      const accel = accelOf(e);
      if (accel) saveHotkey(hk.recording, accel);
      return true;
    }
    return false;
  };

  // 어느 화면에서나: ⌘P 창 고정, ⌘K 액션 패널, 한글 조합 중 키 무시
  const keyGlobal = (e: KeyboardEvent): boolean => {
    // ⌘K: 한글 자판에선 e.key가 "ㅏ"라서 물리 키(e.code)로 판별
    // ⌘P: 창 고정·해제
    if (e.metaKey && e.code === "KeyP") { e.preventDefault(); togglePin(); return true; }
    if ((e.metaKey || e.ctrlKey) && e.code === "KeyK") {
      e.preventDefault();
      if (ai || view) return true;
      if (cur) { setMenu(m => !m); setAsel(0); }
      return true;
    }
    // 한글 조합 중 키 입력은 무시 (WebKit은 isComposing 대신 keyCode 229를 줌)
    return e.isComposing || e.keyCode === 229;
  };

  // 결과·권한 화면: Enter는 (권한이면) 설정 열기 / 결과 복사, Esc는 돌아가기
  const keyView = (e: KeyboardEvent): boolean => {
    if (!view) return false;
    if (e.key === "Escape") { setView(null); input.current?.select(); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if (view.kind === "perm" && view.perm !== "ok") invoke("open_settings", { kind: view.perm });
      else if (view.kind === "text") navigator.clipboard.writeText(view.text);
    }
    return true;
  };

  // 빠른 메모: ⌘Z 되돌리기, Esc 취소, ⌘I 사진, ⇧Enter 줄바꿈, Tab 저장할 곳, 여러 줄일 때 ↑↓는 커서 이동
  const keyMemo = (e: KeyboardEvent): boolean => {
    if (mode !== "memo" || view || menu) return false;
    if (e.metaKey && e.code === "KeyZ" && !q && removed) { e.preventDefault(); undoRemove(); return true; }
    if (e.key === "Escape" && delPending) { e.preventDefault(); setDelPending(null); return true; }
    if (e.key === "Escape" && editing) { e.preventDefault(); cancelEdit(); return true; }
    if (e.key === "Escape" && picking) { e.preventDefault(); cancelPick(); return true; }
    if (e.key === "Backspace" && picking && !q && upDir()) { e.preventDefault(); return true; } // 노트 고르기: 빈 입력에서 ⌫ = 상위 폴더
    if (e.metaKey && e.code === "KeyI") { e.preventDefault(); toggleShot(); return true; } // 방금 찍은 스크린샷 붙이기·빼기
    if (e.key === "Enter" && e.shiftKey) return true; // 줄바꿈
    if (e.key === "Tab") { e.preventDefault(); const n = items.length || 1; setSel(s => (s + (e.shiftKey ? n - 1 : 1)) % n); return true; }
    return q.includes("\n") && (e.key === "ArrowUp" || e.key === "ArrowDown"); // 여러 줄: 커서 이동
  };

  // AI: 기본 검색·AI 화면의 Tab은 AI에게 묻기. 답변 화면에서 Enter 다시 질문, ⌘↵ 노트에게, ⇧Enter 답변 복사, ⌘S 저장, ⌘O 저장한 노트 열기
  const keyAi = (e: KeyboardEvent): boolean => {
    if (e.key === "Tab" && (mode === null || mode === "ask")) { e.preventDefault(); if (q.trim()) ask(q.trim()); return true; }
    if (!ai) return false;
    if (e.key === "Escape") { setAi(null); input.current?.select(); }
    else if (e.metaKey && e.code === "KeyS") { e.preventDefault(); saveAi(); }
    else if (e.metaKey && e.code === "KeyO" && ai.saved) { e.preventDefault(); invoke("open_url", { url: `obsidian://open?path=${encodeURIComponent(ai.saved)}` }); }
    else if (e.key === "Enter" && e.shiftKey) { e.preventDefault(); navigator.clipboard.writeText(ai.text); }
    else if (e.key === "Enter" && e.metaKey) { e.preventDefault(); if (q.trim() && !ai.busy) askNotes(q.trim()); }
    else if (e.key === "Enter") { e.preventDefault(); if (q.trim() && !ai.busy) (ai.notes ? askNotes : ask)(q.trim()); }
    return true;
  };

  // 노트 검색·그래프: ⌘R 비밀번호 보이기, ⌘G 목록↔그래프, ⌘L 로컬 그래프, 그래프가 처리하는 키는 넘김
  const keyNotes = (e: KeyboardEvent): boolean => {
    // ⌘R: 비밀번호 보이기·가리기
    if (mode === "note" && notes.search?.kind === "passwords" && e.metaKey && e.code === "KeyR") { e.preventDefault(); setReveal(v => !v); return true; }
    // ⌘G: 노트 목록 ↔ 그래프
    if (mode === "note" && !conc && e.metaKey && e.code === "KeyG") { e.preventDefault(); setGraph(v => !v); setPick(null); setMenu(false); return true; }
    // ⌘L: 로컬 그래프 끔 → 1단계 → 2단계 → 끔
    if (graphOn && e.metaKey && e.code === "KeyL") { e.preventDefault(); setLocal(v => (v + 1) % 3); setMenu(false); return true; }
    // ⌥+방향키(이웃 노트로 이동)와 ⌘0(맞춤)은 그래프가 처리
    return graphOn && !menu && ((e.altKey && e.key.startsWith("Arrow")) || (e.metaKey && e.code === "Digit0"));
  };

  // ⌘↵, ⌘O 같은 고른 항목의 동작별 단축키
  const keyShortcut = (e: KeyboardEvent): boolean => {
    if (!e.metaKey || !cur || menu) return false;
    const sc = e.code === "Enter" ? "⌘↵" : e.code.startsWith("Key") ? `⌘${e.code.slice(3)}` : "";
    const typed = input.current && input.current.selectionStart !== input.current.selectionEnd;
    const a = sc === "⌘C" && typed ? undefined : cur.actions.find(x => x.shortcut === sc); // 입력창에서 글자를 골랐으면 ⌘C는 그 글자 복사
    if (a) { e.preventDefault(); run(a); return true; }
    // ⌘↵: 고른 항목에 ⌘↵ 동작이 없으면 기본 검색·AI 화면에서는 "내 노트에게 묻기", 그 밖에는 아무것도 안 함 (Enter 동작으로 넘어가지 않게)
    if (e.key === "Enter") {
      e.preventDefault();
      if ((mode === null || mode === "ask") && q.trim()) askNotes(q.trim());
      return true;
    }
    return false;
  };

  // 목록(또는 ⌘K 액션 패널): ↑↓ 이동, Enter 실행, Esc 단계별로 물러나기
  const keyList = (e: KeyboardEvent) => {
    const n = menu ? cur?.actions.length ?? 0 : items.length;
    const move = menu ? setAsel : setSel;
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !menu && pick) setPick(null);
    if (e.key === "ArrowDown") { e.preventDefault(); setPending(null); move(s => Math.min(s + 1, n - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setPending(null); move(s => Math.max(s - 1, 0)); }
    // 확인을 묻는 중이면 (⌘D 삭제 등) Enter는 그 동작을 실행
    else if (e.key === "Enter") { e.preventDefault(); run(menu ? cur?.actions[asel] : cur?.actions.find(x => pending?.key === `${cur.id}:${x.title}`) ?? cur?.actions[0]); }
    // Esc: 확인 취소 → 액션 패널 닫기 → 입력 지우기 → 예시 지우기 → 이전 화면 → 창 닫기
    else if (e.key === "Escape") {
      if (pending) setPending(null); else if (menu) setMenu(false); else if (mode === "files" && fileOpen) { setFileOpen(null); setSel(0); } else if (mode === "cal" && redate) cancelRedate(); else if (q) setQ(""); else if (hint) setHint("");
      else if (mode !== null) back(); else invoke("close_window");
    }
  };

  const onKey = (e: KeyboardEvent) => {
    if (keyForms(e)) return;
    if (document.activeElement !== input.current && !(view || ai)) input.current?.focus();
    if (mode === "cal" && e.metaKey && (e.code === "BracketLeft" || e.code === "BracketRight")) { e.preventDefault(); moveMonth(e.code === "BracketLeft" ? -1 : 1); return; }
    // 홈: 입력한 글을 바로 노션 할 일로 ("내일 3시 회의" ⌘T)
    if (mode === null && !view && e.metaKey && e.code === "KeyT" && q.trim()) { e.preventDefault(); saveTodo(q.trim(), ui).catch(fail); return; }
    if (keyGlobal(e) || keyView(e) || keyMemo(e) || keyAi(e) || keyNotes(e) || keyShortcut(e)) return;
    keyList(e);
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
    : cur?.actions[0] ? [[cur.actions[0].title, ["↵"]], ...(quick ? [[quick.title, [...quick.shortcut!]] as [string, string[]]] : []),
      ...(mode === "note" && notes.search?.kind === "passwords" ? [[reveal ? "가리기" : "보기", ["⌘", "R"]] as [string, string[]]] : []),
      ...(mode === "note" && !conc ? [[graph ? "목록" : "그래프", ["⌘", "G"]] as [string, string[]]] : []),
      ...(graphOn ? [[local ? `로컬 ${local}단계` : "로컬", ["⌘", "L"]] as [string, string[]]] : []), ["액션", ["⌘", "K"]]] : [];
  const placeholder = ai ? "다시 물어보기"
    : mode === "store" ? "확장 검색"
    : mode === "note" && conc ? `${conc.stage.name} · 개념 검색`
    : mode === "note" ? (notes.search?.kind === "commands" ? "명령어 또는 하고 싶은 작업 (예: 포트 확인, 권한 변경)" : `${notes.search?.name ?? "노트"} 검색`)
    : mode === "noteManage" ? "노트 검색 관리"
    : mode === "examples" ? `${exDoc?.doc.name ?? ""} 예시 검색`
    : mode === "hotkeys" ? "단축키 설정"
    : mode === "ask" ? "AI에게 물어보기 (Enter · ⌘↵ 내 노트에서 찾아 묻기)"
    : mode === "files" ? "파일 이름 (홈 · 외장 디스크)"
    : mode === "apps" ? "앱 이름 입력 · 예: Safari, 메모"
    : mode === "feature" ? `${FEATURE_TITLES[feature]} · 이름으로 좁히기 · Esc 처음으로`
    : mode === "cal" ? (redate ? "제목 고치기 · 날짜는 아래 버튼이나 달력 칸 · Enter 저장 · ⌘D 삭제 · Esc 취소" : "할 일 입력 · 예: 내일 오후 3시 치과, 12/1~12/5 워크숍, 금요일까지 보고서")
    : mode === "clip" ? "복사했던 글 검색"
    : mode === "memo" ? (picking ? "노트 이름 검색 (비우면 폴더 보기) · Esc 취소" : memo.shot ? "스크린샷 이름 겸 메모 · Enter 저장 · ⌘I 빼기" : "메모 입력 · ⇧Enter 줄바꿈 · Tab 저장할 곳 바꾸기")
    : hint || "앱, 파일, 명령, 계산, AI에게 묻기 · 글 치고 ⌘T 할 일";
  const header = home ? "Baro로 할 수 있는 일"
    : mode === "store" ? `확장 스토어${store.loading ? " · 불러오는 중…" : ""}`
    : mode === "apps" ? (q.trim() ? `앱 ${appRows.length}개` : `설치된 앱 ${appRows.length}개`)
    : mode === "feature" ? `${FEATURE_TITLES[feature]} ${items.length}개`
    : mode === "cal" ? (cal.loading ? "노션에서 불러오는 중…" : cal.error ? "캘린더 · 노션 연결 필요" : cal.msg ?? `캘린더 · 일정 ${cal.events.length}개 · DB ${cal.dbs.length}개 · Enter 완료 · ⌘O 노션 · ⌘R 새로고침`)
    : mode === "files" ? (found.loading ? (q.trim() ? "찾는 중…" : "최근 파일 불러오는 중…") : fileOpen ? `${fileOpen}만 보는 중 · Esc 전체 종류`
      : q.trim() ? `파일 ${found.items.length}개 · 종류별` : `최근 90일 파일 ${found.items.length}개 · 종류별 · 이름을 입력하면 전체에서 찾기`)
    : mode === "clip" ? (q.trim() ? `찾은 기록 ${items.filter(i => i.id.startsWith("clip-") && !["clip-toggle", "clip-clear"].includes(i.id)).length}개` : clips.enabled ? null : "기록을 멈춘 상태예요")
    : mode === "memo" ? (memo.shot ? `스크린샷 붙임 · 저장 이름: ${now().date}-${shotName(q.replace(/^\s*[!$]/, ""))}` : picking ? (q.trim() ? "전체에서 이름 검색 · Enter로 정하기" : `${picking.dir ? picking.dir.split("/").join(" / ") : "Vault"} · Enter 열기·정하기 · ⌫ 상위 폴더`) : memo.saved ? `✓ ${memo.saved}` : memo.stage ? `${memo.stage.doc.name}에 기록하기` : "저장할 곳 · Tab으로 바꾸기")
    : mode === "note" && conc ? (conc.loading ? "개념 노트 불러오는 중…" : `${conc.stage.category} · ${conc.stage.name} · 개념 ${conc.docs.length}개 · Esc 단계 목록`)
    : mode === "note" && (notes.loading || q.trim()) ? (notes.loading ? "노트 불러오는 중…" : `검색 결과 ${noteList.length}개`)
    : null;
  const empty = mode === "store" ? store.error
    : mode === "note" && conc ? conc.error ?? (!conc.loading && !items.length ? (q ? "일치하는 개념이 없어요." : "이 단계에는 개념 목록이 없어요.") : null)
    : mode === "note" ? notes.error ?? (!notes.loading && !items.length ? (q ? "일치하는 노트가 없어요." : "폴더에 노트(.md)가 없어요.") : null)
    : mode === "hotkeys" ? hk.error
    : mode === "apps" ? (q.trim() && !appRows.length ? "일치하는 앱이 없어요." : null)
    : mode === "feature" ? (!items.length ? (q.trim() ? "일치하는 항목이 없어요." : "아직 없어요. Baro 설정(config.json)에서 추가해요.") : null)
    : mode === "files" ? (!found.loading && !found.items.length ? (q.trim() ? "일치하는 파일이 없어요." : "최근 90일에 바뀐 파일이 없어요.") : null)
    : mode === "memo" ? memo.error
    : mode === "cal" ? cal.error ?? (!cal.loading && !items.length ? (q.trim() ? "일치하는 일정이 없어요." : "앞으로 60일 동안 일정이 없어요. 할 일을 입력해 추가해 보세요.") : null)
    : mode === "clip" ? (!clips.list.length ? "아직 기록이 없어요. 글을 복사하면 여기에 쌓여요 (비밀번호·키처럼 보이는 글은 빼요)." : q.trim() && !items.length ? "일치하는 기록이 없어요." : null)
    : mode === null && q && !items.length ? "결과가 없습니다. 다른 이름으로 검색해 보세요." : null;

  const missingEl = curDoc && curLinks?.missing.length
    ? <MissingLinks names={curLinks.missing} vault={notes.search?.id === "__vault"} onCreate={n => createConcept(curDoc, n)} /> : null;
  const listEl = <ItemList listRef={list} header={header} items={items} sel={sel}
    warn={mode === "hotkeys" ? hk.error : mode === "cal" && cal.errors.length ? `일부를 못 읽었어요: ${cal.errors.join(" / ")}` : null} empty={mode !== "hotkeys" ? empty : null}
    onRow={(it, i) => menu ? undefined : sel !== i ? (setSel(i), setPending(null)) : run(it.actions[0], it)} />;
  const pickDoc = (d: Doc) => { setPick(d); setMenu(false); };

  return (
    <main className={bar ? "panel bar" : "panel"}>
      {/* 위쪽 끌기 막대: 잡고 끌면 창이 움직이고, 옮긴 자리는 다음에 열 때도 유지 */}
      <div className="grip" data-tauri-drag-region title="끌어서 창 이동 · 가운데로 되돌리기: '창 위치 초기화'"
        onMouseDown={() => invoke("set_placed", { on: true })}><span data-tauri-drag-region /></div>
      {mode === "memo" ? <textarea ref={input} className="search memo-input" value={q} autoFocus spellCheck={false} placeholder={placeholder}
        rows={Math.min(6, q.split("\n").length)} onChange={e => setQ(e.target.value)} />
        : mode !== "noteEdit" && mode !== "pwEdit" && mode !== "docEdit" && <input ref={input} className="search" value={q} autoFocus spellCheck={false} placeholder={placeholder}
        onChange={e => setQ(e.target.value)} />}
      {mode === "cal" && calDraft && !view && !ai && <DateBar draft={calDraft} setPick={setCalPick} target={calTarget} setTarget={setCalTarget} />}
      {view ? <ResultView view={view} perm={perm} />
      : ai ? <AiView ai={ai} onOpen={openObsidian} />
      : mode === "pwEdit" && pw ? <PwForm pw={pw} setPw={setPw} folder={notes.search?.name} onSave={savePw} onCancel={() => { setPw(null); setMode("note"); }} />
      : mode === "docEdit" && docEd ? <DocEditor key={docEd.isNew ? "new" : docEd.doc.file} ed={docEd} onChange={f => { docFields.current = f; if (docEd.ask || docEd.msg || docEd.err) setDocEd(d => d && { ...d, ask: false, msg: null, err: null }); }} />
      : mode === "noteEdit" && draft ? <SearchForm draft={draft} setDraft={setDraft} onSave={saveDraft} onCancel={() => { setDraft(null); openNoteManager(); }} onPickFolder={pickFolder} />
      : graphOn ? (
        // 노트 그래프: 왼쪽 그래프 + 오른쪽 미리보기. 검색어는 맞는 노트만 진하게
        <div className="split">
          <NoteGraph docs={graphDocs} matches={graphMatches} selected={curDoc?.record ?? curDoc} loading={notes.loading} cacheKey={notes.search?.id ?? ""} local={local}
            onSelect={pickDoc} onOpen={d => openObsidian(d.file)} />
          <div className="preview" key={curDoc?.file /* 다른 노트로 바뀌면 맨 위부터 */}>
            <article className="md" dangerouslySetInnerHTML={{ __html: previewHtml }} />
            {curLinks && <LinksPanel inn={curLinks.inn} out={curLinks.out} missing={missingEl} onPick={pickDoc} />}
          </div>
        </div>
      ) : mode === "memo" ? (
        // 빠른 메모: 왼쪽 저장할 곳 + 오른쪽 이미 적은 기록 (고른 칸 강조)
        <div className="split">{listEl}<MemoSide shot={memo.shot} recRef={recRef} html={memoHtml} onRecClick={onRecClick} /></div>
      ) : mode === "files" ? (
        // 파일 찾기: 왼쪽 목록 + 오른쪽 고른 파일 내용
        <div className="split files-split">{listEl}<FilePreviewPane path={cur?.path} prev={filePrev?.path === cur?.path ? filePrev?.prev : undefined} loading={!!filePrev?.loading} /></div>
      ) : mode === "cal" ? (
        // 캘린더: 왼쪽 목록 + 오른쪽 한 달 달력. 달력에서 일정을 누르면 목록에서 고르고, 고른 걸 다시 누르면 실행
        <div className="split cal-split">{listEl}<MonthGrid month={month} events={cal.events} loading={cal.loading}
          selected={cur?.id.startsWith("cal-") ? cur.id.slice(4) : undefined} onMove={moveMonth}
          range={calDraft ? { start: calDraft.date, end: calDraft.end?.date ?? null } : undefined} onDay={calDraft ? pickDay : undefined}
          onPick={ev => {
            const i = items.findIndex(it => it.id === `cal-${ev.id}`);
            if (i < 0) invoke("open_url", { url: ev.url.replace(/^https:\/\//, "notion://") });
            else if (i === sel) run(items[i].actions[0], items[i]);
            else { setSel(i); setPending(null); }
          }} /></div>
      ) : mode === "clip" ? (
        // 클립보드 기록: 왼쪽 목록 + 오른쪽 전체 내용
        <div className="split">{listEl}<ClipPreview clip={curClip} fallback={cur?.subtitle} /></div>
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
      {menu && cur && !ai && !view && <ActionMenu item={cur} asel={asel} setAsel={setAsel} run={a => run(a)} />}
      <Footer pending={pending} pinned={pinned} togglePin={togglePin} keys={footerKeys} menu={menu} />
    </main>
  );
}
