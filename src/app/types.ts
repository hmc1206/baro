// App 화면 상태 타입
import type { StoreEntry } from "../commands";
import type { Doc, NoteSearch, NoteKind } from "../notes";

// notes: 내 노트에게 묻기 (sources = 찾은 노트, 답변 아래 출처로 표시)
export type Source = { title: string; file: string };
export type Ai = { id: number; q: string; text: string; busy: boolean; error: string | null; saved?: string; saveError?: string; notes?: boolean; sources?: Source[] };
export type Store = { entries: StoreEntry[]; loading: boolean; error: string | null };
export type Notes = { search: NoteSearch | null; docs: Doc[]; loading: boolean; error: string | null };
// 노트 검색 추가·수정 화면의 입력값
export type Draft = { id: string; name: string; dir: string; kind: NoteKind; hotkey: string; recording: boolean; error: string | null; saving: boolean };
export type Hk = { keys: Record<string, string>; recording: string | null; error: string | null };
// 비밀번호 모음: 수정(doc 있음) 또는 새 노트 추가(doc 없음)
export type PwDraft = { doc: Doc | null; name: string; title: string; password: string; error: string | null; saving: boolean };
// 화면 종류: null(기본 검색) | 파일 찾기 | 확장 스토어 | 노트 검색 | 예시 고르기 | 단축키 설정 | AI 질문 | 노트 검색 관리 | 노트 검색 추가·수정
export type Mode = null | "store" | "note" | "examples" | "hotkeys" | "ask" | "noteManage" | "noteEdit" | "pwEdit" | "files" | "memo" | "clip";
// 클립보드 기록 (Rust clip.rs): at = 복사한 시각(ms), app = 그때 앞에 있던 앱
export type Clip = { text: string; at: number; app: string };
// 빠른 메모: 기록할 커리큘럼 단계(없으면 Daily만), 어디서 왔는지(Esc로 돌아갈 곳), 결과 문구
export type Stage = { search: NoteSearch; doc: Doc };
// 빠른 메모에 붙인 스크린샷 (⌘I): 클립보드 이미지 또는 스크린샷 파일
export type Shot = { source: "clip" | "file"; path: string | null; at: number; preview: string };
export type Memo = { stage: Stage | null; from: Mode; saved: string | null; error: string | null; finding?: boolean; daily?: string; dailyDate?: string; shot?: Shot | null };
// 지운 기록 (⌘Z로 되돌리기): sec는 "daily" 또는 칸 이름
export type Removed = { sec: string; id: string; file: string; date: string; line: number; text: string };
// 기록 항목: "- " 줄 + 들여쓴 이어지는 줄, 또는 ``` 코드 블록 하나 (Rust wiki::items_in과 같은 규칙 — 지울 때 번호가 맞아야 함)
export type RecItem = { i: number; first: string; text: string };
