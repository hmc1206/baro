// 키 입력은 창 전체에서 받음: 마우스로 클릭해 입력창 포커스가 빠져도 Esc·Enter·방향키가 동작
// 화면별 함수가 차례로 받아 보고, 처리했으면 true를 돌려 다음 함수로 넘기지 않음 (순서가 곧 우선순위)
// 화면 하나만 아는 키(AI·노트·편집 폼 등)는 그 화면의 훅이 만든 함수를 받아 쓰고, 여기엔 모든 화면에 걸친 키만 둠
// App.tsx에서 동작 그대로 옮김
import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { saveTodo, Item, Action, View, Ui } from "../commands";
import type { Ai, Mode } from "./types";
import type { InputRef, Setter } from "./ctx";

export type Pending = { key: string; confirm: string } | null;
type KeyFn = (e: KeyboardEvent) => boolean;

export type KeyCtx = {
  mode: Mode; q: string; setQ: Setter<string>; hint: string; setHint: Setter<string>;
  sel: number; setSel: Setter<number>; menu: boolean; setMenu: Setter<boolean>; asel: number; setAsel: Setter<number>;
  pending: Pending; setPending: Setter<Pending>; view: View | null; setView: Setter<View | null>; ai: Ai | null;
  items: Item[]; cur: Item | undefined; input: InputRef; ui: Ui;
  pick: unknown; setPick: Setter<any>; fileOpen: string | null; setFileOpen: Setter<string | null>; redate: unknown; cancelRedate: () => void;
  moveMonth: (d: number) => void; togglePin: () => void; askNotes: (q: string) => void;
  run: (a?: Action, it?: Item) => void; back: () => void; fail: (e: unknown) => void;
  // 빠른 메모 화면
  memo: { removed: unknown; undoRemove: () => void; delPending: unknown; setDelPending: (v: null) => void; editing: unknown; cancelEdit: () => void;
    picking: unknown; cancelPick: () => void; upDir: () => boolean; toggleShot: () => void };
  // 화면 하나만 아는 키 처리 (입력 폼은 다른 키 처리보다 먼저, 나머지는 공통 키 뒤에)
  formKeys: KeyFn[]; keyAi: KeyFn; keyNotes: KeyFn;
};

