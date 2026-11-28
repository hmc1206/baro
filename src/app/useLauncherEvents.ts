// 창 전체 이벤트: 링크는 기본 브라우저로, 백엔드 이벤트(창 열림·인덱싱·색인 진행) 받기 (App.tsx에서 동작 그대로 옮김)
import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { loadConfig, View } from "../commands";
import type { Setter } from "./ctx";

export function useLauncherEvents({ onShown, setRev, setView }: { onShown: (action: string) => void; setRev: Setter<number>; setView: Setter<View | null> }) {
  const shownRef = useRef(onShown);
  shownRef.current = onShown;

  // 미리보기·답변 안의 링크는 Baro 창 안에서 열지 않고 기본 브라우저(로그인·쿠키 그대로)로
  useEffect(() => {
    const onLink = (e: globalThis.MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.("a[href]");
      if (!a) return;
      const href = a.getAttribute("href") ?? "";
      if (href.startsWith("#")) return; // 같은 문서 안 이동은 그대로
      e.preventDefault();
      if (/^(https?|mailto|obsidian):/i.test(href)) invoke("open_url", { url: href });
    };
    document.addEventListener("click", onLink, true);
    return () => document.removeEventListener("click", onLink, true);
  }, []);

  useEffect(() => {
    const uns = [
      listen<string>("shown", e => shownRef.current(e.payload || "baro")),
      // 인덱싱이 끝나면 현재 검색어로 다시 조회
      listen("indexed", () => setRev(r => r + 1)),
      // 노트 뜻 색인 만들기 진행 (그 결과 화면이 떠 있을 때만 갱신)
      listen<{ done: number; total: number }>("embed-progress", e => setView(v => v?.kind === "text" && v.title.startsWith("노트 뜻 색인")
        ? { ...v, title: "노트 뜻 색인 만드는 중", text: `${e.payload.done} / ${e.payload.total} 단락 (${Math.round(e.payload.done / Math.max(1, e.payload.total) * 100)}%)\n창을 닫아도 계속 만들어요.` } : v)),
      listen<{ total: number; count: number; error: string | null }>("embed-done", e => setView(v => v?.kind === "text" && v.title.startsWith("노트 뜻 색인")
        ? e.payload.error ? { kind: "text", title: "노트 뜻 색인을 만들지 못했어요", text: e.payload.error, error: true }
          : { kind: "text", title: "노트 뜻 색인을 만들었어요", text: `단락 ${e.payload.count}개. 이제 내 노트에게 묻기가 단어 검색과 뜻 검색을 함께 써요.` } : v)),
    ];
    loadConfig().then(() => setRev(r => r + 1));
    return () => { uns.forEach(u => u.then(f => f())); };
  }, []);
}
