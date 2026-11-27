import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTodo, notionStart, sectionOf, visibleEvents, monthCells, shiftMonth, eventsOn, notionRange, whenLabel, applyPick, quickStarts, quickEnds, weekBars, type CalEvent } from "../src/app/calendar.ts";

const now = new Date(2026, 10, 27, 10, 0); // 2026-11-27 금요일

test("defaults to today", () => assert.deepEqual(parseTodo("장보기", now), { title: "장보기", date: "2026-11-27", time: null, end: null }));
test("reads relative days and time", () => {
  assert.deepEqual(parseTodo("내일 오후 3시 치과", now), { title: "치과", date: "2026-11-28", time: "15:00", end: null });
  assert.deepEqual(parseTodo("모레 9:30 회의", now), { title: "회의", date: "2026-11-29", time: "09:30", end: null });
  assert.deepEqual(parseTodo("오전 10시 반 운동 오늘", now), { title: "운동", date: "2026-11-27", time: "10:30", end: null });
});
test("reads month/day and rolls to next year when past", () => {
  assert.equal(parseTodo("12월 5일 보고서", now).date, "2026-12-05");
  assert.equal(parseTodo("12/5 보고서", now).date, "2026-12-05");
  assert.equal(parseTodo("3/1 여행", now).date, "2027-03-01");
  assert.deepEqual(parseTodo("2026-12-31 마감", now), { title: "마감", date: "2026-12-31", time: null, end: null });
});
test("reads weekdays", () => {
  assert.equal(parseTodo("월요일 제출", now).date, "2026-11-30");
  assert.equal(parseTodo("금요일 제출", now).date, "2026-12-04");
  assert.equal(parseTodo("다음주 수 제출", now).date, "2026-12-02");
  assert.equal(parseTodo("이번주 토요일 청소", now).date, "2026-11-28");
});
test("reads until-when ranges", () => {
  assert.deepEqual(parseTodo("12/1~12/5 워크숍", now), { title: "워크숍", date: "2026-12-01", time: null, end: { date: "2026-12-05", time: null } });
  assert.deepEqual(parseTodo("내일부터 금요일까지 출장", now), { title: "출장", date: "2026-11-28", time: null, end: { date: "2026-12-04", time: null } });
  assert.deepEqual(parseTodo("내일 오후 2시~4시 회의", now), { title: "회의", date: "2026-11-28", time: "14:00", end: { date: "2026-11-28", time: "16:00" } });
  assert.deepEqual(parseTodo("12/30 ~ 1/2 여행", now).end, { date: "2027-01-02", time: null });
});
test("a single date with 까지 is the due date", () => {
  assert.deepEqual(parseTodo("금요일까지 보고서", now), { title: "보고서", date: "2026-12-04", time: null, end: null });
  assert.deepEqual(parseTodo("보고서 12/5 오후 6시까지", now), { title: "보고서", date: "2026-12-05", time: "18:00", end: null });
});
test("reads 다음주, 주말, 다음달 and drops 에", () => {
  assert.deepEqual(parseTodo("다음주에 공부하기", now), { title: "공부하기", date: "2026-11-30", time: null, end: null });
  assert.deepEqual(parseTodo("금요일에 3시에 미팅", now), { title: "미팅", date: "2026-12-04", time: "15:00", end: null });
  assert.equal(parseTodo("주말 청소", now).date, "2026-11-28");
  assert.equal(parseTodo("다음달 계획", now).date, "2026-12-01");
  assert.equal(parseTodo("일에 집중", now).title, "일에 집중");
});
test("keeps words that only contain day names", () => assert.equal(parseTodo("월세 내기", now).title, "월세 내기"));

test("adds local offset only with time", () => {
  assert.equal(notionStart("2026-11-28", null, -540), "2026-11-28");
  assert.equal(notionStart("2026-11-28", "15:00", -540), "2026-11-28T15:00:00+09:00");
});

const ev = (start: string, done: boolean | null, end: string | null = null): CalEvent =>
  ({ id: start, title: "x", start, end, done, url: "", account: "a", color: "", db: "d", db_id: "d" });

test("labels days", () => {
  assert.equal(sectionOf(ev("2026-11-27T09:00:00.000+09:00", null), "2026-11-27"), "오늘 · 11월 27일 (금)");
  assert.equal(sectionOf(ev("2026-11-28", null), "2026-11-27"), "내일 · 11월 28일 (토)");
  assert.equal(sectionOf(ev("2026-11-20", false), "2026-11-27"), "밀린 할 일");
  assert.equal(sectionOf(ev("2026-11-25", null, "2026-11-29"), "2026-11-27"), "오늘 · 11월 27일 (금)");
});
test("hides past events except undone todos", () => {
  const list = [ev("2026-11-20", true), ev("2026-11-21", false), ev("2026-11-22", null), ev("2026-11-28", null)];
  assert.deepEqual(visibleEvents(list, "2026-11-27").map(e => e.start), ["2026-11-21", "2026-11-28"]);
});

