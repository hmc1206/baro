// 비밀번호 모음: 비밀번호 수정·새 항목 추가 화면 (App.tsx에서 동작 그대로 옮김)
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Doc } from "../notes";
import type { Mode, Notes, PwDraft } from "./types";
import { lastDoc } from "./status";
import { nextName, newPwNote, baseOf } from "./passwords";
import type { Setter } from "./ctx";

export function usePasswords({ mode, notes, openNotes, setQ, setMenu, setMode }: {
  mode: Mode; notes: Notes; openNotes: (id: string) => unknown; setQ: Setter<string>; setMenu: Setter<boolean>; setMode: Setter<Mode>;
}) {
  const [pw, setPw] = useState<PwDraft | null>(null);
  // 비밀번호 수정·새 노트 저장 후 노트 다시 읽기
  const savePw = async () => {
    const search = notes.search;
    if (!pw || pw.saving || !search) return;
    setPw({ ...pw, saving: true, error: null });
    try {
      if (pw.doc) await invoke("note_set_field", { id: search.id, file: pw.doc.file, key: "password", value: pw.password });
      else {
        if (!pw.name.trim()) throw "파일 이름을 입력하세요.";
        const last = lastDoc(notes.docs);
        await invoke("note_create", { id: search.id, name: pw.name.trim(), content: newPwNote(last, pw.name.trim(), pw.title.trim(), pw.password) });
      }
      setPw(null);
      openNotes(search.id);
    } catch (e) { setPw(d => d && { ...d, saving: false, error: String(e) }); }
  };
  const openPw = (doc: Doc | null) => {
    const last = lastDoc(notes.docs);
    const name = doc ? baseOf(doc.file) : nextName(last);
    setPw({ doc, name, title: doc ? doc.name : name.replace(/-/g, " "), password: doc?.meta.password ?? "", error: null, saving: false });
    setQ(""); setMenu(false); setMode("pwEdit");
  };
  const cancelPw = () => { setPw(null); setMode("note"); };
  // 비밀번호 수정·추가 화면: Esc(취소)·⌘↵(저장)
  const keyPwEdit = (e: KeyboardEvent): boolean => {
    if (mode !== "pwEdit" || !pw) return false;
    if (e.key === "Escape") { e.preventDefault(); cancelPw(); }
    else if (e.key === "Enter" && e.metaKey) { e.preventDefault(); savePw(); }
    return true;
  };
  return { pw, setPw, savePw, openPw, cancelPw, keyPwEdit };
}
