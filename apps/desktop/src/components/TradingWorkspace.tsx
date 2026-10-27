import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Columns2, Maximize2, MessageSquare, X } from "lucide-react";
import { useTryLang } from "../lib/i18n";
import { marketCopy } from "../lib/market-i18n";
import { transitionUi } from "../lib/ui-transition";

type Layout = "split" | "chat" | "market";
const KEY = "franklin-trading-layout-v1";
function load(): { layout: Layout; width: number } {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null");
    return { layout: ["split", "chat", "market"].includes(saved?.layout) ? saved.layout : "split", width: Number.isFinite(saved?.width) ? Math.max(32, Math.min(60, saved.width)) : 40 };
  } catch { return { layout: "split", width: 40 }; }
}

export function TradingWorkspace({ active, children, market, conversationRequest, onClose, exitLabel, exitDisabled = false }: {
  active: boolean; children: ReactNode; market: ReactNode; conversationRequest: number; onClose: () => void; exitLabel?: string; exitDisabled?: boolean;
}) {
  const { lang } = useTryLang();
  const copy = marketCopy[lang];
  const [preferences, setPreferences] = useState(load);
  const [mobilePane, setMobilePane] = useState<"chat" | "market">("market");
  const [dragging, setDragging] = useState(false);
  const grid = useRef<HTMLDivElement>(null);
  const conversation = useRef<HTMLDivElement>(null);
  const previousRequest = useRef(conversationRequest);
  const save = useCallback((patch: Partial<ReturnType<typeof load>>) => {
    setPreferences((previous) => ({ ...previous, ...patch }));
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => {
      try { localStorage.setItem(KEY, JSON.stringify(preferences)); } catch { /* optional preference */ }
    }, 200);
    return () => clearTimeout(timer);
  }, [preferences]);
  useEffect(() => {
    if (conversationRequest === previousRequest.current) return;
    previousRequest.current = conversationRequest;
    const frame = requestAnimationFrame(() => transitionUi(() => {
      save({ layout: "split" });
      setMobilePane("chat");
    }, () => conversation.current?.querySelector("textarea")?.focus({ preventScroll: true })));
    return () => cancelAnimationFrame(frame);
  }, [conversationRequest, save]);

  const layout = preferences.layout;
  const switchLayout = (next: Layout) => {
    transitionUi(() => {
      save({ layout: next });
      if (next !== "split") setMobilePane(next);
    });
  };
  return <div className={`trading-workspace${active ? " is-active" : ""}`} data-layout={layout} data-mobile-pane={mobilePane}>
    {active && <header className="trading-workspace-bar">
      <div><span className="trading-workspace-dot" aria-hidden /><strong>{exitLabel ? copy.tradingMode : copy.workspace}</strong><small>{copy.workspaceHint}</small></div>
      <div className="trading-layout-controls" role="group" aria-label={copy.layout}>
        <button type="button" className="trading-split-control" aria-pressed={layout === "split"} title={copy.split} onClick={() => switchLayout("split")}><Columns2 size={14} aria-hidden /><span>{copy.split}</span></button>
        <button type="button" aria-pressed={layout === "chat"} title={copy.conversation} onClick={() => switchLayout("chat")}><MessageSquare size={14} aria-hidden /><span>{copy.conversation}</span></button>
        <button type="button" aria-pressed={layout === "market"} title={copy.chartFocus} onClick={() => switchLayout("market")}><Maximize2 size={14} aria-hidden /><span>{copy.chartFocus}</span></button>
        <button type="button" className="trading-close" aria-label={exitLabel ?? copy.closeWorkspace} title={exitDisabled ? copy.modeWait : exitLabel ?? copy.closeWorkspace} disabled={exitDisabled} onClick={onClose}><X size={15} aria-hidden /></button>
      </div>
    </header>}
    <div ref={grid} className={`trading-workspace-grid${dragging ? " is-resizing" : ""}`} style={{ "--conversation-width": `${preferences.width}%` } as CSSProperties}>
      <div ref={conversation} className="trading-conversation" role={active ? "region" : undefined} aria-label={active ? copy.conversation : undefined}>{children}</div>
      {active && <>
        <div className="trading-divider" role="separator" tabIndex={0} aria-label={copy.resize} aria-orientation="vertical" aria-valuenow={preferences.width} aria-valuemin={32} aria-valuemax={60}
          onKeyDown={(event) => {
            const next = event.key === "ArrowLeft" ? preferences.width + 2 : event.key === "ArrowRight" ? preferences.width - 2 : event.key === "Home" ? 32 : event.key === "End" ? 60 : null;
            if (next === null) return;
            event.preventDefault(); save({ width: Math.max(32, Math.min(60, next)) });
          }}
          onPointerDown={(event) => { if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); setDragging(true); }}
          onPointerMove={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId) || !grid.current) return;
            const bounds = grid.current.getBoundingClientRect();
            save({ width: Math.max(32, Math.min(60, (bounds.right - event.clientX) / bounds.width * 100)) });
          }}
          onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); setDragging(false); }}
          onLostPointerCapture={() => setDragging(false)} />
        <aside className="trading-market" aria-label={copy.chartFocus}>{market}</aside>
      </>}
    </div>
  </div>;
}
