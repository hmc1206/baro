// 커리큘럼·공부 카드: 단계 → 개념 목록, 상태 바꾸기, 체크박스, 분야별 진행, 목록 항목
// App.tsx에서 동작 그대로 옮김. 입력칸(q)·선택(sel)·노트 목록(notes)은 App이 가지고, 여기서는 받아서 씀
import { useEffect, useMemo, useState, type Dispatch, type MouseEvent, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { copy, Item, Action } from "../commands";
import { loadDocs, conceptsOf, conceptDocs, studyCard, Doc, NoteKind } from "../notes";
import type { Mode, Notes, Stage } from "./types";
import { STATUS, nextStatus, isDone, isDoing, weekLabel, docCache, docsSig } from "./status";
import { ago, now } from "./memo";

export type Conc = { stage: Doc; docs: Doc[]; loading: boolean; error: string | null; prevQ: string; prevSel: number };
type StudyCard = ReturnType<typeof studyCard>;
export type StudyCtx = {
  q: string; setQ: Dispatch<SetStateAction<string>>;
  sel: number; setSel: Dispatch<SetStateAction<number>>;
  setMenu: Dispatch<SetStateAction<boolean>>;
  mode: Mode; notes: Notes; setNotes: Dispatch<SetStateAction<Notes>>;
  failNote: (title: string) => (e: unknown) => void;
};

export function useStudy({ q, setQ, sel, setSel, setMenu, mode, notes, setNotes, failNote }: StudyCtx) {
  const [conc, setConc] = useState<{ stage: Doc; docs: Doc[]; loading: boolean; error: string | null; prevQ: string; prevSel: number } | null>(null);
  useEffect(() => { if (mode !== "note" && mode !== "memo") setConc(null); }, [mode]);
  // 지금 노트 검색을 화면 상태는 그대로 두고 다시 읽기 (체크·상태 변경 뒤)
  const reloadDocs = async () => {
    const s = notes.search;
    if (!s) return;
    const docs = await loadDocs(s);
    docCache.set(s.id, { docs, sig: docsSig(docs) });
    setNotes(n => n.search?.id === s.id ? { ...n, docs } : n);
    // 개념 목록을 보고 있으면 그 단계와 개념도 새로
    if (conc) {
      const stage = docs.find(d => d.file === conc.stage.file && d.heading === conc.stage.heading) ?? conc.stage;
      const cd = await conceptDocs(s, stage);
      setConc(c => c && c.stage.file === stage.file && c.stage.heading === stage.heading ? { ...c, stage, docs: cd } : c);
    }
  };
  // 단계 → 개념 목록
  const openConcepts = (stage: Doc, focus?: string) => {
    const s = notes.search;
    if (!s) return;
    setConc({ stage, docs: [], loading: true, error: null, prevQ: q, prevSel: sel });
    setQ(""); setSel(0); setMenu(false);
    conceptDocs(s, stage)
      .then(docs => { setConc(c => c?.stage === stage ? { ...c, docs, loading: false } : c);
        const i = focus === undefined ? -1 : docs.findIndex(d => d.concept?.name === focus);
        if (i >= 0) setSel(i); })
      .catch(e => setConc(c => c?.stage === stage ? { ...c, loading: false, error: String(e) } : c));
  };
  // 개념 노트 머리말에 마지막으로 공부한 날 (머리말이 없거나 노트가 없으면 건너뜀)
  const stampStudied = (file: string) => file
    ? invoke("note_set_field", { id: notes.search!.id, file, key: "last_studied", value: now().date }).catch(() => {}) : Promise.resolve();
  const setConceptStatus = (d: Doc, value: string) => invoke("note_task_state",
    { id: notes.search!.id, file: d.concept!.hubFile, index: d.concept!.hubIndex, text: d.concept!.hubText, value })
    .then(() => value !== "학습 전" && d.concept && !d.next ? stampStudied(d.file) : undefined)
    .then(reloadDocs).catch(failNote("상태를 바꾸지 못했어요"));
  const setStatus = (d: Doc, value: string) => (d.heading
    ? invoke("note_stage_status", { id: notes.search!.id, file: d.file, heading: d.heading, value })
    : invoke("note_set_field", { id: notes.search!.id, file: d.file, key: "status", value }))
    .then(reloadDocs).catch(failNote("상태를 바꾸지 못했어요"));
  // 커리큘럼 미리보기의 체크박스 클릭 → 노트 파일에 체크/해제
  const onPreviewClick = (e: MouseEvent<HTMLElement>, curDoc: Doc | undefined, card: StudyCard | null) => {
    const el = e.target as HTMLElement;
    if (!(el instanceof HTMLInputElement) || el.type !== "checkbox" || notes.search?.kind !== "curriculum" || !curDoc?.tasks) return;
    e.preventDefault(); // 화면은 파일을 고친 뒤 다시 읽어서 바꿈
    const boxes = Array.from(e.currentTarget.querySelectorAll("input[type=checkbox]"));
    // 공부 카드는 노트의 일부 체크박스만 보여 주므로 taskMap으로 노트 전체 순서를 찾음
    const map = curDoc.concept ? card?.taskMap : undefined;
    const i = boxes.indexOf(el), k = map ? map[i] : i, task = curDoc.tasks[k];
    if (!task || boxes.length !== (map ? map.length : curDoc.tasks.length)) return;
    invoke("note_toggle_task", { id: notes.search.id, file: curDoc.file, index: (curDoc.taskBase ?? 0) + k, text: task.text, done: !task.done })
      .then(() => curDoc.concept && !task.done ? stampStudied(curDoc.file) : undefined)
      .then(reloadDocs).catch(failNote("체크하지 못했어요"));
  };
  // 분야별 진행: 허브 단계의 체크박스(개념) 완료 수
  const fieldDone = useMemo(() => {
    const m = new Map<string, [number, number]>();
    for (const d of notes.docs) if (d.heading) {
      const [a, b] = m.get(d.category) ?? [0, 0], t = d.tasks ?? [];
      m.set(d.category, [a + t.filter(x => x.done).length, b + t.length]);
    }
    return m;
  }, [notes.docs]);
  const fieldLabel = (f: string) => { const p = fieldDone.get(f); return p && p[1] ? `${f} · 개념 ${p[0]}/${p[1]} 완료` : f; };

  return { conc, setConc, reloadDocs, openConcepts, stampStudied, setConceptStatus, setStatus, onPreviewClick, fieldLabel };
}

// 커리큘럼 목록 한 줄: 개념, "다음 할 일", 단계. 해당하지 않으면 null (App이 다른 종류로 만듦)
export type StudyItemCtx = {
  q: string; kind: NoteKind; notes: Notes; conc: Conc | null;
  obsidian: Action; finder: Action;
  createConcept: (src: Doc, name: string) => Promise<void>; reloadDocs: () => Promise<void>;
  openObsidian: (file: string) => Promise<unknown>; openMemo: (stage?: Stage, from?: Mode) => void;
  openConcepts: (stage: Doc, focus?: string) => void;
  setConceptStatus: (d: Doc, value: string) => Promise<unknown>; setStatus: (d: Doc, value: string) => Promise<unknown>;
  fieldLabel: (f: string) => string;
};

export function studyItem(d: Doc, { q, kind, notes, conc, obsidian, finder, createConcept, reloadDocs, openObsidian, openMemo,
  openConcepts, setConceptStatus, setStatus, fieldLabel }: StudyItemCtx): Item | null {
  if (d.concept) {
    const c = d.concept, st = c.status, next = nextStatus(st || "학습 전");
    const make: Action = { title: "개념 노트 만들기", keep: true, run: async () => {
      await createConcept(conc?.stage.record ?? conc?.stage ?? d, c.link || c.name); await reloadDocs(); } };
    return { id: `c-${c.hubIndex}-${c.name}`, title: d.name, kind: "wiki", section: q.trim() ? undefined : c.stage,
      glyph: !d.file ? "doc" : isDone(st) ? "done" : isDoing(st) ? "doing" : "todo",
      subtitle: [st, c.priority, !d.file ? "노트 없음" : "", ago(d.meta.last)].filter(Boolean).join(" · ") || c.desc.slice(0, 40),
      actions: d.file ? [
        { title: "Obsidian에서 열기", shortcut: "⌘O", run: () => openObsidian(d.file) },
        { title: "이 개념에 기록하기", shortcut: "⌘N", keep: true, run: async () => openMemo({ search: notes.search!, doc: d }, "note") },
        ...(c.hubIndex >= 0 ? [{ title: `상태를 "${next}"(으)로`, shortcut: "⌘D", keep: true, run: () => setConceptStatus(d, next) }] : []),
        { title: "이름 복사", run: () => copy(d.name) },
      ] : [make, { title: "이름 복사", run: () => copy(c.name) }] };
  }
  if (d.next) {
    const c = d.next.concept;
    return { id: `next-${d.next.section}-${d.category}-${c.hubIndex}-${c.name}`, title: c.name, kind: "wiki", section: d.next.section,
      glyph: isDone(c.status) ? "done" : isDoing(c.status) ? "doing" : "todo",
      subtitle: [d.category, d.name, c.hubIndex < 0 && d.next.section === "다음 할 일" ? `개념 ${conceptsOf(d).length}개` : "", d.next.why].filter(Boolean).join(" · "),
      actions: [{ title: "공부 카드 열기", keep: true, run: async () => openConcepts(d, c.name) },
        c.hubIndex >= 0 ? { title: `상태를 "${nextStatus(c.status || "학습 전")}"(으)로`, shortcut: "⌘D", keep: true,
          run: () => setConceptStatus({ ...d, concept: c }, nextStatus(c.status || "학습 전")) }
          : { title: `단계 상태를 "${STATUS[nextStatus(d.meta.status || "학습 전")] ?? nextStatus(d.meta.status || "학습 전")}"(으)로`, shortcut: "⌘D", keep: true,
            run: () => setStatus(d, nextStatus(d.meta.status || "학습 전")) },
        { title: "이름 복사", run: () => copy(c.name) }] };
  }
  if (kind === "curriculum") {
    const tasks = d.tasks ?? [], n = tasks.filter(x => x.done).length, st = d.meta.status || "todo", next = nextStatus(st);
    const rec = d.heading ? d.record : d; // 허브 단계: 기록은 연결된 단계 노트에
    return { id: `n-${d.file}#${d.heading ?? ""}`, title: d.name, kind: "wiki", section: d.heading && !q.trim() ? fieldLabel(d.category) : undefined,
      glyph: isDone(st) ? "done" : isDoing(st) ? "doing" : "todo",
      subtitle: [STATUS[st] ?? st, weekLabel(d.meta.week) || d.meta.hours, tasks.length ? `${n}/${tasks.length}` : "", q.trim() && d.heading ? d.category : ""].filter(Boolean).join(" · "),
      actions: [...(d.heading && conceptsOf(d).length ? [{ title: `개념 ${conceptsOf(d).length}개 보기`, keep: true, run: async () => openConcepts(d) }] : []), obsidian,
        ...(rec ? [{ title: "이 단계에 기록하기", shortcut: "⌘N", keep: true, run: async () => openMemo({ search: notes.search!, doc: rec }, "note") }] : []),
        { title: `상태를 "${STATUS[next]}"(으)로`, shortcut: "⌘D", keep: true, run: () => setStatus(d, next) },
        ...(d.heading && d.record ? [{ title: "단계 노트 열기", run: () => invoke("open_url", { url: `obsidian://open?path=${encodeURIComponent(d.record!.file)}` }) }] : []),
        finder, { title: "이름 복사", run: () => copy(d.name) }] };
  }
  return null;
}
