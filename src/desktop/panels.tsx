// 바탕화면 패널 내용: 달력(한 달 일정), 클립보드 기록, 빠른 메모(오늘 Daily), 파일 찾기, 창·시스템 명령, 노트 검색·그래프, AI에게 묻기
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { type CalEvent, monthCells, shiftMonth, ymd } from "../app/calendar";
import { MonthGrid } from "../app/MonthGrid";
import { shortDir } from "../app/filekinds";
import { getConfig, panelCommands } from "../commands";
import { NoteGraph } from "../graph";
import { ICONS } from "../icons";
import { type Doc, type NoteSearch, loadDocs, rank } from "../notes";
import type { Ai, Source } from "../app/types";
import { marked } from "marked";

const pad = (n: number) => String(n).padStart(2, "0");

// 달력: 칸이나 일정을 누르면 가운데 카드가 그 날로
export function CalendarPanel({ day, onDay }: { day: string; onDay: (d: string) => void }) {
  const [month, setMonth] = useState(() => day.slice(0, 8) + "01");
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let live = true;
    const load = () => {
      const cells = monthCells(month);
      setLoading(true);
      invoke<{ events: CalEvent[] }>("notion_events", { start: cells[0], end: cells[cells.length - 1], fresh: false })
        .then(d => { if (live) setEvents(d.events); }).catch(() => {}).finally(() => live && setLoading(false));
    };
    load();
    const un = listen("cal-changed", load);
    return () => { live = false; un.then(f => f()); };
  }, [month]);
  return <MonthGrid month={month} events={events} loading={loading} marked={day} onCell={onDay} onPick={e => onDay(e.start.slice(0, 10))}
    onMove={n => setMonth(n === 0 ? ymd(new Date()).slice(0, 8) + "01" : shiftMonth(month, n))} />;
}

// 클립보드 기록: 누르면 다시 복사
type Clip = { text: string; at: number; app: string };
export function ClipPanel({ onMsg }: { onMsg: (m: string) => void }) {
  const [clips, setClips] = useState<Clip[]>([]);
  const [q, setQ] = useState("");
  useEffect(() => {
    const load = () => invoke<Clip[]>("clip_list").then(setClips).catch(() => {});
    load();
    const t = setInterval(load, 3000); // 다른 앱에서 복사한 것도 곧 보이게 (로컬 목록이라 가벼움)
    return () => clearInterval(t);
  }, []);
  const shown = clips.filter(c => !q.trim() || c.text.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 80);
  const ago = (at: number) => {
    const m = Math.floor((Date.now() - at) / 60000);
    return m < 1 ? "방금" : m < 60 ? `${m}분 전` : m < 1440 ? `${Math.floor(m / 60)}시간 전` : `${Math.floor(m / 1440)}일 전`;
  };
  return <>
    <input className="dk-pin" value={q} placeholder="기록에서 찾기" onChange={e => setQ(e.target.value)} />
    <ul className="dk-plist">
      {shown.map(c => (
        <li key={`${c.at}:${c.text.slice(0, 20)}`} title="누르면 복사" onClick={() => navigator.clipboard.writeText(c.text).then(() => onMsg("클립보드에 복사했어요"), e => onMsg(`복사 실패: ${e}`))}>
          <span className="dk-ptext">{c.text.replace(/\s+/g, " ").slice(0, 200)}</span>
          <span className="dk-pmeta">{ago(c.at)}{c.app && ` · ${c.app}`}</span>
          <button title="이 기록 지우기" onClick={e => { e.stopPropagation(); invoke("clip_remove", { at: c.at, text: c.text }).then(() => setClips(l => l.filter(x => x !== c))); }}>✕</button>
        </li>
      ))}
      {!shown.length && <li className="dk-pnone">{clips.length ? "찾는 기록이 없어요" : "복사한 기록이 없어요"}</li>}
    </ul>
  </>;
}

