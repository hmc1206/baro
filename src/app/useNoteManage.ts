// 노트 검색 관리 목록, 노트 검색 추가·수정 화면 (App.tsx에서 동작 그대로 옮김)
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getConfig, loadConfig, Item } from "../commands";
import { KIND_LABELS, type NoteSearch } from "../notes";
import type { Draft, Hk, Mode } from "./types";
import { fmtKey, accelOf } from "./keys";
import type { Setter } from "./ctx";

export function useNoteManage({ mode, setQ, setMode, enter, setRev, hk, setHk, openNotes }: {
  mode: Mode; setQ: Setter<string>; setMode: Setter<Mode>; enter: (m: Mode) => void; setRev: Setter<number>;
  hk: Hk; setHk: Setter<Hk>; openNotes: (id: string, asGraph?: boolean) => unknown;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const openNoteManager = () => {
    enter("noteManage");
    loadConfig().then(() => setRev(r => r + 1));
    invoke<Record<string, string>>("get_hotkeys").then(keys => setHk(h => ({ ...h, keys: keys ?? {} })));
  };
  const openEdit = (s?: NoteSearch) => {
    setDraft({ id: s?.id ?? "", name: s?.name ?? "", dir: s?.dir ?? "", kind: s?.kind ?? "notes",
      hotkey: s ? hk.keys[`note:${s.id}`] ?? "" : "", recording: false, error: null, saving: false });
    setQ(""); setMode("noteEdit");
  };
  const saveDraft = async () => {
    if (!draft || draft.saving) return;
    setDraft({ ...draft, saving: true, error: null });
    try {
      await invoke("save_note_search", { search: { id: draft.id, name: draft.name, dir: draft.dir, kind: draft.kind }, hotkey: draft.hotkey });
      setDraft(null);
      openNoteManager();
    } catch (e) { setDraft(d => d && { ...d, saving: false, error: String(e) }); }
  };
  const pickFolder = async () => {
    const dir = await invoke<string | null>("pick_folder", { start: draft?.dir || "/Volumes/Disk/MyBrain" });
    if (dir) setDraft(d => d && { ...d, dir, name: d.name || dir.split("/").pop()!.replace(/^\d+_/, "") });
  };
  // 노트 검색 관리 목록
  const manageItems = (): Item[] => [
    ...getConfig().note_searches.map(n => ({
      id: `nm-${n.id}`, title: n.name, kind: "wiki" as const, glyph: KIND_LABELS[n.kind]?.glyph ?? "doc", section: "내 노트 검색",
      subtitle: `${KIND_LABELS[n.kind]?.title ?? n.kind} · ${fmtKey(hk.keys[`note:${n.id}`] ?? "") || "단축키 없음"}`,
      actions: [
        { title: "열기", keep: true, run: async () => openNotes(n.id) },
        { title: "그래프로 보기", keep: true, run: async () => openNotes(n.id, true) },
        { title: "수정", keep: true, run: async () => openEdit(n) },
        { title: "삭제", keep: true, confirm: `"${n.name}" 노트 검색을 삭제할까요? 노트 파일은 지워지지 않아요. Enter를 한 번 더 누르세요.`,
          run: async () => { await invoke("delete_note_search", { id: n.id }); await loadConfig(); setRev(r => r + 1); } },
      ],
    })),
    { id: "nm-new", title: "새 노트 검색 만들기", subtitle: "Obsidian 폴더 · 방식 · 단축키 지정", kind: "cmd", glyph: "plus",
      section: "추가", actions: [{ title: "만들기", keep: true, run: async () => openEdit() }] },
  ];
  // 노트 검색 추가·수정 화면: 입력칸은 그대로 두고 Esc(취소)·⌘↵(저장)·단축키 입력만 처리
  const keyNoteEdit = (e: KeyboardEvent): boolean => {
    if (mode !== "noteEdit" || !draft) return false;
    if (draft.recording) {
      e.preventDefault();
      if (e.key === "Escape") { invoke("suspend_hotkeys", { on: false }); setDraft({ ...draft, recording: false }); return true; }
      const accel = accelOf(e);
      if (accel) { invoke("suspend_hotkeys", { on: false }); setDraft({ ...draft, hotkey: accel, recording: false }); }
      return true;
    }
    if (e.key === "Escape") { e.preventDefault(); setDraft(null); openNoteManager(); }
    else if (e.key === "Enter" && e.metaKey) { e.preventDefault(); saveDraft(); }
    return true;
  };
  return { draft, setDraft, openNoteManager, saveDraft, pickFolder, manageItems, keyNoteEdit };
}
