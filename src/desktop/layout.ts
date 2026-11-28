// 바탕화면 패널 배치: 위치·크기 맞추기, 저장된 배치 읽기 (화면 코드 없이 테스트할 수 있게 따로)
export type Rect = { x: number; y: number; w: number; h: number };
export type PanelId = "calendar" | "clipboard" | "memo" | "files" | "window" | "notes";
export type PanelState = { open: boolean; pinned: boolean; rect: Rect };
export type Layout = Record<PanelId, PanelState>;
export type Area = { w: number; h: number; top: number; bottom: number }; // 화면 크기, 위·아래 비워 둘 자리 (메뉴 막대·독)

export const PANELS: PanelId[] = ["calendar", "clipboard", "memo", "files", "window", "notes"];
export const MIN = { w: 280, h: 220 };
const SIZE: Record<PanelId, { w: number; h: number }> = { calendar: { w: 620, h: 460 }, clipboard: { w: 360, h: 440 }, memo: { w: 380, h: 420 },
  files: { w: 460, h: 520 }, window: { w: 340, h: 420 }, notes: { w: 820, h: 580 } };

// 처음 여는 자리: 달력·노트는 왼쪽 끝, 나머지는 오른쪽 끝. 겹치면 place가 그 아래·옆 빈 곳으로 옮김
export function defaultRect(id: PanelId, a: Area): Rect {
  const s = SIZE[id];
  const x = id === "calendar" || id === "notes" ? 32 : a.w - s.w - 32;
  return fit({ x, y: a.top + 70, ...s }, a);
}

export const GAP = 14;
// 두 사각형이 GAP 안쪽까지 붙어 있으면 겹친 것으로 봄
export const hits = (p: Rect, q: Rect) => p.x < q.x + q.w + GAP && q.x < p.x + p.w + GAP && p.y < q.y + q.h + GAP && q.y < p.y + p.h + GAP;

// 이미 있는 것(taken)과 겹치지 않는 자리 중 원래 자리에서 가장 가까운 곳. 그 크기로 들어갈 곳이 없으면 조금씩 줄여 보고,
// 최소 크기로도 없으면 null. 후보는 화면 가장자리와 다른 사각형의 네 변 바로 바깥 (빈 곳의 모서리는 늘 이 중 하나)
export function free(r: Rect, taken: Rect[], a: Area): Rect | null {
  const f = fit(r, a);
  if (!taken.some(t => hits(f, t))) return f;
  let best: Rect | null = null, bd = Infinity;
  for (const k of [1, 0.85, 0.7, 0.55, 0]) {
    const w = Math.max(MIN.w, Math.round(f.w * k)), h = Math.max(MIN.h, Math.round(f.h * k));
    const xs = [f.x, 8, a.w - w - 8, ...taken.flatMap(t => [t.x + t.w + GAP, t.x - w - GAP])];
    const ys = [f.y, a.top + 8, a.h - a.bottom - h - 8, ...taken.flatMap(t => [t.y + t.h + GAP, t.y - h - GAP])];
    for (const x of xs) for (const y of ys) {
      const c = fit({ x, y, w, h }, a);
      if (taken.some(t => hits(c, t))) continue;
      // 가까울수록, 옆보다 위아래로(같은 쪽 가장자리에 쌓이게), 덜 줄일수록 좋음
      const d = 4 * (c.x - f.x) ** 2 + (c.y - f.y) ** 2 + (1 - k) * 2_000_000;
      if (d < bd) { bd = d; best = c; }
    }
  }
  return best;
}
export const place = (r: Rect, taken: Rect[], a: Area): Rect => free(r, taken, a) ?? fit(r, a);

// 가운데 할 일 카드 자리: 패널은 여기에 들어오지 않음 (양옆 가장자리에 붙음)
export const middle = (a: Area): Rect => { const w = Math.round(Math.min(640, a.w * 0.36)); return { x: Math.round((a.w - w) / 2), y: 0, w, h: a.h }; };

// 열린 패널을 order 순서대로(뒤일수록 나중에, 즉 방금 연 것·옮긴 것이 비켜 감) 서로·가운데·고정된 것(fixed)과 안 겹치게.
// 자리가 모자라면 가장 먼저 연 패널부터 닫음 (📌 고정한 것과 맨 마지막 것은 안 닫음. 그래도 모자라면 그 패널만 겹침)
export function settle(l: Layout, order: PanelId[], fixed: Rect[], a: Area): { layout: Layout; closed: PanelId[] } {
  const closed: PanelId[] = [];
  for (;;) {
    const out = { ...l }, taken = [middle(a), ...fixed];
    const open = order.filter(id => out[id].open && !closed.includes(id));
    let stuck = false;
    for (const id of open) {
      const r = free(out[id].rect, taken, a);
      if (!r) stuck = true;
      const rect = r ?? fit(out[id].rect, a);
      taken.push(rect);
      if (rect.x !== out[id].rect.x || rect.y !== out[id].rect.y || rect.w !== out[id].rect.w || rect.h !== out[id].rect.h) out[id] = { ...out[id], rect };
    }
    const victim = stuck ? open.find((id, i) => i < open.length - 1 && !out[id].pinned) : undefined;
    if (!victim) { for (const id of closed) out[id] = { ...out[id], open: false }; return { layout: out, closed }; }
    closed.push(victim);
  }
}

// 왼쪽·오른쪽에 붙은 것들이 차지한 폭 → 가운데 화면을 그만큼 비켜 줌 (사각형 가운데가 화면 왼쪽 반이면 왼쪽)
export function reserve(rects: Rect[], w: number): { l: number; r: number } {
  let l = 0, r = 0;
  for (const x of rects) { if (x.x + x.w / 2 < w / 2) l = Math.max(l, x.x + x.w); else r = Math.max(r, w - x.x); }
  return { l, r };
}

// 최소 크기 이상, 화면 안 (위는 메뉴 막대 아래, 아래는 독 위)
export function fit(r: Rect, a: Area): Rect {
  const maxW = Math.max(MIN.w, a.w - 16), maxH = Math.max(MIN.h, a.h - a.top - a.bottom - 16);
  const w = Math.round(Math.min(Math.max(r.w, MIN.w), maxW));
  const h = Math.round(Math.min(Math.max(r.h, MIN.h), maxH));
  const x = Math.round(Math.min(Math.max(r.x, 8), a.w - w - 8));
  const y = Math.round(Math.min(Math.max(r.y, a.top + 8), a.h - a.bottom - h - 8));
  return { x, y, w, h };
}

// 저장된 배치 → 지금 화면에 맞게. 고정한 패널만 다시 열고, 깨진 값은 기본값으로
export function restore(saved: unknown, a: Area): Layout {
  const s = (saved && typeof saved === "object" ? saved : {}) as Record<string, Partial<PanelState>>;
  const out = {} as Layout;
  for (const id of PANELS) {
    const p = s[id];
    const r = p?.rect;
    const ok = r && [r.x, r.y, r.w, r.h].every(n => typeof n === "number" && Number.isFinite(n));
    const pinned = p?.pinned === true;
    out[id] = { pinned, open: pinned, rect: ok ? fit(r as Rect, a) : defaultRect(id, a) };
  }
  return out;
}
