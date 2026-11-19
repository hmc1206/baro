// 노트 그래프: 노트 검색 폴더 안 노트끼리의 [[링크]]를 Obsidian 그래프 뷰처럼 그림
//  - 원 크기 = 연결 수, 색 = 분류(폴더)
//  - 휠: 확대·축소 / 빈 곳 끌기: 이동 / 노드 끌기: 위치 옮기기 / 클릭: 선택 / 더블클릭: Obsidian에서 열기
//  - 검색어와 맞는 노트만 진하게, 선택한 노트와 이웃은 강조
//  - 로컬 그래프(⌘L): 선택한 노트에서 1·2단계 떨어진 노트만
//  - 범례: 폴더 색, 클릭하면 그 폴더만 / 연결 없는 노트 숨기기 / 맞춤(⌘0)
//  - ⌥+방향키: 고른 노트와 연결된 노트 중 그 방향에 있는 노트로 이동
//  - 노드 위치를 기억해 다시 열면 같은 모양으로 바로 보임. 움직임이 멈추면 다시 그리지 않음(CPU 절약)
import { useEffect, useMemo, useRef, useState } from "react";
import type { Doc } from "./notes";

type Node = { doc: Doc; key: string; x: number; y: number; vx: number; vy: number; deg: number; hue: number; fixed?: boolean };
type Graph = { nodes: Node[]; edges: [number, number][]; nbr: Set<number>[]; hub: number; warm: boolean; local: boolean; cacheKey: string };
type Pos = Map<string, [number, number]>;

const baseName = (file: string) => file.split("/").pop()!.replace(/\.md$/, "");
// 실제 파일 위치 기준 맨 위 폴더 (모든 노트의 공통 상위 폴더 아래 첫 폴더). 머리말 category는 쓰지 않음
function folderFn(docs: Doc[]) {
  const dirs = docs.map(d => d.file.split("/").slice(0, -1));
  let n = dirs[0]?.length ?? 0;
  for (const d of dirs) { let i = 0; while (i < n && i < d.length && d[i] === dirs[0][i]) i++; n = i; }
  return (d: Doc) => d.file.split("/").slice(0, -1)[n] ?? "(맨 위)";
}

// 폴더별 색: 노트가 많은 폴더부터 황금각(137.5°)씩 돌려 서로 잘 구분되게
function folderHues(docs: Doc[], folderOf: (d: Doc) => string) {
  const count = new Map<string, number>();
  for (const d of docs) count.set(folderOf(d), (count.get(folderOf(d)) ?? 0) + 1);
  const list = [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return list.map(([name, n], i) => ({ name, n, hue: Math.round((210 + i * 137.5) % 360) }));
}

// 코드 블록(```·~~~)과 인라인 코드(`…`) 안의 [[…]]는 링크가 아니므로 지움
export function stripCode(body: string): string {
  const out: string[] = [];
  let fence = "";
  for (const line of body.split("\n")) {
    const m = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) { if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = ""; continue; }
    if (m) { fence = m[1]; continue; }
    out.push(line.replace(/(`+)[^`]*?\1/g, ""));
  }
  return out.join("\n");
}

