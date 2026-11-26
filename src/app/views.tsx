// 화면 조각: App이 상태를 가지고, 여기서는 받은 값으로 그리기만 함 (동작은 App.tsx에 있던 그대로)
import { useEffect, useState, type Dispatch, type MouseEvent, type ReactNode, type Ref, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { iconFor, Item, Action, View } from "../commands";
import { Doc, NoteKind, KIND_LABELS } from "../notes";
import { ICONS } from "../icons";
import { fmtKey } from "./keys";
import type { Ai, Draft, PwDraft, Clip, Shot } from "./types";
import { clipDay, clipTime } from "./memo";

export function Icon({ it }: { it: Item }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setSrc(null);
    if (it.path) iconFor(it.path).then(s => { if (live) setSrc(s); });
    return () => { live = false; };
  }, [it.path]);
  if (src) return <img className="icon" src={src} alt="" />;
  const Svg = it.glyph ? ICONS[it.glyph] : undefined;
  return <span className={`icon glyph ${it.kind}`}>{Svg ? <Svg size={15} strokeWidth={2.2} /> : (it.glyph ?? it.title[0])}</span>;
}

// 왼쪽 목록: 구역 제목, 항목, 빈 안내
export function ItemList({ listRef, header, items, sel, warn, empty, onRow }: {
  listRef: Ref<HTMLUListElement>; header: string | null; items: Item[]; sel: number;
  warn?: string | null; empty: string | null; onRow: (it: Item, i: number) => void;
}) {
  return (
    // 목록을 클릭해도 입력창 포커스를 유지
    <ul className="list" role="listbox" ref={listRef} onMouseDown={e => e.preventDefault()}>
      {header && <li className="section">{header}</li>}
      {warn && <li className="empty warn">{warn}</li>}
      {items.map((it, i) => [
        it.section && it.section !== items[i - 1]?.section && <li key={`s-${i}`} className="section">{it.section}</li>,
        <li key={it.id} role="option" aria-selected={i === sel} className={i === sel ? "row on" : "row"}
          // 클릭하면 선택(미리보기 전환), 선택된 항목을 다시 누르면 실행
          onClick={() => onRow(it, i)}>
          <Icon it={it} />
          <span className="title">{it.title}</span><span className="sub">{it.subtitle}</span>
        </li>,
      ])}
      {empty && <li className="empty">{empty}</li>}
    </ul>
  );
}

// 텍스트 결과·권한 안내 화면
export function ResultView({ view, perm }: { view: View; perm: { title: string; body: string } | null }) {
  return (
    <section className="ai-view">
      {perm ? <>
        <div className="view-title">{perm.title}</div>
        <p className="ai-a">{perm.body}</p>
      </> : view.kind === "text" && <>
        <div className="view-title">{view.title}</div>
        <p className={view.error ? "ai-err" : "ai-a mono"}>{view.text}</p>
      </>}
    </section>
  );
}

