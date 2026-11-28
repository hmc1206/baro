// 캘린더·할 일 화면: 노션 계정 여러 개의 일정 DB를 합쳐 날짜별로, 입력하면 할 일 추가
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import type { Item } from "../commands";
import { type CalDb, type CalEvent, type Pick, type Todo, applyPick, isTimetree, dayLabel, monthCells, notionRange, paint, parseTodo, sectionOf, shiftMonth, shiftYmd, timeOf, visibleEvents, whenLabel, ymd } from "./calendar";

export type Cal = { events: CalEvent[]; dbs: CalDb[]; errors: string[]; loading: boolean; error: string | null; msg: string | null };
const EMPTY: Cal = { events: [], dbs: [], errors: [], loading: false, error: null, msg: null };
const BACK = 30, AHEAD = 60; // 지난 30일(밀린 할 일) ~ 앞으로 60일

export const NO_ACCOUNT = "노션·TimeTree 계정이 아직 없어요. 'Baro 설정 열기'에서 notion_accounts(이름·토큰·색) 또는 timetree_accounts(이름·이메일·비밀번호·색)를 넣어 주세요.\n" +
  "노션 토큰: notion.so/my-integrations에서 내부 통합 만들기 → 일정 DB의 ⋯ › 연결에서 그 통합 추가. TimeTree는 읽기 전용, 하루 한 번 새로 받아요.";

