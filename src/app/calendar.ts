// 캘린더·할 일 화면: 입력한 글에서 날짜·시간 읽기, 날짜별 묶음 이름
export type CalEvent = { id: string; title: string; start: string; end: string | null; done: boolean | null; url: string; account: string; color: string; db: string; db_id: string };
export type CalDb = { id: string; name: string; account: string; title_prop: string; date_prop: string; done_prop: string | null };

const DAYS = ["일", "월", "화", "수", "목", "금", "토"];
const pad = (n: number) => String(n).padStart(2, "0");
export const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const fromYmd = (s: string) => new Date(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
export const shiftYmd = (s: string, n: number) => ymd(addDays(fromYmd(s), n));

// "내일 오후 3시 치과" → { title: "치과", date: "2026-11-28", time: "15:00", end: null }. 날짜가 없으면 오늘
// 언제까지: "12/1~12/5 워크숍", "내일부터 금요일까지 출장", "오후 2시~4시 회의" → end에 끝 날짜·시간
// "금요일까지 보고서"처럼 날짜 하나에 "까지"만 붙으면 그날이 마감 (date = 금요일)
export type Todo = { title: string; date: string; time: string | null; end: { date: string; time: string | null } | null };
export function parseTodo(text: string, now: Date): Todo {
  // "내일부터", "12/5까지", "1~5" 를 떼어 읽기 쉽게
  // "다음주에", "금요일에", "3시에"의 "에"도 떼기
  let s = ` ${text.trim().replace(/~/g, " ~ ").replace(/(부터|까지)(?=\s|$)/g, " $1")
    .replace(/(오늘|내일|모레|글피|요일|주|주말|달|\d일|\d시|\d분|반|\d[/.]\d{1,2})에(?=\s|$)/g, "$1")} `;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dates: { at: number; d: Date }[] = [];
  const times: { at: number; t: string; ampm: boolean }[] = [];
  // 같은 모양이 두 번 나올 수 있으니 (12/1~12/5) 찾을 때마다 지우고 다시
  const takeAll = (re: RegExp, f: (m: RegExpMatchArray) => Date | null) => {
    for (let m = s.match(re); m && dates.length < 2; m = s.match(re)) {
      const d = f(m);
      if (!d) break;
      dates.push({ at: m.index ?? 0, d });
      s = s.slice(0, m.index) + " ".repeat(m[0].length) + s.slice((m.index ?? 0) + m[0].length);
    }
  };
  takeAll(/\s(\d{4})-(\d{1,2})-(\d{1,2})(?=\s)/, m => new Date(+m[1], +m[2] - 1, +m[3]));
  takeAll(/\s(\d{1,2})월\s?(\d{1,2})일(?=\s)/, m => monthDay(today, +m[1], +m[2]));
  takeAll(/\s(\d{1,2})[/.](\d{1,2})(?=\s)/, m => monthDay(today, +m[1], +m[2]));
  takeAll(/\s(오늘|내일|모레|글피)(?=\s)/, m => addDays(today, ["오늘", "내일", "모레", "글피"].indexOf(m[1])));
  takeAll(/\s(?:(이번\s?주|다음\s?주)\s?)?([일월화수목금토])요일(?=\s)/, m => weekday(today, DAYS.indexOf(m[2]), m[1]));
  takeAll(/\s(이번\s?주|다음\s?주)\s?([일월화수목금토])(?=\s)/, m => weekday(today, DAYS.indexOf(m[2]), m[1]));
  takeAll(/\s다음\s?주(?=\s)/, () => weekday(today, 1, "다음주")); // 다음 주 월요일
  takeAll(/\s주말(?=\s)/, () => weekday(today, 6, "이번주").getTime() >= today.getTime() ? weekday(today, 6, "이번주") : weekday(today, 6, "다음주"));
  takeAll(/\s다음\s?달(?=\s)/, () => new Date(today.getFullYear(), today.getMonth() + 1, 1));
  takeAll(/\s(\d{1,2})일(?=\s)/, m => {
    const d = new Date(today.getFullYear(), today.getMonth(), +m[1]);
    return d < today ? new Date(today.getFullYear(), today.getMonth() + 1, +m[1]) : d;
  });
  const takeTime = (re: RegExp, f: (m: RegExpMatchArray) => { t: string; ampm: boolean }) => {
    for (let m = s.match(re); m && times.length < 2; m = s.match(re)) {
      times.push({ at: m.index ?? 0, ...f(m) });
      s = s.slice(0, m.index) + " ".repeat(m[0].length) + s.slice((m.index ?? 0) + m[0].length);
    }
  };
  takeTime(/\s(\d{1,2}):(\d{2})(?=\s)/, m => ({ t: `${pad(+m[1])}:${m[2]}`, ampm: true }));
  takeTime(/\s(오전|오후)?\s?(\d{1,2})시(?:\s?(\d{1,2})분|\s?(반))?(?=\s)/, m => {
    let h = +m[2];
    if (m[1] === "오후" && h < 12) h += 12;
    if (m[1] === "오전" && h === 12) h = 0;
    if (!m[1] && h >= 1 && h <= 7) h += 12; // "3시 미팅"은 보통 오후
    return { t: `${pad(h)}:${m[4] ? "30" : pad(+(m[3] ?? 0))}`, ampm: !!m[1] };
  });
  dates.sort((a, b) => a.at - b.at);
  times.sort((a, b) => a.at - b.at);
  const range = /\s(~|부터)\s/.test(s) || dates.length === 2 || times.length === 2;
  const start = dates[0]?.d ?? today;
  let endDate = dates.length === 2 ? dates[1].d : null;
  if (endDate && endDate < start) endDate = new Date(endDate.getFullYear() + 1, endDate.getMonth(), endDate.getDate());
  const t0 = times[0]?.t ?? null;
  let t1 = times[1] ? times[1].t : null;
  // "오후 2시~4시": 끝 시각에 오전·오후가 없고 시작보다 이르면 오후로
  if (t0 && t1 && !times[1].ampm && t1 < t0 && +t1.slice(0, 2) < 12) t1 = `${pad(+t1.slice(0, 2) + 12)}${t1.slice(2)}`;
  const end = range && (endDate || t1) ? { date: ymd(endDate ?? start), time: t1 } : null;
  const title = s.replace(/\s(~|부터|까지)(?=\s)/g, " ").replace(/\s+/g, " ").trim();
  return { title, date: ymd(start), time: t0, end };
}

// 날짜가 이미 지났으면 내년
function monthDay(today: Date, m: number, d: number) {
  const x = new Date(today.getFullYear(), m - 1, d);
  return x < today ? new Date(today.getFullYear() + 1, m - 1, d) : x;
}
// 이번 주(월~일) 또는 다음 주의 그 요일. 주 지정이 없으면 오늘 이후 가장 가까운 그 요일
function weekday(today: Date, wd: number, which?: string) {
  if (!which) return addDays(today, ((wd - today.getDay() + 7) % 7) || 7);
  const monday = addDays(today, -((today.getDay() + 6) % 7));
  return addDays(monday, (wd + 6) % 7 + (which.startsWith("다음") ? 7 : 0));
}

// 노션에 넣을 시작 값: 시간이 있으면 내 시간대를 붙인 시각, 없으면 하루 종일
export function notionStart(date: string, time: string | null, offsetMin: number): string {
  if (!time) return date;
  const o = -offsetMin; // getTimezoneOffset()은 UTC 기준 반대 부호
  return `${date}T${time}:00${o >= 0 ? "+" : "-"}${pad(Math.floor(Math.abs(o) / 60))}:${pad(Math.abs(o) % 60)}`;
}

export const dayLabel = (s: string) => { const d = fromYmd(s); return `${d.getMonth() + 1}월 ${d.getDate()}일 (${DAYS[d.getDay()]})`; };

// 목록에서 보일 날짜(진행 중인 여러 날 일정은 오늘), 지난 미완료 할 일은 "밀린 할 일"
export function sectionOf(e: CalEvent, today: string): string {
  const s = e.start.slice(0, 10);
  const end = (e.end ?? e.start).slice(0, 10);
  if (s < today && end < today) return "밀린 할 일";
  const d = s < today ? today : s;
  const pre = d === today ? "오늘 · " : d === shiftYmd(today, 1) ? "내일 · " : "";
  return pre + dayLabel(d);
}

// 화면에 보일 일정: 지난 것은 완료 안 한 할 일만, 밀린 할 일이 맨 위
export function visibleEvents(list: CalEvent[], today: string): CalEvent[] {
  const past = (e: CalEvent) => (e.end ?? e.start).slice(0, 10) < today;
  return [...list.filter(e => past(e) && e.done === false), ...list.filter(e => !past(e))];
}

export const timeOf = (e: CalEvent) => e.start.length > 10 ? e.start.slice(11, 16) : "하루 종일";

// 월 달력 칸: 그 달을 덮는 일요일 시작 주 단위 날짜들 (5~6주)
export function monthCells(month: string): string[] {
  const first = fromYmd(month.slice(0, 7) + "-01");
  const start = addDays(first, -first.getDay());
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
  const weeks = Math.ceil((first.getDay() + last.getDate()) / 7);
  return Array.from({ length: weeks * 7 }, (_, i) => ymd(addDays(start, i)));
}
export const shiftMonth = (month: string, n: number) => { const d = fromYmd(month.slice(0, 7) + "-01"); return ymd(new Date(d.getFullYear(), d.getMonth() + n, 1)); };
// 그 날에 걸친 일정 (여러 날 일정 포함), 시간 순
export const eventsOn = (list: CalEvent[], day: string) =>
  list.filter(e => e.start.slice(0, 10) <= day && (e.end ?? e.start).slice(0, 10) >= day);

// 바탕화면에서 고른 날에 추가: 글에 날짜·시간 말이 없으면 그 날로 ("장보기" → 고른 날, "내일 장보기" → 내일)
export function todoOn(text: string, day: string, now: Date): Todo {
  const t = parseTodo(text, now);
  return t.title === text.trim().replace(/\s+/g, " ") ? { ...t, date: day } : t;
}

// 바탕화면 오늘 카드: 그날 할 일 (오늘이면 밀린 할 일 포함). 안 한 것 먼저, 시작 순
export function dayList(list: CalEvent[], day: string, today: string): CalEvent[] {
  const late = day === today ? list.filter(e => (e.end ?? e.start).slice(0, 10) < today && e.done === false) : [];
  const all = [...late, ...eventsOn(list, day).filter(e => !late.includes(e))];
  return all.sort((a, b) => Number(!!a.done) - Number(!!b.done) || a.start.localeCompare(b.start));
}

// 노션에 넣을 기간: 끝이 있으면 end. 시작·끝 중 한쪽만 시간이 있으면 맞춤 (노션은 둘 다 날짜 또는 둘 다 시각)
export function notionRange(t: Todo, offsetMin: number): { start: string; end: string | null } {
  const endTime = t.end ? (t.time ? t.end.time ?? t.time : null) : null;
  return {
    start: notionStart(t.date, t.time, offsetMin),
    end: t.end ? notionStart(t.end.date, endTime, offsetMin) : null,
  };
}

// 미리보기 글: "11월 28일 (토) 14:00 ~ 16:00", "12월 1일 (화) ~ 12월 5일 (토)"
export function whenLabel(t: Todo): string {
  const a = `${dayLabel(t.date)}${t.time ? ` ${t.time}` : ""}`;
  if (!t.end) return a;
  const sameDay = t.end.date === t.date;
  const et = t.time ? t.end.time ?? t.time : null; // 노션에 넣을 때와 같은 규칙 (notionRange)
  return `${a} ~ ${sameDay ? "" : dayLabel(t.end.date)}${et ? `${sameDay ? "" : " "}${et}` : ""}`.trim();
}

// 입력칸 아래 버튼: 고른 값이 글에서 읽은 값보다 먼저 (time·end는 null로 "없음"을 고를 수 있음)
export type Pick = { date?: string; time?: string | null; end?: { date: string; time: string | null } | null };
export function applyPick(t: Todo, p: Pick): Todo {
  const date = p.date ?? t.date;
  const time = p.time !== undefined ? p.time : t.time;
  let end = p.end !== undefined ? p.end : t.end;
  if (end && end.date < date) end = null; // 시작보다 이른 끝은 버림
  return { ...t, date, time, end };
}

// 날짜 버튼: 오늘·내일·모레·이번 주말·다음 주 월
export function quickStarts(now: Date): { label: string; date: string }[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const sat = weekday(today, 6, "이번주");
  return [
    { label: "오늘", date: ymd(today) }, { label: "내일", date: ymd(addDays(today, 1)) }, { label: "모레", date: ymd(addDays(today, 2)) },
    { label: "주말", date: ymd(sat >= today ? sat : weekday(today, 6, "다음주")) }, { label: "다음 주 월", date: ymd(weekday(today, 1, "다음주")) },
  ];
}
// 언제까지 버튼: 시작 기준 +1일·+3일·그 주 금·다음 주 금
export function quickEnds(start: string): { label: string; date: string }[] {
  const d = fromYmd(start);
  const fri = weekday(d, 5, "이번주");
  return [
    { label: "+1일", date: ymd(addDays(d, 1)) }, { label: "+3일", date: ymd(addDays(d, 3)) },
    ...(fri > d ? [{ label: "그 주 금", date: ymd(fri) }] : []), { label: "다음 주 금", date: ymd(weekday(d, 5, "다음주")) },
  ];
}
export const QUICK_TIMES = ["09:00", "12:00", "15:00", "18:00", "21:00"];

// 달력 한 주(7칸)에 일정을 막대로: 여러 날 일정은 이어진 막대 하나, 겹치면 아래 줄로
// s·e = 이 주 안에서 시작·끝 칸(0~6), cut = 앞/뒤 주로 이어지는지, hidden = 줄이 모자라 못 보인 날별 개수
export type Bar = { ev: CalEvent; s: number; e: number; lane: number; cutStart: boolean; cutEnd: boolean };
export function weekBars(list: CalEvent[], week: string[], maxLanes: number): { bars: Bar[]; hidden: number[] } {
  const first = week[0], last = week[6];
  const span = (ev: CalEvent) => ({ a: ev.start.slice(0, 10), b: (ev.end ?? ev.start).slice(0, 10) });
  const inWeek = list.filter(ev => { const { a, b } = span(ev); return a <= last && b >= first; })
    .map(ev => {
      const { a, b } = span(ev);
      const s = a < first ? 0 : week.indexOf(a), e = b > last ? 6 : week.indexOf(b);
      return { ev, s, e, cutStart: a < first, cutEnd: b > last };
    })
    .sort((x, y) => x.s - y.s || (y.e - y.s) - (x.e - x.s) || x.ev.start.localeCompare(y.ev.start));
  const lanes: number[][] = []; // 줄마다 차지한 칸
  const bars: Bar[] = [];
  const hidden = Array(7).fill(0);
  for (const b of inWeek) {
    let lane = lanes.findIndex(used => used.every(c => c < b.s || c > b.e));
    if (lane < 0) lane = lanes.length;
    if (lane >= maxLanes) { for (let c = b.s; c <= b.e; c++) hidden[c]++; continue; }
    (lanes[lane] ??= []).push(...Array.from({ length: b.e - b.s + 1 }, (_, i) => b.s + i));
    bars.push({ ...b, lane });
  }
  return { bars, hidden };
}
