// 바탕화면 모드 화면 ("desktop" 창): 위 = 이번 주 날짜 띠 + 시계, 가운데 = 고른 날의 할 일 카드, 아래 = Baro 기능 독
// 창은 바탕화면 아이콘 위·모든 앱 창 아래에 깔려 있음 (src-tauri/src/desktop.rs)
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { type CalDb, type CalEvent, dayList, eventsOn, shiftYmd, timeOf, ymd, paint } from "../app/calendar";
import { addTodo } from "../commands";
import { ICONS } from "../icons";
import { marked } from "marked";
import { NoteGraph } from "../graph";
import { shortDir } from "../app/filekinds";
import { type Doc, loadDocs, rank } from "../notes";
import { Panel } from "./Panel";
import { TodoBoard } from "./TodoBoard";
import { CurriculumBoard } from "./CurriculumBoard";
import { AiPanel, CalendarPanel, ClipPanel, FilesPanel, MemoPanel, NotesPanel, WindowPanel } from "./panels";
import { type Area, type Layout, type PanelId, type Rect, PANELS, fit, reserve, restore, settle } from "./layout";

const DAYS = ["일", "월", "화", "수", "목", "금", "토"];
const WEEK = 7;      // 띠에 보이는 날 수 (오늘부터)
const BACK = 30;     // 밀린 할 일을 찾는 범위
const REFRESH = 180_000;
// 독 버튼: panel이 있으면 바탕화면 패널로 열고, 없으면 런처를 그 기능으로
const DOCK: { action: string; icon: string; label: string; panel?: PanelId }[] = [
  { action: "baro", icon: "search", label: "검색" },
  { action: "files", icon: "folder", label: "파일 찾기", panel: "files" },
  { action: "memo", icon: "memo", label: "빠른 메모", panel: "memo" },
  { action: "calendar", icon: "daily", label: "캘린더", panel: "calendar" }, // ↗로 런처 달력 화면 (수정·삭제)
  { action: "clipboard", icon: "clip", label: "클립보드", panel: "clipboard" },
  { action: "graph", icon: "graph", label: "노트 · 그래프", panel: "notes" },
  { action: "window", icon: "max", label: "창 · 시스템", panel: "window" },
  { action: "ai", icon: "ai", label: "AI에게 묻기", panel: "ai" },
];

type Data = { events: CalEvent[]; dbs: CalDb[]; error: string | null; loaded?: boolean }; // loaded: 노션에서 한 번이라도 받았는지
// 메뉴 막대·Dock 자리 (WebKit의 screen.availTop은 표준 타입에 없음)
const availTop = (screen as Screen & { availTop?: number }).availTop ?? 0;
const TITLES: Record<PanelId, { title: string; icon: string }> = { calendar: { title: "캘린더", icon: "daily" }, clipboard: { title: "클립보드 기록", icon: "clip" }, memo: { title: "빠른 메모 · 오늘 Daily", icon: "memo" },
  files: { title: "파일 찾기", icon: "folder" }, window: { title: "창 · 시스템", icon: "max" }, notes: { title: "노트 검색 · 그래프", icon: "graph" }, ai: { title: "AI에게 묻기", icon: "ai" } };
