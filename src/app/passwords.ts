// 비밀번호 모음: 새 노트 이름·내용 만들기
import type { Doc } from "../notes";

export const MASK = "••••••••";
export const yamlQuote = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
export const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
export const baseOf = (file: string) => file.split("/").pop()!.replace(/\.md$/, "");
// 새 노트 이름 제안: 마지막 노트 이름의 끝 숫자 + 1 (자릿수 유지). 예: Bandit-Level-23 → Bandit-Level-24
export function nextName(last?: Doc) {
  const b = last ? baseOf(last.file) : "새-항목-1";
  const m = b.match(/^(.*?)(\d+)$/);
  return m ? m[1] + String(Number(m[2]) + 1).padStart(m[2].length, "0") : `${b}-2`;
}
// 새 노트 내용: 마지막 노트의 머리말을 이어받아 번호만 바꿈 (level·login·ssh 등), 비밀번호는 입력값
export function newPwNote(last: Doc | undefined, name: string, title: string, password: string) {
  const oldNum = last?.meta.level ?? baseOf(last?.file ?? "").match(/(\d+)$/)?.[1];
  const newNum = name.match(/(\d+)$/) ? String(Number(name.match(/(\d+)$/)![1])) : undefined;
  const lines = ["---", `created: ${today()}`];
  for (const [k, v0] of Object.entries(last?.meta ?? {})) {
    if (["created", "updated", "password", "key_file"].includes(k)) continue;
    let v = last?.meta.key_file ? v0.replace(`-i ${last.meta.key_file} `, "") : v0;
    if (oldNum && newNum) v = v.replace(new RegExp(`(?<!\\d)${Number(oldNum)}(?!\\d)`, "g"), newNum);
    lines.push(`${k}: ${/^[\w.-]+$/.test(v) ? v : yamlQuote(v)}`);
  }
  if (last?.aliases.length) lines.push(`tags: [${last.aliases.join(", ")}]`);
  lines.push(`password: ${yamlQuote(password)}`, "---");
  const prefix = last ? baseOf(last.file).replace(/\d+$/, "") : "";
  const keep = [...(last?.body.split(/^## 관련\s*$/m)[1] ?? "").matchAll(/\[\[([^\]|#]+)/g)].map(m => m[1]).filter(l => !prefix || !l.startsWith(prefix));
  const links = [...new Set([...keep, ...(last ? [baseOf(last.file)] : [])])].map(l => `[[${l}]]`).join(" · ");
  return `${lines.join("\n")}\n\n# ${title || name}\n\n## 풀이\n- \n\n## 배운 점\n- \n\n## 관련\n${links}\n`;
}
