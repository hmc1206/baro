// 단축키 설정 화면: 목록, 단축키 입력 받기 (App.tsx에서 동작 그대로 옮김)
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Item } from "../commands";
import type { Hk, Mode } from "./types";
import { hotkeyLabels, fmtKey, accelOf } from "./keys";
import type { Setter } from "./ctx";

export function useHotkeys({ enter }: { enter: (m: Mode) => void }) {
  const [hk, setHk] = useState<Hk>({ keys: {}, recording: null, error: null });
  const startRecording = async (action: string) => {
    await invoke("suspend_hotkeys", { on: true });
    setHk(h => ({ ...h, recording: action, error: null }));
  };
  const saveHotkey = (action: string, accel: string) =>
    invoke<Record<string, string>>("set_hotkey", { action, accel })
      .then(keys => setHk({ keys, recording: null, error: null }))
      .catch(e => setHk(h => ({ ...h, recording: null, error: String(e) })));
  const hotkeyItems = (): Item[] => hotkeyLabels().map(([action, label]) => ({
    id: `hk-${action}`, title: label, kind: "cmd", glyph: "keyboard", section: "전역 단축키",
    subtitle: hk.recording === action ? "새 단축키를 누르세요 · Esc 취소" : fmtKey(hk.keys[action] ?? "") || "없음",
    actions: [
      { title: "단축키 바꾸기", keep: true, run: () => startRecording(action) },
      ...(action === "baro" ? [] : [{ title: "단축키 지우기", keep: true, run: () => saveHotkey(action, "") }]),
    ],
  }));
  const openHotkeys = () => {
    enter("hotkeys");
    invoke<Record<string, string>>("get_hotkeys").then(keys => setHk({ keys: keys ?? {}, recording: null, error: null }));
  };
  // 단축키 입력 중: 다음에 누른 조합을 저장
  const keyRecording = (e: KeyboardEvent): boolean => {
    if (!hk.recording) return false;
    e.preventDefault();
    if (e.key === "Escape") { invoke("suspend_hotkeys", { on: false }); setHk(h => ({ ...h, recording: null })); return true; }
    const accel = accelOf(e);
    if (accel) saveHotkey(hk.recording, accel);
    return true;
  };
  return { hk, setHk: setHk as Setter<Hk>, hotkeyItems, openHotkeys, keyRecording };
}