const STORE = "baro.desktop.panels";
// 바탕화면 화면 세 개: 홈(지금 할 일 하나를 크게) · 할 일(그날 계획 전체) · 커리큘럼(다음 공부·분야별 진행). 마지막으로 본 화면을 기억
type View = "home" | "todo" | "study";
const SCREEN_KEY = "baro.desktop.screen";
const SCREENS: { id: View; icon: string; label: string }[] = [{ id: "home", icon: "home", label: "홈" }, { id: "todo", icon: "tasks", label: "할 일" }, { id: "study", icon: "curriculum", label: "커리큘럼" }];
// 패널을 둘 수 있는 자리 (메뉴 막대 아래 ~ 독 위)
const area = (): Area => ({ w: window.innerWidth, h: window.innerHeight, top: Math.max(availTop, 28), bottom: Math.max(screen.height - availTop - screen.availHeight, 0) + 84 });
const loadLayout = (): Layout => { let v: unknown = null; try { v = JSON.parse(localStorage.getItem(STORE) ?? "null"); } catch { /* 저장된 배치 없음 */ } return restore(v, area()); };
const saveLayout = (l: Layout) => { try { localStorage.setItem(STORE, JSON.stringify(l)); } catch { /* 저장 못 해도 화면은 그대로 */ } };
// 노트 카드 자리 (styles.css .dk-note: 왼쪽 28, 위 110, 아래 100, 폭 min(440px, 30vw))
const noteRect = (): Rect => ({ x: 28, y: 110, w: Math.min(440, window.innerWidth * 0.3), h: window.innerHeight - 210 });
const fromYmd = (s: string) => new Date(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));

