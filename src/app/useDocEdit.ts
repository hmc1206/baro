// Baro 안에서 노트 편집 (비밀번호 모음은 비밀번호 수정 화면을 씀)
// 편집칸 값은 편집기 안에서만 바뀌고(입력할 때 App 전체를 다시 그리지 않게), 저장·닫기 때 여기서 읽음
// App.tsx에서 동작 그대로 옮김
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Item, View } from "../commands";
import type { Doc } from "../notes";
import type { Ai, DocEd, Mode, Notes } from "./types";
import { docCache } from "./status";
import { now } from "./memo";
import { parseDoc, serializeDoc, titleOf, type DocFields } from "./docfields";
import { openObsidian } from "./obsidian";
import type { InputRef, Setter } from "./ctx";

export function useDocEdit({ mode, q, setQ, notes, setMode, setView, setAi, reloadDocs, input, failNote }: {
  mode: Mode; q: string; setQ: Setter<string>; notes: Notes; setMode: Setter<Mode>; setView: Setter<View | null>; setAi: Setter<Ai | null>;
  reloadDocs: () => Promise<void>; input: InputRef; failNote: (title: string) => (e: unknown) => void;
}) {
  const [docEd, setDocEd] = useState<DocEd | null>(null);
  const docFields = useRef<DocFields | null>(null);
  const docDirty = () => !!docEd && !!docFields.current && serializeDoc(docFields.current) !== docEd.start;
  const startDocEdit = (ed: Omit<DocEd, "start" | "ask" | "msg" | "err">) => {
    docFields.current = ed.init;
    setDocEd({ ...ed, start: ed.isNew ? "" : serializeDoc(ed.init), ask: false, msg: null, err: null });
    setView(null); setAi(null); setMode("docEdit");
  };
  const openDocEdit = (d: Doc) => {
    const search = notes.search;
    if (!search) return;
    invoke<string>("note_read", { id: search.id, file: d.file })
      .then(text => startDocEdit({ search, doc: d, base: text, init: parseDoc(text, titleOf(d.file)), q }))
      .catch(failNote);
  };
  // 닫을 때: 폴더를 새로 읽고, 방금 고친(만든) 글을 목록에서 골라 둠
  const pickFile = useRef<string | null>(null);
  const closeDocEdit = () => {
    const back = docEd?.isNew ? "" : docEd?.q ?? "";
    pickFile.current = docEd?.doc.file || null;
    setTimeout(() => { pickFile.current = null; }, 3000); // 목록에 안 나오면 (검색어에 안 맞는 등) 그냥 둠
    if (docEd) docCache.delete(docEd.search.id);
    setDocEd(null); docFields.current = null; setMode("note"); setQ(back); reloadDocs();
    requestAnimationFrame(() => input.current?.focus());
  };
  const saveDocEdit = async () => {
    const ed = docEd, f = docFields.current;
    if (!ed || !f) return;
    const name = f.title.trim(), content = serializeDoc(f);
    if (!name) { setDocEd({ ...ed, err: "제목을 써 주세요. 제목이 파일 이름이 돼요.", msg: null }); return; }
    if (!ed.isNew && content === ed.start && name === titleOf(ed.doc.file)) { setDocEd({ ...ed, msg: "바뀐 내용이 없어요", err: null, ask: false }); return; }
    const done = (file: string, msg: string) => {
      setDocEd(d => d && { ...d, isNew: false, doc: { ...d.doc, name, file }, base: content, start: content, ask: false, msg, err: null });
      docCache.delete(ed.search.id); reloadDocs(); // 목록에도 바로 반영
    };
    const call = ed.isNew ? invoke<string>("note_create", { id: ed.search.id, name, content })
      : invoke<string>("note_write", { id: ed.search.id, file: ed.doc.file, base: ed.base, content, name });
    await call.then(file => done(file, `✓ ${ed.isNew ? "만들었어요" : file !== ed.doc.file ? "이름 바꿔 저장했어요" : "저장했어요"} · ${now().time}`))
      .catch(e => setDocEd(d => d && { ...d, err: String(e), msg: null }));
  };
  const openNewDoc = (title: string) => {
    const search = notes.search;
    if (!search) return;
    startDocEdit({ search, doc: { name: title || "새 글", file: "" } as Doc, isNew: true, base: "",
      init: { title, props: [{ key: "created", value: now().date }], body: "" }, q });
  };
  // 글쓰기 노트 검색: 새 글. 입력한 검색어가 있으면 그걸 제목으로
  const newWriteItem = (): Item => {
    const title = q.trim();
    return { id: "w-new", title: title ? `새 글 쓰기: ${title}` : "새 글 쓰기", subtitle: `${notes.search?.name ?? ""} 폴더에 만들어요 · 제목이 파일 이름`,
      kind: "cmd", glyph: "plus", section: "쓰기", actions: [{ title: "쓰기", keep: true, run: async () => openNewDoc(title) }] };
  };
  // 편집기에서 칸이 바뀌면: 값은 ref에 두고, 떠 있던 안내만 지움
  const onFieldsChange = (f: DocFields) => {
    docFields.current = f;
    if (docEd && (docEd.ask || docEd.msg || docEd.err)) setDocEd(d => d && { ...d, ask: false, msg: null, err: null });
  };
  // 노트 편집: ⌘S 저장, Esc 닫기 (안 저장한 변경이 있으면 한 번 더), ⌘O Obsidian. 나머지 키는 편집칸으로
  const keyDocEdit = (e: KeyboardEvent): boolean => {
    if (mode !== "docEdit" || !docEd) return false;
    if (e.metaKey && e.code === "KeyS") { e.preventDefault(); saveDocEdit(); }
    else if (e.metaKey && e.code === "KeyO") { e.preventDefault(); if (docEd.doc.file) openObsidian(docEd.doc.file); }
    else if (e.key === "Escape") {
      e.preventDefault();
      if (docDirty() && !docEd.ask) setDocEd({ ...docEd, ask: true });
      else closeDocEdit();
    }
    return true;
  };
  return { docEd, openDocEdit, openNewDoc, newWriteItem, onFieldsChange, keyDocEdit, pickFile };
}

// 닫은 뒤 목록이 다시 그려지면 방금 고친 글을 골라 둠 (매 그리기마다 확인)
export function usePickEdited(pickFile: { current: string | null }, mode: Mode, items: Item[], setSel: Setter<number>) {
  useEffect(() => {
    if (!pickFile.current || mode !== "note") return;
    const i = items.findIndex(it => it.id === `n-${pickFile.current}`);
    if (i >= 0) { setSel(i); pickFile.current = null; }
  });
}
