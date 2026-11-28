import { useEffect, useRef, useState, type MouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  featureItems, storeItems, aiItem, notesAiItem, getConfig, loadConfig, Item, Action, View, Ui, Feature,
} from "./commands";
import { Doc } from "./notes";
import { NoteGraph } from "./graph";
import { PERMS } from "./app/keys";
import type { Mode, Notes } from "./app/types";
import { nextName } from "./app/passwords";
import { lastDoc } from "./app/status";
import { useMemoScreen } from "./app/useMemoScreen";
import { useStudy } from "./app/useStudy";
import { groupByKind } from "./app/filekinds";
import { useCalendar } from "./app/useCalendar";
import { MonthGrid } from "./app/MonthGrid";
import { DateBar } from "./app/DateBar";
import { ItemList, ResultView, AiView, PwForm, SearchForm, MissingLinks, LinksPanel, MemoSide, ClipPreview, FilePreviewPane, ActionMenu, Footer, DocEditor } from "./app/views";
import type { Pending } from "./app/useLauncherKeys";
import { useLauncherKeys } from "./app/useLauncherKeys";
import { useLauncherEvents } from "./app/useLauncherEvents";
import { useAi } from "./app/useAi";
import { useClip } from "./app/useClip";
import { useHotkeys } from "./app/useHotkeys";
import { useNoteManage } from "./app/useNoteManage";
import { usePasswords } from "./app/usePasswords";
import { useDocEdit, usePickEdited } from "./app/useDocEdit";
import { useFiles, useFilePreview } from "./app/useFiles";
import { useHomeResults, useSearchEffects } from "./app/useSearch";
import { useStore } from "./app/useStore";
import { useExamples } from "./app/useExamples";
import { useNoteView } from "./app/useNoteView";
import { noteItem, withEdit, type NoteItemCtx } from "./app/noteItems";
import { openObsidian, createConcept } from "./app/obsidian";
import { placeholderOf, headerOf, emptyOf, footerKeysOf, sizeKindOf } from "./app/labels";