// [[대상]], [[폴더/대상|별칭]], [[대상#절]], ![[임베드]] → 대상 (경로가 있으면 경로 포함, .md 제외)
export function linksOf(d: Doc): string[] {
  const out = [...stripCode(d.body).matchAll(/\[\[([^\]|#]+)/g)].map(m => m[1]);
  return [...out, ...d.related].map(l => l.split("#")[0].trim().replace(/\.md$/i, "")).filter(Boolean);
}

const dirOf = (file: string) => file.split("/").slice(0, -1);
const shared = (a: string[], b: string[]) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };

// 링크 → 노트 번호. 같은 이름이 여러 개면 Obsidian처럼:
// 경로를 적었으면 경로가 맞는 노트, 아니면 보내는 노트와 같은(가까운) 폴더 → 경로가 짧은 노트
export function resolver(docs: Doc[]) {
  const byBase = new Map<string, number[]>();
  const byName = new Map<string, number>();
  docs.forEach((d, i) => {
    const k = baseName(d.file).toLowerCase();
    byBase.set(k, [...(byBase.get(k) ?? []), i]);
    if (!byName.has(d.name.toLowerCase())) byName.set(d.name.toLowerCase(), i);
  });
  return (link: string, from: Doc): number | undefined => {
    const parts = link.toLowerCase().split("/").filter(Boolean);
    const cands = byBase.get(parts[parts.length - 1] ?? "");
    if (!cands) return parts.length === 1 ? byName.get(parts[0]) : undefined;
    if (cands.length === 1) return cands[0];
    let list = cands;
    if (parts.length > 1) {
      // macOS 파일 이름은 한글이 NFD라 NFC로 맞춰 비교
      const tail = ("/" + parts.join("/") + ".md").normalize("NFC");
      const hit = cands.filter(i => ("/" + docs[i].file.toLowerCase()).normalize("NFC").endsWith(tail));
      if (hit.length) list = hit;
    }
    const src = dirOf(from.file);
    return [...list].sort((a, b) => {
      const da = dirOf(docs[a].file), db = dirOf(docs[b].file);
      return shared(db, src) - shared(da, src) || da.length - db.length || docs[a].file.localeCompare(docs[b].file);
    })[0];
  };
}

// 방향 있는 링크 [보내는 노트, 받는 노트] (중복 제거)
function directed(docs: Doc[]) {
  const resolve = resolver(docs);
  const seen = new Set<string>();
  const out: [number, number][] = [];
  docs.forEach((d, i) => linksOf(d).forEach(l => {
    const j = resolve(l, d);
    if (j === undefined || j === i || seen.has(`${i}>${j}`)) return;
    seen.add(`${i}>${j}`); out.push([i, j]);
  }));
  return out;
}

// 노트마다 가는 링크·오는 링크 (미리보기용)
export function linkInfo(docs: Doc[]) {
  const m = new Map<string, { out: Doc[]; inn: Doc[] }>(docs.map(d => [d.file, { out: [], inn: [] }]));
  for (const [i, j] of directed(docs)) { m.get(docs[i].file)!.out.push(docs[j]); m.get(docs[j].file)!.inn.push(docs[i]); }
  return m;
}

// 링크 연결만 계산 (위치 없이, 방향 없음)
function adjacency(docs: Doc[]) {
  const seen = new Set<string>();
  const edges: [number, number][] = [];
  for (const [i, j] of directed(docs)) {
    const k = i < j ? `${i}-${j}` : `${j}-${i}`;
    if (!seen.has(k)) { seen.add(k); edges.push([i, j]); }
  }
  const nbr = docs.map(() => new Set<number>());
  edges.forEach(([a, b]) => { nbr[a].add(b); nbr[b].add(a); });
  return { edges, nbr };
}

// 노드 위치 기억: 노트 검색(그래프)마다 따로, 앱을 다시 켜도 남도록 localStorage에도 저장
const posCache = new Map<string, Pos>();
const posKey = (k: string) => `baro.graphPos.${k}`;
function loadPos(k: string): Pos {
  let m = posCache.get(k);
  if (m) return m;
  m = new Map();
  try { for (const [f, xy] of Object.entries(JSON.parse(localStorage.getItem(posKey(k)) ?? "{}") as Record<string, [number, number]>)) m.set(f, xy); } catch { /* 저장된 위치 없음 */ }
  posCache.set(k, m);
  return m;
}
function savePos(g: Graph) {
  if (g.local || !g.cacheKey || !g.nodes.length) return; // 로컬 그래프 배치는 전체 배치를 덮지 않게
  const m = loadPos(g.cacheKey);
  for (const n of g.nodes) m.set(n.key, [Math.round(n.x), Math.round(n.y)]);
  try { localStorage.setItem(posKey(g.cacheKey), JSON.stringify(Object.fromEntries(m))); } catch { /* 저장 못 해도 동작에는 문제없음 */ }
}

// 고른 노트에서 depth 단계 안에 있는 노트 번호 (BFS)
function around(nbr: Set<number>[], root: number, depth: number): number[] {
  const seen = new Set([root]);
  let front = [root];
  for (let d = 0; d < depth; d++) {
    const next: number[] = [];
    for (const i of front) for (const j of nbr[i]) if (!seen.has(j)) { seen.add(j); next.push(j); }
    front = next;
  }
  return [...seen].sort((a, b) => a - b);
}

function build(docs: Doc[], cacheKey: string, local: boolean, partial: boolean, hues: Map<string, number>, folderOf: (d: Doc) => string): Graph {
  const { edges, nbr } = adjacency(docs);
  const saved = loadPos(cacheKey);
  // 처음 위치: 기억한 위치 → 없으면 기억한 이웃 근처 → 그것도 없으면 해바라기 배치(겹치지 않게 고르게 퍼짐)
  const nodes: Node[] = docs.map((doc, i) => {
    const r = 12 * Math.sqrt(i + 1), t = i * 2.39996;
    const [x, y] = saved.get(doc.file) ?? [r * Math.cos(t), r * Math.sin(t)];
    return { doc, key: doc.file, x, y, vx: 0, vy: 0, deg: nbr[i].size, hue: hues.get(folderOf(doc)) ?? 0 };
  });
  let known = 0;
  nodes.forEach((n, i) => {
    if (saved.has(n.key)) { known++; return; }
    const j = [...nbr[i]].find(j => saved.has(nodes[j].key));
    if (j !== undefined) { n.x = nodes[j].x + (Math.random() - .5) * 40; n.y = nodes[j].y + (Math.random() - .5) * 40; }
  });
  // 축소 상태에서 이름을 보여 줄 노트: 연결 수 상위 15개 (최소 6개 이상 연결)
  const hub = Math.max(6, nbr.map(x => x.size).sort((a, b) => b - a)[14] ?? 0);
  // 대부분 위치를 기억하고 있으면 살짝만 다시 정리 (로컬 그래프는 모여야 하므로 항상 새로 배치)
  return { nodes, edges, nbr, hub, warm: !local && known >= nodes.length * .8, local: partial, cacheKey };
}

const radius = (n: Node, zoom = 1) => (3 + Math.sqrt(n.deg) * 2.2) / Math.sqrt(Math.min(zoom, 1));

export function NoteGraph({ docs, matches, selected, loading, cacheKey = "", local = 0, onSelect, onOpen }: {
  docs: Doc[]; matches: Set<string> | null; selected?: Doc; loading?: boolean; cacheKey?: string; local?: number;
  onSelect: (d: Doc) => void; onOpen: (d: Doc) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const legend = useRef<HTMLDivElement>(null);
  const [folder, setFolder] = useState<string | null>(null); // 범례에서 고른 폴더만 보기
  const [noOrphans, setNoOrphans] = useState(false); // 연결 없는 노트 숨기기
  const adj = useMemo(() => adjacency(docs), [docs]);
  const folderOf = useMemo(() => folderFn(docs), [docs]);
  const folders = useMemo(() => folderHues(docs, folderOf), [docs, folderOf]);
  const hues = useMemo(() => new Map(folders.map(f => [f.name, f.hue])), [folders]);
  const root = local && selected ? docs.findIndex(d => d.file === selected.file) : -1;
  // 보여 줄 노트 (번호 목록을 문자열로 바꿔 같은 집합이면 다시 만들지 않음). 로컬 → 폴더 → 연결 없는 노트 순서로 거름
  let idx = root >= 0 ? around(adj.nbr, root, local) : null;
  if (folder) idx = (idx ?? docs.map((_, i) => i)).filter(i => i === root || folderOf(docs[i]) === folder);
  if (noOrphans) { // 지금 보이는 노트끼리 연결이 없는 노트 숨기기
    const on = new Set(idx ?? docs.map((_, i) => i));
    idx = [...on].filter(i => i === root || [...adj.nbr[i]].some(j => on.has(j)));
  }
  const keep = idx ? idx.join(",") : "";
  const g = useMemo(() => build(idx ? (keep ? keep.split(",").map(i => docs[+i]) : []) : docs, cacheKey, root >= 0, !!idx, hues, folderOf),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [docs, keep, idx === null, cacheKey, hues, root >= 0]);
  // 화면 상태는 렌더링 없이 바뀌므로 ref에 보관. kick: 다음 프레임 그리기 예약
  const st = useRef({ zoom: 1, ox: 0, oy: 0, alpha: 1, hover: -1, touched: false, refit: false, kick: () => {}, drag: null as null | { node: number; moved: boolean; sx: number; sy: number; ox: number; oy: number } });
  const props = useRef({ matches, selected, onSelect, onOpen });
  props.current = { matches, selected, onSelect, onOpen };

  useEffect(() => {
    const c = canvas.current!;
    const ctx = c.getContext("2d")!;
    const s = st.current;
    s.alpha = g.warm ? .08 : 1; s.zoom = 1; s.ox = 0; s.oy = 0; s.touched = false; s.hover = -1;
    let raf = 0, w = 0, h = 0;
    const kick = () => { if (!raf) raf = requestAnimationFrame(frame); };
    s.kick = kick;
    const resize = () => {
      const r = c.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
      w = r.width; h = r.height; c.width = w * dpr; c.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!s.touched) s.refit = true; // 창 크기가 바뀌면 다시 전체 맞춤 (직접 움직였으면 그대로)
      kick();
    };
    const ro = new ResizeObserver(resize); ro.observe(c); resize();

    // 힘 계산 한 단계: 노드끼리 밀어내기 + 링크는 스프링 + 가운데로 약하게 당기기
    const tick = () => {
      const N = g.nodes, a = s.alpha;
      for (let i = 0; i < N.length; i++) for (let j = i + 1; j < N.length; j++) {
        const p = N[i], q = N[j];
        let dx = q.x - p.x, dy = q.y - p.y, d2 = dx * dx + dy * dy;
        if (d2 > 90000) continue;
        if (d2 < 1) { dx = Math.random() - .5; dy = Math.random() - .5; d2 = 1; }
        const f = 900 * a / d2;
        p.vx -= dx * f; p.vy -= dy * f; q.vx += dx * f; q.vy += dy * f;
      }
      for (const [i, j] of g.edges) {
        const p = N[i], q = N[j], dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy) || 1;
        // 링크가 많은 노트(인덱스 노트)는 당기는 힘을 나눠 받게 해서 튀지 않게 (d3-force 방식)
        const f = (d - 50) / d * .5 * a / Math.max(1, Math.min(p.deg, q.deg));
        const bp = q.deg / (p.deg + q.deg || 1);
        p.vx += dx * f * bp; p.vy += dy * f * bp; q.vx -= dx * f * (1 - bp); q.vy -= dy * f * (1 - bp);
      }
      for (const n of N) {
        // 연결 없는 노트는 가운데로 더 당겨 멀리 흩어지지 않게
        const k = n.deg ? .004 : .015;
        n.vx -= n.x * k * a; n.vy -= n.y * k * a;
        if (n.fixed) { n.vx = n.vy = 0; continue; }
        n.vx *= .6; n.vy *= .6;
        const v = Math.hypot(n.vx, n.vy);
        if (v > 30) { n.vx *= 30 / v; n.vy *= 30 / v; } // 한 번에 너무 멀리 튀지 않게
        if (!Number.isFinite(n.x + n.y + n.vx + n.vy)) { n.x = Math.random() * 10; n.y = Math.random() * 10; n.vx = n.vy = 0; }
        n.x += n.vx; n.y += n.vy;
      }
      s.alpha = Math.max(s.alpha * .985, s.drag ? .3 : 0);
    };

    const scheme = matchMedia("(prefers-color-scheme: dark)");
    const draw = () => {
      // 색은 그릴 때마다 읽음 → 열어 둔 채 다크 모드로 바꿔도 맞음
      const css = getComputedStyle(document.documentElement);
      const text = css.getPropertyValue("--text").trim() || "#222";
      const muted = css.getPropertyValue("--muted").trim() || "#888";
      const dark = scheme.matches;
      const { matches: m, selected: sel } = props.current;
      const selI = sel ? g.nodes.findIndex(n => n.key === sel.file) : -1;
      const focus = s.hover >= 0 ? s.hover : selI;
      const near = focus >= 0 ? g.nbr[focus] : null;
      // 흐리게: 검색어와 안 맞는 노트, 마우스를 올린 노트와 연결 안 된 노트 (선택만으로는 흐리게 하지 않음)
      const dim = s.hover >= 0 ? g.nbr[s.hover] : null;
      const lit = (i: number) => (!m || m.has(g.nodes[i].key)) && (!dim || i === s.hover || dim.has(i));
      ctx.clearRect(0, 0, w, h);
      ctx.save();
      ctx.translate(w / 2 + s.ox, h / 2 + s.oy); ctx.scale(s.zoom, s.zoom);
      ctx.lineWidth = 1 / s.zoom;
      for (const [i, j] of g.edges) {
        const on = focus >= 0 && (i === focus || j === focus);
        ctx.strokeStyle = on ? (dark ? "rgba(140,170,255,.8)" : "rgba(47,107,255,.7)") : lit(i) && lit(j) ? (dark ? "rgba(255,255,255,.16)" : "rgba(27,34,48,.16)") : (dark ? "rgba(255,255,255,.04)" : "rgba(27,34,48,.04)");
        ctx.beginPath(); ctx.moveTo(g.nodes[i].x, g.nodes[i].y); ctx.lineTo(g.nodes[j].x, g.nodes[j].y); ctx.stroke();
      }
      g.nodes.forEach((n, i) => {
        const on = lit(i);
        ctx.globalAlpha = on ? 1 : .15;
        ctx.fillStyle = `hsl(${n.hue} 60% ${dark ? 62 : 48}%)`;
        ctx.beginPath(); ctx.arc(n.x, n.y, radius(n, s.zoom), 0, Math.PI * 2); ctx.fill();
        if (i === selI) { ctx.strokeStyle = text; ctx.lineWidth = 2 / s.zoom; ctx.stroke(); ctx.lineWidth = 1 / s.zoom; }
      });
      // 이름: 확대했을 때 전부, 아니면 선택·이웃·연결 많은 노드만
      ctx.font = `${11 / s.zoom}px -apple-system, "Apple SD Gothic Neo", sans-serif`;
      ctx.textAlign = "center";
      g.nodes.forEach((n, i) => {
        const show = i === focus || (near?.has(i) ?? false) || (s.zoom > 1.4 && lit(i)) || (n.deg >= g.hub && lit(i) && !dim) || (g.nodes.length <= 40 && lit(i)) || (m !== null && m.has(n.key) && m.size < 25);
        if (!show) return;
        ctx.globalAlpha = lit(i) ? 1 : .3;
        ctx.fillStyle = i === focus ? text : muted;
        ctx.fillText(n.doc.name, n.x, n.y + radius(n, s.zoom) + 12 / s.zoom);
      });
      ctx.restore(); ctx.globalAlpha = 1;
    };
    // 사용자가 움직이기 전까지는 전체가 화면에 들어오게 확대 비율을 맞춤
    const fit = () => {
      if (s.touched || !g.nodes.length || !w) return;
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const n of g.nodes) { x0 = Math.min(x0, n.x); x1 = Math.max(x1, n.x); y0 = Math.min(y0, n.y); y1 = Math.max(y1, n.y); }
      const top = legend.current ? legend.current.offsetHeight + 8 : 0; // 범례 아래부터 맞춤
      const z = Math.min(2, (w - 40) / Math.max(x1 - x0, 1), (h - 50 - top) / Math.max(y1 - y0, 1));
      s.zoom = z; s.ox = -(x0 + x1) / 2 * z; s.oy = -(y0 + y1) / 2 * z + top / 2;
    };
    // 움직이는 동안만 매 프레임 계산·그리기. 멈추면 위치를 저장하고 다음 변화(마우스·선택·크기)까지 쉼
    function frame() {
      raf = 0;
      const moving = s.alpha > .002;
      if (moving) tick();
      if (moving || s.refit) { s.refit = false; fit(); }
      draw();
      if (s.alpha > .002) kick();
      else if (moving) savePos(g);
    }
    kick();

    // 마우스 좌표 → 그래프 좌표 / 그 위치의 노드
    const toWorld = (e: MouseEvent) => {
      const r = c.getBoundingClientRect();
      return { x: (e.clientX - r.left - w / 2 - s.ox) / s.zoom, y: (e.clientY - r.top - h / 2 - s.oy) / s.zoom };
    };
    const hit = (e: MouseEvent) => {
      const p = toWorld(e);
      let best = -1, bd = Infinity;
      g.nodes.forEach((n, i) => { const d = Math.hypot(n.x - p.x, n.y - p.y); if (d < radius(n, s.zoom) + 4 / s.zoom && d < bd) { bd = d; best = i; } });
      return best;
    };
    const down = (e: MouseEvent) => {
      e.preventDefault();
      const i = hit(e);
      s.touched = true;
      s.drag = { node: i, moved: false, sx: e.clientX, sy: e.clientY, ox: s.ox, oy: s.oy };
      if (i >= 0) { g.nodes[i].fixed = true; s.alpha = Math.max(s.alpha, .3); }
      kick();
    };
    const move = (e: MouseEvent) => {
      const d = s.drag;
      if (!d) {
        if (e.target !== c && s.hover < 0) return; // 그래프 밖에서 움직이면 무시
        const i = e.target === c ? hit(e) : -1;
        if (i !== s.hover) { s.hover = i; kick(); }
        c.style.cursor = i >= 0 ? "pointer" : "grab";
        return;
      }
      if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 3) d.moved = true;
      if (d.node >= 0) { const p = toWorld(e); g.nodes[d.node].x = p.x; g.nodes[d.node].y = p.y; }
      else { s.ox = d.ox + e.clientX - d.sx; s.oy = d.oy + e.clientY - d.sy; c.style.cursor = "grabbing"; }
      kick();
    };
    const up = () => {
      const d = s.drag; s.drag = null;
      if (!d) return;
      if (d.node >= 0) { g.nodes[d.node].fixed = false; if (!d.moved) props.current.onSelect(g.nodes[d.node].doc); }
      kick();
    };
    const dbl = (e: MouseEvent) => { const i = hit(e); if (i >= 0) props.current.onOpen(g.nodes[i].doc); };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      s.touched = true;
      const r = c.getBoundingClientRect(), mx = e.clientX - r.left - w / 2, my = e.clientY - r.top - h / 2;
      const z = Math.min(4, Math.max(.2, s.zoom * Math.exp(-e.deltaY * .002)));
      // 마우스 위치를 기준으로 확대
      s.ox = mx - (mx - s.ox) * z / s.zoom; s.oy = my - (my - s.oy) * z / s.zoom; s.zoom = z;
      kick();
    };
    const leave = () => { s.hover = -1; kick(); };
    // ⌘0: 전체가 보이게 맞춤 / ⌥+방향키: 연결된 노트 중 그 방향에 있는 노트로 이동
    const key = (e: KeyboardEvent) => {
      if (e.metaKey && e.code === "Digit0") { e.preventDefault(); s.touched = false; s.refit = true; kick(); return; }
      const dir = e.altKey && !e.metaKey && ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, number[]>)[e.key];
      if (!dir) return;
      e.preventDefault();
      const sel = props.current.selected;
      const from = sel ? g.nodes.findIndex(n => n.key === sel.file) : -1;
      if (from < 0) { // 아직 고른 노트가 없으면 연결이 가장 많은 노트부터
        const hub = g.nodes.reduce((b, n, i) => n.deg > (g.nodes[b]?.deg ?? -1) ? i : b, -1);
        if (hub >= 0) props.current.onSelect(g.nodes[hub].doc);
        return;
      }
      const p = g.nodes[from];
      let best = -1, bs = -Infinity;
      for (const j of g.nbr[from]) {
        const q = g.nodes[j], dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy) || 1;
        const cos = (dx * dir[0] + dy * dir[1]) / d;
        if (cos < .35) continue; // 대략 그 방향(±70°)에 있는 것만
        const sc = cos * 2 - d / 400; // 방향이 잘 맞고 가까울수록
        if (sc > bs) { bs = sc; best = j; }
      }
      if (best >= 0) props.current.onSelect(g.nodes[best].doc);
    };
    window.addEventListener("keydown", key);
    scheme.addEventListener("change", kick);
    c.addEventListener("mousedown", down); window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
    c.addEventListener("dblclick", dbl); c.addEventListener("wheel", wheel, { passive: false }); c.addEventListener("mouseleave", leave);
    return () => {
      cancelAnimationFrame(raf); ro.disconnect(); scheme.removeEventListener("change", kick); window.removeEventListener("keydown", key);
      if (s.alpha > .002) savePos(g); // 정리 중에 닫아도 지금 위치 기억
      c.removeEventListener("mousedown", down); window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up);
      c.removeEventListener("dblclick", dbl); c.removeEventListener("wheel", wheel); c.removeEventListener("mouseleave", leave);
    };
  }, [g]);

  // 검색어·선택이 바뀌면 다시 그리기
  useEffect(() => { st.current.kick(); }, [matches, selected]);

  // 키보드로 선택이 바뀌면 그 노드가 화면 안에 오도록 이동
  useEffect(() => {
    const n = selected && g.nodes.find(x => x.key === selected.file);
    const c = canvas.current;
    if (!n || !c) return;
    const s = st.current, r = c.getBoundingClientRect();
    if (!s.touched && s.alpha > .002) return; // 아직 전체 맞춤 중이면 그대로 둠
    const sx = n.x * s.zoom + s.ox, sy = n.y * s.zoom + s.oy;
    if (Math.abs(sx) > r.width / 2 - 40 || Math.abs(sy) > r.height / 2 - 40) { s.touched = true; s.ox = -n.x * s.zoom; s.oy = -n.y * s.zoom; s.kick(); }
  }, [selected, g]);

  const linked = g.nodes.filter(n => n.deg > 0).length;
  const fitNow = () => { const s = st.current; s.touched = false; s.refit = true; s.kick(); };
  return (
    <div className="graph">
      <canvas ref={canvas} />
      {!loading && docs.length > 0 && (
        <div className="graph-legend" ref={legend}>
          {folders.length > 1 && folders.slice(0, 10).map(f => (
            <button key={f.name} className={folder === f.name ? "on" : folder ? "off" : ""} title={`${f.name}만 보기 (다시 누르면 전체)`}
              onClick={() => setFolder(v => v === f.name ? null : f.name)}>
              <i style={{ background: `hsl(${f.hue} 60% 55%)` }} />{f.name}<span>{f.n}</span>
            </button>
          ))}
          <div className="graph-tools">
            <button className={noOrphans ? "on" : ""} onClick={() => setNoOrphans(v => !v)}>연결 없는 노트 숨기기</button>
            <button onClick={fitNow}>맞춤 <kbd>⌘</kbd><kbd>0</kbd></button>
          </div>
        </div>
      )}
      <div className="graph-info">{loading ? "노트 불러오는 중… (외장 디스크는 처음에 몇 초 걸려요)" : <>{root >= 0 ? `로컬 ${local}단계 · ` : ""}{folder ? `${folder} · ` : ""}{matches ? (matches.size ? `검색 결과 ${matches.size}개 · ` : "일치하는 노트가 없어요 · ") : ""}노트 {g.nodes.length}개 · 링크 {g.edges.length}개{!matches && linked < g.nodes.length ? ` · 연결 없는 노트 ${g.nodes.length - linked}개` : ""}</>}</div>
    </div>
  );
}
