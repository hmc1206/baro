// Baro 노트 편집기: 원문 ↔ 속성·내용 칸. 제목은 파일 이름 (본문에 "# 제목"을 따로 넣지 않음)
// 원문 = 머리말(--- 속성 ---) + 내용. 속성 값은 YAML 그대로(여러 줄 목록도 줄바꿈 포함 그대로) 다룸
export type Prop = { key: string; value: string };
export type DocFields = { title: string; props: Prop[]; body: string };

export function parseDoc(raw: string, title: string): DocFields {
  const props: Prop[] = [];
  let body = raw;
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    body = raw.slice(fm[0].length).replace(/^\n/, "");
    for (const line of fm[1].split("\n")) {
      const m = line.match(/^([^\s:#][^:]*):(.*)$/);
      if (m) props.push({ key: m[1].trim(), value: m[2].trim() });
      else if (props.length) props[props.length - 1].value += "\n" + line; // 목록 등 이어지는 줄
    }
  }
  return { title, props, body };
}

export function serializeDoc(f: DocFields): string {
  const props = f.props.filter(p => p.key.trim());
  const head = props.length ? `---\n${props.map(p => `${p.key.trim()}:${p.value === "" || p.value.startsWith("\n") ? "" : " "}${p.value}`).join("\n")}\n---\n\n` : "";
  return head + f.body;
}

// 파일 경로 → 제목(파일 이름)
export const titleOf = (file: string) => (file.split("/").pop() ?? "").replace(/\.md$/, "");

// 태그: 머리말 tags 값(한 줄 "a, b", "[a, b]", 또는 여러 줄 "- a") ↔ 목록. 저장은 여러 줄 목록 모양
export function tagsOf(value: string): string[] {
  const v = value.trim();
  const items = v.includes("\n") || v.startsWith("-") ? v.split("\n").map(l => l.trim().replace(/^-\s*/, ""))
    : v.replace(/^\[|\]$/g, "").split(",");
  return items.map(t => t.trim().replace(/^["']|["']$/g, "").replace(/^#/, "")).filter(Boolean);
}
export const tagsValue = (tags: string[]) => tags.map(t => `\n  - ${t}`).join("");
// 태그 바꾸기: tags 속성이 있으면 그 자리에서, 없으면 끝에 추가. 태그가 없어지면 속성도 뺌
export function withTags(f: DocFields, tags: string[]): DocFields {
  const i = f.props.findIndex(p => p.key.trim() === "tags");
  const props = tags.length
    ? (i < 0 ? [...f.props, { key: "tags", value: tagsValue(tags) }] : f.props.map((p, j) => j === i ? { ...p, value: tagsValue(tags) } : p))
    : f.props.filter((_, j) => j !== i);
  return { ...f, props };
}
