// Obsidian 열기·개념 노트 만들기 (App.tsx에서 동작 그대로 옮김)
import { invoke } from "@tauri-apps/api/core";
import type { Doc } from "../notes";
import { docCache } from "./status";
import { today } from "./passwords";

// 뉴스 출처는 https 주소라 그대로 브라우저로 엶
export const openObsidian = (file: string) => invoke("open_url", { url: /^https:\/\//.test(file) ? file : `obsidian://open?path=${encodeURIComponent(file)}` });

// 아직 없는 [[링크]] → 개념 노트 만들기 (Vault에 같은 이름이 있으면 그 노트를 엶). 만든 뒤 Obsidian에서 열기
export async function createConcept(src: Doc, name: string, { reloadDocs, failNote }: { reloadDocs: () => Promise<void>; failNote: (title: string) => (e: unknown) => void }) {
  try {
    const [path, made] = await invoke<[string, boolean]>("concept_create", { src: src.file, name, date: today() });
    docCache.delete("__vault");
    if (made) await reloadDocs().catch(() => {});
    await openObsidian(path);
  } catch (e) { failNote("개념 노트를 만들지 못했어요")(e); }
}
