// 바탕화면 패널 틀: 머리줄을 끌어 옮기고, 오른쪽 아래 모서리를 끌어 크기 바꾸기. 📌 고정, ↗ 런처에서 열기, ✕ 닫기
import { type ReactNode, useRef } from "react";
import { ICONS } from "../icons";
import type { Rect } from "./layout";

export function Panel({ title, icon, rect, pinned, z, onRect, onDone, onPin, onClose, onLauncher, onFront, children }: {
  title: string; icon: string; rect: Rect; pinned: boolean; z: number;
  onRect: (r: Rect) => void; onDone: () => void; // 끄는 중에는 onRect, 손을 떼면 onDone (그때 저장)
  onPin: () => void; onClose: () => void; onLauncher: () => void; onFront: () => void; children: ReactNode;
}) {
  const start = useRef<{ px: number; py: number; r: Rect; mode: "move" | "size" } | null>(null);
  const down = (mode: "move" | "size") => (e: React.PointerEvent) => {
    if (e.button !== 0 || (mode === "move" && (e.target as HTMLElement).closest("button"))) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    start.current = { px: e.clientX, py: e.clientY, r: rect, mode };
  };
  const move = (e: React.PointerEvent) => {
    const s = start.current;
    if (!s) return;
    const dx = e.clientX - s.px, dy = e.clientY - s.py;
    onRect(s.mode === "move" ? { ...s.r, x: s.r.x + dx, y: s.r.y + dy } : { ...s.r, w: s.r.w + dx, h: s.r.h + dy });
  };
  const up = () => { if (start.current) { start.current = null; onDone(); } };
  const Svg = ICONS[icon];
  const Pin = ICONS[pinned ? "pin" : "pinOff"];
  const Out = ICONS.link;
  return (
    <section className={`dk-panel dk-glass${pinned ? " pinned" : ""}`} style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, zIndex: z }}
      onPointerDownCapture={onFront}>
      <header className="dk-ph" onPointerDown={down("move")} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        {Svg && <Svg size={15} strokeWidth={2} />}
        <span className="dk-pt">{title}</span>
        <button className={pinned ? "on" : ""} onClick={onPin} title={pinned ? "고정 풀기 (바탕화면을 누르면 닫힘)" : "바탕화면에 고정 (다시 켜도 그 자리에)"}><Pin size={14} strokeWidth={2} /></button>
        <button onClick={onLauncher} title="런처에서 크게 열기"><Out size={14} strokeWidth={2} /></button>
        <button onClick={onClose} title="닫기">✕</button>
      </header>
      <div className="dk-pb">{children}</div>
      <span className="dk-grip" onPointerDown={down("size")} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
    </section>
  );
}
