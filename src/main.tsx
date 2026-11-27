import { createRoot } from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import { Desktop } from "./desktop/Desktop";
import "./styles.css";
// 같은 화면 코드를 창 두 개가 씀: "main" = 런처, "desktop" = 바탕화면 모드
const desktop = (() => { try { return getCurrentWindow().label === "desktop"; } catch { return false; } })();
if (desktop) document.documentElement.classList.add("desk");
createRoot(document.getElementById("root")!).render(desktop ? <Desktop /> : <App />);
