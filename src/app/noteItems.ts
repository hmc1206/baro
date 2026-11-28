// 노트 검색 결과 한 줄(항목)과 그 동작 (App.tsx에서 동작 그대로 옮김)
import { invoke } from "@tauri-apps/api/core";
import { copy, pasteText, copySecret, pasteSecret, Item, Action } from "../commands";
import { Doc, KIND_LABELS } from "../notes";
import type { Notes } from "./types";
import type { Conc } from "./useStudy";
import { studyItem, type StudyItemCtx } from "./useStudy";
import { MASK } from "./passwords";

export type NoteItemCtx = {
  q: string; notes: Notes; conc: Conc | null; reveal: boolean;
  setQ: (q: string) => void;
  openPw: (d: Doc | null) => void; openDocEdit: (d: Doc) => void; openExamples: (d: Doc) => void;
  // 공부(커리큘럼) 항목에 넘기는 것들
  study: Omit<StudyItemCtx, "q" | "kind" | "notes" | "conc" | "obsidian" | "finder">;
};

export function noteItem(d: Doc, c: NoteItemCtx): Item {
  const { q, notes, conc, reveal } = c;
  const kind = notes.search?.kind ?? "notes";
  const obsidian: Action = { title: "Obsidian에서 열기", shortcut: "⌘O",
    run: () => invoke("open_url", { url: `obsidian://open?path=${encodeURIComponent(d.file)}` }) };
  const finder: Action = { title: "Finder에서 보기", shortcut: "⌘F", run: () => invoke("reveal", { path: d.file }) };
  if (kind === "write") return { id: `n-${d.file}`, title: d.name, kind: "wiki", glyph: "doc", section: q.trim() ? undefined : "이 폴더의 글",
    subtitle: d.summary, actions: [{ title: "Baro에서 고치기", keep: true, run: async () => c.openDocEdit(d) }, obsidian, finder] };
  if (kind === "passwords") {
    const p = d.meta.password ?? "", ssh = d.meta.ssh;
    return { id: `n-${d.file}`, title: d.name, kind: "wiki", glyph: "lock", section: q.trim() ? undefined : d.category,
      subtitle: p ? (reveal ? p : MASK) : d.meta.key_file ? `키 파일 ${d.meta.key_file}` : "비밀번호 없음",
      actions: [
        ...(p ? [{ title: "비밀번호 복사", run: () => copySecret(p) },
          { title: "앞 앱에 비밀번호 붙여넣기", shortcut: "⌘↵", run: () => pasteSecret(p) }] : []),
        { title: "비밀번호 수정", shortcut: "⌘E", keep: true, run: async () => c.openPw(d) },
        ...(ssh ? [{ title: "접속 명령 복사", run: () => copy(ssh) }, { title: "접속 명령 붙여넣기", run: () => pasteText(ssh) }] : []),
        obsidian, finder,
      ] };
  }
  const s = studyItem(d, { q, kind, notes, conc, obsidian, finder, ...c.study });
  if (s) return s;
  const pick = kind === "commands" ? "예시 골라서 쓰기" : "코드 골라서 쓰기";
  const actions: Action[] = kind === "snippets" ? [
    { title: "앞 앱에 붙여넣기", run: () => pasteText(d.body) },
    { title: "복사", run: () => copy(d.body) },
    obsidian, finder,
  ] : [
    ...(d.examples.length ? [{ title: pick, keep: true, run: async () => c.openExamples(d) }] : [obsidian]),
    ...(d.examples[0] ? [{ title: kind === "commands" ? "대표 예시 붙여넣기" : "첫 코드 붙여넣기", shortcut: "⌘↵", run: () => pasteText(d.examples[0].cmd) }] : []),
    { title: "이름 복사", run: () => copy(d.name) },
    ...(d.examples.length ? [obsidian] : []),
    finder,
    ...d.related.map(r => ({ title: `관련: ${r}`, keep: true, run: async () => c.setQ(r) })),
  ];
  const sub = q.trim() ? d.category
    : kind === "commands" ? (d.stub ? "요약" : `예시 ${d.examples.length}개`)
    : kind === "notes" && d.examples.length ? `코드 ${d.examples.length}개` : d.summary;
  return { id: `n-${d.file}`, title: d.name, subtitle: sub, kind: "wiki", section: q.trim() ? undefined : d.category, actions,
    glyph: kind === "commands" ? (d.stub ? "doc" : "terminal") : KIND_LABELS[kind].glyph };
}

// 편집 가능한 노트에는 "Baro에서 편집" 동작을 덧붙임 (비밀번호·글쓰기 노트 검색은 제외)
export function withEdit(it: Item, d: Doc, kind: string | undefined, openDocEdit: (d: Doc) => void): Item {
  return kind === "passwords" || kind === "write" ? it
    : { ...it, actions: [...it.actions, { title: "Baro에서 편집", shortcut: "⌘E", keep: true, run: async () => openDocEdit(d) }] };
}
