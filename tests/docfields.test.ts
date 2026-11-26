import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDoc, serializeDoc, titleOf, tagsOf, withTags } from "../src/app/docfields.ts";

test("머리말·내용으로 나누고 그대로 다시 합침 (본문의 # 제목도 내용 그대로)", () => {
  const raw = "---\ncreated: 2026-11-27\ntags:\n  - baro\n  - memo\nsummary: \"한 줄\"\n---\n\n# 제목\n\n본문 첫 줄\n";
  const f = parseDoc(raw, "백야");
  assert.equal(f.title, "백야");
  assert.deepEqual(f.props.map(p => p.key), ["created", "tags", "summary"]);
  assert.equal(f.props[1].value, "\n  - baro\n  - memo");
  assert.equal(f.body, "# 제목\n\n본문 첫 줄\n");
  assert.equal(serializeDoc(f), raw);
});

test("머리말 없는 노트, 속성 추가 (이름 빈 속성은 빠짐)", () => {
  const f = parseDoc("그냥 본문\n", "메모");
  assert.deepEqual(f, { title: "메모", props: [], body: "그냥 본문\n" });
  f.props.push({ key: "status", value: "draft" }, { key: "", value: "빈 이름은 빠짐" });
  assert.equal(serializeDoc(f), "---\nstatus: draft\n---\n\n그냥 본문\n");
  assert.equal(titleOf("/a/b/수족관.md"), "수족관");
});

test("태그 읽기·바꾸기", () => {
  assert.deepEqual(tagsOf("\n  - 독서\n  - \"헤르만헤세\""), ["독서", "헤르만헤세"]);
  assert.deepEqual(tagsOf("[a, #b]"), ["a", "b"]);
  assert.deepEqual(tagsOf("daily"), ["daily"]);
  const f = withTags({ title: "t", props: [{ key: "created", value: "2026-11-27" }], body: "" }, ["독서", "소설"]);
  assert.equal(serializeDoc(f), "---\ncreated: 2026-11-27\ntags:\n  - 독서\n  - 소설\n---\n\n");
  assert.deepEqual(withTags(f, []).props.map(p => p.key), ["created"]);
});
