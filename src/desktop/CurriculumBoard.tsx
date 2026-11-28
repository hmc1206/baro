// 바탕화면 "커리큘럼" 화면
// 왼쪽 = 분야별 진행. 분야를 누르면 그 아래로 단계 목록이 펼쳐지고, 단계를 누르면 개념까지
// 오른쪽 = 고른 분야의 다음 할 일·복습할 개념. 개념을 누르면 아래 카드가 그 개념 내용으로 바뀌고, "공부 카드"로 런처의 공부 카드를 엶
// 런처 커리큘럼과 같은 데이터(loadDocs·nextUp·conceptDocs)를 읽음
import { useEffect, useMemo, useState } from "react";
import { marked } from "marked";
import { invoke } from "@tauri-apps/api/core";
import { getConfig, loadConfig } from "../commands";
import { byStage, conceptDocs, conceptsOf, loadDocs, nextUp, type Concept, type Doc, type NoteSearch } from "../notes";

type Field = { key: string; search: NoteSearch; name: string; stages: Doc[]; done: number; total: number; unit: string; stage: string; hub: string };
type Next = { field: string; search: NoteSearch; d: Doc };
// 아래 카드에 보여 줄 개념: 어느 커리큘럼·단계의 어느 개념인지 + 읽어 온 개념 노트
type Focus = { search: NoteSearch; stage: Doc; c: Concept; doc?: Doc; loading: boolean; error?: string };
type Data = { fields: Field[]; next: Next[]; loaded: boolean; error: string | null };

const PICK_KEY = "baro.desktop.study.field";
const isDone = (s?: string) => s === "완료" || s === "done";
const isDoing = (s?: string) => s === "학습 중" || s === "doing";

// 분야 하나의 진행: 개념 체크박스가 있으면 개념 수, 없으면(보안처럼) 단계 수
export function fieldProgress(stages: Doc[]): { done: number; total: number; unit: string; stage: string } {
  const sorted = [...stages].sort(byStage);
  const cs = sorted.flatMap(conceptsOf).filter(c => c.hubIndex >= 0);
  const cur = sorted.find(s => !isDone(s.meta.status)) ?? sorted[sorted.length - 1];
  const stage = cur?.heading ?? cur?.name ?? "";
  return cs.length
    ? { done: cs.filter(c => isDone(c.status)).length, total: cs.length, unit: "개념", stage }
    : { done: sorted.filter(s => isDone(s.meta.status)).length, total: sorted.length, unit: "단계", stage };
}

async function load(): Promise<Omit<Data, "loaded">> {
  // 바탕화면 창은 런처와 따로라 설정을 직접 읽음
  const cfg = getConfig().note_searches.length ? getConfig() : await loadConfig();
  const searches = cfg.note_searches.filter(s => s.kind === "curriculum");
  if (!searches.length) return { fields: [], next: [], error: "config.json에 커리큘럼(kind: curriculum) 노트 검색이 없어요" };
  const fields: Field[] = [], next: Next[] = [], errs: string[] = [];
  for (const search of searches) {
    try {
      const docs = await loadDocs(search);
      const byField = new Map<string, Doc[]>();
      for (const d of docs) byField.set(d.category || search.name, [...byField.get(d.category || search.name) ?? [], d]);
      for (const [name, stages] of byField)
        fields.push({ key: `${search.id}:${name}`, search, name, stages: [...stages].sort(byStage), hub: stages[0].file, ...fieldProgress(stages) });
      next.push(...nextUp(docs).map(d => ({ field: `${search.id}:${d.category || search.name}`, search, d })));
    } catch (e) { errs.push(`${search.name}: ${e}`); }
  }
  return { fields, next, error: errs.length ? errs.join("\n") : null };
}

