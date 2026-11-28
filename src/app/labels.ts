// 화면별 문구: 입력창 안내, 목록 머리말, 빈 목록 안내, 아래 도움말 키, 창 크기 종류 (App.tsx에서 동작 그대로 옮김)
import { FEATURE_TITLES, Item, Feature, View } from "../commands";
import type { Doc } from "../notes";
import type { Ai, Hk, Memo, Mode, Notes, Store } from "./types";
import type { Cal } from "./useCalendar";
import type { Conc } from "./useStudy";
import { now } from "./memo";

export type LabelCtx = {
  mode: Mode; home: boolean; q: string; hint: string; items: Item[]; view: View | null; ai: Ai | null;
  notes: Notes; noteListLen: number; conc: Conc | null; store: Store; hk: Hk; feature: Feature; exDoc: { doc: Doc } | null;
  appRows: Item[]; found: { items: Item[]; loading: boolean }; fileOpen: string | null;
  cal: Cal; redate: unknown; clips: { list: unknown[]; enabled: boolean };
  memo: Memo; picking: { dir: string } | null; shotName: (s: string) => string;
};

export function placeholderOf(c: LabelCtx): string {
  const { mode, ai, notes, conc, exDoc, feature, redate, picking, memo, hint } = c;
  return ai ? "다시 물어보기"
    : mode === "store" ? "확장 검색"
    : mode === "note" && conc ? `${conc.stage.name} · 개념 검색`
    : mode === "note" ? (notes.search?.kind === "commands" ? "명령어 또는 하고 싶은 작업 (예: 포트 확인, 권한 변경)" : `${notes.search?.name ?? "노트"} 검색`)
    : mode === "noteManage" ? "노트 검색 관리"
    : mode === "examples" ? `${exDoc?.doc.name ?? ""} 예시 검색`
    : mode === "hotkeys" ? "단축키 설정"
    : mode === "ask" ? "AI에게 물어보기 (Enter · ⌘↵ 내 노트에서 찾아 묻기)"
    : mode === "files" ? "파일 이름 (홈 · 외장 디스크)"
    : mode === "apps" ? "앱 이름 입력 · 예: Safari, 메모"
    : mode === "feature" ? `${FEATURE_TITLES[feature]} · 이름으로 좁히기 · Esc 처음으로`
    : mode === "cal" ? (redate ? "제목 고치기 · 날짜는 아래 버튼이나 달력 칸 · Enter 저장 · ⌘D 삭제 · Esc 취소" : "할 일 입력 · 예: 내일 오후 3시 치과, 12/1~12/5 워크숍, 금요일까지 보고서")
    : mode === "clip" ? "복사했던 글 검색"
    : mode === "memo" ? (picking ? "노트 이름 검색 (비우면 폴더 보기) · Esc 취소" : memo.shot ? "스크린샷 이름 겸 메모 · Enter 저장 · ⌘I 빼기" : "메모 입력 · ⇧Enter 줄바꿈 · Tab 저장할 곳 바꾸기")
    : hint || "앱, 파일, 명령, 계산, AI에게 묻기 · 글 치고 ⌘T 할 일";
}

export function headerOf(c: LabelCtx): string | null {
  const { mode, home, q, items, store, appRows, feature, cal, found, fileOpen, clips, memo, picking, conc, notes, noteListLen, shotName } = c;
  return home ? "Baro로 할 수 있는 일"
    : mode === "store" ? `확장 스토어${store.loading ? " · 불러오는 중…" : ""}`
    : mode === "apps" ? (q.trim() ? `앱 ${appRows.length}개` : `설치된 앱 ${appRows.length}개`)
    : mode === "feature" ? `${FEATURE_TITLES[feature]} ${items.length}개`
    : mode === "cal" ? (cal.loading ? "노션에서 불러오는 중…" : cal.error ? "캘린더 · 노션 연결 필요" : cal.msg ?? `캘린더 · 일정 ${cal.events.length}개 · DB ${cal.dbs.length}개 · Enter 완료 · ⌘O 노션 · ⌘R 새로고침`)
    : mode === "files" ? (found.loading ? (q.trim() ? "찾는 중…" : "최근 파일 불러오는 중…") : fileOpen ? `${fileOpen}만 보는 중 · Esc 전체 종류`
      : q.trim() ? `파일 ${found.items.length}개 · 종류별` : `최근 90일 파일 ${found.items.length}개 · 종류별 · 이름을 입력하면 전체에서 찾기`)
    : mode === "clip" ? (q.trim() ? `찾은 기록 ${items.filter(i => i.id.startsWith("clip-") && !["clip-toggle", "clip-clear"].includes(i.id)).length}개` : clips.enabled ? null : "기록을 멈춘 상태예요")
    : mode === "memo" ? (memo.shot ? `스크린샷 붙임 · 저장 이름: ${now().date}-${shotName(q.replace(/^\s*[!$]/, ""))}` : picking ? (q.trim() ? "전체에서 이름 검색 · Enter로 정하기" : `${picking.dir ? picking.dir.split("/").join(" / ") : "Vault"} · Enter 열기·정하기 · ⌫ 상위 폴더`) : memo.saved ? `✓ ${memo.saved}` : memo.stage ? `${memo.stage.doc.name}에 기록하기` : "저장할 곳 · Tab으로 바꾸기")
    : mode === "note" && conc ? (conc.loading ? "개념 노트 불러오는 중…" : `${conc.stage.category} · ${conc.stage.name} · 개념 ${conc.docs.length}개 · Esc 단계 목록`)
    : mode === "note" && (notes.loading || q.trim()) ? (notes.loading ? "노트 불러오는 중…" : `검색 결과 ${noteListLen}개`)
    : null;
}

