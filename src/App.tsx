import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { query, fileItems, storeItems, iconFor, loadConfig, Item, Action, View, Ui, StoreEntry } from "./commands";

function Icon({ it }: { it: Item }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setSrc(null);
    if (it.path) iconFor(it.path).then(s => { if (live) setSrc(s); });
    return () => { live = false; };
  }, [it.path]);
  if (src) return <img className="icon" src={src} alt="" />;
  return <span className={`icon glyph ${it.kind}`}>{it.glyph ?? it.title[0]}</span>;
}

// 권한별 안내 문구
const PERMS: Record<string, { title: string; body: string }> = {
  accessibility: {
    title: "손쉬운 사용 권한이 필요해요",
    body: "창 관리와 붙여넣기는 다른 앱의 창과 키보드를 제어해야 해서 이 권한이 필요해요.\n\n" +
      "Enter를 누르면 시스템 설정 → 개인정보 보호 및 보안 → 손쉬운 사용 화면이 열려요. 목록에서 Baro를 켜 주세요. " +
      "목록에 없으면 + 버튼으로 /Applications/Baro.app을 추가하세요.\n\n" +
      "Baro를 새로 빌드해 설치하면 권한이 풀릴 수 있어요. 그때는 목록에서 Baro를 지웠다가 다시 추가하세요.",
  },
  automation: {
    title: "자동화 권한이 필요해요",
    body: "휴지통 비우기(Finder)와 다크 모드 전환(System Events)은 다른 앱에 명령을 보내야 해서 이 권한이 필요해요.\n\n" +
      "처음 실행할 때 macOS가 \"Baro가 Finder를 제어하려고 합니다\"라고 물으면 허용을 누르세요. 이미 거절했다면 " +
      "Enter를 눌러 시스템 설정 → 개인정보 보호 및 보안 → 자동화에서 Baro 아래 항목을 켜 주세요.",
  },
  ok: {
    title: "필요한 권한이 모두 있어요",
    body: "손쉬운 사용: 허용됨\n자동화: 휴지통 비우기·다크 모드를 처음 쓸 때 macOS가 따로 물어봐요.",
  },
};

type Ai = { id: number; q: string; text: string; busy: boolean; error: string | null };
type Store = { entries: StoreEntry[]; loading: boolean; error: string | null };

