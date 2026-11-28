// 확장 스토어 화면 (App.tsx에서 동작 그대로 옮김)
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { StoreEntry } from "../commands";
import type { Mode, Store } from "./types";

export function useStore({ enter }: { enter: (m: Mode) => void }) {
  const [store, setStore] = useState<Store>({ entries: [], loading: false, error: null });
  const openStore = () => {
    enter("store");
    setStore(s => ({ ...s, loading: true, error: null }));
    invoke<StoreEntry[]>("store_list")
      .then(entries => setStore({ entries, loading: false, error: null }))
      .catch(e => setStore({ entries: [], loading: false, error: String(e) }));
  };
  return { store, openStore };
}
