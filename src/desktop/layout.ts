// 바탕화면 패널 배치: 위치·크기 맞추기, 저장된 배치 읽기 (화면 코드 없이 테스트할 수 있게 따로)
export type Rect = { x: number; y: number; w: number; h: number };
export type PanelId = "calendar" | "clipboard" | "memo";
export type PanelState = { open: boolean; pinned: boolean; rect: Rect };
export type Layout = Record<PanelId, PanelState>;
export type Area = { w: number; h: number; top: number; bottom: number }; // 화면 크기, 위·아래 비워 둘 자리 (메뉴 막대·독)

export const PANELS: PanelId[] = ["calendar", "clipboard", "memo"];
export const MIN = { w: 280, h: 220 };
const SIZE: Record<PanelId, { w: number; h: number }> = { calendar: { w: 620, h: 460 }, clipboard: { w: 360, h: 440 }, memo: { w: 380, h: 420 } };

// 처음 여는 자리: 달력은 왼쪽, 클립보드·메모는 오른쪽 (가운데 할 일 카드를 가리지 않게)
export function defaultRect(id: PanelId, a: Area): Rect {
  const s = SIZE[id];
  const y = a.top + 90;
  const x = id === "calendar" ? 32 : id === "clipboard" ? a.w - s.w - 32 : a.w - s.w - 32 - (SIZE.clipboard.w + 16);
  return fit({ x, y, ...s }, a);
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
