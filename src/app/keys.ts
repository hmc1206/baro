// 단축키 표시·기록과 권한 안내 문구
import { getConfig } from "../commands";

// 권한별 안내 문구
export const PERMS: Record<string, { title: string; body: string }> = {
  accessibility: {
    title: "손쉬운 사용 권한이 필요해요",
    body: "창 관리와 붙여넣기는 다른 앱의 창과 키보드를 제어해야 해서 이 권한이 필요해요.\n\n" +
      "Enter를 누르면 시스템 설정 → 개인정보 보호 및 보안 → 손쉬운 사용 화면이 열려요. 목록에서 Baro를 켜 주세요. " +
      "목록에 없으면 + 버튼으로 /Applications/Baro.app을 추가하세요.\n\n" +
      "Baro를 새로 빌드해 설치하면 권한이 풀릴 수 있어요. 그때는 목록에서 Baro를 지웠다가 다시 추가하세요.",
  },
  automation: {
    title: "자동화 권한이 필요해요",
    body: "휴지통 비우기(Finder), 다크 모드 전환·창 관리·붙여넣기(System Events)는 다른 앱에 명령을 보내야 해서 이 권한이 필요해요.\n\n" +
      "처음 실행할 때 macOS가 \"Baro가 Finder를 제어하려고 합니다\"라고 물으면 허용을 누르세요. 이미 거절했다면 " +
      "Enter를 눌러 시스템 설정 → 개인정보 보호 및 보안 → 자동화에서 Baro 아래 항목을 켜 주세요.",
  },
  input: {
    title: "입력 모니터링 권한이 필요해요",
    body: "스니펫 자동 입력은 어느 앱에서든 ;키워드를 알아채야 해서 키 입력을 읽는 권한이 필요해요. " +
      "입력한 글자는 저장하지 않고 마지막 40글자만 잠깐 비교하며, 비밀번호 칸에서는 macOS가 아예 넘겨주지 않아요.\n\n" +
      "Enter를 누르면 시스템 설정 → 개인정보 보호 및 보안 → 입력 모니터링 화면이 열려요. 목록에서 Baro를 켠 뒤 " +
      "\"스니펫 자동 입력 켜기\"를 다시 실행하세요. (켠 뒤에도 안 되면 Baro를 껐다 켜 주세요.)",
  },
  ok: {
    title: "필요한 권한이 모두 있어요",
    body: "손쉬운 사용: 허용됨\n자동화: 휴지통 비우기·다크 모드를 처음 쓸 때 macOS가 따로 물어봐요.",
  },
};

// 단축키를 지정할 수 있는 기능: 고정 기능(Rust config.rs의 HOTKEY_ACTIONS) + 사용자가 만든 노트 검색
export const hotkeyLabels = (): [string, string][] => [
  ["baro", "Baro 열기"], ["ai", "AI에게 묻기"], ["store", "확장 스토어"], ["graph", "노트 그래프 (전체)"], ["files", "파일 찾기 (Finder)"], ["memo", "빠른 메모"], ["clipboard", "클립보드 기록"],
  ...getConfig().note_searches.map(n => [`note:${n.id}`, n.name] as [string, string]),
  // 검색어 없는 퀵링크 (예: 아이디어 캔버스 열기). 누르면 Baro 창 없이 바로 열림
  ...getConfig().quicklinks.filter(l => !l.url.includes("{query}")).map(l => [`link:${l.keyword}`, l.name] as [string, string]),
];
const KEY_NAMES: Record<string, string> = {
  Alt: "⌥", Option: "⌥", Shift: "⇧", Control: "⌃", Ctrl: "⌃", Super: "⌘", Cmd: "⌘", Command: "⌘", Meta: "⌘",
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Enter: "↵", Backquote: "`", Minus: "-", Equal: "=",
  Comma: ",", Period: ".", Slash: "/", Semicolon: ";", Quote: "'", BracketLeft: "[", BracketRight: "]", Backslash: "\\",
};
// "Alt+KeyL" → "⌥L"
export const fmtKey = (accel: string) =>
  accel ? accel.split("+").map(k => KEY_NAMES[k] ?? k.replace(/^Key|^Digit/, "")).join("") : "";
// 눌린 키 → "Alt+Shift+KeyL" (물리 키 이름이라 한글 자판에서도 같음)
export function accelOf(e: KeyboardEvent) {
  if (["Shift", "Alt", "Control", "Meta", "CapsLock"].includes(e.key)) return null;
  const mods = [e.ctrlKey && "Control", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Super"].filter(Boolean);
  // 수정 키 없이 쓸 수 있는 건 F1~F20만
  if (!mods.length && !/^F\d+$/.test(e.code)) return null;
  return [...mods, e.code].join("+");
}
