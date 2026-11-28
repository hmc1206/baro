// 앱 실행 화면·파일 찾기 화면: 결과 불러오기, 고른 파일 미리보기 (App.tsx에서 동작 그대로 옮김)
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { fileItems, recentFileItems, appList, Item } from "../commands";
import type { Mode } from "./types";
import type { FilePrev } from "./views";
import type { Setter } from "./ctx";

export function useFiles({ q, mode, setSel, enter }: { q: string; mode: Mode; setSel: Setter<number>; enter: (m: Mode) => void }) {
  const [found, setFound] = useState<{ items: Item[]; loading: boolean }>({ items: [], loading: false }); // 파일 찾기 화면 결과
  const [fileOpen, setFileOpen] = useState<string | null>(null); // 파일 찾기 화면에서 한 종류만 펼쳐 보는 중
  const [appRows, setAppRows] = useState<Item[]>([]); // 앱 실행 화면 결과
  const openFiles = () => { setFound({ items: [], loading: false }); setFileOpen(null); enter("files"); };

  // 앱 실행 화면: 입력이 없으면 전체 앱, 있으면 일치하는 앱
  useEffect(() => {
    if (mode !== "apps") return;
    let live = true;
    appList(q.trim()).then(items => { if (live) { setAppRows(items); setSel(0); } });
    return () => { live = false; };
  }, [q, mode]);

  // 파일 찾기 화면: 입력이 없으면 최근 바뀐 파일, 입력이 멈추면 홈 + 외장 디스크 검색 (둘 다 종류별 구역으로 보여 줌)
  useEffect(() => {
    if (mode !== "files") return;
    setFound(f => ({ ...f, loading: true }));
    let live = true;
    const load = q.trim() ? () => fileItems(q, true) : recentFileItems;
    const t = setTimeout(() => load().then(items => { if (live) { setFound({ items, loading: false }); setSel(0); } }), q.trim() ? 150 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [q, mode]);

  return { found, fileOpen, setFileOpen, appRows, openFiles };
}

// 파일 찾기: 고른 파일 내용 불러오기 (방향키로 빨리 지나가면 건너뛰고, 본 파일은 기억)
export function useFilePreview(curPath: string | undefined) {
  const [filePrev, setFilePrev] = useState<{ path: string; prev: FilePrev | null; loading: boolean } | null>(null); // 파일 찾기 오른쪽 미리보기
  const prevCache = useRef(new Map<string, FilePrev>());
  useEffect(() => {
    if (!curPath) return;
    const hit = prevCache.current.get(curPath);
    if (hit) { setFilePrev({ path: curPath, prev: hit, loading: false }); return; }
    setFilePrev({ path: curPath, prev: null, loading: true });
    let live = true;
    const t = setTimeout(() => invoke<FilePrev>("file_preview", { path: curPath })
      .then(p => { if (prevCache.current.size > 60) prevCache.current.clear(); prevCache.current.set(curPath, p); return p; }, () => null)
      .then(p => { if (live) setFilePrev({ path: curPath, prev: p, loading: false }); }), 120);
    return () => { live = false; clearTimeout(t); };
  }, [curPath]);
  return filePrev;
}