export default function App() {
  const [q, setQ] = useState("");
  const [top, setTop] = useState<Item[]>([]);
  const [bottom, setBottom] = useState<Item[]>([]);
  const [files, setFiles] = useState<Item[]>([]);
  const [sel, setSel] = useState(0);
  const [menu, setMenu] = useState(false); // ⌘K 액션 패널
  const [asel, setAsel] = useState(0);
  // 확인 대기 중인 동작 (스토어 항목은 매번 새로 만들어지므로 "항목 id:동작 이름"으로 구분)
  const [pending, setPending] = useState<{ key: string; confirm: string } | null>(null);
  const [ai, setAi] = useState<Ai | null>(null); // AI 답변 화면
  const [view, setView] = useState<View | null>(null); // 텍스트 결과·권한 안내 화면
  const [store, setStore] = useState<Store | null>(null); // 확장 스토어 화면
  const aiSeq = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const seq = useRef(0);
  const [rev, setRev] = useState(0);

  const ask = (question: string) => {
    const id = ++aiSeq.current;
    setView(null);
    setAi({ id, q: question, text: "", busy: true, error: null });
    setMenu(false);
    invoke("ask_ai", { id, prompt: question })
      .catch(e => setAi(a => a && a.id === id ? { ...a, busy: false, error: String(e) } : a));
  };
  const loadStore = () => {
    setStore(s => ({ entries: s?.entries ?? [], loading: true, error: null }));
    invoke<StoreEntry[]>("store_list")
      .then(entries => setStore({ entries, loading: false, error: null }))
      .catch(e => setStore({ entries: [], loading: false, error: String(e) }));
  };
  const ui: Ui = {
    ask,
    show: v => { setAi(null); setView(v); },
    openStore: () => { setQ(""); setView(null); setAi(null); loadStore(); },
  };
  const items = store ? storeItems(q, store.entries, () => setRev(r => r + 1), ui) : [...top, ...files, ...bottom];

  useEffect(() => {
    const uns = [
      // 창이 열릴 때마다 입력창 포커스, 설정·확장 다시 읽기
      listen("shown", () => {
        setMenu(false); setPending(null);
        loadConfig().then(() => setRev(r => r + 1));
        input.current?.focus(); input.current?.select();
      }),
      // 인덱싱이 끝나면 현재 검색어로 다시 조회
      listen("indexed", () => setRev(r => r + 1)),
      listen<{ id: number; text: string }>("ai-chunk", e =>
        setAi(a => a && a.id === e.payload.id ? { ...a, text: a.text + e.payload.text } : a)),
      listen<{ id: number; error: string | null }>("ai-done", e =>
        setAi(a => a && a.id === e.payload.id ? { ...a, busy: false, error: e.payload.error } : a)),
    ];
    loadConfig().then(() => setRev(r => r + 1));
    return () => { uns.forEach(u => u.then(f => f())); };
  }, []);

  // 빠른 결과: 최신 요청 결과만 반영
  useEffect(() => {
    const id = ++seq.current;
    setSel(0); setMenu(false); setPending(null);
    if (store) return;
    query(q, ui).then(r => {
      if (id !== seq.current) return;
      setTop(r.top); setBottom(r.bottom);
    });
  }, [q, rev, !!store]);

  // 파일 검색: 입력이 멈추면 실행
  useEffect(() => {
    setFiles([]);
    if (store) return;
    const t = setTimeout(() => {
      const id = seq.current;
      fileItems(q).then(f => { if (id === seq.current) setFiles(f); });
    }, 180);
    return () => clearTimeout(t);
  }, [q, !!store]);

  // 선택 항목이 보이도록 스크롤
  useEffect(() => { list.current?.children[sel]?.scrollIntoView({ block: "nearest" }); }, [sel]);

  const fail = (e: unknown) => {
    const msg = String(e);
    setAi(null);
    setView(msg.startsWith("PERM:") ? { kind: "perm", perm: msg.slice(5) } : { kind: "text", title: "실행하지 못했어요", text: msg, error: true });
  };
  const cur = items[sel];
  const run = (a?: Action, it: Item | undefined = cur) => {
    if (!a || !it) return;
    const key = `${it.id}:${a.title}`;
    if (a.confirm && pending?.key !== key) { setPending({ key, confirm: a.confirm }); setMenu(false); return; }
    setPending(null); setMenu(false);
    a.run().catch(fail);
    if (!a.title.startsWith("AI") && !store) setQ("");
  };

  const onKey = (e: React.KeyboardEvent) => {
    // ⌘K: 한글 자판에선 e.key가 "ㅏ"라서 물리 키(e.code)로 판별
    if ((e.metaKey || e.ctrlKey) && e.code === "KeyK") {
      e.preventDefault();
      if (ai || view) return;
      if (cur) { setMenu(m => !m); setAsel(0); }
      return;
    }
    // 한글 조합 중 키 입력은 무시 (WebKit은 isComposing 대신 keyCode 229를 줌)
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (view) {
      // 결과·권한 화면: Enter는 (권한이면) 설정 열기 / 결과 복사, Esc는 돌아가기
      if (e.key === "Escape") { setView(null); input.current?.select(); }
      else if (e.key === "Enter") {
        e.preventDefault();
        if (view.kind === "perm" && view.perm !== "ok") invoke("open_settings", { kind: view.perm });
        else if (view.kind === "text") navigator.clipboard.writeText(view.text);
      }
      return;
    }
    if (e.key === "Tab" && !store) { e.preventDefault(); if (q.trim()) ask(q.trim()); return; }
    if (ai) {
      // AI 화면: Enter는 입력한 내용으로 다시 질문, ⇧Enter로 답변 복사
      if (e.key === "Escape") { setAi(null); input.current?.select(); }
      else if (e.key === "Enter" && e.shiftKey) { e.preventDefault(); navigator.clipboard.writeText(ai.text); }
      else if (e.key === "Enter") { e.preventDefault(); if (q.trim() && !ai.busy) ask(q.trim()); }
      return;
    }
    const n = menu ? cur?.actions.length ?? 0 : items.length;
    const move = menu ? setAsel : setSel;
    if (e.key === "ArrowDown") { e.preventDefault(); setPending(null); move(s => Math.min(s + 1, n - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setPending(null); move(s => Math.max(s - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); run(menu ? cur?.actions[asel] : cur?.actions[0]); }
    // Esc: 확인 취소 → 액션 패널 닫기 → 입력 지우기 → 스토어 나가기 → 창 닫기
    else if (e.key === "Escape") {
      if (pending) setPending(null); else if (menu) setMenu(false); else if (q) setQ("");
      else if (store) setStore(null); else invoke("hide");
    }
  };

  const perm = view?.kind === "perm" ? PERMS[view.perm] ?? PERMS.accessibility : null;
  const footerKeys: [string, string[]][] = view
    ? [[view.kind === "perm" ? (view.perm === "ok" ? "" : "시스템 설정 열기") : "결과 복사", ["↵"]], ["돌아가기", ["esc"]]]
    : ai ? [["답변 복사", ["⇧", "↵"]], ["돌아가기", ["esc"]]]
    : cur ? [[cur.actions[0].title, ["↵"]], ["액션", ["⌘", "K"]]] : [];

  return (
    <main className="panel">
      <input ref={input} className="search" value={q} autoFocus spellCheck={false}
        placeholder={ai ? "다시 물어보기" : store ? "확장 검색" : "앱, 파일, 명령, 계산, AI에게 묻기"}
        onChange={e => setQ(e.target.value)} onKeyDown={onKey} />
      {view ? (
        <section className="ai-view">
          {perm ? <>
            <div className="view-title">{perm.title}</div>
            <p className="ai-a">{perm.body}</p>
          </> : view.kind === "text" && <>
            <div className="view-title">{view.title}</div>
            <p className={view.error ? "ai-err" : "ai-a mono"}>{view.text}</p>
          </>}
        </section>
      ) : ai ? (
        <section className="ai-view">
          <div className="ai-q"><span className="icon glyph ai">✦</span>{ai.q}</div>
          {ai.error ? <p className="ai-err">{ai.error}</p>
            : <p className="ai-a">{ai.text}{ai.busy && <span className="caret" />}</p>}
        </section>
      ) : (
        <ul className="list" role="listbox" ref={list}>
          {store && <li className="section">확장 스토어{store.loading ? " · 불러오는 중…" : ""}</li>}
          {items.map((it, i) => (
            <li key={it.id} role="option" aria-selected={i === sel} className={i === sel ? "row on" : "row"}
              onMouseMove={() => !menu && sel !== i && (setSel(i), setPending(null))} onClick={() => run(it.actions[0], it)}>
              <Icon it={it} />
              <span className="title">{it.title}</span><span className="sub">{it.subtitle}</span>
            </li>
          ))}
          {store?.error && <li className="empty">{store.error}</li>}
          {!store && q && !items.length && <li className="empty">결과가 없습니다. 다른 이름으로 검색해 보세요.</li>}
        </ul>
      )}
      {menu && cur && !ai && !view && (
        <div className="menu" role="menu">
          <div className="menu-head">{cur.title}</div>
          {cur.actions.map((a, i) => (
            <div key={a.title} role="menuitem" className={i === asel ? "act on" : "act"}
              onMouseMove={() => setAsel(i)} onMouseDown={e => { e.preventDefault(); run(a); }}>
              <span>{a.title}</span>{i === 0 && <kbd>↵</kbd>}
            </div>
          ))}
        </div>
      )}
      <footer className="foot">
        {pending ? <span className="warn">{pending.confirm}</span> : <span className="brand">Baro</span>}
        {!pending && <span className="keys">
          {footerKeys.filter(([label]) => label).map(([label, keys], i) => (
            <span key={label} className={i === 1 && menu ? "on" : ""}>
              {i > 0 && <span className="sep" />}{label} {keys.map(k => <kbd key={k}>{k}</kbd>)}
            </span>
          ))}
        </span>}
      </footer>
    </main>
  );
}
