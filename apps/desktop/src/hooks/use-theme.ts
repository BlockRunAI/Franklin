// Theme (Light / Gold / Dark). Applied via `data-theme` on <html>, persisted
// to localStorage. Existing user choices are preserved; fresh installs start
// in Light.

import { useEffect, useState } from "react";

export type Theme = "gold" | "light" | "dark";
const KEY = "franklin-webui-theme";
const DEFAULT_THEME: Theme = "light";

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(DEFAULT_THEME);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(KEY) as Theme | null;
      const next: Theme = saved === "light" || saved === "dark" || saved === "gold" ? saved : DEFAULT_THEME;
      setThemeState(next);
      applyTheme(next);
    } catch { /* no localStorage — defaults to light */ }
  }, []);

  const setTheme = (t: Theme) => {
    setThemeState(t);
    applyTheme(t);
    try { localStorage.setItem(KEY, t); } catch { /* ignore */ }
  };

  return { theme, setTheme };
}

function applyTheme(t: Theme) {
  document.documentElement.setAttribute("data-theme", t);
}
