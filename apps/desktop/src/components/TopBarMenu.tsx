// Top-bar "…" overflow menu (Doubao-style). For now it holds a single action —
// Share conversation. More per-conversation actions can be added here later.

import { useEffect, useRef } from "react";
import { Share2 } from "lucide-react";
import { useTryLang } from "../lib/i18n";

const LABELS: Record<string, { share: string }> = {
  en: { share: "Share conversation" },
  zh: { share: "分享对话" },
  es: { share: "Compartir conversación" },
};

export function TopBarMenu({ onShare, onClose }: { onShare: () => void; onClose: () => void }) {
  const { lang } = useTryLang();
  const L = LABELS[lang] ?? LABELS.en;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div className="try-topbar-menu" ref={ref} role="menu">
      <button className="try-topbar-menu-item" onClick={onShare} role="menuitem">
        <Share2 className="h-4 w-4" />
        <span>{L.share}</span>
      </button>
    </div>
  );
}
