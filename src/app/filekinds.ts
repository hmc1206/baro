// 파일 찾기 화면: 확장자로 종류를 나누고 종류별 구역으로 묶기
const KINDS: [string, string[]][] = [
  ["문서", ["md", "txt", "rtf", "doc", "docx", "hwp", "hwpx", "pages", "odt", "ppt", "pptx", "key", "xls", "xlsx", "numbers", "csv", "tsv"]],
  ["PDF", ["pdf"]],
  ["이미지", ["png", "jpg", "jpeg", "gif", "heic", "webp", "svg", "bmp", "tif", "tiff", "psd", "ai", "fig", "raw"]],
  ["영상", ["mp4", "mov", "mkv", "avi", "webm", "m4v"]],
  ["음악·소리", ["mp3", "wav", "m4a", "flac", "aac", "ogg", "aiff"]],
  ["코드", ["ts", "tsx", "js", "jsx", "mjs", "py", "ipynb", "rs", "java", "kt", "c", "h", "cpp", "go", "rb", "swift", "sh", "zsh", "sql",
    "json", "yaml", "yml", "toml", "html", "css", "xml"]],
  ["압축·설치", ["zip", "tar", "gz", "tgz", "7z", "rar", "dmg", "pkg", "iso"]],
];
export const KIND_ORDER = [...KINDS.map(k => k[0]), "기타"];
const BY_EXT = new Map(KINDS.flatMap(([k, exts]) => exts.map(e => [e, k] as [string, string])));

export function fileKind(path: string): string {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? BY_EXT.get(name.slice(dot + 1).toLowerCase()) ?? "기타" : "기타";
}

// 종류 순서대로 묶고 구역마다 per개까지. 더 있으면 구역 끝에 "더 보기" 항목(more로 만듦)을 붙임.
// open: 한 종류만 펼쳐 보는 중이면 그 종류 전부
export function groupByKind<T extends { path?: string; section?: string }>(
  items: T[], per: number, open: string | null, more: (kind: string, rest: number) => T): T[] {
  const groups = new Map<string, T[]>(KIND_ORDER.map(k => [k, []]));
  for (const it of items) groups.get(fileKind(it.path ?? ""))!.push(it);
  if (open) return (groups.get(open) ?? []).map(it => ({ ...it, section: `${open} ${groups.get(open)!.length}개` }));
  return KIND_ORDER.flatMap(k => {
    const g = groups.get(k)!;
    const label = `${k} ${g.length}개`;
    const shown = g.slice(0, per).map(it => ({ ...it, section: label }));
    return g.length > per ? [...shown, { ...more(k, g.length - per), section: label }] : shown;
  });
}
