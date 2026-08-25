// Theme (Gold / Light / Dark). Applied via `data-theme` on <html>, persisted
// to localStorage. Same model as franklin-run's useTheme — ported verbatim
// because it has no Next.js dependency.

import { useEffect, useState } from "react";

export type Theme = "gold" | "light" | "dark";
const KEY = "franklin-webui-theme";

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>("gold");

  useEffect(() => {
    try {
      const saved = localStorage.getItem(KEY) as Theme | null;
      const next: Theme = saved === "light" || saved === "dark" || saved === "gold" ? saved : "gold";
      setThemeState(next);
      applyTheme(next);
    } catch { /* no localStorage — defaults to gold */ }
  }, []);

  const setTheme = (t: Theme) => {
    setThemeState(t);
    applyTheme(t);
    try { localStorage.setItem(KEY, t); } catch { /* ignore */ }
  };

  return { theme, setTheme };
}

function applyTheme(t: Theme) {
  if (t === "gold") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
}