export function CurriculumBoard() {
  const [data, setData] = useState<Data>({ fields: [], next: [], loaded: false, error: null });
  const [pick, setPick] = useState<string | null>(() => { try { return localStorage.getItem(PICK_KEY); } catch { return null; } });
  const [openStage, setOpenStage] = useState<string | null>(null);
  const [focus, setFocus] = useState<Focus | null>(null);
  // 개념 노트 읽기 (단계의 개념 노트를 한 번에 읽고 그중 이 개념)
  const show = (search: NoteSearch, stage: Doc, c: Concept) => {
    const same = (x: Concept) => x.hubFile === c.hubFile && x.hubIndex === c.hubIndex && x.name === c.name;
    setFocus({ search, stage, c, loading: true });
    conceptDocs(search, stage)
      .then(ds => setFocus(f => f && same(f.c) ? { ...f, loading: false, doc: ds.find(d => d.concept && same(d.concept)) } : f))
      .catch(e => setFocus(f => f && same(f.c) ? { ...f, loading: false, error: String(e) } : f));
  };
  // 런처에서 그 개념의 공부 카드 열기
  const card = (x: Focus) => invoke("open_launcher", { action: `concept:${JSON.stringify({ id: x.search.id, file: x.stage.file, heading: x.stage.heading ?? "", name: x.c.name })}` });
  const focusHtml = useMemo(() => {
    const d = focus?.doc;
    if (!d) return "";
    const md = (d.body || "").replace(/<!--[\s\S]*?-->/g, "").trim();
    return marked.parse(md || (d.stub ? "_아직 개념 노트가 없어요. 공부 카드에서 만들 수 있어요_" : "_내용이 없는 노트예요_"), { async: false }) as string;
  }, [focus]);
  const reload = () => load().then(d => setData({ ...d, loaded: true }), e => setData(x => ({ ...x, loaded: true, error: String(e) })));
  useEffect(() => {
    reload();
    // 런처에서 공부하고 돌아오면 새로 (창이 다시 보일 때)
    const on = () => { if (document.visibilityState === "visible") reload(); };
    document.addEventListener("visibilitychange", on);
    window.addEventListener("focus", on);
    return () => { document.removeEventListener("visibilitychange", on); window.removeEventListener("focus", on); };
  }, []);
  // 고른 분야가 없거나 사라졌으면 첫 분야
  const field = data.fields.find(f => f.key === pick) ?? data.fields[0];
  const choose = (key: string) => {
    setPick(key); setOpenStage(null); setFocus(null);
    try { localStorage.setItem(PICK_KEY, key); } catch { /* 기억 못 해도 고르기는 됨 */ }
  };
  const study = (s: NoteSearch) => invoke("open_launcher", { action: `note:${s.id}` });
  const obsidian = (file: string) => invoke("open_url", { url: `obsidian://open?path=${encodeURIComponent(file)}` });
  const mine = data.next.filter(x => x.field === field?.key);
  const todo = mine.filter(x => x.d.next?.section === "다음 할 일");
  const review = mine.filter(x => x.d.next?.section !== "다음 할 일");
  const empty = (msg: string) => <p className="dk-cu-none">{data.loaded ? msg : "불러오는 중…"}</p>;
  const chip = (s?: string) => <span className={`dk-cu-chip${isDone(s) ? " done" : isDoing(s) ? " doing" : s === "복습 필요" || s === "review" ? " review" : ""}`}>{s || "학습 전"}</span>;

  // 오른쪽 카드 한 줄: 개념 + 단계 + 이유. 누르면 런처 공부 카드
  const row = ({ search, d }: Next) => {
    const c = d.next!.concept;
    return (
      <li key={`${c.hubFile}#${c.hubIndex}#${c.name}`} className={focus && focus.c.hubFile === c.hubFile && focus.c.hubIndex === c.hubIndex ? "on" : ""}
        onClick={() => show(search, d, c)} title="개념 내용 보기">
        <span className="dk-lt">{c.name}<small className="dk-cu-sub">{d.heading ?? d.name}</small></span>
        <span className="dk-lm">{d.next!.why}</span>
      </li>
    );
  };

  // 왼쪽에서 펼친 분야의 단계 목록 (단계를 누르면 개념까지)
  const stages = (f: Field) => (
    <ul className="dk-cu-stages">
      {f.stages.map(st => {
        const id = `${st.file}#${st.heading ?? ""}`;
        const cs = conceptsOf(st).filter(c => c.hubIndex >= 0);
        const done = cs.filter(c => isDone(c.status)).length;
        const open = openStage === id;
        return (
          <li key={id} className={open ? "on" : ""}>
            <div className="dk-cu-stage" onClick={e => { e.stopPropagation(); setOpenStage(open ? null : id); }}>
              <span className="dk-cu-name">{st.heading ?? st.name}</span>
              {cs.length > 0 && <em>{done}/{cs.length}</em>}
              {chip(st.meta.status)}
            </div>
            {open && (cs.length ? <ul className="dk-cu-concepts">
              {cs.map(c => (
                <li key={`${c.hubIndex}:${c.name}`} className={focus && focus.c.hubFile === c.hubFile && focus.c.hubIndex === c.hubIndex ? "on" : ""}
                  onClick={e => { e.stopPropagation(); show(f.search, st, c); }} title="개념 내용 보기">
                  <span className="dk-cu-name">{c.name}</span>
                  {chip(c.status)}
                </li>
              ))}
            </ul> : <p className="dk-cu-none">개념 목록이 없는 단계예요 · <button className="dk-link" onClick={e => { e.stopPropagation(); obsidian(st.file); }}>Obsidian에서 보기</button></p>)}
          </li>
        );
      })}
    </ul>
  );

  return (
    <main className="dk-board dk-cu">
      <section className="dk-glass dk-cu-fields">
        <div className="dk-box-k"><b>분야별 진행</b><span>누르면 단계가 펼쳐져요</span><button className="dk-link" onClick={reload}>새로 읽기</button></div>
        {data.fields.length ? <ul className="dk-cu-list">
          {data.fields.map(f => {
            const pct = f.total ? Math.round(f.done / f.total * 100) : 0;
            const on = f.key === field?.key;
            return (
              <li key={f.key} className={on ? "on" : ""} onClick={() => choose(f.key)}>
                <div className="dk-cu-head">
                  <b>{f.name}</b>
                  <em>{f.done}/{f.total} {f.unit} · {pct}%</em>
                </div>
                <div className="dk-cu-bar"><i style={{ width: `${pct}%` }} /></div>
                <div className="dk-cu-foot">
                  <span>지금: {f.stage || "—"}</span>
                  <button className="dk-link" onClick={e => { e.stopPropagation(); study(f.search); }}>공부하기</button>
                  <button className="dk-link" onClick={e => { e.stopPropagation(); obsidian(f.hub); }}>Obsidian</button>
                </div>
                {on && stages(f)}
              </li>
            );
          })}
        </ul> : empty("커리큘럼이 없어요")}
        {data.error && <p className="dk-cu-err">{data.error}</p>}
      </section>
      <div className="dk-cu-side">
        <section className="dk-glass">
          <div className="dk-box-k"><b>다음 할 일</b><span>{field?.name ?? ""}</span><em>{todo.length}</em></div>
          {todo.length ? <ul className="dk-rows">{todo.map(row)}</ul> : empty("이어서 할 개념이 없어요")}
        </section>
        {focus ? <section className="dk-glass dk-cu-focus">
          <div className="dk-box-k">
            <b>{focus.c.name}</b>{chip(focus.c.status)}
            <button className="dk-x" onClick={() => setFocus(null)} title="복습할 개념으로 돌아가기">✕</button>
          </div>
          <small className="dk-cu-sub">{focus.stage.heading ?? focus.stage.name}{focus.c.review ? ` · 복습일 ${focus.c.review}` : ""}{focus.c.prereq && focus.c.prereq !== "없음" ? ` · 선행 ${focus.c.prereq}` : ""}</small>
          {focus.c.desc && <p className="dk-cu-desc">{focus.c.desc}</p>}
          {focus.loading ? empty("") : focus.error ? <p className="dk-cu-err">{focus.error}</p>
            : <article className="md dk-cu-md" dangerouslySetInnerHTML={{ __html: focusHtml }} />}
          <div className="dk-cu-acts">
            <button className="dk-btn primary" onClick={() => card(focus)}>공부 카드</button>
            {focus.doc?.file && <button className="dk-btn" onClick={() => obsidian(focus.doc!.file)}>Obsidian에서 열기</button>}
          </div>
        </section> : <section className="dk-glass">
          <div className="dk-box-k"><b>복습할 개념</b><span>{field?.name ?? ""}</span><em>{review.length}</em></div>
          {review.length ? <ul className="dk-rows">{review.map(row)}</ul> : empty("오늘 복습할 개념이 없어요")}
        </section>}
      </div>
    </main>
  );
}
