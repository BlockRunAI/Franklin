// App shell — i18n provider + theme bootstrap + the main chat surface. v0.1
// has only the chat view; later phases insert routing (files / terminal /
// plugins panels) here.

import { useEffect } from "react";
import { FranklinChat } from "./components/FranklinChat";
import { TryLangProvider } from "./lib/i18n";
import { useTheme } from "./hooks/use-theme";

function ThemeBoot() {
  // Mounting the hook is enough — it pulls from localStorage and applies the
  // data-theme attribute. Nothing to render.
  useTheme();
  return null;
}

// Detected once: are we running inside the Electron desktop shell? The preload
// injects window.__FRANKLIN__. In the desktop we reserve a draggable title-bar
// strip at the top (macOS hides the OS title bar); in a browser tab we don't.
const IS_ELECTRON = typeof window !== "undefined" && !!window.__FRANKLIN__;

export default function App() {
  // Tab title reflects local-only nature so users find the WebUI tab among
  // many open tabs while the CLI owns the terminal.
  useEffect(() => {
    document.title = "Franklin · Local WebUI";
  }, []);

  useEffect(() => {
    if (IS_ELECTRON) {
      document.documentElement.classList.add("is-electron");
      // macOS uses hiddenInset (traffic lights overlay the toolbar); only there
      // do we inset the toolbar to clear them.
      if (/Mac/i.test(navigator.platform || navigator.userAgent)) {
        document.documentElement.classList.add("is-mac");
      }
    }
  }, []);

  return (
    <TryLangProvider>
      <ThemeBoot />
      <FranklinChat />
    </TryLangProvider>
  );
}
