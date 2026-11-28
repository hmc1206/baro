// 명령어·코드 노트의 예시 고르기 화면 (App.tsx에서 동작 그대로 옮김)
import { useState } from "react";
import { copy, pasteText, Item } from "../commands";
import type { Doc } from "../notes";
import type { Mode } from "./types";
import type { Setter } from "./ctx";

export function useExamples({ q, setQ, setMode }: { q: string; setQ: Setter<string>; setMode: Setter<Mode> }) {
  const [exDoc, setExDoc] = useState<{ doc: Doc; prevQ: string } | null>(null); // 예시 고르기 대상
  const openExamples = (doc: Doc) => { setExDoc({ doc, prevQ: q }); setQ(""); setMode("examples"); };
  const exampleItems = (doc: Doc): Item[] => doc.examples
    .filter(e => !q.trim() || `${e.cmd} ${e.desc}`.toLowerCase().includes(q.trim().toLowerCase()))
    .map((e, i) => ({ id: `ex-${i}-${e.cmd}`, title: e.cmd, subtitle: e.desc, kind: "wiki", glyph: "terminal",
      section: `${doc.name} 예시`, actions: [
        { title: "앞 앱에 붙여넣기", run: () => pasteText(e.cmd) },
        { title: "복사", run: () => copy(e.cmd) },
      ] }));
  return { exDoc, openExamples, exampleItems };
}
