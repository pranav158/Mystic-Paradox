import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/cinzel";
import "@fontsource-variable/inter";
import App from "./App";
import { installPointerFx } from "./lib/pointerFx";
import { applyUiScale } from "./lib/prefs";
import "./index.css";

async function boot() {
  // `npm run dev` in a normal browser has no Tauri runtime; install IPC mocks so the UI can be
  // previewed and screenshotted. Never part of a production build (the branch is compiled out).
  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
    await import("./dev/browserPreview");
  }
  // Set the saved interface size before the first paint so the layout never jumps.
  await applyUiScale();
  installPointerFx();
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void boot();
