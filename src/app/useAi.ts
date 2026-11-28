// AI 답변 화면: 묻기(AI·내 노트), 스트리밍 답변 받기, Obsidian에 저장, 이 화면의 키 처리
// App.tsx에서 동작 그대로 옮김
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { loadConfig, View } from "../commands";
import type { Ai, Mode, Source } from "./types";
import type { InputRef, Setter } from "./ctx";

export function useAi({ q, mode, setView, setMenu, setRev, input }: {
  q: string; mode: Mode; setView: Setter<View | null>; setMenu: Setter<boolean>; setRev: Setter<number>; input: InputRef;
}) {
  const [ai, setAi] = useState<Ai | null>(null); // AI 답변 화면
  const aiSeq = useRef(0);

  const ask = (question: string) => {
    const id = ++aiSeq.current;
    setView(null);
    setAi({ id, q: question, text: "", busy: true, error: null });
    setMenu(false);
    invoke<Source[]>("ask_ai", { id, prompt: question })
      .then(sources => { if (sources.length) setAi(a => a && a.id === id ? { ...a, sources } : a); })
      .catch(e => setAi(a => a && a.id === id ? { ...a, busy: false, error: String(e) } : a));
  };
  const askNotes = (question: string) => {
    const id = ++aiSeq.current;
    setView(null);
    setAi({ id, q: question, text: "", busy: true, error: null, notes: true, sources: [] });
    setMenu(false);
    invoke<Source[]>("ask_notes", { id, question })
      .then(sources => setAi(a => a && a.id === id ? { ...a, sources } : a))
      .catch(e => setAi(a => a && a.id === id ? { ...a, busy: false, error: String(e) } : a));
  };
  // AI 답변을 Obsidian 노트로 저장 (⌘S). 날짜는 내 Mac의 오늘 날짜
  const saveAi = async () => {
    if (!ai || ai.busy || !ai.text.trim() || ai.saved) return;
    const d = new Date();
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const id = ai.id;
    try {
      const src = ai.sources?.length ? `\n\n## ${ai.notes ? "출처 노트" : "출처 기사"}\n${ai.sources.map((s, i) => `${i + 1}. ${ai.notes ? `[[${s.title}]]` : `[${s.title}](${s.file})`}`).join("\n")}` : "";
      const saved = await invoke<string>("save_ai", { date, question: ai.q, answer: ai.text + src });
      setAi(a => a && a.id === id ? { ...a, saved, saveError: undefined } : a);
      loadConfig().then(() => setRev(r => r + 1));
    } catch (e) { setAi(a => a && a.id === id ? { ...a, saveError: String(e) } : a); }
  };

  useEffect(() => {
    const uns = [
      listen<{ id: number; text: string }>("ai-chunk", e =>
        setAi(a => a && a.id === e.payload.id ? { ...a, text: a.text + e.payload.text } : a)),
      listen<{ id: number; error: string | null }>("ai-done", e =>
        setAi(a => a && a.id === e.payload.id ? { ...a, busy: false, error: e.payload.error } : a)),
    ];
    return () => { uns.forEach(u => u.then(f => f())); };
  }, []);

  // AI: 기본 검색·AI 화면의 Tab은 AI에게 묻기. 답변 화면에서 Enter 다시 질문, ⌘↵ 노트에게, ⇧Enter 답변 복사, ⌘S 저장, ⌘O 저장한 노트 열기
  const keyAi = (e: KeyboardEvent): boolean => {
    if (e.key === "Tab" && (mode === null || mode === "ask")) { e.preventDefault(); if (q.trim()) ask(q.trim()); return true; }
    if (!ai) return false;
    if (e.key === "Escape") { setAi(null); input.current?.select(); }
    else if (e.metaKey && e.code === "KeyS") { e.preventDefault(); saveAi(); }
    else if (e.metaKey && e.code === "KeyO" && ai.saved) { e.preventDefault(); invoke("open_url", { url: `obsidian://open?path=${encodeURIComponent(ai.saved)}` }); }
    else if (e.key === "Enter" && e.shiftKey) { e.preventDefault(); navigator.clipboard.writeText(ai.text); }
    else if (e.key === "Enter" && e.metaKey) { e.preventDefault(); if (q.trim() && !ai.busy) askNotes(q.trim()); }
    else if (e.key === "Enter") { e.preventDefault(); if (q.trim() && !ai.busy) (ai.notes ? askNotes : ask)(q.trim()); }
    return true;
  };

  return { ai, setAi, ask, askNotes, keyAi };
}
