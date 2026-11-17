// 노트 그래프: 노트 검색 폴더 안 노트끼리의 [[링크]]를 Obsidian 그래프 뷰처럼 그림
//  - 원 크기 = 연결 수, 색 = 분류(폴더)
//  - 휠: 확대·축소 / 빈 곳 끌기: 이동 / 노드 끌기: 위치 옮기기 / 클릭: 선택 / 더블클릭: Obsidian에서 열기
//  - 검색어와 맞는 노트만 진하게, 선택한 노트와 이웃은 강조
import { useEffect, useMemo, useRef } from "react";
import type { Doc } from "./notes";

type Node = { doc: Doc; key: string; x: number; y: number; vx: number; vy: number; deg: number; hue: number; fixed?: boolean };
type Graph = { nodes: Node[]; edges: [number, number][]; nbr: Set<number>[]; hub: number };

const baseName = (file: string) => file.split("/").pop()!.replace(/\.md$/, "");
const hueOf = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };

// [[대상]], [[대상|별칭]], [[대상#절]], ![[임베드]] → 대상 노트 이름
function linksOf(d: Doc): string[] {
  const out = [...d.body.matchAll(/\[\[([^\]|#]+)/g)].map(m => m[1].split("/").pop()!.trim());
  return [...out, ...d.related];
}

function build(docs: Doc[]): Graph {
  const byName = new Map<string, number>();
  docs.forEach((d, i) => { byName.set(baseName(d.file).toLowerCase(), i); if (!byName.has(d.name.toLowerCase())) byName.set(d.name.toLowerCase(), i); });
  const seen = new Set<string>();
  const edges: [number, number][] = [];
  docs.forEach((d, i) => linksOf(d).forEach(l => {
    const j = byName.get(l.toLowerCase());
    if (j === undefined || j === i) return;
    const k = i < j ? `${i}-${j}` : `${j}-${i}`;
    if (!seen.has(k)) { seen.add(k); edges.push([i, j]); }
  }));
  const nbr = docs.map(() => new Set<number>());
  edges.forEach(([a, b]) => { nbr[a].add(b); nbr[b].add(a); });
  // 처음 위치: 해바라기 배치(겹치지 않게 고르게 퍼짐)
  const nodes = docs.map((doc, i) => {
    const r = 12 * Math.sqrt(i + 1), t = i * 2.39996;
    return { doc, key: doc.file, x: r * Math.cos(t), y: r * Math.sin(t), vx: 0, vy: 0, deg: nbr[i].size, hue: hueOf(doc.category.split("/")[0]) };
  });
  // 축소 상태에서 이름을 보여 줄 노트: 연결 수 상위 15개 (최소 6개 이상 연결)
  const hub = Math.max(6, nbr.map(x => x.size).sort((a, b) => b - a)[14] ?? 0);
  return { nodes, edges, nbr, hub };
}

const radius = (n: Node, zoom = 1) => (3 + Math.sqrt(n.deg) * 2.2) / Math.sqrt(Math.min(zoom, 1));

export function NoteGraph({ docs, matches, selected, loading, onSelect, onOpen }: {
  docs: Doc[]; matches: Set<string> | null; selected?: Doc; loading?: boolean;
  onSelect: (d: Doc) => void; onOpen: (d: Doc) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const g = useMemo(() => build(docs), [docs]);
  // 화면 상태는 렌더링 없이 바뀌므로 ref에 보관
  const st = useRef({ zoom: 1, ox: 0, oy: 0, alpha: 1, hover: -1, touched: false, drag: null as null | { node: number; moved: boolean; sx: number; sy: number; ox: number; oy: number } });
  const props = useRef({ matches, selected, onSelect, onOpen });
  props.current = { matches, selected, onSelect, onOpen };

  useEffect(() => {
    const c = canvas.current!;
    const ctx = c.getContext("2d")!;
    const s = st.current;
    s.alpha = 1; s.zoom = 1; s.ox = 0; s.oy = 0; s.touched = false;
    let raf = 0, w = 0, h = 0;
    const resize = () => {
      const r = c.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
      w = r.width; h = r.height; c.width = w * dpr; c.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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

    const css = getComputedStyle(document.documentElement);
    const text = css.getPropertyValue("--text").trim() || "#222";
    const muted = css.getPropertyValue("--muted").trim() || "#888";
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    const draw = () => {
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
        const show = i === focus || (near?.has(i) ?? false) || (s.zoom > 1.4 && lit(i)) || (n.deg >= g.hub && lit(i) && !dim) || (m !== null && m.has(n.key) && m.size < 25);
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
      const z = Math.min(2, (w - 40) / Math.max(x1 - x0, 1), (h - 50) / Math.max(y1 - y0, 1));
      s.zoom = z; s.ox = -(x0 + x1) / 2 * z; s.oy = -(y0 + y1) / 2 * z;
    };
    const loop = () => { if (s.alpha > .002) { tick(); fit(); } draw(); raf = requestAnimationFrame(loop); };
    loop();

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
    };
    const move = (e: MouseEvent) => {
      const d = s.drag;
      if (!d) { const i = hit(e); s.hover = i; c.style.cursor = i >= 0 ? "pointer" : "grab"; return; }
      if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 3) d.moved = true;
      if (d.node >= 0) { const p = toWorld(e); g.nodes[d.node].x = p.x; g.nodes[d.node].y = p.y; }
      else { s.ox = d.ox + e.clientX - d.sx; s.oy = d.oy + e.clientY - d.sy; c.style.cursor = "grabbing"; }
    };
    const up = () => {
      const d = s.drag; s.drag = null;
      if (!d) return;
      if (d.node >= 0) { g.nodes[d.node].fixed = false; if (!d.moved) props.current.onSelect(g.nodes[d.node].doc); }
    };
    const dbl = (e: MouseEvent) => { const i = hit(e); if (i >= 0) props.current.onOpen(g.nodes[i].doc); };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      s.touched = true;
      const r = c.getBoundingClientRect(), mx = e.clientX - r.left - w / 2, my = e.clientY - r.top - h / 2;
      const z = Math.min(4, Math.max(.2, s.zoom * Math.exp(-e.deltaY * .002)));
      // 마우스 위치를 기준으로 확대
      s.ox = mx - (mx - s.ox) * z / s.zoom; s.oy = my - (my - s.oy) * z / s.zoom; s.zoom = z;
    };
    const leave = () => { s.hover = -1; };
    c.addEventListener("mousedown", down); window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
    c.addEventListener("dblclick", dbl); c.addEventListener("wheel", wheel, { passive: false }); c.addEventListener("mouseleave", leave);
    return () => {
      cancelAnimationFrame(raf); ro.disconnect();
      c.removeEventListener("mousedown", down); window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up);
      c.removeEventListener("dblclick", dbl); c.removeEventListener("wheel", wheel); c.removeEventListener("mouseleave", leave);
    };
  }, [g]);

  // 키보드로 선택이 바뀌면 그 노드가 화면 안에 오도록 이동
  useEffect(() => {
    const n = selected && g.nodes.find(x => x.key === selected.file);
    const c = canvas.current;
    if (!n || !c) return;
    const s = st.current, r = c.getBoundingClientRect();
    if (!s.touched && s.alpha > .002) return; // 아직 전체 맞춤 중이면 그대로 둠
    const sx = n.x * s.zoom + s.ox, sy = n.y * s.zoom + s.oy;
    if (Math.abs(sx) > r.width / 2 - 40 || Math.abs(sy) > r.height / 2 - 40) { s.touched = true; s.ox = -n.x * s.zoom; s.oy = -n.y * s.zoom; }
  }, [selected, g]);

  const linked = g.nodes.filter(n => n.deg > 0).length;
  return (
    <div className="graph">
      <canvas ref={canvas} />
      <div className="graph-info">{loading ? "노트 불러오는 중… (외장 디스크는 처음에 몇 초 걸려요)" : <>{matches ? (matches.size ? `검색 결과 ${matches.size}개 · ` : "일치하는 노트가 없어요 · ") : ""}노트 {g.nodes.length}개 · 링크 {g.edges.length}개{!matches && linked < g.nodes.length ? ` · 연결 없는 노트 ${g.nodes.length - linked}개` : ""}</>}</div>
    </div>
  );
}
