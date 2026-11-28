// 클립보드 기록 화면: 기록 불러오기, 목록 항목 (App.tsx에서 동작 그대로 옮김)
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { copy, pasteText, Item } from "../commands";
import type { Clip, Mode, Stage } from "./types";
import { clipDay, clipTime } from "./memo";
import type { Setter } from "./ctx";

export function useClip({ q, setQ, enter, openMemo }: {
  q: string; setQ: Setter<string>; enter: (m: Mode) => void; openMemo: (stage?: Stage, from?: Mode) => void;
}) {
  const [clips, setClips] = useState<{ list: Clip[]; enabled: boolean }>({ list: [], enabled: true });
  const loadClips = () => Promise.all([invoke<Clip[]>("clip_list"), invoke<boolean>("clip_enabled")])
    .then(([list, enabled]) => setClips({ list, enabled })).catch(() => {});
  const openClip = () => { enter("clip"); loadClips(); };
  // 클립보드 기록 목록: 검색어가 있으면 글 안에서 찾기. 맨 끝에 기록 끄기·모두 지우기
  const clipItems = (): Item[] => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const shown = clips.list.filter(c => words.every(w => c.text.toLowerCase().includes(w))).slice(0, 100);
    const rows: Item[] = shown.map(c => ({
      id: `clip-${c.at}`, title: c.text.trim().split("\n")[0].slice(0, 120), kind: "snippet", glyph: "clip", section: clipDay(c.at),
      subtitle: [clipTime(c.at), c.app, c.text.includes("\n") ? `${c.text.split("\n").length}줄` : ""].filter(Boolean).join(" · "),
      actions: [
        { title: "앞 앱에 붙여넣기", run: () => pasteText(c.text) },
        { title: "복사", shortcut: "⌘C", run: () => copy(c.text) },
        { title: "빠른 메모로 보내기", shortcut: "⌘N", keep: true, run: async () => { openMemo(undefined, "clip"); setQ(c.text); } },
        { title: "이 기록 지우기", shortcut: "⌘D", keep: true, run: async () => { await invoke("clip_remove", { at: c.at, text: c.text }); await loadClips(); } },
      ],
    }));
    if (q.trim()) return rows;
    return [...rows,
      { id: "clip-toggle", title: clips.enabled ? "클립보드 기록 멈추기" : "클립보드 기록 다시 켜기", kind: "cmd", glyph: clips.enabled ? "pause" : "clip", section: "설정",
        subtitle: clips.enabled ? "멈춘 동안 복사한 글은 저장하지 않아요" : "지금은 기록하지 않고 있어요",
        actions: [{ title: clips.enabled ? "멈추기" : "켜기", keep: true, run: async () => { await invoke("clip_set_enabled", { on: !clips.enabled }); await loadClips(); } }] },
      ...(clips.list.length ? [{ id: "clip-clear", title: "모두 지우기", kind: "cmd" as const, glyph: "trash", section: "설정", subtitle: `기록 ${clips.list.length}개`,
        actions: [{ title: "모두 지우기", keep: true, confirm: "클립보드 기록을 모두 지울까요? 되돌릴 수 없어요. Enter를 한 번 더 누르세요.",
          run: async () => { await invoke("clip_clear"); await loadClips(); } }] }] : []),
    ];
  };
  return { clips, openClip, clipItems };
}