export default function App() {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [menu, setMenu] = useState(false); // ⌘K 액션 패널
  const [asel, setAsel] = useState(0);
  const [pending, setPending] = useState<Pending>(null); // 확인 대기 중인 동작 (항목은 매번 새로 만들어지므로 "항목 id:동작 이름"으로 구분)
  const [view, setView] = useState<View | null>(null); // 텍스트 결과·권한 안내 화면
  const [mode, setMode] = useState<Mode>(null);
  const [notes, setNotes] = useState<Notes>({ search: null, docs: [], loading: false, error: null });
  const [feature, setFeature] = useState<Feature>("window"); // 기능 목록 화면에서 보는 기능
  const [hint, setHint] = useState(""); // 처음 화면 기능을 고르면 입력창에 흐리게 보이는 예시
  const [pinned, setPinned] = useState(false); // 창 고정: 다른 앱을 눌러도 화면에 남음
  const [rev, setRev] = useState(0);
  const input = useRef<HTMLInputElement & HTMLTextAreaElement>(null); // 메모 화면에서는 여러 줄 입력칸(textarea)
  const list = useRef<HTMLUListElement>(null);
  const restoreSel = useRef<number | null>(null);
  const togglePin = () => invoke<boolean>("set_pinned", { on: !pinned }).then(setPinned);

  const enter = (m: Mode) => { setQ(""); setHint(""); setView(null); setAi(null); setMode(m); input.current?.focus(); };
  const fail = (e: unknown) => {
    const msg = String(e);
    invoke("log_error", { msg }).catch(() => {});
    setAi(null);
    setView(msg.startsWith("PERM:") ? { kind: "perm", perm: msg.slice(5) } : { kind: "text", title: "실행하지 못했어요", text: msg, error: true });
  };
  const { ai, setAi, ask, askNotes, keyAi } = useAi({ q, mode, setView, setMenu, setRev, input });
  const failNote = (title: string) => (e: unknown) => { invoke("log_error", { msg: `${title}: ${e}` }).catch(() => {}); setAi(null); setView({ kind: "text", title, text: String(e), error: true }); };

  // 화면별 상태와 동작: 공부(커리큘럼)·빠른 메모·캘린더·클립보드·파일·스토어·노트 등 (각각 src/app/ 아래 훅)
  const { conc, setConc, reloadDocs, openConcepts, stampStudied, setConceptStatus, setStatus, onPreviewClick: togglePreviewTask, fieldLabel } =
    useStudy({ q, setQ, sel, setSel, setMenu, mode, notes, setNotes, failNote });
  // 바탕화면 커리큘럼에서 "공부 카드" → 그 커리큘럼을 열고, 단계를 다 읽으면 그 개념의 공부 카드로
  const [goConcept, setGoConcept] = useState<{ id: string; file: string; heading: string; name: string } | null>(null);
  useEffect(() => {
    if (!goConcept || notes.search?.id !== goConcept.id || notes.loading) return;
    const stage = notes.docs.find(d => d.file === goConcept.file && (d.heading ?? "") === goConcept.heading);
    setGoConcept(null);
    if (stage) openConcepts(stage, goConcept.name);
  }, [goConcept, notes]);
  const memoScr = useMemoScreen({ q, setQ, sel, setSel, mode, enter, input, notes, reloadDocs, conc, stampStudied });
  const { memo, crit, memoHtml, recRef, openMemo, memoItems, onRecClick, shotName, picking } = memoScr;
  const { clips, openClip, clipItems } = useClip({ q, setQ, enter, openMemo });
  const { cal, redate, cancelRedate, draft: calDraft, setPick: setCalPick, target: calTarget, setTarget: setCalTarget, pickDay, month, moveMonth, loadCal, calItems } = useCalendar({ q, setQ });
  const openCal = (text = "") => { enter("cal"); cancelRedate(); loadCal(); if (text) setQ(text); };
  const files = useFiles({ q, mode, setSel, enter });
  const { store, openStore } = useStore({ enter });
  const nv = useNoteView({ mode, q, sel, menu, setMenu, notes, setNotes, conc, setConc, enter });
  const { exDoc, openExamples, exampleItems } = useExamples({ q, setQ, setMode });
  const { hk, setHk, hotkeyItems, openHotkeys, keyRecording } = useHotkeys({ enter });
  const nm = useNoteManage({ mode, setQ, setMode, enter, setRev, hk, setHk, openNotes: nv.openNotes });
  const pws = usePasswords({ mode, notes, openNotes: nv.openNotes, setQ, setMenu, setMode });
  const de = useDocEdit({ mode, q, setQ, notes, setMode, setView, setAi, reloadDocs, input, failNote });
  const homeRes = useHomeResults();
  const home = mode === null && !q.trim();

  // 런처는 검색 막대만: 검색 결과·명령에서 고르는 캘린더·메모·클립보드·파일·창 명령·노트(일반·명령어·스니펫)·그래프는 바탕화면 패널로
  // (패널의 ↗ 버튼이나 커리큘럼·비밀번호 노트는 지금처럼 런처 화면으로. 단축키로 열 때(onShown)는 위 함수들을 그대로 씀)
  const toPanel = (panel: string) => { invoke("open_panel", { panel }).catch(fail); setQ(""); };
  const panelNotes = (id: string) => ["notes", "commands", "snippets"].includes(getConfig().note_searches.find(n => n.id === id)?.kind ?? "");
  const ui: Ui = {
    ask, askNotes, openStore, openNoteManager: nm.openNoteManager, openHotkeys, togglePin,
    openNotes: (id, asGraph) => id === "__vault" || panelNotes(id) ? toPanel(id === "__vault" ? "graph" : `notes:${id}`) : nv.openNotes(id, asGraph),
    openGraph: () => toPanel("graph"), openFiles: () => toPanel("files"), openMemo: () => toPanel("memo"), openClip: () => toPanel("clipboard"),
    openCal, // 달력은 런처 화면 그대로 (삭제·수정까지 바로)
    show: v => { setAi(null); setView(v); },
    setQuery: text => { setMode(null); setHint(""); setQ(text); input.current?.focus(); }, // 처음 검색 화면으로 가서 입력
    openApps: () => enter("apps"),
    openFeature: f => { if (f === "window" || f === "system") toPanel("window"); else { setFeature(f); enter("feature"); } },
    setHint: text => { setQ(""); setHint(text); input.current?.focus(); },
  };

  const nctx: NoteItemCtx = { q, notes, conc, reveal: nv.reveal, setQ, openPw: pws.openPw, openDocEdit: de.openDocEdit, openExamples,
    study: { createConcept: (s, n) => createConcept(s, n, { reloadDocs, failNote }), reloadDocs, openObsidian, openMemo, openConcepts, setConceptStatus, setStatus, fieldLabel } };
  const noteOf = (d: Doc) => noteItem(d, nctx);
  const items: Item[] =
    mode === "examples" && exDoc ? exampleItems(exDoc.doc)
    : mode === "note" ? [...(notes.search?.kind === "write" && !conc ? [de.newWriteItem()] : []), ...nv.noteList.map(d => withEdit(noteOf(d), d, notes.search?.kind, de.openDocEdit)), ...(notes.search?.kind === "passwords" && !notes.loading && !notes.error ? [{
        id: "pw-new", title: "새 항목 추가", subtitle: `${nextName(lastDoc(notes.docs))} · 비밀번호 입력`, kind: "cmd" as const, glyph: "plus",
        section: "추가", actions: [{ title: "추가", keep: true, run: async () => pws.openPw(null) }] }] : [])]
    : mode === "pwEdit" ? []
    : mode === "noteManage" ? nm.manageItems()
    : mode === "noteEdit" ? []
    : mode === "hotkeys" ? hotkeyItems()
    : mode === "store" ? storeItems(q, store.entries, () => setRev(r => r + 1), ui)
    : mode === "ask" ? (q.trim() ? [aiItem(q.trim(), ask, askNotes), ...[notesAiItem(q.trim(), askNotes)].filter((x): x is Item => !!x)] : [])
    : mode === "files" ? groupByKind(files.found.items, q.trim() ? 6 : 8, files.fileOpen, (kind, rest): Item => ({
        id: `fk-${kind}`, title: `${kind} ${rest}개 더 보기`, subtitle: "Esc로 전체 종류로 돌아오기", kind: "cmd", glyph: "plus",
        actions: [{ title: "더 보기", keep: true, run: async () => { files.setFileOpen(kind); setSel(0); } }] }))
    : mode === "apps" ? files.appRows
    : mode === "feature" ? featureItems(feature, q, ui)
    : mode === "memo" ? memoItems()
    : mode === "clip" ? clipItems()
    : mode === "cal" ? calItems()
    : home ? [] : [...homeRes.top, ...homeRes.files, ...homeRes.bottom]; // 처음 화면: 목록 없이 검색 막대만
  usePickEdited(de.pickFile, mode, items, setSel);
  const memoPickAt = mode === "memo" ? items.findIndex(i => i.id === "memo-pick") : -1; // 빠른 메모: 저장할 곳 칸 수 (그 뒤는 고르기·사진·클립보드)
  const bar = home && !view && !ai; // 검색어가 없으면 창을 입력 막대 높이로
  const sizeKind = sizeKindOf({ bar, graphOn: nv.graphOn, ai, mode });
  useEffect(() => { invoke("set_view", { kind: sizeKind }); }, [sizeKind]);
  const { graphOn, curDoc, card, curLinks } = nv;
  const cur = graphOn && nv.pick ? noteOf(curDoc ?? nv.pick) : items[sel];
  const curClip = mode === "clip" ? clips.list.find(c => `clip-${c.at}` === items[sel]?.id) : undefined;
  const filePrev = useFilePreview(mode === "files" ? items[sel]?.path : undefined);
  // 커리큘럼 미리보기의 체크박스 클릭 → 노트 파일에 체크/해제
  const onPreviewClick = (e: MouseEvent<HTMLElement>) => togglePreviewTask(e, curDoc, card);

  useSearchEffects({ q, rev, mode, ui, res: homeRes, restoreSel, setSel, setMenu, setPending, setPick: nv.setPick, picking, memo, crit, memoPickAt });
  // 선택 항목이 보이도록 스크롤
  useEffect(() => { list.current?.querySelectorAll("[role=option]")[sel]?.scrollIntoView({ block: "nearest" }); }, [sel, mode]);

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
    else if (graphOn) { nv.setGraph(false); nv.setPick(null); }
    else if (mode === "memo" && memo.from) setMode(memo.from); // 커리큘럼에서 왔으면 그 화면으로
    else setMode(null);
  };

  // 단축키로 열렸을 때: 기능에 맞는 화면으로 전환
  const onShown = (action: string) => {
    setMenu(false); setPending(null);
    loadConfig().then(() => setRev(r => r + 1));
    if (action.startsWith("note:")) nv.openNotes(action.slice(5));
    else if (action.startsWith("concept:")) {
      // concept:{"id","file","heading","name"} (바탕화면 커리큘럼 → 공부 카드)
      try { const c = JSON.parse(action.slice(8)); setGoConcept(c); nv.openNotes(c.id); } catch { /* 잘못된 값이면 무시 */ }
    }
    else if (action === "store") openStore();
    else if (action === "ai") enter("ask");
    else if (action === "graph") nv.openGraph();
    else if (action === "files") files.openFiles();
    else if (action === "memo") openMemo();
    else if (action === "clipboard") openClip();
    else if (action === "calendar") openCal();
    else if (mode !== null && mode !== "store" && mode !== "noteEdit" && mode !== "docEdit") enter(null); // 편집 중인 노트는 창을 다시 열어도 그대로
    input.current?.focus(); input.current?.select();
  };
  useLauncherEvents({ onShown, setRev, setView });
  useLauncherKeys({ mode, q, setQ, hint, setHint, sel, setSel, menu, setMenu, asel, setAsel, pending, setPending, view, setView, ai, items, cur, input, ui,
    pick: nv.pick, setPick: nv.setPick, fileOpen: files.fileOpen, setFileOpen: files.setFileOpen, redate, cancelRedate, moveMonth, togglePin, askNotes, run, back, fail,
    memo: memoScr, formKeys: [de.keyDocEdit, nm.keyNoteEdit, pws.keyPwEdit, keyRecording], keyAi, keyNotes: nv.keyNotes });

  const labels = { mode, home, q, hint, items, view, ai, notes, noteListLen: nv.noteList.length, conc, store, hk, feature, exDoc, appRows: files.appRows, found: files.found,
    fileOpen: files.fileOpen, cal, redate, clips, memo, picking, shotName };
  const placeholder = placeholderOf(labels), header = headerOf(labels), empty = emptyOf(labels);
  const footerKeys = footerKeysOf({ view, ai, hk, cur, graphOn, pick: nv.pick, mode, notes, reveal: nv.reveal, conc, graph: nv.graph, local: nv.local });
  const perm = view?.kind === "perm" ? PERMS[view.perm] ?? PERMS.accessibility : null;

  const missingEl = curDoc && curLinks?.missing.length
    ? <MissingLinks names={curLinks.missing} vault={notes.search?.id === "__vault"} onCreate={n => createConcept(curDoc, n, { reloadDocs, failNote })} /> : null;
  const listEl = <ItemList listRef={list} header={header} items={items} sel={sel}
    warn={mode === "hotkeys" ? hk.error : mode === "cal" && cal.errors.length ? `일부를 못 읽었어요: ${cal.errors.join(" / ")}` : null} empty={mode !== "hotkeys" ? empty : null}
    onRow={(it, i) => menu ? undefined : sel !== i ? (setSel(i), setPending(null)) : run(it.actions[0], it)} />;

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
      : mode === "pwEdit" && pws.pw ? <PwForm pw={pws.pw} setPw={pws.setPw} folder={notes.search?.name} onSave={pws.savePw} onCancel={pws.cancelPw} />
      : mode === "docEdit" && de.docEd ? <DocEditor key={de.docEd.isNew ? "new" : de.docEd.doc.file} ed={de.docEd} onChange={de.onFieldsChange} />
      : mode === "noteEdit" && nm.draft ? <SearchForm draft={nm.draft} setDraft={nm.setDraft} onSave={nm.saveDraft} onCancel={() => { nm.setDraft(null); nm.openNoteManager(); }} onPickFolder={nm.pickFolder} />
      : graphOn ? (
        // 노트 그래프: 왼쪽 그래프 + 오른쪽 미리보기. 검색어는 맞는 노트만 진하게
        <div className="split">
          <NoteGraph docs={nv.graphDocs} matches={nv.graphMatches} selected={curDoc?.record ?? curDoc} loading={notes.loading} cacheKey={notes.search?.id ?? ""} local={nv.local}
            onSelect={nv.pickDoc} onOpen={d => openObsidian(d.file)} />
          <div className="preview" key={curDoc?.file /* 다른 노트로 바뀌면 맨 위부터 */}>
            <article className="md" dangerouslySetInnerHTML={{ __html: nv.previewHtml }} />
            {curLinks && <LinksPanel inn={curLinks.inn} out={curLinks.out} missing={missingEl} onPick={nv.pickDoc} />}
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
              dangerouslySetInnerHTML={{ __html: nv.previewHtml }} />
            {missingEl && <div className="links">{missingEl}</div>}
          </div>
        </div>
      ) : listEl}
      {menu && cur && !ai && !view && <ActionMenu item={cur} asel={asel} setAsel={setAsel} run={a => run(a)} />}
      <Footer pending={pending} pinned={pinned} togglePin={togglePin} keys={footerKeys} menu={menu} />
    </main>
  );
}