// 빠른 메모: 오늘 Daily 노트의 목록 줄을 보고, 입력하면 "- 시:분 내용"으로 끝에 추가
export function MemoPanel({ onMsg }: { onMsg: (m: string) => void }) {
  const [lines, setLines] = useState<string[]>([]);
  const [text, setText] = useState("");
  const date = ymd(new Date());
  const load = () => invoke<string>("memo_daily_read", { date }).then(s => setLines(s.split("\n").filter(l => l.startsWith("- ")).map(l => l.slice(2)))).catch(() => {});
  useEffect(() => { load(); }, [date]);
  const save = async () => {
    const t = text.trim();
    if (!t) return;
    const d = new Date();
    setText("");
    try { await invoke("memo_daily", { date, time: `${pad(d.getHours())}:${pad(d.getMinutes())}`, text: t }); onMsg("오늘 Daily에 적었어요"); load(); }
    catch (e) { setText(t); onMsg(`메모 저장 실패: ${e}`); }
  };
  const openDaily = () => invoke<string>("memo_daily_path", { date })
    .then(p => invoke("open_url", { url: `obsidian://open?path=${encodeURIComponent(p)}` })).catch(e => onMsg(String(e)));
  return <>
    <ul className="dk-plist memo">
      {lines.map((l, i) => {
        const m = l.match(/^(\d{1,2}:\d{2})\s+(.*)$/);
        return <li key={i} className="static"><span className="dk-ptext">{m ? m[2] : l}</span>{m && <span className="dk-pmeta">{m[1]}</span>}</li>;
      })}
      {!lines.length && <li className="dk-pnone">오늘 적은 메모가 없어요</li>}
    </ul>
    <div className="dk-prow">
      <input className="dk-pin" value={text} placeholder="메모 적고 Enter · 오늘 Daily 노트에 추가" onChange={e => setText(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter" && !e.nativeEvent.isComposing) save(); }} />
      <button className="dk-btn" onClick={openDaily} title="Obsidian에서 오늘 Daily 열기">열기</button>
    </div>
  </>;
}

// 파일 찾기: 비우면 최근 파일, 입력하면 홈·외장 디스크에서 이름으로. 누르면 열기, 버튼으로 Finder·경로 복사
export function FilesPanel({ onMsg }: { onMsg: (m: string) => void }) {
  const [q, setQ] = useState("");
  const [paths, setPaths] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      setLoading(true);
      invoke<string[]>(q.trim() ? "files_wide" : "files_recent", q.trim() ? { q: q.trim() } : {})
        .then(p => { if (live) setPaths(p.slice(0, 120)); }).catch(() => {}).finally(() => live && setLoading(false));
    }, q.trim() ? 220 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [q]);
  return <>
    <input className="dk-pin" value={q} placeholder="파일 이름 (비우면 최근 파일)" onChange={e => setQ(e.target.value)} autoFocus />
    <ul className="dk-plist">
      {paths.map(p => {
        const name = p.normalize("NFC").split("/").pop() ?? p;
        return (
          <li key={p} title="누르면 열기" onClick={() => invoke("open_path", { path: p }).catch(e => onMsg(String(e)))}>
            <span className="dk-ptext">{name}<small>{shortDir(p.normalize("NFC"))}</small></span>
            <button title="Finder에서 보기" onClick={e => { e.stopPropagation(); invoke("reveal", { path: p }); }}>⌕</button>
            <button title="경로 복사" onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(p).then(() => onMsg("경로를 복사했어요")); }}>⧉</button>
          </li>
        );
      })}
      {!paths.length && <li className="dk-pnone">{loading ? "찾는 중…" : q.trim() ? "찾는 파일이 없어요" : "최근 파일이 없어요"}</li>}
    </ul>
  </>;
}

