import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultRect, fit, restore } from "../src/desktop/layout.ts";

const a = { w: 1920, h: 1200, top: 40, bottom: 90 };

test("fit keeps panels inside the free area and above the minimum size", () => {
  assert.deepEqual(fit({ x: -50, y: 0, w: 100, h: 100 }, a), { x: 8, y: 48, w: 280, h: 220 });
  assert.deepEqual(fit({ x: 1900, y: 1190, w: 400, h: 300 }, a), { x: 1512, y: 802, w: 400, h: 300 });
  assert.equal(fit({ x: 0, y: 0, w: 5000, h: 5000 }, a).h, 1200 - 40 - 90 - 16);
});
test("default spots do not overlap", () => {
  const c = defaultRect("calendar", a), k = defaultRect("clipboard", a), m = defaultRect("memo", a);
  assert.ok(c.x + c.w < m.x && m.x + m.w < k.x);
});
test("restore reopens only pinned panels and repairs bad values", () => {
  const l = restore({ calendar: { pinned: true, open: true, rect: { x: 100, y: 100, w: 500, h: 400 } }, clipboard: { pinned: false, open: true, rect: { x: "a" } } }, a);
  assert.deepEqual(l.calendar, { pinned: true, open: true, rect: { x: 100, y: 100, w: 500, h: 400 } });
  assert.deepEqual(l.clipboard, { pinned: false, open: false, rect: defaultRect("clipboard", a) });
  assert.equal(restore("junk", a).memo.open, false);
});
