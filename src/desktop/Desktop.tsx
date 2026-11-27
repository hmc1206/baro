// 바탕화면 모드 화면 ("desktop" 창): 위 = 이번 주 날짜 띠 + 시계, 가운데 = 고른 날의 할 일 카드, 아래 = Baro 기능 독
// 창은 바탕화면 아이콘 위·모든 앱 창 아래에 깔려 있음 (src-tauri/src/desktop.rs)
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { type CalDb, type CalEvent, dayList, eventsOn, shiftYmd, timeOf, ymd } from "../app/calendar";
import { addTodo } from "../commands";
import { ICONS } from "../icons";
import { Panel } from "./Panel";
import { CalendarPanel, ClipPanel, MemoPanel } from "./panels";
import { type Area, type Layout, type PanelId, PANELS, fit, restore } from "./layout";

const DAYS = ["일", "월", "화", "수", "목", "금", "토"];
const WEEK = 7;      // 띠에 보이는 날 수 (오늘부터)
const BACK = 30;     // 밀린 할 일을 찾는 범위
const REFRESH = 180_000;
// 독 버튼: panel이 있으면 바탕화면 패널로 열고, 없으면 런처를 그 기능으로
const DOCK: { action: string; icon: string; label: string; panel?: PanelId }[] = [
  { action: "baro", icon: "search", label: "검색" },
  { action: "files", icon: "folder", label: "파일 찾기" },
  { action: "memo", icon: "memo", label: "빠른 메모", panel: "memo" },
  { action: "calendar", icon: "daily", label: "캘린더", panel: "calendar" },
  { action: "clipboard", icon: "clip", label: "클립보드", panel: "clipboard" },
  { action: "graph", icon: "graph", label: "노트 그래프" },
  { action: "ai", icon: "ai", label: "AI에게 묻기" },
];

type Data = { events: CalEvent[]; dbs: CalDb[]; error: string | null };
// 메뉴 막대·Dock 자리 (WebKit의 screen.availTop은 표준 타입에 없음)
const availTop = (screen as Screen & { availTop?: number }).availTop ?? 0;
const TITLES: Record<PanelId, { title: string; icon: string }> = { calendar: { title: "캘린더", icon: "daily" }, clipboard: { title: "클립보드 기록", icon: "clip" }, memo: { title: "빠른 메모 · 오늘 Daily", icon: "memo" } };
const STORE = "baro.desktop.panels";
// 패널을 둘 수 있는 자리 (메뉴 막대 아래 ~ 독 위)
const area = (): Area => ({ w: window.innerWidth, h: window.innerHeight, top: Math.max(availTop, 28), bottom: Math.max(screen.height - availTop - screen.availHeight, 0) + 84 });
const loadLayout = (): Layout => { let v: unknown = null; try { v = JSON.parse(localStorage.getItem(STORE) ?? "null"); } catch { /* 저장된 배치 없음 */ } return restore(v, area()); };
const saveLayout = (l: Layout) => { try { localStorage.setItem(STORE, JSON.stringify(l)); } catch { /* 저장 못 해도 화면은 그대로 */ } };
const fromYmd = (s: string) => new Date(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));