// 창 · 시스템: 방금 쓰던 앱의 창 배치, 잠자기·잠금 같은 명령. 되돌릴 수 없는 것은 한 번 더 눌러야 실행
export function WindowPanel({ onMsg }: { onMsg: (m: string) => void }) {
  const [ask, setAsk] = useState<string | null>(null);
  const cmds = panelCommands();
  const press = (c: ReturnType<typeof panelCommands>[number]) => {
    if (c.confirm && ask !== c.id) { setAsk(c.id); onMsg(c.confirm.replace(/Enter를 한 번 더 누르세요\.?/, "한 번 더 누르면 실행해요.")); return; }
    setAsk(null);
    c.run().catch(e => onMsg(String(e).startsWith("PERM:") ? "손쉬운 사용 권한이 필요해요 · 런처에서 'Baro 권한 확인'" : String(e)));
  };
  const group = (pre: string, title: string) => <>
    <div className="dk-pk">{title}</div>
    <div className="dk-grid">{cmds.filter(c => c.id.startsWith(pre)).map(c => {
      const Svg = ICONS[c.glyph];
      return <button key={c.id} className={ask === c.id ? "ask" : ""} onClick={() => press(c)}>{Svg && <Svg size={16} strokeWidth={2} />}<span>{c.title.replace(/^창: /, "")}</span></button>;
    })}</div>
  </>;
  return <div className="dk-scroll">{group("w-", "방금 쓰던 앱의 창")}{group("s-", "시스템")}</div>;
}

