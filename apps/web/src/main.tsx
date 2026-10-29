import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/primitives.css";
import "./app/app.css";
import "./media/media.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { EngineProvider } from "./store/engine";
import { initTheme } from "./store/theme";
import { initializeDesktop } from "./lib/desktop";

await initializeDesktop();
initTheme();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <EngineProvider>
      <App />
    </EngineProvider>
  </StrictMode>,
);