export function useLauncherKeys(c: KeyCtx) {
  const { mode, q, setQ, hint, setHint, setSel, menu, setMenu, setAsel, asel, pending, setPending, view, setView, ai, items, cur, input, pick, setPick } = c;

  // 어느 화면에서나: ⌘P 창 고정, ⌘K 액션 패널, 한글 조합 중 키 무시
  const keyGlobal = (e: KeyboardEvent): boolean => {
    // ⌘K: 한글 자판에선 e.key가 "ㅏ"라서 물리 키(e.code)로 판별
    // ⌘P: 창 고정·해제
    if (e.metaKey && e.code === "KeyP") { e.preventDefault(); c.togglePin(); return true; }
    if ((e.metaKey || e.ctrlKey) && e.code === "KeyK") {
      e.preventDefault();
      if (ai || view) return true;
      if (cur) { setMenu(m => !m); setAsel(0); }
      return true;
    }
    // 한글 조합 중 키 입력은 무시 (WebKit은 isComposing 대신 keyCode 229를 줌)
    return e.isComposing || e.keyCode === 229;
  };

  // 결과·권한 화면: Enter는 (권한이면) 설정 열기 / 결과 복사, Esc는 돌아가기
  const keyView = (e: KeyboardEvent): boolean => {
    if (!view) return false;
    if (e.key === "Escape") { setView(null); input.current?.select(); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if (view.kind === "perm" && view.perm !== "ok") invoke("open_settings", { kind: view.perm });
      else if (view.kind === "text") navigator.clipboard.writeText(view.text);
    }
    return true;
  };

  // 빠른 메모: ⌘Z 되돌리기, Esc 취소, ⌘I 사진, ⇧Enter 줄바꿈, Tab 저장할 곳, 여러 줄일 때 ↑↓는 커서 이동
  const keyMemo = (e: KeyboardEvent): boolean => {
    const m = c.memo;
    if (mode !== "memo" || view || menu) return false;
    if (e.metaKey && e.code === "KeyZ" && !q && m.removed) { e.preventDefault(); m.undoRemove(); return true; }
    if (e.key === "Escape" && m.delPending) { e.preventDefault(); m.setDelPending(null); return true; }
    if (e.key === "Escape" && m.editing) { e.preventDefault(); m.cancelEdit(); return true; }
    if (e.key === "Escape" && m.picking) { e.preventDefault(); m.cancelPick(); return true; }
    if (e.key === "Backspace" && m.picking && !q && m.upDir()) { e.preventDefault(); return true; } // 노트 고르기: 빈 입력에서 ⌫ = 상위 폴더
    if (e.metaKey && e.code === "KeyI") { e.preventDefault(); m.toggleShot(); return true; } // 방금 찍은 스크린샷 붙이기·빼기
    if (e.key === "Enter" && e.shiftKey) return true; // 줄바꿈
    if (e.key === "Tab") { e.preventDefault(); const n = items.length || 1; setSel(s => (s + (e.shiftKey ? n - 1 : 1)) % n); return true; }
    return q.includes("\n") && (e.key === "ArrowUp" || e.key === "ArrowDown"); // 여러 줄: 커서 이동
  };

  // ⌘↵, ⌘O 같은 고른 항목의 동작별 단축키
  const keyShortcut = (e: KeyboardEvent): boolean => {
    if (!e.metaKey || !cur || menu) return false;
    const sc = e.code === "Enter" ? "⌘↵" : e.code.startsWith("Key") ? `⌘${e.code.slice(3)}` : "";
    const typed = input.current && input.current.selectionStart !== input.current.selectionEnd;
    const a = sc === "⌘C" && typed ? undefined : cur.actions.find(x => x.shortcut === sc); // 입력창에서 글자를 골랐으면 ⌘C는 그 글자 복사
    if (a) { e.preventDefault(); c.run(a); return true; }
    // ⌘↵: 고른 항목에 ⌘↵ 동작이 없으면 기본 검색·AI 화면에서는 "내 노트에게 묻기", 그 밖에는 아무것도 안 함 (Enter 동작으로 넘어가지 않게)
    if (e.key === "Enter") {
      e.preventDefault();
      if ((mode === null || mode === "ask") && q.trim()) c.askNotes(q.trim());
      return true;
    }
    return false;
  };

  // 목록(또는 ⌘K 액션 패널): ↑↓ 이동, Enter 실행, Esc 단계별로 물러나기
  const keyList = (e: KeyboardEvent) => {
    const n = menu ? cur?.actions.length ?? 0 : items.length;
    const move = menu ? setAsel : setSel;
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !menu && pick) setPick(null);
    if (e.key === "ArrowDown") { e.preventDefault(); setPending(null); move(s => Math.min(s + 1, n - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setPending(null); move(s => Math.max(s - 1, 0)); }
    // 확인을 묻는 중이면 (⌘D 삭제 등) Enter는 그 동작을 실행
    else if (e.key === "Enter") { e.preventDefault(); c.run(menu ? cur?.actions[asel] : cur?.actions.find(x => pending?.key === `${cur.id}:${x.title}`) ?? cur?.actions[0]); }
    // Esc: 확인 취소 → 액션 패널 닫기 → 입력 지우기 → 예시 지우기 → 이전 화면 → 창 닫기
    else if (e.key === "Escape") {
      if (pending) setPending(null); else if (menu) setMenu(false); else if (mode === "files" && c.fileOpen) { c.setFileOpen(null); setSel(0); } else if (mode === "cal" && c.redate) c.cancelRedate(); else if (q) setQ(""); else if (hint) setHint("");
      else if (mode !== null) c.back(); else invoke("close_window");
    }
  };

  const onKey = (e: KeyboardEvent) => {
    if (c.formKeys.some(f => f(e))) return;
    if (document.activeElement !== input.current && !(view || ai)) input.current?.focus();
    if (mode === "cal" && e.metaKey && (e.code === "BracketLeft" || e.code === "BracketRight")) { e.preventDefault(); c.moveMonth(e.code === "BracketLeft" ? -1 : 1); return; }
    // 홈: 입력한 글을 바로 노션 할 일로 ("내일 3시 회의" ⌘T)
    if (mode === null && !view && e.metaKey && e.code === "KeyT" && q.trim()) { e.preventDefault(); saveTodo(q.trim(), c.ui).catch(c.fail); return; }
    if (keyGlobal(e) || keyView(e) || keyMemo(e) || c.keyAi(e) || c.keyNotes(e) || keyShortcut(e)) return;
    keyList(e);
  };

  const keyRef = useRef(onKey);
  keyRef.current = onKey;
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);
}
