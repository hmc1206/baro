// 커리큘럼 허브 해석·다음 할 일·개념 검색·공부 카드 테스트 (npm test)
import test from "node:test";
import assert from "node:assert/strict";
import { hubStages, conceptsOf, nextUp, conceptHits, studyCard, criteriaOf, criterionHints, byStage, type Doc } from "../src/notes.ts";

const fe = `---
type: curriculum-hub
field: frontend
---
# FE

## 단계별 학습

### P01 웹

**단계 상태**: 학습 중 · 약 18시간 · 단계 노트: [[P01-web|열기]]

- [x] [[P01-001-web|P01-001 인터넷과 웹]] · 필수 · 선행: 없음 · 완료
- [ ] [[P01-002-cs|P01-002 클라이언트와 서버]] · 필수 · 선행: P01-003 · 학습 전
- [ ] [[P01-003-dns|P01-003 도메인과 DNS]] · 필수 · 선행: P01-001 · 학습 전
- [ ] [[P01-004-http|P01-004 HTTP 요청과 응답]] · 선택 · 선행: 없음 · 복습 필요

## 관련
`;
const sec = `---
type: curriculum-hub
field: security
---
# Sec

## 단계별 학습

### 단계 0 CLI

**단계 상태**: 완료

### 1단계 네트워크

**단계 상태**: 학습 전 · 1-3주 · 약 30시간

- **핵심 개념(원본)**:
  - OSI-7계층 — 계층 구조 → 개념 노트 대신 [[CS-07-01 OSI]]
  - DNS — 이름 해석
`;
const stages = (): Doc[] => hubStages([{ file: "/v/Sec.md", folder: "", text: sec }, { file: "/v/FE.md", folder: "", text: fe }],
  [{ file: "/v/Frontend/P01-web.md", folder: "", text: "# P01 웹 노트" }], new Map()).sort(byStage);

test("허브의 ### 단계를 분야 순서(프론트엔드 → 보안)로 읽음", () => {
  const s = stages();
  assert.deepEqual(s.map(d => [d.category, d.name, d.meta.status]),
    [["프론트엔드", "P01 웹", "학습 중"], ["보안", "단계 0 CLI", "완료"], ["보안", "1단계 네트워크", "학습 전"]]);
  assert.equal(s[0].meta.hours, "약 18시간");
  assert.equal(s[2].meta.week, "1-3");
  assert.equal(s[0].record?.file, "/v/Frontend/P01-web.md");
  assert.equal(s[0].tasks?.length, 4);
});

test("개념 줄: 상태·우선순위·선행·허브 체크박스 번호, 보안은 핵심 개념 줄", () => {
  const [p01, , net] = stages();
  const cs = conceptsOf(p01);
  assert.deepEqual(cs.map(c => [c.name, c.status, c.prereq, c.hubIndex]), [
    ["P01-001 인터넷과 웹", "완료", "없음", 0], ["P01-002 클라이언트와 서버", "학습 전", "P01-003", 1],
    ["P01-003 도메인과 DNS", "학습 전", "P01-001", 2], ["P01-004 HTTP 요청과 응답", "복습 필요", "없음", 3]]);
  assert.equal(cs[1].link, "P01-002-cs");
  assert.deepEqual(conceptsOf(net).map(c => [c.name, c.link, c.hubIndex]), [["OSI-7계층", "CS-07-01 OSI", -1], ["DNS", "", -1]]);
});

test("다음 할 일: 선행이 끝난 첫 개념, 보안은 첫 미완료 단계, 복습 필요는 복습 칸", () => {
  const n = nextUp(stages());
  assert.deepEqual(n.map(d => [d.next!.section, d.next!.concept.name, d.next!.why]), [
    ["다음 할 일", "P01-003 도메인과 DNS", "선행 P01-001 완료"], // P01-002는 선행 P01-003이 아직
    ["다음 할 일", "OSI-7계층", "단계 시작"],
    ["복습할 개념", "P01-004 HTTP 요청과 응답", "복습 필요"]]);
  // 학습 중인 개념이 있으면 그것을 이어서
  const s = stages();
  s[0] = { ...s[0], body: s[0].body.replace("P01-002 클라이언트와 서버]] · 필수 · 선행: P01-003 · 학습 전", "P01-002 클라이언트와 서버]] · 필수 · 선행: P01-003 · 학습 중") };
  assert.equal(nextUp(s)[0].next!.concept.name, "P01-002 클라이언트와 서버");
  assert.equal(nextUp(s)[0].next!.why, "이어서 공부");
});

