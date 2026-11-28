import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultRect, fit, hits, middle, PANELS, place, reserve, restore, settle } from "../src/desktop/layout.ts";

const a = { w: 1920, h: 1200, top: 40, bottom: 90 };

test("fit keeps panels inside the free area and above the minimum size", () => {
  assert.deepEqual(fit({ x: -50, y: 0, w: 100, h: 100 }, a), { x: 8, y: 48, w: 280, h: 220 });
  assert.deepEqual(fit({ x: 1900, y: 1190, w: 400, h: 300 }, a), { x: 1512, y: 802, w: 400, h: 300 });
  assert.equal(fit({ x: 0, y: 0, w: 5000, h: 5000 }, a).h, 1200 - 40 - 90 - 16);
});
test("settle opens panels without overlaps and closes the oldest loose one when space runs out", () => {
  const note = { x: 28, y: 110, w: 440, h: 900 };
  const l = restore({}, a);
  for (const id of PANELS) l[id] = { ...l[id], open: true };
  l.calendar.pinned = true;
  const { layout: s, closed } = settle(l, PANELS, [note], a);
  const open = PANELS.filter(id => s[id].open), rs = open.map(id => s[id].rect);
  assert.ok(closed.length > 0 && !closed.includes("calendar") && !closed.includes("notes")); // 고정한 것·방금 연 것은 남음
  assert.deepEqual(open, PANELS.filter(id => !closed.includes(id)));
  rs.forEach((r, i) => { assert.ok(!hits(r, note) && !hits(r, middle(a)), open[i]); rs.slice(i + 1).forEach(q => assert.ok(!hits(r, q))); });
  assert.deepEqual(settle(restore({}, a), PANELS, [], a).closed, []); // 아무것도 안 열려 있으면 그대로
});
test("place keeps a free spot and moves to the nearest free one otherwise", () => {
  const r = { x: 100, y: 100, w: 300, h: 300 };
  assert.deepEqual(place(r, [], a), r);
  const moved = place(r, [{ x: 100, y: 100, w: 300, h: 300 }], a);
  assert.ok(!hits(moved, r));
  assert.ok(moved.y === r.y || moved.x === r.x); // 바로 옆이나 아래
});
test("reserve measures the left and right sides", () => {
  assert.deepEqual(reserve([{ x: 32, y: 0, w: 400, h: 10 }, { x: 1500, y: 0, w: 380, h: 10 }], 1920), { l: 432, r: 420 });
  assert.deepEqual(reserve([], 1920), { l: 0, r: 0 });
});
test("restore reopens only pinned panels and repairs bad values", () => {
  const l = restore({ calendar: { pinned: true, open: true, rect: { x: 100, y: 100, w: 500, h: 400 } }, clipboard: { pinned: false, open: true, rect: { x: "a" } } }, a);
  assert.deepEqual(l.calendar, { pinned: true, open: true, rect: { x: 100, y: 100, w: 500, h: 400 } });
  assert.deepEqual(l.clipboard, { pinned: false, open: false, rect: defaultRect("clipboard", a) });
  assert.equal(restore("junk", a).memo.open, false);
});