export function emptyOf(c: LabelCtx): string | null {
  const { mode, q, items, store, conc, notes, hk, appRows, found, memo, cal, clips } = c;
  return mode === "store" ? store.error
    : mode === "note" && conc ? conc.error ?? (!conc.loading && !items.length ? (q ? "일치하는 개념이 없어요." : "이 단계에는 개념 목록이 없어요.") : null)
    : mode === "note" ? notes.error ?? (!notes.loading && !items.length ? (q ? "일치하는 노트가 없어요." : "폴더에 노트(.md)가 없어요.") : null)
    : mode === "hotkeys" ? hk.error
    : mode === "apps" ? (q.trim() && !appRows.length ? "일치하는 앱이 없어요." : null)
    : mode === "feature" ? (!items.length ? (q.trim() ? "일치하는 항목이 없어요." : "아직 없어요. Baro 설정(config.json)에서 추가해요.") : null)
    : mode === "files" ? (!found.loading && !found.items.length ? (q.trim() ? "일치하는 파일이 없어요." : "최근 90일에 바뀐 파일이 없어요.") : null)
    : mode === "memo" ? memo.error
    : mode === "cal" ? cal.error ?? (!cal.loading && !items.length ? (q.trim() ? "일치하는 일정이 없어요." : "앞으로 60일 동안 일정이 없어요. 할 일을 입력해 추가해 보세요.") : null)
    : mode === "clip" ? (!clips.list.length ? "아직 기록이 없어요. 글을 복사하면 여기에 쌓여요 (비밀번호·키처럼 보이는 글은 빼요)." : q.trim() && !items.length ? "일치하는 기록이 없어요." : null)
    : mode === null && q && !items.length ? "결과가 없습니다. 다른 이름으로 검색해 보세요." : null;
}

// 아래 도움말 키 (고른 항목의 기본 동작과 단축키 동작)
export function footerKeysOf({ view, ai, hk, cur, graphOn, pick, mode, notes, reveal, conc, graph, local }: {
  view: View | null; ai: Ai | null; hk: Hk; cur: Item | undefined; graphOn: boolean; pick: unknown; mode: Mode; notes: Notes;
  reveal: boolean; conc: unknown; graph: boolean; local: number;
}): [string, string[]][] {
  const quick = graphOn && pick ? cur?.actions.find(a => a.shortcut === "⌘F") // 그래프: 고른 노트의 위치 보기
    : cur?.actions.find((a, i) => i > 0 && a.shortcut); // 기본 동작과 겹치면 하단에 두 번 보이지 않게
  return view
    ? [[view.kind === "perm" ? (view.perm === "ok" ? "" : "시스템 설정 열기") : "결과 복사", ["↵"]], ["돌아가기", ["esc"]]]
    : ai ? [["답변 복사", ["⇧", "↵"]], ...(ai.notes ? [] : [["노트에서 다시 묻기", ["⌘", "↵"]] as [string, string[]]]), ai.saved ? ["Obsidian에서 열기", ["⌘", "O"]] : ["Obsidian에 저장", ["⌘", "S"]], ["돌아가기", ["esc"]]]
    : hk.recording ? [["취소", ["esc"]]]
    : cur?.actions[0] ? [[cur.actions[0].title, ["↵"]], ...(quick ? [[quick.title, [...quick.shortcut!]] as [string, string[]]] : []),
      ...(mode === "note" && notes.search?.kind === "passwords" ? [[reveal ? "가리기" : "보기", ["⌘", "R"]] as [string, string[]]] : []),
      ...(mode === "note" && !conc ? [[graph ? "목록" : "그래프", ["⌘", "G"]] as [string, string[]]] : []),
      ...(graphOn ? [[local ? `로컬 ${local}단계` : "로컬", ["⌘", "L"]] as [string, string[]]] : []), ["액션", ["⌘", "K"]]] : [];
}

// 창 크기 종류: 그래프는 가장 크게, 미리보기가 있는 화면·AI 답변은 넓게. 종류마다 사용자가 맞춘 크기를 기억
export function sizeKindOf({ bar, graphOn, ai, mode }: { bar: boolean; graphOn: boolean; ai: unknown; mode: Mode }): string {
  return bar ? "bar" : graphOn ? "graph" : ai || mode === "note" || mode === "docEdit" || mode === "memo" || mode === "clip" ? "wide" : mode === "cal" ? "graph" : "normal";
}
