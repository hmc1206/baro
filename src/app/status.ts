// 커리큘럼 상태 이름과 노트 목록 캐시
import { byCategory, type Doc } from "../notes";

// 커리큘럼 상태: 머리말 status 값 → 표시 이름, ⌘D로 다음 상태. 허브 단계는 학습 전 → 학습 중 → 복습 필요 → 완료
export const STATUS: Record<string, string> = { todo: "할 일", doing: "진행 중", "in-progress": "진행 중", done: "완료",
  "학습 전": "학습 전", "학습 중": "학습 중", "복습 필요": "복습 필요", "완료": "완료" };
export const HUB_STATES = ["학습 전", "학습 중", "복습 필요", "완료"];
export const nextStatus = (s: string) => HUB_STATES.includes(s) ? HUB_STATES[(HUB_STATES.indexOf(s) + 1) % 4]
  : s === "todo" || !s ? "doing" : s === "done" ? "todo" : "done";
export const isDone = (s: string) => s === "done" || s === "완료";
export const isDoing = (s: string) => ["진행 중", "학습 중", "복습 필요"].includes(STATUS[s]);
export const weekLabel = (w?: string) => !w ? "" : /^[\d\s~-]+$/.test(w) ? `${w.replace(/-/g, "~")}주` : w;
// 노트 검색별로 읽은 노트 (창을 다시 열 때 바로 보여 주기용). sig: 내용이 바뀌었는지 비교
export const docCache = new Map<string, { docs: Doc[]; sig: string }>();
export function docsSig(docs: Doc[]) {
  let h = 0;
  // 허브 단계는 개념 노트의 복습일(reviews)도 비교 (허브 글이 같아도 next_review가 바뀌면 다시 그림)
  const seen = new Set<Map<string, string>>();
  const rv = (d: Doc) => !d.reviews || seen.has(d.reviews) ? "" : (seen.add(d.reviews), [...d.reviews].join(";"));
  for (const d of docs) for (const s of [d.file, d.body, rv(d)]) for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `${docs.length}:${h}`;
}
export const lastDoc = (docs: Doc[]) => { const d = byCategory(docs); return d[d.length - 1]; };
