// 노트 검색 화면: 노트 열기, 목록·그래프·미리보기 상태, ⌘R·⌘G·⌘L 키 (App.tsx에서 동작 그대로 옮김)
import { useMemo, useState } from "react";
import { marked } from "marked";
import { getConfig, loadConfig } from "../commands";
import { loadDocs, rank, byCategory, byStage, nextUp, conceptHits, studyCard, Doc, NoteSearch } from "../notes";
import { linkInfo } from "../graph";
import type { Mode, Notes } from "./types";
import type { Conc } from "./useStudy";
import { STATUS, weekLabel, docCache, docsSig } from "./status";
import { MASK } from "./passwords";
import type { Setter } from "./ctx";

export function useNoteView({ mode, q, sel, menu, setMenu, notes, setNotes, conc, setConc, enter }: {
  mode: Mode; q: string; sel: number; menu: boolean; setMenu: Setter<boolean>; notes: Notes; setNotes: Setter<Notes>;
  conc: Conc | null; setConc: Setter<Conc | null>; enter: (m: Mode) => void;
}) {
  const [reveal, setReveal] = useState(false); // 비밀번호 모음: 비밀번호 보이기 (⌘R)
  const [graph, setGraph] = useState(false); // 노트 검색을 그래프로 보기 (⌘G)
  const [pick, setPick] = useState<Doc | null>(null); // 그래프에서 클릭한 노트
  const [local, setLocal] = useState(0); // 로컬 그래프: 0 끔, 1·2 = 고른 노트에서 몇 단계까지 (⌘L)

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

  // 노트 검색: 검색어가 없으면 분류(폴더)별 전체, 있으면 점수순
  const noteList = useMemo(
    () => mode === "note" && conc ? conc.docs.filter(d => !q.trim() || `${d.name} ${d.summary}`.toLowerCase().includes(q.trim().toLowerCase()))
      : mode === "note" ? (q.trim() ? [...(notes.search?.kind === "curriculum" ? conceptHits(notes.docs, q) : []), ...rank(notes.docs, q).slice(0, 80)]
      : notes.search?.kind === "curriculum" ? [...nextUp(notes.docs), ...[...notes.docs].sort(byStage)]
      : byCategory(notes.docs)) : [],
    [mode, notes.docs, q, notes.search?.kind, conc]);

  const graphOn = mode === "note" && graph;
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

  const pickDoc = (d: Doc) => { setPick(d); setMenu(false); };

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

  return { reveal, graph, setGraph, pick, setPick, local, openNotes, openGraph, noteList, graphOn, graphDocs, curDoc, card,
    curLinks, graphMatches, previewHtml, pickDoc, keyNotes };
}