// AI 답변 화면 (내 노트에게 묻기면 찾은 노트도)
export function AiView({ ai, onOpen }: { ai: Ai; onOpen: (file: string) => void }) {
  const S = ICONS[ai.notes ? "notesAi" : "ai"];
  return (
    <section className="ai-view">
      <div className="ai-q"><span className="icon glyph ai"><S size={15} strokeWidth={2.2} /></span>{ai.q}</div>
      {ai.error ? <p className="ai-err">{ai.error}</p>
        : <p className="ai-a">{ai.text}{ai.busy && <span className="caret" />}</p>}
      {ai.notes && !!ai.sources?.length && (
        <div className="links ai-sources">
          <div className="links-head">찾은 노트 {ai.sources.length} · 클릭하면 Obsidian에서 열기</div>
          <div className="links-list">{ai.sources.map((s, i) =>
            <button key={s.file} className="link-item" title={s.file} onClick={() => onOpen(s.file)}>[{i + 1}] {s.title}</button>)}</div>
        </div>
      )}
      {ai.notes && ai.busy && !ai.sources?.length && !ai.text && <p className="ai-saved">노트에서 찾는 중…</p>}
      {ai.saved && <p className="ai-saved">저장했어요: {ai.saved.replace(/^.*\/MyBrain\//, "")}</p>}
      {ai.saveError && <p className="ai-err">{ai.saveError}</p>}
    </section>
  );
}

// 비밀번호 수정·새 항목 추가
export function PwForm({ pw, setPw, folder, onSave, onCancel }: {
  pw: PwDraft; setPw: (p: PwDraft) => void; folder?: string; onSave: () => void; onCancel: () => void;
}) {
  return (
    <form className="form" onSubmit={e => { e.preventDefault(); onSave(); }}>
      <div className="view-title">{pw.doc ? `${pw.doc.name} 비밀번호 수정` : "새 항목 추가"}</div>
      {!pw.doc && <>
        <label>파일 이름 <span className="hint">{folder} 폴더에 만들어요. 앞 노트의 머리말(level·login·ssh)을 번호만 바꿔 이어받아요</span>
          <input autoFocus value={pw.name} onChange={e => setPw({ ...pw, name: e.target.value })} />
        </label>
        <label>제목
          <input value={pw.title} placeholder="예: Bandit Level 24 — 쉘 스크립트 작성" onChange={e => setPw({ ...pw, title: e.target.value })} />
        </label>
      </>}
      <label>비밀번호 <span className="hint">노트 머리말 password만 바뀌고 본문은 그대로예요</span>
        <input autoFocus={!!pw.doc} className="mono" value={pw.password} spellCheck={false} autoComplete="off" onFocus={e => e.target.select()}
          onChange={e => setPw({ ...pw, password: e.target.value })} />
      </label>
      {pw.error && <p className="ai-err">{pw.error}</p>}
      <div className="form-actions">
        <button type="button" onClick={onCancel}>취소 <kbd>esc</kbd></button>
        <button type="submit" className="primary" disabled={pw.saving}>{pw.saving ? "저장 중…" : "저장"} <kbd>⌘</kbd><kbd>↵</kbd></button>
      </div>
    </form>
  );
}

// 노트 검색 추가·수정
export function SearchForm({ draft, setDraft, onSave, onCancel, onPickFolder }: {
  draft: Draft; setDraft: (d: Draft) => void; onSave: () => void; onCancel: () => void; onPickFolder: () => void;
}) {
  return (
    <form className="form" onSubmit={e => { e.preventDefault(); onSave(); }}>
      <div className="view-title">{draft.id ? "노트 검색 수정" : "새 노트 검색"}</div>
      <label>이름
        <input autoFocus value={draft.name} placeholder="예: 쿠버네티스 명령어" onChange={e => setDraft({ ...draft, name: e.target.value })} />
      </label>
      <label>Obsidian 폴더 <span className="hint">하위 폴더까지 읽어요</span>
        <span className="inline">
          <input value={draft.dir} placeholder="/Volumes/Disk/MyBrain/..." onChange={e => setDraft({ ...draft, dir: e.target.value })} />
          <button type="button" onClick={onPickFolder}>폴더 선택…</button>
        </span>
      </label>
      <div className="field">방식
        <div className="kinds">
          {(Object.keys(KIND_LABELS) as NoteKind[]).map(k => {
            const K = ICONS[KIND_LABELS[k].glyph];
            return (
              <button type="button" key={k} className={draft.kind === k ? "kind on" : "kind"} onClick={() => setDraft({ ...draft, kind: k })}>
                <span className="kind-title">{K && <K size={14} />} {KIND_LABELS[k].title}</span>
                <span className="hint">{KIND_LABELS[k].desc}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="field">단축키
        <span className="inline">
          <button type="button" className={draft.recording ? "rec on" : "rec"}
            onClick={async () => { await invoke("suspend_hotkeys", { on: true }); setDraft({ ...draft, recording: true }); }}>
            {draft.recording ? "새 단축키를 누르세요 · Esc 취소" : fmtKey(draft.hotkey) || "지정 안 함 (클릭해서 지정)"}
          </button>
          {draft.hotkey && !draft.recording && <button type="button" onClick={() => setDraft({ ...draft, hotkey: "" })}>지우기</button>}
        </span>
      </div>
      {draft.error && <p className="ai-err">{draft.error}</p>}
      <div className="form-actions">
        <button type="button" onClick={onCancel}>취소 <kbd>esc</kbd></button>
        <button type="submit" className="primary" disabled={draft.saving}>{draft.saving ? "저장 중…" : "저장"} <kbd>⌘</kbd><kbd>↵</kbd></button>
      </div>
    </form>
  );
}

// 아직 노트가 없는 [[링크]]: 누르면 개념 노트를 만들어 Obsidian에서 열기
export function MissingLinks({ names, vault, onCreate }: { names: string[]; vault: boolean; onCreate: (name: string) => void }) {
  return (
    <section>
      <div className="links-head">{vault ? "아직 없는 노트" : "이 폴더에 없는 노트"} {names.length} · 누르면 {vault ? "개념 노트를 만들어요" : "Vault에서 찾아 열고, 없으면 개념 노트를 만들어요"}</div>
      <div className="links-list">{names.map(n =>
        <button key={n} className="link-item missing" title={`${n}.md 만들기`} onClick={() => onCreate(n)}>+ {n}</button>)}</div>
    </section>
  );
}

// 그래프 옆 미리보기 아래: 오는·가는 링크 (+ 아직 없는 링크)
export function LinksPanel({ inn, out, missing, onPick }: { inn: Doc[]; out: Doc[]; missing: ReactNode; onPick: (d: Doc) => void }) {
  return (
    <div className="links">
      {([["이 노트로 오는 링크", inn], ["이 노트에서 가는 링크", out]] as [string, Doc[]][]).map(([title, ds]) => (
        <section key={title}>
          <div className="links-head">{title} {ds.length}</div>
          {ds.length ? <div className="links-list">{ds.map(d =>
            <button key={d.file} className="link-item" title={d.file} onClick={() => onPick(d)}>{d.name}</button>)}</div>
            : <div className="links-none">없음</div>}
        </section>
      ))}
      {missing}
    </div>
  );
}

// 빠른 메모 오른쪽: (붙인 스크린샷) + 이미 적은 기록
export function MemoSide({ shot, recRef, html, onRecClick }: {
  shot?: Shot | null; recRef: Ref<HTMLElement>; html: string; onRecClick: (e: MouseEvent<HTMLElement>) => void;
}) {
  if (!shot) return <article ref={recRef} className="preview md memo-rec" onClick={onRecClick} dangerouslySetInnerHTML={{ __html: html }} />;
  return (
    <div className="preview memo-side">
      <figure className="shot"><img src={shot.preview} alt="붙인 스크린샷" />
        <figcaption>{shot.source === "clip" ? "클립보드 이미지" : "스크린샷 파일 (저장하면 원본은 휴지통으로)"} · ⌘I 빼기</figcaption></figure>
      <article ref={recRef} className="md memo-rec" onClick={onRecClick} dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

// 클립보드 기록 오른쪽: 고른 기록 전체
export function ClipPreview({ clip, fallback }: { clip?: Clip; fallback?: string }) {
  return (
    <article className="preview clip-view">
      {clip ? <>
        <pre>{clip.text}</pre>
        <p className="clip-meta">{clipDay(clip.at)} {clipTime(clip.at)}{clip.app && ` · ${clip.app}`} · {clip.text.length.toLocaleString()}자</p>
      </> : <p className="clip-meta">{fallback}</p>}
    </article>
  );
}

// ⌘K 액션 패널
export function ActionMenu({ item, asel, setAsel, run }: {
  item: Item; asel: number; setAsel: Dispatch<SetStateAction<number>>; run: (a: Action) => void;
}) {
  return (
    <div className="menu" role="menu">
      <div className="menu-head">{item.title}</div>
      {item.actions.map((a, i) => (
        <div key={a.title} role="menuitem" className={i === asel ? "act on" : "act"}
          onMouseMove={() => setAsel(i)} onMouseDown={e => { e.preventDefault(); run(a); }}>
          <span>{a.title}</span>
          <span>{i === 0 ? <kbd>↵</kbd> : a.shortcut && [...a.shortcut].map(k => <kbd key={k}>{k}</kbd>)}</span>
        </div>
      ))}
    </div>
  );
}

// 하단 막대: 끌어서 창을 옮김. "deep"이라 막대 안 글자·키 표시 위를 눌러도 끌림 (핀 버튼은 제외)
export function Footer({ pending, pinned, togglePin, keys, menu }: {
  pending: { confirm: string } | null; pinned: boolean; togglePin: () => void; keys: [string, string[]][]; menu: boolean;
}) {
  const P = ICONS[pinned ? "pin" : "pinOff"];
  return (
    <footer className="foot" data-tauri-drag-region="deep" title="하단 막대를 끌어 창 이동 · 가장자리를 끌어 크기 조절 (화면 종류마다 기억)">
      {pending ? <span className="warn">{pending.confirm}</span> : <span className="brand">
        <button className={pinned ? "pin on" : "pin"} title={pinned ? "고정 해제 (⌘P)" : "창 고정 (⌘P)"}
          onMouseDown={e => e.preventDefault()} onClick={togglePin}>
          <P size={13} strokeWidth={2.2} />
        </button>
        Baro{pinned && <span className="pinned-hint"> · 고정됨</span>}
      </span>}
      {!pending && <span className="keys">
        {keys.filter(([label]) => label).map(([label, ks], i) => (
          <span key={label} className={label === "액션" && menu ? "on" : ""}>
            {i > 0 && <span className="sep" />}{label} {ks.map(k => <kbd key={k}>{k}</kbd>)}
          </span>
        ))}
      </span>}
    </footer>
  );
}