export function Desktop() {
  const [now, setNow] = useState(() => new Date());
  const today = ymd(now);
  const [day, setDay] = useState(today);
  const [data, setData] = useState<Data>({ events: [], dbs: [], error: null });
  const [at, setAt] = useState(0); // 카드에 크게 보이는 할 일 (그날 목록의 몇 번째)
  const [text, setText] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const seq = useRef(0);
  // 패널: 고정한 것은 다시 켜도 그 자리에. 고정 안 한 것은 바탕화면 빈 곳을 누르거나 Esc면 닫힘
  const [layout, setLayout] = useState<Layout>(loadLayout);
  const [order, setOrder] = useState<PanelId[]>(PANELS); // 뒤에 있을수록 위
  const change = (f: (l: Layout) => Layout, persist = true) => setLayout(l => { const n = f(l); if (persist) saveLayout(n); return n; });
  const set = (id: PanelId, p: Partial<Layout[PanelId]>, persist = true) => change(l => ({ ...l, [id]: { ...l[id], ...p } }), persist);
  const front = (id: PanelId) => setOrder(o => o[o.length - 1] === id ? o : [...o.filter(x => x !== id), id]);
  const togglePanel = (id: PanelId) => { const open = !layout[id].open; set(id, { open, ...(open ? {} : { pinned: false }) }); if (open) front(id); };
  const closeLoose = () => change(l => { const n = { ...l }; for (const id of PANELS) if (n[id].open && !n[id].pinned) n[id] = { ...n[id], open: false }; return n; });
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") closeLoose(); };
    const resize = () => change(l => { const n = { ...l }; for (const id of PANELS) n[id] = { ...n[id], rect: fit(n[id].rect, area()) }; return n; });
    window.addEventListener("keydown", key); window.addEventListener("resize", resize);
    return () => { window.removeEventListener("keydown", key); window.removeEventListener("resize", resize); };
  }, []);

  const load = () => {
    const my = ++seq.current;
    const t = ymd(new Date());
    return invoke<Data>("notion_events", { start: shiftYmd(t, -BACK), end: shiftYmd(t, WEEK), fresh: false })
      .then(d => { if (my === seq.current) setData({ events: d.events, dbs: d.dbs, error: null }); })
      .catch(e => { if (my === seq.current) setData(o => ({ ...o, error: String(e) === "NO_ACCOUNT" ? "노션 계정이 연결되지 않았어요 · 런처의 캘린더에서 연결" : String(e) })); });
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
  useEffect(() => { if (!msg) return; const t = setTimeout(() => setMsg(null), 4000); return () => clearTimeout(t); }, [msg]);

  const list = dayList(data.events, day, today);
  const cur = list[Math.min(at, list.length - 1)];
  const left = list.filter(e => !e.done).length;
  const week = Array.from({ length: WEEK }, (_, i) => shiftYmd(today, i));
  const late = data.events.filter(e => (e.end ?? e.start).slice(0, 10) < today && e.done === false).length;
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
  const add = async () => {
    const t = text.trim();
    if (!t) return;
    setText(""); setMsg("노션에 저장 중…");
    try { setMsg(await addTodo(t, day)); } catch (e) { setText(t); setMsg(String(e).replace(/^Error: /, "")); }
  };

  const d = fromYmd(day);
  const dayName = `${d.getMonth() + 1}월 ${d.getDate()}일 ${DAYS[d.getDay()]}요일`;
  const rel = day === today ? "오늘" : day === shiftYmd(today, 1) ? "내일" : dayName;
  return (
    <div className="dk" onPointerDown={e => { if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains("dk-center")) closeLoose(); }} style={{ paddingTop: Math.max(availTop, 28) + 14, paddingBottom: Math.max(screen.height - availTop - screen.availHeight, 0) + 18 }}>
      <header className="dk-top dk-glass">
        <div className="dk-days">
          {week.map((w, i) => {
            const n = eventsOn(data.events, w).filter(e => !e.done).length;
            const wd = fromYmd(w).getDay();
            return (
              <button key={w} className={`dk-day${w === day ? " on" : ""}${wd === 0 ? " sun" : wd === 6 ? " sat" : ""}`} onClick={() => setDay(w)}>
                <span className="dk-wd">{i === 0 ? "오늘" : DAYS[wd]}</span>
                <span className="dk-dn">{+w.slice(8)}</span>
                <span className="dk-dots">{Array.from({ length: Math.min(n, 4) }, (_, k) => <i key={k} />)}</span>
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

      <main className="dk-center">
        <section className="dk-card dk-glass">
          <div className="dk-card-head">
            <span className="dk-chip">{rel}{rel !== dayName && <em>{dayName}</em>}</span>
            <span className="dk-count">{list.length ? `남은 ${left} · 전체 ${list.length}` : ""}</span>
            {list.length > 1 && <span className="dk-nav">
              <button onClick={() => setAt(a => (a - 1 + list.length) % list.length)} title="이전">‹</button>
              <span>{Math.min(at, list.length - 1) + 1}/{list.length}</span>
              <button onClick={() => setAt(a => (a + 1) % list.length)} title="다음">›</button>
            </span>}
          </div>
          {data.error ? <p className="dk-empty">{data.error}</p> : cur ? <>
            <div className="dk-hero">
              <span className="dk-when">{cur.start.slice(0, 10) < today ? `밀림 · ${+cur.start.slice(5, 7)}/${+cur.start.slice(8, 10)}` : timeOf(cur)}
                {cur.end && cur.end.slice(0, 10) !== cur.start.slice(0, 10) && ` ~ ${+cur.end.slice(5, 7)}/${+cur.end.slice(8, 10)}`}</span>
              <h1 className={cur.done ? "done" : ""}>{cur.title}</h1>
              <span className="dk-meta"><i style={{ background: cur.color || "var(--accent)" }} />{cur.account} · {cur.db}</span>
              <div className="dk-acts">
                {cur.done !== null && dbOf(cur)?.done_prop && <button className="dk-btn primary" onClick={() => toggleDone(cur)}>{cur.done ? "완료 취소" : "✓ 완료"}</button>}
                <button className="dk-btn" onClick={() => invoke("open_url", { url: cur.url.replace(/^https:\/\//, "notion://") })}>노션에서 열기</button>
              </div>
            </div>
            <ul className="dk-list">
              {list.map((e, i) => (
                <li key={e.id} className={`${i === at ? "on" : ""}${e.done ? " done" : ""}`} onClick={() => setAt(i)}>
                  <button className="dk-check" disabled={e.done === null || !dbOf(e)?.done_prop} onClick={ev => { ev.stopPropagation(); toggleDone(e); }}>{e.done ? "✓" : ""}</button>
                  <span className="dk-lt">{e.title}</span>
                  <span className="dk-lm">{e.start.slice(0, 10) < today ? "밀림" : timeOf(e)}</span>
                  <i style={{ background: e.color || "var(--accent)" }} />
                </li>
              ))}
            </ul>
          </> : <p className="dk-empty">{rel} 할 일이 없어요</p>}
          <input className="dk-add" value={text} placeholder={`${rel}에 할 일 추가 · 예: 3시 회의, 내일 장보기 (Enter)`}
            onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.nativeEvent.isComposing) add(); }} />
        </section>
      </main>

      {PANELS.filter(id => layout[id].open).map(id => (
        <Panel key={id} title={TITLES[id].title} icon={TITLES[id].icon} rect={layout[id].rect} pinned={layout[id].pinned} z={10 + order.indexOf(id)}
          onRect={r => set(id, { rect: fit(r, area()) }, false)} onDone={() => change(l => l)} onFront={() => front(id)}
          onPin={() => set(id, { pinned: !layout[id].pinned })} onClose={() => set(id, { open: false, pinned: false })}
          onLauncher={() => invoke("open_launcher", { action: id })}>
          {id === "calendar" ? <CalendarPanel day={day} onDay={setDay} /> : id === "clipboard" ? <ClipPanel onMsg={setMsg} /> : <MemoPanel onMsg={setMsg} />}
        </Panel>
      ))}

      <nav className="dk-dock dk-glass">
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
