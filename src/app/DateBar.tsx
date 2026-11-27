// 캘린더 입력칸 아래: 날짜·시간·언제까지를 버튼으로 고르기 (글로 쓴 값보다 버튼이 먼저)
import { type Pick, type Todo, QUICK_TIMES, quickEnds, quickStarts, whenLabel } from "./calendar";

export function DateBar({ draft, setPick, target, setTarget }: {
  draft: Todo; setPick: (p: Pick) => void; target: "start" | "end"; setTarget: (t: "start" | "end") => void;
}) {
  const chip = (key: string, label: string, on: boolean, click: () => void) =>
    <button key={key} className={on ? "chip on" : "chip"} onClick={click}>{label}</button>;
  return (
    // 버튼을 눌러도 입력칸 포커스 유지 (Enter로 바로 저장)
    <div className="datebar" onMouseDown={e => { if (!(e.target instanceof HTMLInputElement)) e.preventDefault(); }}>
      <div className="datebar-row">
        <span className="datebar-k">날짜</span>
        {quickStarts(new Date()).map(o => chip(o.label, o.label, draft.date === o.date, () => setPick({ date: o.date })))}
        {chip("cal-start", "📅 달력에서", target === "start", () => setTarget("start"))}
      </div>
      <div className="datebar-row">
        <span className="datebar-k">시간</span>
        {chip("none", "없음", !draft.time, () => setPick({ time: null }))}
        {QUICK_TIMES.map(t => chip(t, t, draft.time === t, () => setPick({ time: t })))}
        <input type="time" className={draft.time ? "datebar-time" : "datebar-time empty"} title="직접 시간 고르기" value={draft.time ?? ""} onChange={e => setPick({ time: e.target.value || null })} />
      </div>
      <div className="datebar-row">
        <span className="datebar-k">언제까지</span>
        {chip("none", "없음", !draft.end, () => { setPick({ end: null }); setTarget("start"); })}
        {quickEnds(draft.date).map(o => chip(o.label, o.label, draft.end?.date === o.date, () => setPick({ end: { date: o.date, time: draft.end?.time ?? null } })))}
        {chip("cal-end", "📅 달력에서", target === "end", () => setTarget("end"))}
      </div>
      <div className="datebar-sum">
        {whenLabel(draft)}
        <span>{target === "end" ? " · 달력 칸을 누르면 끝 날짜" : " · 달력 칸을 누르면 시작 날짜"}</span>
      </div>
    </div>
  );
}