export function useCalendar({ q, setQ }: { q: string; setQ: (q: string) => void }) {
  const [cal, setCal] = useState<Cal>(EMPTY);
  // 달력에 보이는 달 (그 달 1일). 목록 범위(지난 30일~앞으로 60일)와 합쳐서 불러옴
  const [month, setMonthState] = useState(() => ymd(new Date()).slice(0, 8) + "01");
  const monthRef = useRef(month);
  const [redate, setRedate] = useState<CalEvent | null>(null); // 수정 중인 일정 (입력칸 = 제목, 아래 버튼 = 날짜)
  const [removed, setRemoved] = useState<CalEvent | null>(null); // 방금 휴지통으로 보낸 일정 (되살리기)
  const seq = useRef(0); // 달을 빨리 넘기면 늦게 온 이전 응답은 버림
  // 입력칸 아래 날짜 버튼으로 고른 값 (글에서 읽은 값보다 먼저), 달력 칸을 누르면 시작/끝 중 어디에 넣을지
  const [pick, setPickState] = useState<Pick>({});
  const [target, setTarget] = useState<"start" | "end">("start");
  const [base, setBase] = useState<Todo | null>(null); // 수정: 원래 제목·날짜
  const resetPick = () => { setPickState({}); setTarget("start"); };
  const setPick = (p: Pick) => setPickState(o => ({ ...o, ...p }));
  useEffect(() => { if (!q.trim() && !redate) resetPick(); }, [q, redate]);

  // 지금 만들거나 바꾸는 할 일의 날짜 (입력 글 + 고른 버튼)
  const t0 = q.trim();
  const parsed = parseTodo(t0, new Date());
  // 수정 중에는 입력칸 글을 그대로 제목으로 (제목 속 "다음주" 같은 말을 날짜로 읽지 않게), 날짜는 버튼·달력으로
  const draft: Todo | null = redate && base ? applyPick({ ...base, title: t0 || base.title }, pick)
    : t0 ? applyPick(parsed, pick) : null;
  const pickDay = (day: string) => {
    if (!draft) return;
    if (target === "end") setPick({ end: { date: day, time: draft.end?.time ?? null } });
    else setPick({ date: day });
  };
  const startRedate = (e: CalEvent) => {
    const t = (x: string | null) => x && x.length > 10 ? x.slice(11, 16) : null;
    setBase({ title: e.title, date: e.start.slice(0, 10), time: t(e.start), end: e.end ? { date: e.end.slice(0, 10), time: t(e.end) } : null });
    resetPick(); setRedate(e); setQ(e.title);
  };
  const trash = async (e: CalEvent, restore = false) => {
    await invoke("notion_trash", { account: e.account, page: e.id, restore });
    setRemoved(restore ? null : e);
    await load(true, restore ? `↩ 되살림: ${e.title}` : `🗑 휴지통으로: ${e.title} · 맨 위에서 되살리기`);
  };

  const load = (fresh = false, msg: string | null = null) => {
    setCal(c => ({ ...c, loading: true, error: null, msg }));
    const my = ++seq.current;
    const today = ymd(new Date());
    const cells = monthCells(monthRef.current);
    const start = [shiftYmd(today, -BACK), cells[0]].sort()[0];
    const end = [shiftYmd(today, AHEAD), cells[cells.length - 1]].sort()[1];
    return invoke<{ events: CalEvent[]; dbs: CalDb[]; errors: string[] }>("notion_events", { start, end, fresh })
      .then(d => {
        if (fresh) emit("cal-changed").catch(() => {}); // 추가·수정·삭제 뒤: 바탕화면도 새로고침 (노션 캐시를 비운 뒤라 새 값)
        if (my === seq.current) setCal({ ...d, events: paint(d.events), loading: false, error: null, msg });
      })
      .catch(e => my === seq.current && setCal({ ...EMPTY, error: String(e) === "NO_ACCOUNT" ? NO_ACCOUNT : String(e) }));
  };

  // ⌘R: 노션만 새로. TimeTree는 하루 한 번 자동 (막히지 않게)
  const refresh = () => load(true);
  // TimeTree 일정에서만: 지금 다시 받기 (1시간에 한 번까지, 결과는 맨 위 안내)
  const refreshTimetree = async () => {
    const m = await invoke<string>("timetree_refresh").catch(e => String(e));
    await load(false, m);
  };

  const calItems = (): Item[] => {
    if (cal.error) return [{ id: "cal-config", title: "Baro 설정 열기", subtitle: "config.json의 notion_accounts에 계정 추가 · 저장 후 다시 열기", kind: "cmd", glyph: "settings",
      actions: [{ title: "열기", run: () => invoke("open_config") }, { title: "다시 불러오기", shortcut: "⌘R", keep: true, run: refresh }] }];
    const today = ymd(new Date());
    // 이번 달을 보면 밀린 할 일 + 앞으로 일정, 다른 달을 보면 그 달 일정 전부
    const now = month.slice(0, 7) === today.slice(0, 7);
    const shown = now ? visibleEvents(cal.events, today)
      : cal.events.filter(e => e.start.slice(0, 7) === month.slice(0, 7));
    const rows: Item[] = shown.map(e => {
      const db = cal.dbs.find(d => d.id === e.db_id);
      const toggle = e.done !== null && db?.done_prop
        ? [{ title: e.done ? "완료 취소" : "완료", keep: true, run: async () => {
            await invoke("notion_done", { account: e.account, page: e.id, prop: db.done_prop, done: !e.done });
            await load(true, e.done ? `완료 취소: ${e.title}` : `✓ 완료: ${e.title}`);
          } }] : [];
      const end = e.end && e.end.slice(0, 10) !== e.start.slice(0, 10) ? `~ ${dayLabel(e.end.slice(0, 10))}` : "";
      const tt = isTimetree(e); // 읽기 전용: 열기·새로고침만
      return {
        id: `cal-${e.id}`, title: e.title, kind: "cmd", glyph: e.done === null ? "daily" : e.done ? "done" : "todo", color: e.color || undefined,
        section: now ? sectionOf(e, today) : dayLabel(e.start.slice(0, 10)),
        subtitle: [now && e.start.slice(0, 10) < today && sectionOf(e, today) === "밀린 할 일" ? dayLabel(e.start.slice(0, 10)) : timeOf(e), end, e.account, e.db].filter(Boolean).join(" · "),
        actions: tt ? [
          { title: "TimeTree에서 열기", shortcut: "⌘O", run: () => invoke("open_url", { url: e.url }) },
          { title: "새로고침 (노션만)", shortcut: "⌘R", keep: true, run: refresh },
          { title: "TimeTree 지금 다시 받기 (1시간에 한 번)", keep: true, run: refreshTimetree },
        ] : [...toggle,
          ...(db ? [{ title: "수정 (제목·날짜)", shortcut: "⌘E", keep: true, run: async () => startRedate(e) }] : []),
          { title: "노션 앱에서 열기", shortcut: "⌘O", run: () => invoke("open_url", { url: e.url.replace(/^https:\/\//, "notion://") }) },
          { title: "브라우저에서 열기", run: () => invoke("open_url", { url: e.url }) },
          { title: "새로고침", shortcut: "⌘R", keep: true, run: refresh },
          { title: "삭제 (노션 휴지통)", shortcut: "⌘D", keep: true, confirm: `'${e.title}'을(를) 노션 휴지통으로 보낼까요? 노션 휴지통에서 되살릴 수 있어요. Enter를 한 번 더 누르세요.`,
            run: () => trash(e) }],
      } as Item;
    });
    const t = q.trim();
    // 수정 중: 입력칸 = 제목, 아래 버튼 = 날짜. Enter로 노션에 저장
    if (redate && draft) {
      const p = draft;
      return [{
        id: "cal-redate", title: `수정: ${p.title}`, kind: "cmd", glyph: "daily", section: "할 일 수정",
        subtitle: `${whenLabel(p)} · ${redate.account} · ${redate.db} · Enter 저장 · Esc 취소`,
        actions: [{ title: "수정 저장", keep: true, run: async () => {
          const { start, end } = notionRange(p, new Date().getTimezoneOffset());
          await invoke("notion_edit", { account: redate.account, page: redate.id, dbId: redate.db_id, title: p.title, start, end });
          setRedate(null); setQ(""); resetPick();
          await load(true, `✓ 수정: ${p.title} (${whenLabel(p)})`);
        } },
        { title: "삭제 (노션 휴지통)", shortcut: "⌘D", keep: true, confirm: `'${redate.title}'을(를) 노션 휴지통으로 보낼까요? Enter를 한 번 더 누르세요.`,
          run: async () => { const e = redate; setRedate(null); setQ(""); resetPick(); await trash(e); } }],
      }];
    }
    // 방금 지운 일정 되살리기 (맨 위)
    const undo: Item[] = removed && !t ? [{ id: "cal-undo", title: `되살리기: ${removed.title}`, kind: "cmd", glyph: "trash", section: "방금 지운 일정",
      subtitle: `${removed.account} · ${removed.db} · Enter로 노션 휴지통에서 꺼내기`,
      actions: [{ title: "되살리기", keep: true, run: () => trash(removed, true) }, { title: "목록에서 숨기기", keep: true, run: async () => setRemoved(null) }] }] : [];
    if (!t) return [...undo, ...rows];
    // 입력 중: 맨 위에 "할 일 추가" (Enter = 첫 DB, ⌘K로 다른 계정·DB)
    const p = draft ?? parsed;
    const targets = [...cal.dbs].sort((a, b) => Number(!!b.done_prop) - Number(!!a.done_prop));
    const when = whenLabel(p);
    const add: Item = {
      id: "cal-add", title: `할 일 추가: ${p.title || "(제목을 입력하세요)"}`, kind: "cmd", glyph: "plus", section: "새 할 일",
      subtitle: targets.length ? `${when} · ${targets[0].account} · ${targets[0].name} · ⌘K 다른 DB` : cal.loading ? "노션 DB 불러오는 중…" : "일정 DB가 없어요 (통합을 DB에 연결해 주세요)",
      actions: p.title ? targets.map(d => ({ title: `${d.account} · ${d.name}에 추가`, keep: true, run: async () => {
        await invoke("notion_create", { dbId: d.id, title: p.title, ...notionRange(p, new Date().getTimezoneOffset()) });
        setQ(""); resetPick();
        await load(true, `✓ 추가: ${p.title} (${when} · ${d.account})`);
      } })) : [{ title: "제목 입력", keep: true, run: async () => {} }],
    };
    const words = t.toLowerCase().split(/\s+/);
    return [add, ...rows.filter(r => words.some(w => r.title.toLowerCase().includes(w)))];
  };

  // n달 앞뒤로 (0이면 이번 달)
  const moveMonth = (n: number) => {
    const m = n === 0 ? ymd(new Date()).slice(0, 8) + "01" : shiftMonth(monthRef.current, n);
    monthRef.current = m; setMonthState(m); load();
  };

  return { cal, redate, cancelRedate: () => { setRedate(null); setQ(""); resetPick(); }, draft, pick, setPick, target, setTarget, pickDay, month, moveMonth, loadCal: load, calItems, resetCal: () => setCal(EMPTY) };
}