export function Desktop() {
  const [now, setNow] = useState(() => new Date());
  const today = ymd(now);
  const [day, setDay] = useState(today);
  const [data, setData] = useState<Data>({ events: [], dbs: [], error: null });
  const [at, setAt] = useState(0); // 카드에 크게 보이는 할 일 (그날 목록의 몇 번째)
  const [text, setText] = useState("");
  const [scr, setScr] = useState<View>(() => { const v = localStorage.getItem(SCREEN_KEY); return v === "todo" || v === "study" ? v : "home"; });
  const go = (v: View) => { setScr(v); try { localStorage.setItem(SCREEN_KEY, v); } catch { /* 기억 못 해도 전환은 됨 */ } };
  const [msg, setMsg] = useState<string | null>(null);
  const seq = useRef(0);
  // 바탕 그래프: Obsidian 전체 노트 (처음 한 번 읽음)
  const [vault, setVault] = useState<Doc[]>([]);
  const [note, setNote] = useState<Doc | null>(null);
  const noteHtml = useMemo(() => {
    if (!note) return "";
    const pw = note.meta.password;
    const md = (pw ? note.markdown.split(pw).join("••••••") : note.markdown).replace(/<!--[\s\S]*?-->/g, "");
    return marked.parse(md.trim() || "_내용이 없는 노트예요_", { async: false }) as string;
  }, [note]);
  useEffect(() => { loadDocs({ id: "__vault", name: "전체 노트", dir: "", kind: "notes" }).then(setVault).catch(() => {}); }, []);
  // 패널: 고정한 것은 다시 켜도 그 자리에. 고정 안 한 것은 바탕화면 빈 곳을 누르거나 Esc면 닫힘
  // 띄운 것끼리 겹치지 않게: 열거나 옮기기를 마치면 settle로 빈 곳에 맞춤 (방금 만진 패널이 비켜 감). 노트 카드도 자리 차지
  const noteOn = useRef(false);
  noteOn.current = !!note && scr !== "home"; // 홈에서는 노트가 오른쪽 카드 안에 떠서 자리 비킬 필요 없음
  const fixed = () => noteOn.current ? [noteRect()] : [];
  const [layout, setLayout] = useState<Layout>(() => settle(loadLayout(), PANELS, [], area()).layout);
  const [order, setOrder] = useState<PanelId[]>(PANELS); // 뒤에 있을수록 위
  const orderRef = useRef(order);
  orderRef.current = order;
  const change = (f: (l: Layout) => Layout, persist = true) => setLayout(l => { const n = f(l); if (persist) saveLayout(n); return n; });
  const set = (id: PanelId, p: Partial<Layout[PanelId]>, persist = true) => change(l => ({ ...l, [id]: { ...l[id], ...p } }), persist);
  const shut = useRef<PanelId[]>([]); // 자리가 모자라 닫은 패널 → 알림
  const fitAll = (l: Layout) => { const r = settle(l, orderRef.current, fixed(), area()); if (r.closed.length) shut.current = r.closed; return r.layout; };
  const tidy = () => change(fitAll);
  useEffect(() => { if (shut.current.length) { setMsg(`자리가 모자라 ${shut.current.map(id => TITLES[id].title).join(", ")} 패널을 닫았어요 · 📌 고정한 패널은 안 닫아요`); shut.current = []; } }, [layout]);
  const front = (id: PanelId) => {
    const o = orderRef.current;
    if (o[o.length - 1] !== id) { orderRef.current = [...o.filter(x => x !== id), id]; setOrder(orderRef.current); }
  };
  const show = (id: PanelId) => { front(id); change(l => fitAll({ ...l, [id]: { ...l[id], open: true } })); };
  const togglePanel = (id: PanelId) => { if (layout[id].open) set(id, { open: false, pinned: false }); else show(id); };
  useEffect(tidy, [note, scr]); // 노트 카드가 뜨면 왼쪽 패널이 비켜 감
  // 가운데 화면은 양옆 패널·노트 카드만큼 비켜 줌. 끄는 동안엔 그대로 (가운데가 따라 흔들리지 않게)
  const [dragging, setDragging] = useState(false);
  const lastRes = useRef({ l: 0, r: 0 });
  if (!dragging) lastRes.current = reserve([...PANELS.filter(id => layout[id].open).map(id => layout[id].rect), ...fixed()], window.innerWidth);
  const padL = lastRes.current.l ? lastRes.current.l + 28 : 28, padR = lastRes.current.r ? lastRes.current.r + 28 : 28;
  const narrow = lastRes.current.l > 0 || lastRes.current.r > 0; // 이전·다음 카드는 가운데 밖으로 삐져나와서, 양옆에 뭐가 있으면 숨김
  // 빈 곳·Esc: 고정 안 한 패널 닫고, 단축키로 앞에 올라와 있었으면 다시 앱 창 아래로
  const closeLoose = () => { change(l => { const n = { ...l }; for (const id of PANELS) if (n[id].open && !n[id].pinned) n[id] = { ...n[id], open: false }; return n; }); invoke("desktop_lower"); };
  // 노트 패널을 어떤 노트 검색(또는 전체 그래프)으로 열지. 단축키·런처 검색에서 정해 줌
  const [notesAt, setNotesAt] = useState({ id: "__vault", graph: false, n: 0 });
  const openPanel = (p: string) => {
    const id = (p.startsWith("notes") || p === "graph" ? "notes" : p) as PanelId;
    if (!PANELS.includes(id)) return;
    if (id === "notes") setNotesAt(o => ({ id: p.startsWith("notes:") ? p.slice(6) : "__vault", graph: p === "graph", n: o.n + 1 }));
    show(id);
  };
  useEffect(() => {
    const take = () => invoke<string | null>("desktop_take_pending").then(p => { if (p) openPanel(p); });
    take();
    const un = listen("open-panel", take);
    return () => { un.then(f => f()); };
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { setNote(null); closeLoose(); } };
    const resize = () => change(l => { const n = { ...l }; for (const id of PANELS) n[id] = { ...n[id], rect: fit(n[id].rect, area()) }; return fitAll(n); });
    window.addEventListener("keydown", key); window.addEventListener("resize", resize);
    return () => { window.removeEventListener("keydown", key); window.removeEventListener("resize", resize); };
  }, []);

  // 읽는 범위: 오늘 기준(밀린 일 30일 전 ~ 7일 뒤) + 달력에서 고른 날과 그 뒤 7일("다가오는 일")까지
  // (예전에는 오늘 기준만 읽어서, 달력에서 먼 날을 고르면 그날 일정이 있어도 "할 일이 없어요"로 나왔음)
  const dayRef = useRef(day);
  dayRef.current = day;
  const loaded = useRef<{ start: string; end: string } | null>(null);
  const range = (d: string) => {
    const t = ymd(new Date());
    const a = shiftYmd(t, -BACK), b = shiftYmd(t, WEEK), c = shiftYmd(d, -1), e = shiftYmd(d, WEEK);
    return { start: c < a ? c : a, end: e > b ? e : b };
  };
  const load = () => {
    const my = ++seq.current;
    const r = range(dayRef.current);
    loaded.current = r;
    return invoke<Data>("notion_events", { ...r, fresh: false })
      .then(d => { if (my === seq.current) setData({ events: paint(d.events), dbs: d.dbs, error: null, loaded: true }); })
      .catch(e => { if (my === seq.current) setData(o => ({ ...o, loaded: true, error: String(e) === "NO_ACCOUNT" ? "노션 계정이 연결되지 않았어요 · 런처의 캘린더에서 연결" : String(e) })); });
  };
  useEffect(() => {
    load();
    const tick = setInterval(() => setNow(new Date()), 10_000);
    const poll = setInterval(load, REFRESH);
    const un = listen("cal-changed", () => load()); // 런처에서 추가·수정·완료하면 바로
    window.addEventListener("focus", load);
    return () => { clearInterval(tick); clearInterval(poll); un.then(f => f()); window.removeEventListener("focus", load); };
  }, []);
  // 자정이 지나면 고른 날도 새 오늘로
  const prevToday = useRef(today);
  useEffect(() => { if (prevToday.current !== today) { if (day === prevToday.current) setDay(today); prevToday.current = today; load(); } }, [today]);
  useEffect(() => setAt(0), [day]);
  // 고른 날이 읽어 둔 범위 밖이면 그 날까지 다시 읽기
  useEffect(() => {
    const r = range(day), l = loaded.current;
    if (l && (r.start < l.start || r.end > l.end)) load();
  }, [day]);
  useEffect(() => { if (!msg) return; const t = setTimeout(() => setMsg(null), 4000); return () => clearTimeout(t); }, [msg]);

  const list = dayList(data.events, day, today);
  const pos = Math.max(0, Math.min(at, list.length - 1));
  const cur = list[pos];
  // 지금 할 일 제목과 맞는 노트 (그래프에서 진하게). 없으면 전부 같은 밝기
  const related = useMemo(() => {
    const hit = cur ? rank(vault, cur.title).slice(0, 40) : [];
    return hit.length ? new Set(hit.map(d => d.file)) : null;
  }, [vault, cur?.title]);
  const left = list.filter(e => !e.done).length;
  const week = Array.from({ length: WEEK }, (_, i) => shiftYmd(today, i));
  // 키보드: ⌘1 홈 · ⌘2 할 일 · ⌘3 커리큘럼 · ←/→ 이전·다음 할 일 (글 입력 중에는 ←→ 그대로)
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.metaKey && (e.key === "1" || e.key === "2" || e.key === "3")) { e.preventDefault(); go(e.key === "1" ? "home" : e.key === "2" ? "todo" : "study"); return; }
      const t = e.target as HTMLElement;
      if (e.metaKey || e.altKey || e.ctrlKey || t.closest("input, textarea, [contenteditable]") || list.length < 2) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); setAt(a => (Math.min(a, list.length - 1) + (e.key === "ArrowLeft" ? -1 : 1) + list.length) % list.length); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [list.length]);
  const lateList = data.events.filter(e => (e.end ?? e.start).slice(0, 10) < today && (e.end ?? e.start).slice(0, 10) >= shiftYmd(today, -BACK) && e.done === false); // 먼 과거 날을 골라 더 읽어도 밀린 일은 30일까지만
  const late = lateList.length;
  // 할 일 화면 "다가오는 일": 고른 날 다음부터 7일 안의 안 한 일
  const upcoming = data.events.filter(e => e.done !== true && e.start.slice(0, 10) > day && e.start.slice(0, 10) <= shiftYmd(day, WEEK)).slice(0, 6);
  const dbOf = (e: CalEvent) => data.dbs.find(d => d.id === e.db_id);

  const toggleDone = async (e: CalEvent) => {
    const db = dbOf(e);
    if (!db?.done_prop || e.done === null) return;
    setData(o => ({ ...o, events: o.events.map(x => x.id === e.id ? { ...x, done: !e.done } : x) })); // 먼저 화면에 반영
    try {
      await invoke("notion_done", { account: e.account, page: e.id, prop: db.done_prop, done: !e.done });
      setMsg(e.done ? `완료 취소: ${e.title}` : `✓ 완료: ${e.title}`);
    } catch (err) { setMsg(`노션 저장 실패: ${err}`); }
    load();
  };
  // 할 일 화면에서 추가할 날짜·시각: 시작은 늘 오늘부터 (추가하고 나면 다시 오늘). 글에 "내일", "3시"처럼 적으면 글이 먼저
  const [addDate, setAddDate] = useState(today);
  const [addTime, setAddTime] = useState("");
  const [addEnd, setAddEnd] = useState(""); // 끝나는 날 (비우면 하루)
  useEffect(() => { setAddDate(today); setAddEnd(""); }, [today]); // 자정이 지나면 새 오늘로
  const add = async (date = day, time = "", until = "") => {
    const t = text.trim();
    if (!t) return;
    setText(""); setMsg("노션에 저장 중…");
    try { setMsg(await addTodo(t, date || day, time || null, until || null)); setAddDate(today); setAddTime(""); setAddEnd(""); } catch (e) { setText(t); setMsg(String(e).replace(/^Error: /, "")); }
  };

  const d = fromYmd(day);
  const dayName = `${d.getMonth() + 1}월 ${d.getDate()}일 ${DAYS[d.getDay()]}요일`;
  const rel = day === today ? "오늘" : day === shiftYmd(today, 1) ? "내일" : dayName;
  return (
    <div className={`dk ${scr}${note ? " noting" : ""}${narrow ? " narrow" : ""}`} onPointerDown={e => { if (e.target === e.currentTarget || (e.target as HTMLElement).closest(".dk-bgraph")) closeLoose(); }} style={{ paddingTop: Math.max(availTop, 28) + 14, paddingLeft: padL, paddingRight: padR, paddingBottom: Math.max(screen.height - availTop - screen.availHeight, 0) + 18,
      ...({ "--pt": `${Math.max(availTop, 28) + 14}px`, "--pb": `${Math.max(screen.height - availTop - screen.availHeight, 0) + 18}px`, "--pl": `${padL}px`, "--pr": `${padR}px` } as CSSProperties) }}>
      <header className="dk-top dk-glass">
        <div className="dk-days">
          {week.map((w, i) => {
            const n = eventsOn(data.events, w).filter(e => !e.done).length;
            const wd = fromYmd(w).getDay();
            return (
              <button key={w} className={`dk-day${w === day ? " on" : ""}${w === today ? " today" : ""}${wd === 0 ? " sun" : wd === 6 ? " sat" : ""}`} onClick={() => setDay(w)}>
                <span className="dk-wd">{i === 0 ? "오늘" : DAYS[wd]}</span>
                <span className="dk-dn">{+w.slice(8)}</span>
                {n > 0 && <span className="dk-dots">{Array.from({ length: Math.min(n, 3) }, (_, k) => <i key={k} />)}</span>}
              </button>
            );
          })}
        </div>
        <div className="dk-side">
          {late > 0 && <button className="dk-badge" onClick={() => setDay(today)}>밀린 할 일 {late}</button>}
          <div className="dk-clock">
            <b>{`${now.getHours()}`.padStart(2, "0")}:{`${now.getMinutes()}`.padStart(2, "0")}</b>
            <span>{now.getMonth() + 1}월 {now.getDate()}일 {DAYS[now.getDay()]}요일</span>
          </div>
        </div>
      </header>

      {/* 바탕 전체: Obsidian 노트 그래프가 천천히 떠다님. 지금 할 일과 관련된 노트는 진하게, 누르면 노트 카드, 두 번 누르면 Obsidian */}
      <div className="dk-bgraph">
        <NoteGraph docs={vault} matches={related} selected={note ?? undefined} cacheKey="dk-bg" onSelect={setNote}
          onOpen={d => invoke("open_url", { url: `obsidian://open?path=${encodeURIComponent(d.file)}` })} />
      </div>
      {/* 고른 노트: 본문을 그대로 읽을 수 있는 카드 (스크롤). 비밀번호가 적힌 노트는 가림 */}
      {note && scr !== "home" && <aside className="dk-note dk-glass">
        <header>
          <div><b>{note.name}</b><small>{shortDir(note.file)}</small></div>
          <button className="dk-btn" onClick={() => invoke("open_url", { url: `obsidian://open?path=${encodeURIComponent(note.file)}` })}>Obsidian에서 열기</button>
          <button className="dk-x" onClick={() => setNote(null)} title="닫기">✕</button>
        </header>
        <article className="md dk-note-md" key={note.file} dangerouslySetInnerHTML={{ __html: noteHtml }} />
      </aside>}

      {scr === "home" ? <main className="dk-center">
        {/* 히어로: 고른 할 일을 그림 카드에 크게. 양옆에 이전·다음 할 일 카드가 살짝 보임 */}
        <section className="dk-stage">
          {list.length > 1 && <>
            <button className="dk-peek l" onClick={() => setAt(a => (a - 1 + list.length) % list.length)} title="이전 할 일">
              <span>{list[(pos - 1 + list.length) % list.length].title}</span></button>
            <button className="dk-peek r" onClick={() => setAt(a => (a + 1) % list.length)} title="다음 할 일">
              <span>{list[(pos + 1) % list.length].title}</span></button>
          </>}
          {/* 홈에서 그래프 노트를 누르면: 이 카드가 그 노트 내용으로 (✕ 또는 Esc면 다시 할 일) */}
          {note ? <article className="dk-hero-card dk-notecard">
            <div className="dk-hero-top">
              <span className="dk-chip">노트</span>
              <span className="dk-count">{shortDir(note.file)}</span>
              <button className="dk-x" onClick={() => setNote(null)} title="할 일로 돌아가기">✕</button>
            </div>
            <h1>{note.name}</h1>
            <article className="md dk-note-md" key={note.file} dangerouslySetInnerHTML={{ __html: noteHtml }} />
            <div className="dk-acts">
              <button className="dk-btn primary" onClick={() => invoke("open_url", { url: `obsidian://open?path=${encodeURIComponent(note.file)}` })}>Obsidian에서 열기</button>
              <button className="dk-btn" onClick={() => setNote(null)}>할 일로 돌아가기</button>
            </div>
          </article> : <article className="dk-hero-card">
            <div className="dk-hero-top">
              <span className="dk-chip">{rel}{rel !== dayName && <em>{dayName}</em>}</span>
              {list.length > 0 && <span className="dk-count">남은 {left} · 전체 {list.length}</span>}
            </div>
            {!data.loaded ? <div className="dk-hero"><span className="dk-skel" style={{ fontSize: 48 }} /><span className="dk-skel sm" /></div> : data.error ? <p className="dk-empty">{data.error}</p> : cur ? <>
              <div className="dk-hero">
                <span className="dk-when">{rel} · {cur.start.slice(0, 10) < today ? `밀림 · ${+cur.start.slice(5, 7)}/${+cur.start.slice(8, 10)}` : timeOf(cur)}
                  {cur.end && cur.end.slice(0, 10) !== cur.start.slice(0, 10) && ` ~ ${+cur.end.slice(5, 7)}/${+cur.end.slice(8, 10)}`}</span>
                <h1 className={cur.done ? "done" : ""}>{cur.title}</h1>
                <span className="dk-meta"><i style={{ background: cur.color || "var(--accent)" }} />{cur.account} · {cur.db}</span>
              </div>
              <div className="dk-acts">
                {cur.done !== null && dbOf(cur)?.done_prop && <button className="dk-btn primary" onClick={() => toggleDone(cur)}>{cur.done ? "완료 취소" : "완료 →"}</button>}
                <button className="dk-btn" onClick={() => invoke("open_url", { url: cur.url.replace(/^https:\/\//, "notion://") })}>노션에서 열기</button>
              </div>
              {list.length > 1 && <div className="dk-pager">{list.map((e, i) => <button key={e.id} className={i === pos ? "on" : ""} onClick={() => setAt(i)} title={e.title} />)}</div>}
            </> : <div className="dk-hero"><h1 className="dk-none">{rel} 할 일이 없어요</h1><span className="dk-meta">아래에 적으면 노션에 바로 추가돼요</span></div>}
          </article>}
        </section>

        {/* 홈 오른쪽: 그날 할 일 짧게 (누르면 위 카드로) */}
        {data.loaded && list.length > 0 && <section className="dk-homelist dk-glass">
          <div className="dk-box-k"><b>{rel} 할 일</b><em>{list.length - left}/{list.length} 완료</em></div>
          <ul className="dk-rows">
            {list.slice(0, 6).map((e, i) => (
              <li key={e.id} className={`${i === pos ? "on" : ""}${e.done ? " done" : ""}`} onClick={() => setAt(i)}>
                <span className="dk-tag">{i === pos ? "지금" : e.start.slice(0, 10) < today ? "밀림" : timeOf(e)}</span>
                <i style={{ background: e.color || "var(--accent)" }} />
                <span className="dk-lt">{e.title}</span>
                <button className="dk-check" disabled={e.done === null || !dbOf(e)?.done_prop} title={e.done ? "완료 취소" : "완료"} onClick={ev => { ev.stopPropagation(); toggleDone(e); }}>{e.done ? "✓" : ""}</button>
              </li>
            ))}
            {list.length > 6 && <li className="dk-blank" onClick={() => go("todo")}>외 {list.length - 6}개 · 할 일 화면에서 보기 →</li>}
          </ul>
        </section>}
        <section className="dk-quick dk-glass">
          <span className="dk-quick-k">빠른 추가</span>
          <input className="dk-add" value={text} placeholder={`${rel}에 할 일 추가 · 예: 3시 회의, 내일 장보기 (Enter)`}
            onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.nativeEvent.isComposing) add(); }} />
          <button className="dk-btn" onClick={() => go("todo")}>{rel} 계획 보기 →</button>
        </section>
        {/* 다가오는 일: 고른 날 다음 7일 안의 안 한 일 (누르면 그날로) */}
        {data.loaded && upcoming.length > 0 && <section className="dk-homelist dk-glass">
          <div className="dk-box-k"><b>다가오는 일</b><em>{upcoming.length}</em></div>
          <ul className="dk-rows">
            {upcoming.map(e => (
              <li key={e.id} onClick={() => setDay(e.start.slice(0, 10))}>
                <span className="dk-tag">{+e.start.slice(5, 7)}/{+e.start.slice(8, 10)}</span>
                <span className="dk-lt">{e.title}</span>
                <span className="dk-lm">{timeOf(e)}</span>
              </li>
            ))}
          </ul>
        </section>}
      </main> : scr === "study" ? <CurriculumBoard /> : <TodoBoard {...{ list, pos, setAt, cur, today, rel, dayName, left, late: lateList, upcoming, loading: !data.loaded, dbOf, toggleDone, error: data.error, setDay, calendar: <CalendarPanel day={day} onDay={setDay} />, addInput: <div className="dk-addbox">
            <input className="dk-add" value={text} placeholder="할 일 적고 Enter · 날짜·시각은 아래에서"
              onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.nativeEvent.isComposing) add(addDate, addTime, addEnd); }} />
            <div className="dk-addrow">
              <input className="dk-add dk-when-in" type="date" value={addDate} title="시작 날짜" onChange={e => { const v = e.target.value || day; setAddDate(v); if (addEnd && addEnd <= v) setAddEnd(""); }} />
              {addEnd ? <>
                <span className="dk-tilde">~</span>
                <input className="dk-add dk-when-in" type="date" value={addEnd} min={shiftYmd(addDate, 1)} title="끝나는 날" onChange={e => setAddEnd(e.target.value > addDate ? e.target.value : "")} />
                <button className="dk-link" onClick={() => setAddEnd("")}>하루만</button>
              </> : <button className="dk-link" onClick={() => setAddEnd(shiftYmd(addDate, 1))}>+ 끝나는 날</button>}
              {addTime ? <>
                <input className="dk-add dk-when-in" type="time" value={addTime} title="시각" onChange={e => setAddTime(e.target.value)} />
                <button className="dk-link" onClick={() => setAddTime("")}>하루 종일로</button>
              </> : <button className="dk-link" onClick={() => setAddTime("09:00")}>+ 시각 추가</button>}
              <button className="dk-btn primary" disabled={!text.trim()} onClick={() => add(addDate, addTime, addEnd)}>추가</button>
            </div>
          </div> }} />}

      {PANELS.filter(id => layout[id].open).map(id => (
        <Panel key={id} title={TITLES[id].title} icon={TITLES[id].icon} rect={layout[id].rect} pinned={layout[id].pinned} z={10 + order.indexOf(id)}
          onRect={r => { setDragging(true); set(id, { rect: fit(r, area()) }, false); }} onDone={() => { setDragging(false); tidy(); }} onFront={() => front(id)}
          onPin={() => set(id, { pinned: !layout[id].pinned })} onClose={() => set(id, { open: false, pinned: false })}
          onLauncher={() => invoke("open_launcher", { action: id === "notes" ? (notesAt.id === "__vault" ? "graph" : `note:${notesAt.id}`) : id === "window" ? "baro" : id })}>
          {id === "calendar" ? <CalendarPanel day={day} onDay={setDay} /> : id === "clipboard" ? <ClipPanel onMsg={setMsg} />
            : id === "files" ? <FilesPanel onMsg={setMsg} /> : id === "window" ? <WindowPanel onMsg={setMsg} />
            : id === "ai" ? <AiPanel onMsg={setMsg} />
            : id === "notes" ? <NotesPanel key={notesAt.n} initial={notesAt.id} graph={notesAt.graph} onMsg={setMsg} /> : <MemoPanel onMsg={setMsg} />}
        </Panel>
      ))}

      <nav className="dk-dock dk-glass">
        {SCREENS.map(v => { const Svg = ICONS[v.icon]; return <button key={v.id} className={`dk-scr${scr === v.id ? " on" : ""}`} title={v.label} onClick={() => go(v.id)}>
          <Svg size={20} strokeWidth={2} /><span>{v.label}</span></button>; })}
        <span className="dk-sep" />
        {DOCK.map(b => {
          const Svg = ICONS[b.icon];
          const on = b.panel && layout[b.panel].open;
          return <button key={b.action} className={on ? "on" : ""} title={b.label}
            onClick={() => b.panel ? togglePanel(b.panel) : invoke("open_launcher", { action: b.action })}>
            <Svg size={20} strokeWidth={2} /><span>{b.label}{b.panel ? (on ? " 닫기" : " · 바탕화면에 열기") : " · 런처"}</span>
            {b.panel && layout[b.panel].pinned && <i className="dk-pinned" />}</button>;
        })}
        <span className="dk-sep" />
        <button title="바탕화면 모드 끄기 (메뉴 막대 Baro 아이콘에서 다시 켜기)" onClick={() => invoke("desktop_set", { on: false })}>
          {(() => { const P = ICONS.power; return <P size={20} strokeWidth={2} />; })()}<span>끄기</span></button>
      </nav>
      {msg && <div className="dk-toast dk-glass">{msg}</div>}
    </div>
  );
}