test("month cells start on Sunday and cover the month", () => {
  const c = monthCells("2026-11-01");
  assert.equal(c.length, 35);
  assert.deepEqual([c[0], c[34]], ["2026-11-01", "2026-12-05"]);
  const feb = monthCells("2026-02-01"); // 2월 1일이 일요일, 28일 → 4주
  assert.equal(feb.length, 28);
  assert.equal(shiftMonth("2026-12-01", 1), "2027-01-01");
  assert.equal(shiftMonth("2026-01-01", -1), "2025-12-01");
});

test("events on a day include multi-day spans", () => {
  const list = [ev("2026-11-25", null, "2026-11-29"), ev("2026-11-27T09:00:00.000+09:00", false), ev("2026-11-28", null)];
  assert.equal(eventsOn(list, "2026-11-27").length, 2);
  assert.equal(eventsOn(list, "2026-11-30").length, 0);
});

test("notion range keeps start and end the same kind", () => {
  const off = -540;
  assert.deepEqual(notionRange(parseTodo("내일 오후 2시~4시 회의", now), off), { start: "2026-11-28T14:00:00+09:00", end: "2026-11-28T16:00:00+09:00" });
  assert.deepEqual(notionRange(parseTodo("12/1~12/5 워크숍", now), off), { start: "2026-12-01", end: "2026-12-05" });
  assert.deepEqual(notionRange(parseTodo("내일 오후 3시부터 금요일까지 출장", now), off), { start: "2026-11-28T15:00:00+09:00", end: "2026-12-04T15:00:00+09:00" });
  assert.deepEqual(notionRange(parseTodo("보고서", now), off), { start: "2026-11-27", end: null });
});

test("when label", () => {
  assert.equal(whenLabel(parseTodo("12/1~12/5 워크숍", now)), "12월 1일 (화) ~ 12월 5일 (토)");
  assert.equal(whenLabel(parseTodo("내일 오후 2시~4시 회의", now)), "11월 28일 (토) 14:00 ~ 16:00");
  assert.equal(whenLabel(parseTodo("금요일까지 보고서", now)), "12월 4일 (금)");
});

test("picks override parsed values", () => {
  const t = parseTodo("내일 오후 3시 치과", now);
  assert.deepEqual(applyPick(t, { date: "2026-12-01" }), { ...t, date: "2026-12-01" });
  assert.equal(applyPick(t, { time: null }).time, null);
  assert.equal(applyPick(t, { end: { date: "2026-11-20", time: null } }).end, null); // 시작보다 이르면 버림
});

test("quick date buttons", () => {
  assert.deepEqual(quickStarts(now).map(q => q.date), ["2026-11-27", "2026-11-28", "2026-11-29", "2026-11-28", "2026-11-30"]);
  assert.deepEqual(quickEnds("2026-11-27").map(q => q.label), ["+1일", "+3일", "다음 주 금"]); // 금요일이면 '그 주 금' 없음
  assert.deepEqual(quickEnds("2026-11-30").map(q => q.date), ["2026-12-01", "2026-12-03", "2026-12-04", "2026-12-11"]);
});

test("multi-day events become one bar per week", () => {
  const week = monthCells("2026-11-01").slice(21, 28); // 11/22(일) ~ 11/28(토)
  const list = [ev("2026-11-27", false, "2026-11-28"), ev("2026-11-27T09:00:00.000+09:00", null), ev("2026-11-20", null, "2026-11-23"), ev("2026-11-28", null, "2026-12-02")];
  const { bars, hidden } = weekBars(list, week, 3);
  const pick = (start: string) => bars.find(b => b.ev.start === start)!;
  assert.deepEqual([pick("2026-11-20").s, pick("2026-11-20").e, pick("2026-11-20").cutStart], [0, 1, true]);
  assert.deepEqual([pick("2026-11-27").s, pick("2026-11-27").e, pick("2026-11-27").lane], [5, 6, 0]);
  assert.equal(pick("2026-11-27T09:00:00.000+09:00").lane, 1); // 같은 날 겹치면 아래 줄
  assert.deepEqual([pick("2026-11-28").s, pick("2026-11-28").e, pick("2026-11-28").cutEnd, pick("2026-11-28").lane], [6, 6, true, 1]);
  assert.deepEqual(hidden, [0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(weekBars(list, week, 1).hidden, [0, 0, 0, 0, 0, 1, 1]);
});
