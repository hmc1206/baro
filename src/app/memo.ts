// 빠른 메모·클립보드 기록: 날짜 문구와 기록 칸 읽기 (Rust wiki.rs와 같은 규칙)
import type { RecItem } from "./types";

export const dayOf = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
export function clipDay(ms: number) {
  const t = dayOf(Date.now()), y = dayOf(Date.now() - 86400000), d = dayOf(ms);
  return d === t ? "오늘" : d === y ? "어제" : d;
}
export const clipTime = (ms: number) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const RECORD = { learn: "배운 점", stuck: "막힌 점과 해결", cmd: "사용한 명령어" } as const;
export const pad = (n: number) => String(n).padStart(2, "0");
// 마지막 공부 날짜 → "오늘", "3일 전"
export const ago = (date?: string) => {
  const t = date && Date.parse(`${date}T00:00:00`);
  if (!t) return "";
  const n = Math.round((Date.parse(`${now().date}T00:00:00`) - t) / 86400000);
  return n <= 0 ? "오늘 공부" : `${n}일 전 공부`;
};
export const now = () => { const d = new Date(); return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` }; };
// 명령어 기록: 한 줄이면 "- `cmd`", 여러 줄이거나 `가 있으면 코드 블록
export const cmdBlock = (s: string) => !s.includes("\n") && !s.includes("`") ? `- \`${s}\`` : "```bash\n" + s + "\n```";
// 여러 줄 메모 → 목록 한 항목 (둘째 줄부터 들여쓰기)
export const listBlock = (s: string) => "- " + s.split("\n").map(l => l.trimEnd()).join("\n  ");
export function itemsOf(lines: string[]): RecItem[] {
  const out: RecItem[] = [];
  for (let i = 0; i < lines.length;) {
    let j = i + 1;
    if (lines[i].startsWith("```")) { while (j < lines.length && !lines[j].startsWith("```")) j++; j = Math.min(j + 1, lines.length); }
    else if (lines[i].startsWith("- ")) { while (j < lines.length && lines[j].trim() && /^[ \t]/.test(lines[j])) j++; }
    else { i++; continue; }
    out.push({ i: out.length, first: lines[i], text: lines.slice(i, j).join("\n") });
    i = j;
  }
  return out;
}
export const sectionRaw = (body: string, name: string) => {
  const lines = body.split("\n"), h = lines.findIndex(l => l.trimEnd() === `### ${name}`);
  if (h < 0) return [];
  const end = lines.findIndex((l, i) => i > h && l.startsWith("#"));
  return lines.slice(h + 1, end < 0 ? undefined : end);
};
export const dailyRaw = (text: string) => { const m = text.match(/^---\n[\s\S]*?\n---\n/); return (m ? text.slice(m[0].length) : text).split("\n"); };
// 기록 고치기: 저장된 항목 → 입력칸에 넣을 글 (Daily는 시각을 떼어 두고, 명령어 칸은 `·코드 블록을 벗김)
export function editTextOf(it: RecItem, sec: string): { text: string; time?: string } {
  const lines = it.text.split("\n");
  if (lines[0].startsWith("```")) return { text: lines.slice(1, lines[lines.length - 1].startsWith("```") ? -1 : undefined).join("\n") };
  const body = [lines[0].slice(2), ...lines.slice(1).map(l => l.replace(/^ {1,2}|^\t/, ""))];
  if (sec === "daily") { const m = body[0].match(/^(\d\d:\d\d) ?(.*)$/); if (m) return { time: m[1], text: [m[2], ...body.slice(1)].join("\n") }; }
  if (sec === RECORD.cmd && body.length === 1) { const m = body[0].match(/^`([^`]*)`$/); if (m) return { text: m[1] }; }
  return { text: body.join("\n") };
}
// 고친 글 → 파일에 넣을 블록 (처음 저장할 때와 같은 모양)
export function editBlockOf(sec: string, text: string, time?: string): string {
  const s = text.split("\n").map(l => l.trimEnd()).join("\n").trim();
  if (sec === "daily") return listBlock(time ? `${time} ${s}` : s);
  return sec === RECORD.cmd ? cmdBlock(s) : listBlock(s);
}
