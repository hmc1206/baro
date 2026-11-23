import { test } from "node:test";
import assert from "node:assert/strict";
import { itemsOf, editTextOf, editBlockOf, listBlock, cmdBlock, RECORD } from "../src/app/memo.ts";

// 저장된 기록 → 고칠 글 → 다시 저장하면 원래 모양 그대로
const round = (sec: string, block: string) => {
  const it = itemsOf(block.split("\n"))[0];
  const { text, time } = editTextOf(it, sec);
  return { text, back: editBlockOf(sec, text, time) };
};

test("메모 고치기: 저장된 모양과 고칠 글이 서로 돌아온다", () => {
  const daily = "- 14:05 첫 줄\n  둘째 줄";
  assert.deepEqual(round("daily", daily), { text: "첫 줄\n둘째 줄", back: daily });
  const learn = listBlock("배운 것\n이어서");
  assert.deepEqual(round(RECORD.learn, learn), { text: "배운 것\n이어서", back: learn });
  const one = cmdBlock("nslookup example.com");
  assert.deepEqual(round(RECORD.cmd, one), { text: "nslookup example.com", back: one });
  const multi = cmdBlock("cd web\nls -a");
  assert.deepEqual(round(RECORD.cmd, multi), { text: "cd web\nls -a", back: multi });
});

test("메모 고치기: Daily 시각은 그대로 두고 글만 바뀐다", () => {
  const it = itemsOf(["- 09:30 옛 글"])[0];
  const { time } = editTextOf(it, "daily");
  assert.equal(editBlockOf("daily", "새 글\n둘째", time), "- 09:30 새 글\n  둘째");
});
