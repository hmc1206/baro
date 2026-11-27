// 바탕화면 패널 내용: 달력(한 달 일정), 클립보드 기록, 빠른 메모(오늘 Daily)
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { type CalEvent, monthCells, shiftMonth, ymd } from "../app/calendar";
import { MonthGrid } from "../app/MonthGrid";

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
