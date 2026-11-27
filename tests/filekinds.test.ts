import { test } from "node:test";
import assert from "node:assert/strict";
import { fileKind, groupByKind } from "../src/app/filekinds.ts";

test("확장자로 종류 나누기 (대소문자 무시, 확장자 없거나 ._ 숨김은 기타)", () => {
  assert.equal(fileKind("/a/보고서.HWP"), "문서");
  assert.equal(fileKind("/a/b.pdf"), "PDF");
  assert.equal(fileKind("/a/IMG_1.HEIC"), "이미지");
  assert.equal(fileKind("/a/main.rs"), "코드");
  assert.equal(fileKind("/a/Makefile"), "기타");
  assert.equal(fileKind("/a/.zshrc"), "기타");
});

test("종류 순서대로 묶고 구역마다 개수 제한 + 더 보기, 펼치면 그 종류만", () => {
  const it = (p: string) => ({ path: p, title: p });
  const items = ["x.png", "a.md", "b.md", "c.md", "y.zip"].map(it);
  const more = (k: string, rest: number) => ({ title: `${k}+${rest}` });
  const g = groupByKind(items, 2, null, more);
  assert.deepEqual(g.map(x => x.title), ["a.md", "b.md", "문서+1", "x.png", "y.zip"]);
  assert.deepEqual(g.map(x => x.section), ["문서 3개", "문서 3개", "문서 3개", "이미지 1개", "압축·설치 1개"]);
  assert.deepEqual(groupByKind(items, 2, "문서", more).map(x => x.title), ["a.md", "b.md", "c.md"]);
});
