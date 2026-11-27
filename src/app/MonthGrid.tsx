// 캘린더 화면 오른쪽: 한 달 달력에 모든 계정의 일정·할 일을 칸마다 (계정 색, 완료는 줄 긋기)
import { type CalEvent, monthCells, timeOf, weekBars, ymd } from "./calendar";

const WEEK = ["일", "월", "화", "수", "목", "금", "토"];
const LANES = 3; // 한 주에 보일 일정 줄 수 (넘치면 날짜 칸에 +N)

// range·onDay: 할 일 날짜를 고르는 중이면 그 기간을 칠하고, 칸을 누르면 그 날짜로
// marked·onCell: 바탕화면 달력 패널 — 고른 날을 칠하고, 칸을 누르면 그 날 (일정 막대도 그대로 누를 수 있음)
export function MonthGrid({ month, events, selected, loading, onMove, onPick, range, onDay, marked, onCell }: {
  month: string; events: CalEvent[]; selected?: string; loading: boolean;
  onMove: (n: number) => void; onPick: (e: CalEvent) => void;
  range?: { start: string; end: string | null }; onDay?: (day: string) => void;
  marked?: string; onCell?: (day: string) => void;
}) {
  const today = ymd(new Date());
  const cells = monthCells(month);
  const sel = events.find(e => e.id === selected);
  const selDay = sel && sel.start.slice(0, 10);
  const [y, m] = [month.slice(0, 4), +month.slice(5, 7)];
  return (
    <section className={onDay ? "month picking" : "month"} onMouseDown={e => e.preventDefault() /* 입력창 포커스 유지 */}>
      <header className="month-head">
        <span className="month-title">{y}년 {m}월</span>
        {loading && <span className="month-load">불러오는 중…</span>}
        <span className="month-nav">
          <button onClick={() => onMove(-1)} title="이전 달 (⌘[)">‹</button>
          <button onClick={() => onMove(0)} title="이번 달">오늘</button>
          <button onClick={() => onMove(1)} title="다음 달 (⌘])">›</button>
        </span>
      </header>
      <div className="month-grid">
        <div className="month-wds">
          {WEEK.map((w, i) => <div key={w} className={`month-wd${i === 0 ? " sun" : i === 6 ? " sat" : ""}`}>{w}</div>)}
        </div>
        {Array.from({ length: cells.length / 7 }, (_, wi) => {
          const week = cells.slice(wi * 7, wi * 7 + 7);
          const { bars, hidden } = weekBars(events, week, LANES);
          return (
            // 한 주 = 날짜 칸 7개(배경) 위에 일정 막대. 여러 날 일정은 칸을 가로질러 이어짐
            <div key={week[0]} className="month-week" style={{ gridTemplateRows: `20px repeat(${LANES}, 18px) 1fr` }}>
              {week.map((d, i) => {
                const cls = ["month-cell", d.slice(0, 7) !== month.slice(0, 7) && "out", d === today && "today", (d === selDay || d === marked) && !range && "picked",
                  range && d >= range.start && d <= (range.end ?? range.start) && "in-range", range && (d === range.start || d === range.end) && "range-edge"].filter(Boolean).join(" ");
                return (
                  <div key={d} className={cls} style={{ gridColumn: i + 1, gridRow: "1 / -1" }} onClick={onDay ? () => onDay(d) : onCell ? () => onCell(d) : undefined}>
                    <span className="month-day">{+d.slice(8)}</span>
                    {hidden[i] > 0 && <span className="month-more">+{hidden[i]}</span>}
                  </div>
                );
              })}
              {bars.map(b => {
                const e = b.ev;
                const cls = ["month-ev", e.done && "done", e.id === selected && "on", b.cutStart && "cut-s", b.cutEnd && "cut-e", b.e > b.s && "multi"].filter(Boolean).join(" ");
                return (
                  <button key={e.id} className={cls} onClick={ev => { if (onDay) return; ev.stopPropagation(); onPick(e); }}
                    style={{ gridColumn: `${b.s + 1} / ${b.e + 2}`, gridRow: b.lane + 2, ["--ev" as string]: e.color || "var(--accent)" }}
                    title={`${e.title} · ${timeOf(e)}${e.end && e.end.slice(0, 10) !== e.start.slice(0, 10) ? ` ~ ${e.end.slice(5, 10).replace("-", "/")}` : ""} · ${e.account} · ${e.db}`}>
                    {e.done !== null && <span className="month-box">{e.done ? "✓" : ""}</span>}
                    {e.start.length > 10 && !b.cutStart && <span className="month-time">{e.start.slice(11, 16)}</span>}
                    {e.title}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </section>
  );
}
