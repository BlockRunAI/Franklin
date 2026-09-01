import { useEffect, useState } from "react";

export type SidebarItemId = "agents" | "tools" | "gallery" | "cli" | "mcp" | "skills" | "phone" | "wallet";

export const SIDEBAR_ITEMS: { id: SidebarItemId; label: string }[] = [
  { id: "agents", label: "Agents" },
  { id: "tools", label: "Marketplace" },
  { id: "gallery", label: "Gallery" },
  { id: "cli", label: "Install CLI" },
  { id: "mcp", label: "MCP" },
  { id: "skills", label: "Skills" },
  { id: "phone", label: "Phone" },
  { id: "wallet", label: "Wallet" },
];

const STORAGE_KEY = "franklin-sidebar-preferences-v1";
const CHANGE_EVENT = "franklin:sidebar-preferences";
const DEFAULT_VISIBLE = SIDEBAR_ITEMS.map((item) => item.id);

function loadVisible(): SidebarItemId[] {
  if (typeof window === "undefined") return DEFAULT_VISIBLE;
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!Array.isArray(saved)) return DEFAULT_VISIBLE;
    return DEFAULT_VISIBLE.filter((id) => saved.includes(id));
  } catch {
    return DEFAULT_VISIBLE;
  }
}

export function useSidebarPreferences() {
  const [visibleItems, setVisibleItems] = useState<SidebarItemId[]>(loadVisible);

  useEffect(() => {
    const sync = () => setVisibleItems(loadVisible());
    window.addEventListener(CHANGE_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(CHANGE_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const save = (next: SidebarItemId[]) => {
    setVisibleItems(next);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* local cache unavailable */ }
    window.dispatchEvent(new Event(CHANGE_EVENT));
  };

  const setItemVisible = (id: SidebarItemId, visible: boolean) => {
    save(visible
      ? DEFAULT_VISIBLE.filter((item) => item === id || visibleItems.includes(item))
      : visibleItems.filter((item) => item !== id));
  };

  const reset = () => save(DEFAULT_VISIBLE);

  return { visibleItems, setItemVisible, reset };
}
