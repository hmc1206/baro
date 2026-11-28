// 바탕화면 "할 일" 화면: 그날 계획 전체를 카드 격자로
// 위 = 다음 할 일(크게) + 요약, 가운데 = 그날 순서, 아래 = 시간 정해진 일정 · 밀린 일 · 다가오는 일
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { type CalDb, type CalEvent, timeOf } from "../app/calendar";

const md = (s: string) => `${+s.slice(5, 7)}/${+s.slice(8, 10)}`;
const openNotion = (e: CalEvent) => invoke("open_url", { url: e.url.replace(/^https:\/\//, "notion://") });

export function TodoBoard({ list, pos, setAt, cur, today, rel, dayName, left, late, upcoming, dbOf, toggleDone, error, setDay, addInput }: {
  list: CalEvent[]; pos: number; setAt: (n: number) => void; cur: CalEvent | undefined; today: string; rel: string; dayName: string; left: number;
  late: CalEvent[]; upcoming: CalEvent[]; dbOf: (e: CalEvent) => CalDb | undefined; toggleDone: (e: CalEvent) => void; error: string | null;
  setDay: (d: string) => void; addInput: ReactNode;
}) {
  const done = list.length - left;
  const canDone = (e: CalEvent) => e.done !== null && !!dbOf(e)?.done_prop;
  const timed = list.filter(e => e.start.length > 10).sort((a, b) => a.start.localeCompare(b.start));
  const nowHm = new Date().toTimeString().slice(0, 5);
  const tag = (e: CalEvent, i: number) => i === pos ? "지금" : i === pos + 1 ? "다음" : e.start.slice(0, 10) < today ? "밀림" : timeOf(e);
  return (
    <main className="dk-board">
      {/* 다음 할 일: 고른 할 일을 크게 + 바로 할 동작 */}
      <section className="dk-next dk-glass">
        <div className="dk-next-k"><b>다음 할 일</b>{list.length > 0 && <span>{pos + 1} / {list.length}</span>}<em>{rel !== dayName ? `${rel} · ${dayName}` : dayName}</em></div>
        {error ? <p className="dk-empty">{error}</p> : cur ? <>
          <h2 className={cur.done ? "done" : ""}>{cur.title}</h2>
          <p className="dk-next-sub">{cur.start.slice(0, 10) < today ? `밀림 · ${md(cur.start)}부터` : timeOf(cur)}{cur.end && cur.end.slice(0, 10) !== cur.start.slice(0, 10) && ` ~ ${md(cur.end)}`} · {cur.account} · {cur.db}</p>
          <div className="dk-next-acts">
            {canDone(cur) && <button className="dk-btn primary" onClick={() => toggleDone(cur)}>{cur.done ? "완료 취소" : "완료 →"}</button>}
            <button className="dk-btn" onClick={() => openNotion(cur)}>노션에서 열기</button>
            {list.length > 1 && <button className="dk-link" onClick={() => setAt((pos + 1) % list.length)}>나중에</button>}
          </div>
        </> : <h2 className="dk-none">{rel} 할 일이 없어요</h2>}
      </section>

      {/* 요약: 남은 · 완료 · 밀린 + 진행 막대 */}
      <section className="dk-sum dk-glass">
        <div className="dk-box-k"><b>{rel} 요약</b></div>
        <div className="dk-stats">
          <div><b>{left}</b><span>남은 일</span></div>
          <div><b>{done}</b><span>완료</span></div>
          <div className={late.length ? "warn" : ""}><b>{late.length}</b><span>밀린 일</span></div>
        </div>
        <div className="dk-bar"><i style={{ width: `${list.length ? (done / list.length) * 100 : 0}%` }} /></div>
      </section>

      {/* 그날 순서: 누르면 위 "다음 할 일"로, 오른쪽에 열기·완료 */}
      <section className="dk-plan dk-glass">
        <div className="dk-box-k"><b>{rel} 순서</b><span>위에서부터 차례로 · 누르면 다음 할 일로</span><em>{done}/{list.length} 완료</em></div>
        <ul className="dk-rows">
          {list.map((e, i) => (
            <li key={e.id} className={`${i === pos ? "on" : ""}${e.done ? " done" : ""}`} onClick={() => setAt(i)}>
              <span className="dk-tag">{tag(e, i)}</span>
              <i style={{ background: e.color || "var(--accent)" }} />
              <span className="dk-lt">{e.title}</span>
              <span className="dk-lm">{e.account} · {e.db}</span>
              <button className="dk-mini" onClick={ev => { ev.stopPropagation(); openNotion(e); }}>열기</button>
              <button className="dk-check" disabled={!canDone(e)} title={e.done ? "완료 취소" : "완료"} onClick={ev => { ev.stopPropagation(); toggleDone(e); }}>{e.done ? "✓" : ""}</button>
            </li>
          ))}
          {!list.length && !error && <li className="dk-blank">아래에 적으면 노션에 바로 추가돼요</li>}
        </ul>
        {addInput}
      </section>

      {/* 시간 정해진 일정: 세로 타임라인, 지난 시각은 흐리게 */}
      <section className="dk-time dk-glass">
        <div className="dk-box-k"><b>시간 정해진 일정</b><em>{timed.length}</em></div>
        <ol className="dk-tl">
          {timed.map(e => (
            <li key={e.id} className={rel === "오늘" && e.start.slice(11, 16) < nowHm ? "past" : ""} onClick={() => setAt(list.indexOf(e))}>
              <time>{e.start.slice(11, 16)}</time><span>{e.title}</span>
            </li>
          ))}
          {!timed.length && <li className="dk-blank">시간이 정해진 일이 없어요</li>}
        </ol>
      </section>

      {/* 밀린 일 + 다가오는 일: 날짜를 누르면 그날로 */}
      <section className="dk-soon dk-glass">
        <div className="dk-box-k"><b>밀린 일 · 다가오는 일</b><em>{late.length + upcoming.length}</em></div>
        <ul className="dk-rows small">
          {late.map(e => (
            <li key={e.id} className="late" onClick={() => setDay(today)}>
              <span className="dk-tag">밀림</span><span className="dk-lt">{e.title}</span><span className="dk-lm">{md(e.start)}</span>
            </li>
          ))}
          {upcoming.map(e => (
            <li key={e.id} onClick={() => setDay(e.start.slice(0, 10))}>
              <span className="dk-tag">{md(e.start)}</span><span className="dk-lt">{e.title}</span><span className="dk-lm">{timeOf(e)}</span>
            </li>
          ))}
          {!late.length && !upcoming.length && <li className="dk-blank">일주일 안에 남은 일이 없어요</li>}
        </ul>
      </section>
    </main>
  );
}
