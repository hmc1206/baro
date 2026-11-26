// 빠른 메모 화면: 저장할 곳 목록, 기록 쓰기·고치기·지우기·되돌리기, 사진, 오른쪽 기록 칸
// App.tsx에서 동작 그대로 옮김. 입력칸(q)과 선택(sel)은 App이 가지고, 여기서는 받아서 씀
import { useEffect, useMemo, useRef, useState, type Dispatch, type MouseEvent, type RefObject, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { marked } from "marked";
import { getConfig, Item, Action } from "../commands";
import { loadDocs, byStage, conceptDocs, criteriaOf, criterionHints, questionsOf, evidencePlan, Criterion, Doc } from "../notes";
import type { Mode, Notes, Stage, Shot, Memo, Removed, RecItem } from "./types";
import { isDone, isDoing, docCache, docsSig } from "./status";
import { RECORD, now, cmdBlock, listBlock, itemsOf, sectionRaw, dailyRaw, editTextOf, editBlockOf } from "./memo";

type Conc = { stage: Doc } | null;
export type MemoCtx = {
  q: string; setQ: Dispatch<SetStateAction<string>>;
  sel: number; setSel: Dispatch<SetStateAction<number>>;
  mode: Mode; enter: (m: Mode) => void;
  input: RefObject<HTMLInputElement & HTMLTextAreaElement | null>;
  notes: Notes; reloadDocs: () => Promise<void>; conc: Conc;
  stampStudied: (file: string) => Promise<unknown>;
};

export function useMemoScreen({ q, setQ, sel, setSel, mode, enter, input, notes, reloadDocs, conc, stampStudied }: MemoCtx) {
  const [memo, setMemo] = useState<Memo>({ stage: null, from: null, saved: null, error: null });
  const [delPending, setDelPending] = useState<string | null>(null); // 한 번 누른 × ("칸:번호")
  const [removed, setRemoved] = useState<Removed | null>(null);
  const [editing, setEditing] = useState<{ sec: string; i: number; first: string; time?: string } | null>(null); // ✎로 고치는 중인 기록
  const [shots, setShots] = useState<Record<string, string>>({}); // 메모 기록 속 사진: "id|file|이름" → data URL ("" = 못 읽음)
  const recRef = useRef<HTMLElement>(null);
  const shotList = useRef(""); // 방금 사진 링크를 넣은 첨부 목록 노트 (저장 안내에 표시)
  const memoDest = useRef(0); // 빠른 메모: 마지막으로 고른 저장할 곳 (사진 넣은 뒤 그 칸으로 돌아가기)
  // 빠른 메모가 개념 노트를 향할 때 그 노트의 완료 기준 (검증·설명·재현)
  const crit = useMemo(() => memo.stage?.doc.concept && memo.stage.doc.file ? criteriaOf(memo.stage.doc) : [], [memo.stage]);
  // 빠른 메모 열기. stage가 없으면 커리큘럼에서 "진행 중"(없으면 아직 안 끝난 첫) 단계를 찾음 (목차 노트 제외)
  const openMemo = (stage?: Stage, from: Mode = null) => {
    setMemo({ stage: stage ?? null, from, saved: null, error: null, finding: !stage });
    setDelPending(null); setRemoved(null); setEditing(null);
    enter("memo");
    loadDaily();
    if (stage) return;
    (async () => {
      for (const s of getConfig().note_searches.filter(n => n.kind === "curriculum")) {
        let docs = docCache.get(s.id)?.docs;
        if (!docs) { docs = await loadDocs(s).catch(() => [] as Doc[]); docCache.set(s.id, { docs, sig: docsSig(docs) }); }
        // 허브 단계는 연결된 단계 노트에 기록 (없으면 건너뜀)
        const stages = docs.filter(d => !d.aliases.includes("moc") && (!d.heading || d.record)).sort(byStage);
        const doc = stages.find(d => isDoing(d.meta.status)) ?? stages.find(d => !isDone(d.meta.status));
        if (doc) { setMemo(m => ({ ...m, stage: { search: s, doc: doc.record ?? doc }, finding: false })); return; }
      }
      setMemo(m => ({ ...m, finding: false }));
    })();
  };
  const loadDaily = () => { const date = now().date; return invoke<string>("memo_daily_read", { date }).then(daily => setMemo(m => ({ ...m, daily, dailyDate: date }))).catch(() => {}); };
  // 단계 노트를 다시 읽어 오른쪽 기록을 새로 (커리큘럼 화면도)
  const refreshStage = (st: Stage) => {
    docCache.delete(st.search.id);
    if (notes.search?.id === st.search.id) reloadDocs();
    loadDocs(st.search).then(docs => {
      const doc = docs.map(d => d.record ?? d).find(d => d.file === st.doc.file);
      if (doc) setMemo(m => m.stage?.doc.file === doc.file ? { ...m, stage: { ...m.stage, doc } } : m);
      else if (conc) conceptDocs(st.search, conc.stage).then(cd => { // 개념 노트에 기록한 경우
        const d = cd.find(x => x.file === st.doc.file);
        if (d) setMemo(m => m.stage?.doc.file === d.file ? { ...m, stage: { ...m.stage, doc: d } } : m);
      });
    }).catch(() => {});
  };
  // 기록 지우기 (×를 두 번). 지운 내용은 ⌘Z로 되돌릴 수 있게 보관
  const removeRecord = async (sec: string, i: number) => {
    setDelPending(null);
    const st = memo.stage, daily = sec === "daily";
    const list = daily ? itemsOf(dailyRaw(memo.daily ?? "")) : itemsOf(sectionRaw(st?.doc.body ?? "", sec));
    const item = list[i];
    if (!item || (!daily && !st)) return;
    const args = { id: st?.search.id ?? "", file: st?.doc.file ?? "", date: memo.dailyDate ?? now().date, section: sec };
    await invoke<{ line: number; text: string }>("memo_remove", { ...args, index: i, first: item.first })
      .then(r => {
        setRemoved({ sec, id: args.id, file: args.file, date: args.date, line: r.line, text: r.text });
        setMemo(m => ({ ...m, saved: "지웠어요 · ⌘Z로 되돌리기", error: null }));
        if (daily) loadDaily(); else refreshStage(st!);
      }).catch(memoFail);
  };
  const undoRemove = async () => {
    const r = removed;
    if (!r) return;
    await invoke("memo_restore", { id: r.id, file: r.file, date: r.date, section: r.sec, line: r.line, text: r.text })
      .then(() => {
        setRemoved(null);
        setMemo(m => ({ ...m, saved: "되돌렸어요", error: null }));
        if (r.sec === "daily") loadDaily(); else if (memo.stage) refreshStage(memo.stage);
      }).catch(memoFail);
  };
  // 기록 고치기 (✎): 그 항목 글을 입력칸에 불러오고, Enter로 같은 자리에 덮어씀
  const recordsOf = (sec: string) => sec === "daily" ? itemsOf(dailyRaw(memo.daily ?? "")) : itemsOf(sectionRaw(memo.stage?.doc.body ?? "", sec));
  const startEdit = (sec: string, i: number) => {
    // 완료 기준 증거("crit:기준번호"): 앞 날짜는 떼어 두고 글만 불러옴
    if (sec.startsWith("crit:")) {
      const ev = crit[Number(sec.slice(5))]?.evidence[i];
      if (ev === undefined) return;
      const m = ev.match(/^(\d{4}-\d\d-\d\d) ?([\s\S]*)$/);
      setDelPending(null); setEditing({ sec, i, first: ev.split("\n")[0], time: m?.[1] }); setQ(m ? m[2] : ev); setSel(0);
      setMemo(m => ({ ...m, saved: null, error: null }));
      requestAnimationFrame(() => input.current?.focus());
      return;
    }
    const item = recordsOf(sec)[i];
    if (!item) return;
    const { text, time } = editTextOf(item, sec);
    setDelPending(null); setEditing({ sec, i, first: item.first, time }); setQ(text); setSel(0);
    setMemo(m => ({ ...m, saved: null, error: null }));
    requestAnimationFrame(() => input.current?.focus());
  };
  const cancelEdit = () => { setEditing(null); setQ(""); };
  const saveEdit = async () => {
    const ed = editing, st = memo.stage, daily = ed?.sec === "daily";
    if (!ed || !q.trim() || (!daily && !st)) return;
    const c = ed.sec.startsWith("crit:") ? crit[Number(ed.sec.slice(5))] : null;
    if (c && st) {
      await invoke("note_edit_evidence", { id: st.search.id, file: st.doc.file, index: (st.doc.taskBase ?? 0) + c.index, text: c.text,
        n: ed.i, first: ed.first, body: q, field: /재현/.test(c.label) ? c.label : null })
        .then(() => { setEditing(null); setQ(""); setMemo(m => ({ ...m, saved: `${c.label} 증거를 고쳤어요`, error: null })); refreshStage(st); })
        .catch(memoFail);
      return;
    }
    await invoke("memo_replace", { id: st?.search.id ?? "", file: st?.doc.file ?? "", date: memo.dailyDate ?? now().date,
      section: ed.sec, index: ed.i, first: ed.first, text: editBlockOf(ed.sec, q, ed.time) })
      .then(() => {
        setEditing(null); setQ(""); setRemoved(null);
        setMemo(m => ({ ...m, saved: "고쳤어요", error: null }));
        if (daily) loadDaily(); else refreshStage(st!);
      }).catch(memoFail);
  };
  const onRecClick = (e: MouseEvent<HTMLElement>) => {
    const ed = (e.target as HTMLElement).closest<HTMLElement>(".rec-edit");
    if (ed) { startEdit(ed.dataset.sec!, Number(ed.dataset.i)); return; }
    const b = (e.target as HTMLElement).closest<HTMLElement>(".rec-del");
    if (!b) { setDelPending(null); return; }
    const key = `${b.dataset.sec}:${b.dataset.i}`;
    if (delPending === key) removeRecord(b.dataset.sec!, Number(b.dataset.i));
    else setDelPending(key);
  };
  const memoDone = (saved: string) => {
    const list = shotList.current;
    shotList.current = "";
    setMemo(m => ({ ...m, saved: list ? `${saved} · 사진은 ${list}에도 추가` : saved, error: null })); setQ("");
  };
  const memoFail = (e: unknown) => { shotList.current = ""; setMemo(m => ({ ...m, saved: null, error: String(e) })); };
  const saveDaily = async (text: string) => {
    if (!text) return;
    const { date, time } = now();
    await invoke("memo_daily", { date, time, text }).then(() => { memoDone(`오늘 Daily에 적었어요 · ${time}`); loadDaily(); }).catch(memoFail);
  };
  const saveRecord = async (section: string, block: string) => {
    const st = memo.stage;
    if (!st || !block.trim()) return;
    await invoke("note_add_record", { id: st.search.id, file: st.doc.file, section, block })
      .then(() => {
        memoDone(`${st.doc.name.split(":")[0]} · ${section}에 기록했어요`);
        refreshStage(st); // 오른쪽 기록과 커리큘럼 화면을 새 내용으로
      }).catch(memoFail);
  };
  // 개념 메모: 완료 기준 줄 아래에 증거를 달고 체크 (재현은 머리말 evidence에도)
  const saveEvidence = async (c: Criterion, block: string) => {
    const st = memo.stage;
    if (!st || !block.trim()) return;
    const today = now().date, d = st.doc, plan = evidencePlan(crit, c, d, today);
    const set = (key: string, value: string) => invoke("note_set_field", { id: st.search.id, file: d.file, key, value });
    await invoke("note_add_evidence", { id: st.search.id, file: d.file, index: (d.taskBase ?? 0) + c.index, text: c.text,
      date: today, body: block, field: /재현/.test(c.label) ? c.label : null })
      .then(() => stampStudied(d.file))
      // 상태·복습일·허브 상태는 Baro가 맞춤 (머리말이 없는 노트면 건너뜀)
      .then(() => plan.status ? set("status", plan.status).catch(() => {}) : undefined)
      .then(() => plan.review ? set("next_review", plan.review).catch(() => {}) : undefined)
      .then(() => plan.hub && d.concept ? invoke("note_task_state",
        { id: st.search.id, file: d.concept.hubFile, index: d.concept.hubIndex, text: d.concept.hubText, value: plan.hub }).catch(() => {}) : undefined)
      .then(() => {
        const more = [plan.hub ? `허브 ${plan.hub}` : "", plan.status ? `status ${plan.status}` : "", plan.review ? `다음 복습 ${plan.review.slice(5)}` : ""].filter(Boolean);
        memoDone(`${d.name.split(" ")[0]} · ${c.label} 증거를 적고 체크했어요${more.length ? ` · ${more.join(" · ")}` : ""}`);
        refreshStage(st);
      }).catch(memoFail);
  };
  const saveClipboard = async () => {
    const clip = (await invoke<string>("clipboard_text").catch(() => "")).trim();
    if (!clip) return memoFail("클립보드가 비어 있어요.");
    await saveRecord(RECORD.cmd, cmdBlock(clip));
  };
  // 스크린샷 파일 이름: 메모 첫 줄 (비어 있으면 스크린샷-시각)
  const shotName = (text: string) => text.split("\n")[0].trim() || `스크린샷-${now().time.replace(":", "")}`;
  // 붙인 스크린샷을 메모할 노트 옆 attachments/에 저장하고 "![[파일]]"을 돌려줌. 없으면 "", 실패하면 null
  const attachShot = async (text: string, id: string, file: string): Promise<string | null> => {
    const s = memo.shot;
    if (!s) return "";
    try {
      const [f, list] = await invoke<[string, string]>("shot_save", { source: s.source, path: s.path, name: shotName(text), date: now().date, id, file });
      setMemo(m => ({ ...m, shot: null }));
      shotList.current = list;
      return `![[${f}]]`;
    } catch (e) { memoFail(e); return null; }
  };
  const toggleShot = async () => memo.shot ? setMemo(m => ({ ...m, shot: null }))
    : invoke<Shot>("shot_latest").then(shot => setMemo(m => ({ ...m, shot, saved: null, error: null }))).catch(memoFail);
  // 메모 화면 목록: 저장할 곳 (순서 고정). "!"·"$"로 시작하면 막힌 점·명령어로 선택이 옮겨 가고 그 글자는 빼고 저장
  const memoItems = (): Item[] => {
    const raw = q.trim(), pre = raw[0] === "!" || raw[0] === "$";
    const text = pre ? raw.slice(1).trim() : raw;
    const st = memo.stage, short = st?.doc.name.split(":")[0] ?? "";
    if (editing) {
      const where = editing.sec === "daily" ? "오늘 Daily"
        : editing.sec.startsWith("crit:") ? `${short} · ${crit[Number(editing.sec.slice(5))]?.label ?? ""} 증거` : `${short} · ${editing.sec}`;
      return [
        { id: "memo-edit-save", title: "고친 내용 저장", subtitle: `${where} · ${editing.i + 1}번째 기록 자리에 덮어써요`, kind: "wiki", glyph: "memo",
          actions: [{ title: "저장", keep: true, run: saveEdit }] },
        { id: "memo-edit-cancel", title: "고치기 취소", subtitle: "Esc", kind: "wiki", glyph: "pause",
          actions: [{ title: "취소", keep: true, run: async () => cancelEdit() }] },
      ];
    }
    // ⌘O: 메모를 적을 노트를 Obsidian에서 열기
    const openNote = (file: string) => invoke("open_url", { url: `obsidian://open?path=${encodeURIComponent(file)}` });
    const openStage: Action = { title: "이 노트 열기 (Obsidian)", shortcut: "⌘O", run: async () => { if (st) await openNote(st.doc.file); } };
    const openDaily: Action = { title: "오늘 Daily 열기 (Obsidian)", shortcut: "⌘O",
      run: () => invoke<string>("memo_daily_path", { date: now().date }).then(openNote) };
    const rec = (section: string, glyph: string): Item => ({ id: `memo-${section}`, title: `${short} · ${section}`, subtitle: st!.doc.name, kind: "wiki", glyph,
      actions: [{ title: "기록", keep: true, run: async () => {
        if (!text && !memo.shot) return;
        const emb = await attachShot(text, st!.search.id, st!.doc.file);
        if (emb === null) return;
        await saveRecord(section, section === RECORD.cmd ? [text && cmdBlock(text), emb].filter(Boolean).join("\n") : listBlock([text, emb].filter(Boolean).join("\n")));
      } }, openStage] });
    // 개념 노트면 완료 기준(검증·설명·재현) 칸을 맨 위에: 적은 글을 그 기준의 증거로 달고 체크
    const crits = st ? crit.map((c, i): Item => ({ id: `memo-crit-${i}`, title: `${short} · ${c.label}${c.done ? " ✓" : ""}`, subtitle: c.desc, kind: "wiki", glyph: "curriculum",
      actions: [{ title: "증거 기록", keep: true, run: async () => {
        if (!text && !memo.shot) return;
        const emb = await attachShot(text, st.search.id, st.doc.file);
        if (emb === null) return;
        await saveEvidence(c, [text, emb].filter(Boolean).join("\n"));
      } }, openStage] })) : [];
    const recs = st ? [...crits, rec(RECORD.learn, "learn"), rec(RECORD.stuck, "stuck"), rec(RECORD.cmd, "cmdlog")] : [];
    const daily: Item = { id: "memo-daily", title: "오늘 Daily에 메모", subtitle: `03_Daily/${now().date}.md`, kind: "wiki", glyph: "daily",
      actions: [{ title: "메모", keep: true, run: async () => {
        if (!raw && !memo.shot) return;
        const emb = await attachShot(raw, "", "");
        if (emb !== null) await saveDaily([raw, emb].filter(Boolean).join("\n"));
      } }, openDaily] };
    // 클립보드 기록은 입력이 비어 있을 때만 (입력한 메모 대신 클립보드가 저장되는 실수 방지). 맨 끝이라 다른 칸 순서는 그대로
    const clip: Item[] = st && !raw ? [{ id: "memo-clip", title: "클립보드를 명령어로 기록", subtitle: `${short} · ${RECORD.cmd}`, kind: "wiki", glyph: "clip",
      actions: [{ title: "기록", keep: true, run: saveClipboard }] }] : [];
    // 사진 같이 넣기: 복사한 스크린샷을 메모에 붙이고, 고르던 저장할 곳으로 선택을 되돌림 (입력한 글은 그대로)
    const photo: Item = { id: "memo-shot", kind: "wiki", glyph: memo.shot ? "imageOff" : "image",
      title: memo.shot ? "사진 빼기" : "사진 같이 넣기",
      subtitle: memo.shot ? "붙인 사진을 메모에서 빼요 · ⌘I" : "복사한 스크린샷(⌘⌃⇧4)을 메모에 붙여요 · ⌘I",
      actions: [{ title: memo.shot ? "빼기" : "넣기", keep: true, run: async () => { await toggleShot(); setSel(memoDest.current); } }] };
    return [...recs, daily, photo, ...clip];
  };
  // 빠른 메모 오른쪽: 단계의 "내 기록" 세 칸과 오늘 Daily 메모 (칸마다 최근 6개)
  const memoSel = mode === "memo" ? memoItems()[sel]?.id ?? "" : "";
  useEffect(() => { if (mode === "memo" && memoSel && memoSel !== "memo-shot") memoDest.current = sel; }, [mode, memoSel, sel]);
  const memoHtml = useMemo(() => {
    if (mode !== "memo") return "";
    // 기록 속 "![[사진]]"을 그 노트 옆 attachments/의 사진으로 (아직 안 읽었으면 이름만, 아래 effect가 읽어 옴)
    const md = (text: string, daily = false) => marked.parse(text.replace(/!\[\[([^\]|#/]+\.(?:png|jpe?g|heic|tiff))(?:\|[^\]]*)?\]\]/gi, (_, f: string) => {
      const key = daily ? `||${f}` : `${memo.stage?.search.id ?? ""}|${memo.stage?.doc.file ?? ""}|${f}`, src = shots[key];
      const name = f.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);
      return src ? `<img class="rec-shot" src="${src}" alt="${name}" title="${name}">` : `<span class="rec-shot-name" data-shot="${encodeURIComponent(key)}">🖼 ${name}</span>`;
    }), { async: false }) as string;
    const box = (on: boolean, title: string, sub: string, sec: string, items: RecItem[]) => {
      const shown = items.slice(-6), n = items.length;
      return `<section class="rec${on ? " on" : ""}"><h4>${title} <span>${n ? `${n}개${n > 6 ? " · 최근 6개" : ""}` : ""}</span></h4>`
        + (shown.length ? shown.map(it => {
          const ask = delPending === `${sec}:${it.i}`, ed = editing?.sec === sec && editing.i === it.i;
          return `<div class="rec-item${ed ? " editing" : ""}">${md(it.text, sec === "daily")}`
            + `<button class="rec-edit" data-sec="${sec}" data-i="${it.i}" title="고치기">✎</button>`
            + `<button class="rec-del${ask ? " ask" : ""}" data-sec="${sec}" data-i="${it.i}" title="지우기">${ask ? "지우기?" : "×"}</button></div>`;
        }).join("") : `<p class="none">${sub}</p>`) + "</section>";
    };
    const st = memo.stage, body = st?.doc.body ?? "";
    // 완료 기준 칸: 기준 설명과 지금까지 단 증거 (✎ 고치기, 지우기는 Obsidian에서)
    const critBox = (c: Criterion, i: number) => `<section class="rec${memoSel === `memo-crit-${i}` ? " on" : ""}"><h4>${c.label} <span>${c.done ? "✓ 체크됨" : "아직 체크 전"}${c.evidence.length ? ` · 증거 ${c.evidence.length}개` : ""}</span></h4>`
      + `<ol class="ask">${questionsOf(c).map(x => `<li>${marked.parseInline(x, { async: false }) as string}</li>`).join("")}</ol>`
      + (/재현/.test(c.label) ? `<p class="none">기록하면 체크·evidence·status·복습일은 자동으로 바뀌어요</p>` : "")
      + c.evidence.map((e, n) => ({ e, n })).slice(-6).map(({ e, n }) => `<div class="rec-item${editing?.sec === `crit:${i}` && editing.i === n ? " editing" : ""}">${md(e)}`
        + `<button class="rec-edit solo" data-sec="crit:${i}" data-i="${n}" title="고치기">✎</button></div>`).join("") + "</section>"
      + (memoSel === `memo-crit-${i}` && st ? hintBox((/검증/.test(c.label) && st.doc.expect
        ? `<details><summary>기대 관찰 (예측을 적은 뒤 펼치기)</summary>\n\n${st.doc.expect.see}\n\n**변형 도전** — ${st.doc.expect.vary}\n\n</details>\n\n` : "")
        + criterionHints(st.doc, c.label)) : "");
    // 고른 기준에 답할 때 볼 노트 본문 칸 (정답 모음이 따로 없어 근거 칸을 보여 줌)
    const hintBox = (md: string) => md ? `<section class="rec hint"><h4>답 근거 <span>이 노트 본문에서</span></h4>${marked.parse(md, { async: false }) as string}</section>` : "";
    return [
      ...crit.map(critBox),
      ...(st ? [RECORD.learn, RECORD.stuck, RECORD.cmd].map(s => box(memoSel === `memo-${s}` || (memoSel === "memo-clip" && s === RECORD.cmd),
        `${st.doc.name.split(":")[0]} · ${s}`, "아직 없음", s, itemsOf(sectionRaw(body, s)))) : []),
      box(memoSel === "memo-daily", "오늘 Daily", "오늘 적은 메모가 없어요", "daily", itemsOf(dailyRaw(memo.daily ?? ""))),
    ].join("");
  }, [mode, memo.stage, memo.daily, memoSel, delPending, crit, editing, shots]);
  // 아직 안 읽은 기록 속 사진을 읽어 와 다시 그림 (못 읽으면 이름만 남김)
  useEffect(() => {
    const keys = [...new Set(Array.from(recRef.current?.querySelectorAll<HTMLElement>("[data-shot]") ?? []).map(e => decodeURIComponent(e.dataset.shot!)))].filter(k => !(k in shots));
    keys.forEach(k => {
      const [id, file, name] = k.split("|");
      invoke<string>("shot_read", { id, file, name }).catch(() => "").then(src => setShots(s => ({ ...s, [k]: src })));
    });
  }, [memoHtml]);
  // 고른 칸이 보이게 스크롤
  useEffect(() => { recRef.current?.querySelector(".rec.on")?.scrollIntoView({ block: "nearest" }); }, [memoHtml]);

  return { memo, setMemo, crit, removed, delPending, setDelPending, editing, recRef, memoHtml,
    openMemo, memoItems, onRecClick, undoRemove, cancelEdit, toggleShot, shotName };
}