// 노트 검색 · 그래프: Obsidian 노트 검색(일반 노트·명령어·스니펫)이나 전체 노트 그래프. 누르면 고르고, 두 번 누르면 Obsidian에서 열기
const VAULT: NoteSearch = { id: "__vault", name: "전체 노트", dir: "", kind: "notes" };
export function NotesPanel({ initial, graph: graph0, onMsg }: { initial: string; graph: boolean; onMsg: (m: string) => void }) {
  const searches = [VAULT, ...getConfig().note_searches.filter(n => ["notes", "commands", "snippets"].includes(n.kind))];
  const [sid, setSid] = useState(initial);
  const [graph, setGraph] = useState(graph0);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [cur, setCur] = useState<Doc | null>(null);
  useEffect(() => {
    const s = searches.find(x => x.id === sid) ?? VAULT;
    let live = true;
    setLoading(true); setCur(null);
    loadDocs(s).then(d => { if (live) setDocs(d); }).catch(e => onMsg(`노트를 읽지 못했어요: ${e}`)).finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [sid]);
  const hits = q.trim() ? rank(docs, q.trim()) : docs;
  const open = (d: Doc) => invoke("open_url", { url: `obsidian://open?path=${encodeURIComponent(d.file)}` });
  return <>
    <div className="dk-prow">
      <select className="dk-pin dk-sel" value={sid} onChange={e => setSid(e.target.value)}>{searches.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
      <input className="dk-pin" value={q} placeholder={loading ? "노트 불러오는 중…" : `노트 ${docs.length}개에서 찾기`} onChange={e => setQ(e.target.value)} autoFocus />
      <button className={`dk-btn${graph ? " primary" : ""}`} onClick={() => setGraph(g => !g)} title="그래프로 보기">그래프</button>
    </div>
    {graph ? <div className="dk-graph">
      <NoteGraph docs={docs} matches={q.trim() ? new Set(hits.map(d => d.file)) : null} selected={cur ?? undefined} loading={loading} cacheKey={`dk-${sid}`}
        onSelect={setCur} onOpen={open} />
    </div> : <ul className="dk-plist">
      {hits.slice(0, 150).map(d => (
        <li key={d.file} className={cur?.file === d.file ? "on" : ""} onClick={() => cur?.file === d.file ? open(d) : setCur(d)} title="한 번 더 누르면 Obsidian에서 열기">
          <span className="dk-ptext">{d.name}<small>{d.summary || d.category}</small></span>
        </li>
      ))}
      {!hits.length && <li className="dk-pnone">{loading ? "불러오는 중…" : "일치하는 노트가 없어요"}</li>}
    </ul>}
    {cur && <div className="dk-pdoc">
      <b>{cur.name}</b>
      <p>{cur.summary || cur.body.replace(/[#>*`\-[\]]/g, "").trim().slice(0, 220)}</p>
      {cur.examples.slice(0, 4).map((x, i) => <code key={i} title="누르면 복사" onClick={() => navigator.clipboard.writeText(x.cmd).then(() => onMsg("명령어를 복사했어요"))}>{x.cmd}</code>)}
      <button className="dk-btn" onClick={() => open(cur)}>Obsidian에서 열기</button>
    </div>}
  </>;
}

// AI에게 묻기: 런처와 같은 AI(ask_ai)·내 노트에게 묻기(ask_notes). 답은 흘러나오는 대로 보이고 ⌘S·저장으로 Obsidian 노트에
// 답 조각(ai-chunk)은 모든 창에 가므로 런처와 번호가 겹치지 않게 큰 번호부터 씀
let aiSeq = 2_000_000_000;
export function AiPanel({ onMsg }: { onMsg: (m: string) => void }) {
  const [q, setQ] = useState("");
  const [ai, setAi] = useState<Ai | null>(null);
  useEffect(() => {
    const uns = [
      listen<{ id: number; text: string }>("ai-chunk", e => setAi(a => a && a.id === e.payload.id ? { ...a, text: a.text + e.payload.text } : a)),
      listen<{ id: number; error: string | null }>("ai-done", e => setAi(a => a && a.id === e.payload.id ? { ...a, busy: false, error: e.payload.error } : a)),
    ];
    return () => { uns.forEach(u => u.then(f => f())); };
  }, []);
  const ask = (notes: boolean) => {
    const t = q.trim();
    if (!t || ai?.busy) return;
    const id = ++aiSeq;
    setAi({ id, q: t, text: "", busy: true, error: null, notes, sources: [] });
    setQ("");
    const fail = (e: unknown) => setAi(a => a && a.id === id ? { ...a, busy: false, error: String(e) } : a);
    if (notes) invoke<Source[]>("ask_notes", { id, question: t }).then(sources => setAi(a => a && a.id === id ? { ...a, sources } : a)).catch(fail);
    else invoke("ask_ai", { id, prompt: t }).catch(fail);
  };
  const save = async () => {
    if (!ai || ai.busy || !ai.text.trim() || ai.saved) return;
    const src = ai.sources?.length ? `\n\n## 출처 노트\n${ai.sources.map((s, i) => `${i + 1}. [[${s.title}]]`).join("\n")}` : "";
    try { const saved = await invoke<string>("save_ai", { date: ymd(new Date()), question: ai.q, answer: ai.text + src }); setAi(a => a && { ...a, saved }); onMsg("AI 답변을 Obsidian에 저장했어요"); }
    catch (e) { onMsg(`저장 실패: ${e}`); }
  };
  const obsidian = (file: string) => invoke("open_url", { url: `obsidian://open?path=${encodeURIComponent(file)}` });
  return <>
    <div className="dk-ai">
      {ai ? <>
        <p className="dk-ai-q">{ai.notes ? "내 노트에게 · " : ""}{ai.q}</p>
        {ai.error ? <p className="dk-pnone">{ai.error}</p>
          : <article className="md" dangerouslySetInnerHTML={{ __html: marked.parse(ai.text || (ai.busy ? "_생각하는 중…_" : ""), { async: false }) as string }} />}
        {!!ai.sources?.length && <div className="dk-ai-src">{ai.sources.map(s => <button key={s.file} className="dk-mini" onClick={() => obsidian(s.file)}>{s.title}</button>)}</div>}
        {!ai.busy && !ai.error && ai.text.trim() && <div className="dk-prow">
          {ai.saved ? <button className="dk-mini" onClick={() => obsidian(ai.saved!)}>저장한 노트 열기</button> : <button className="dk-mini" onClick={save}>Obsidian에 저장 (⌘S)</button>}
          <button className="dk-mini" onClick={() => navigator.clipboard.writeText(ai.text).then(() => onMsg("답변을 복사했어요"))}>복사</button>
        </div>}
      </> : <p className="dk-pnone">궁금한 걸 적고 Enter · 내 노트에서 찾아 답하려면 ⌘Enter</p>}
    </div>
    <div className="dk-prow">
      <input className="dk-pin" value={q} placeholder="AI에게 묻기 · Enter / 내 노트에게 ⌘Enter" onChange={e => setQ(e.target.value)}
        onKeyDown={e => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); ask(e.metaKey); }
          else if (e.key === "s" && e.metaKey) { e.preventDefault(); save(); }
        }} />
      <button className="dk-btn" disabled={!q.trim() || ai?.busy} onClick={() => ask(false)}>묻기</button>
    </div>
  </>;
}