test("개념 검색: 분야를 넘어 찾고 이름 시작 일치가 먼저", () => {
  assert.deepEqual(conceptHits(stages(), "dns").map(d => [d.category, d.next!.concept.name]),
    [["보안", "DNS"], ["프론트엔드", "P01-003 도메인과 DNS"]]);
  assert.deepEqual(conceptHits(stages(), "계층 구조").map(d => d.next!.concept.name), ["OSI-7계층"]); // 설명까지
  assert.equal(conceptHits(stages(), "  ").length, 0);
});

test("공부 카드: 5단계 순서, 완료 기준 체크박스는 노트 체크박스 번호로", () => {
  const c = conceptsOf(stages()[0])[0];
  const body = "# P01-001\n\n## 목표\n**목표**: 웹을 설명한다\n\n## What\n인터넷은 망의 망\n\n## Practice\n- [ ] curl 해 보기\n\n## Explain\n세 문장으로\n\n## 완료 기준\n- [x] 설명함\n- [ ] 그림 그림\n";
  const d: Doc = { name: c.name, category: c.stage, summary: "", aliases: [], related: [], markdown: "", body, examples: [], file: "/v/P01-001-web.md",
    stub: false, meta: { status: c.status }, tasks: [{ done: false, text: "curl 해 보기" }, { done: true, text: "설명함" }, { done: false, text: "그림 그림" }], concept: c };
  const { md, taskMap } = studyCard(d);
  const steps = ["① 목표 확인", "② 읽고 이해하기", "③ 예측하고 직접 해 보기", "④ 문서를 닫고 설명하기", "⑤ 완료 기준 체크·증거 남기기"].map(s => md.indexOf(`#### ${s}`));
  assert.ok(steps.every((x, i) => x >= 0 && (i === 0 || x > steps[i - 1])), md);
  assert.ok(md.includes("웹을 설명한다") && md.includes("인터넷은 망의 망") && md.includes("curl 해 보기"), md);
  assert.deepEqual(taskMap, [0, 1, 2]); // 실습 칸 체크박스 → 완료 기준 체크박스 (화면 순서 = 노트 번호)
});

test("criteriaOf: 완료 기준 칸의 체크박스와 그 아래 증거", () => {
  const body = [
    "# 개념", "", "- [ ] 앞쪽 할 일", "```", "- [ ] 코드 안", "```",
    "## Explain · 학습 완료 기준",
    "- [x] **노트별 검증**: URL 5개 부분 표시",
    "  - 2026-11-23 메일은 웹이 아님",
    "    둘째 줄",
    "- [ ] **말로 설명**: 60~90초 설명",
    "- [ ] **독립 재현**: 다시 구현",
    "", "## 다음 칸", "- [ ] 다른 할 일",
  ].join("\n");
  const c = criteriaOf({ body } as Doc);
  assert.deepEqual(c.map(x => [x.index, x.label, x.done]), [[1, "노트별 검증", true], [2, "말로 설명", false], [3, "독립 재현", false]]);
  assert.equal(c[0].desc, "URL 5개 부분 표시");
  assert.equal(c[0].text, "**노트별 검증**: URL 5개 부분 표시");
  assert.deepEqual(c[0].evidence, ["2026-11-23 메일은 웹이 아님\n둘째 줄"]);
  assert.deepEqual(c[1].evidence, []);
});

test("criterionHints: 기준마다 답 근거가 되는 노트 칸", () => {
  const body = [
    "# 개념", "## 학습 순서와 목표", "- 목표",
    "## What · Why · How", "- 핵심 설명",
    "## Syntax · Example", "```text", "## 코드 안 제목은 칸이 아님", "```",
    "## Practice · 작은 구현", "- 실습",
    "## Real World · Connection", "- 자주 발생하는 오류",
    "## Explain · 학습 완료 기준", "- [ ] **노트별 검증**: x",
  ].join("\n");
  const titles = (label: string) => [...criterionHints({ body } as Doc, label).matchAll(/^\*\*(.+?)\*\*$/gm)].map(m => m[1]);
  assert.deepEqual(titles("노트별 검증"), ["What · Why · How", "Syntax · Example", "Practice · 작은 구현"]);
  assert.deepEqual(titles("말로 설명"), ["What · Why · How", "Real World · Connection"]);
  assert.deepEqual(titles("독립 재현"), ["Syntax · Example", "Practice · 작은 구현"]);
  assert.match(criterionHints({ body } as Doc, "독립 재현"), /## 코드 안 제목은 칸이 아님/);
});
