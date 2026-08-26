// Copy text reliably across contexts:
//   1. Electron native clipboard (window.__FRANKLIN__.copy) — most reliable in
//      the desktop app, where navigator.clipboard is flaky.
//   2. navigator.clipboard.writeText — browsers on a secure origin.
//   3. a hidden <textarea> + execCommand('copy') — last-resort fallback.
export async function copyText(text: string): Promise<boolean> {
  const bridge = typeof window !== "undefined" ? window.__FRANKLIN__ : undefined;
  if (bridge?.copy) {
    try {
      if (bridge.copy(text)) return true;
    } catch {
      /* fall through */
    }
  }

  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }

  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    ta.setAttribute("readonly", "");
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
