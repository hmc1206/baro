// 처음 화면(검색 막대)의 결과: 기본 검색 + 파일 검색 (App.tsx에서 동작 그대로 옮김)
import { useEffect, useRef, useState } from "react";
import { query, fileItems, Item, Ui } from "../commands";
import type { Memo, Mode } from "./types";
import type { Setter } from "./ctx";

// 결과 보관. 목록(items)을 만들 때 쓰므로 효과(useSearchEffects)보다 먼저 부름
export function useHomeResults() {
  const [top, setTop] = useState<Item[]>([]);
  const [bottom, setBottom] = useState<Item[]>([]);
  const [files, setFiles] = useState<Item[]>([]);
  const seq = useRef(0);
  return { top, setTop, bottom, setBottom, files, setFiles, seq };
}

export function useSearchEffects({ q, rev, mode, ui, res, restoreSel, setSel, setMenu, setPending, setPick, picking, memo, crit, memoPickAt }: {
  q: string; rev: number; mode: Mode; ui: Ui; res: ReturnType<typeof useHomeResults>;
  restoreSel: { current: number | null }; setSel: Setter<number>; setMenu: Setter<boolean>; setPending: (p: null) => void; setPick: (p: null) => void;
  picking: unknown; memo: Memo; crit: unknown[]; memoPickAt: number;
}) {
  const { setTop, setBottom, setFiles, seq } = res;
  // 기본 검색 결과: 최신 요청 결과만 반영
  useEffect(() => {
    const id = ++seq.current;
    setMenu(false); setPending(null); setPick(null);
    if (mode !== "memo") { setSel(restoreSel.current ?? 0); restoreSel.current = null; }
    else if (picking) setSel(0); // 노트 고르기: 검색할 때마다 첫 결과
    else if (memo.stage && /^\s*!/.test(q)) setSel(crit.length + 1); // 막힌 점과 해결 (개념이면 완료 기준 칸 다음)
    else if (memo.stage && /^\s*\$/.test(q)) setSel(crit.length + 2); // 사용한 명령어
    else if (q.trim()) setSel(s => s >= memoPickAt ? 0 : s); // 고르기·사진·클립보드 칸에 있다가 입력을 시작하면 첫 칸으로
    if (mode !== null) return;
    query(q, ui).then(r => {
      if (id !== seq.current) return;
      setTop(r.top); setBottom(r.bottom);
    });
  }, [q, rev, mode]);

  // 파일 검색: 입력이 멈추면 실행
  useEffect(() => {
    setFiles([]);
    if (mode !== null) return;
    const t = setTimeout(() => {
      const id = seq.current;
      fileItems(q).then(f => { if (id === seq.current) setFiles(f); });
    }, 180);
    return () => clearTimeout(t);
  }, [q, mode]);
}
