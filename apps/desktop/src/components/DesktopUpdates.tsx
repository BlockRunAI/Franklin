import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Download, Loader2, RefreshCw, X } from "lucide-react";
import { useTryLang } from "../lib/i18n";
import { updateCopy, type DesktopUpdateState } from "../lib/desktop-updates";

interface UpdateControl {
  state: DesktopUpdateState | null;
  open: boolean;
  show: () => void;
  close: () => void;
  run: (action: "checkForUpdates" | "downloadUpdate" | "openUpdateInstaller" | "cancelUpdateDownload") => void;
}
const UpdateContext = createContext<UpdateControl | null>(null);
const DISMISSED_KEY = "franklin-dismissed-update-v1";

export function DesktopUpdateProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const api = window.__FRANKLIN__;
    if (!api?.getUpdateState) return;
    let active = true, changed = false;
    const unsubscribe = api.onUpdateState?.((next) => { changed = true; if (active) setState(next); });
    void api.getUpdateState().then((next) => { if (active && !changed) setState(next); }).catch(() => {});
    return () => { active = false; unsubscribe?.(); };
  }, []);
  const run = useCallback((action: Parameters<UpdateControl["run"]>[0]) => {
    const result = window.__FRANKLIN__?.[action]?.();
    void result?.then((next) => { if (next) setState(next); }).catch(() => setState((previous) => previous ? { ...previous, status: "error", error: "network" } : previous));
  }, []);
  const close = () => {
    if (state?.version) { try { localStorage.setItem(DISMISSED_KEY, state.version); } catch { /* optional preference */ } }
    setOpen(false);
  };
  return <UpdateContext.Provider value={{ state, open, show: () => setOpen(true), close, run }}>{children}</UpdateContext.Provider>;
}

export function DesktopUpdateMenuItem({ onSelect }: { onSelect: () => void }) {
  const updates = useContext(UpdateContext);
  const { lang } = useTryLang();
  if (!updates?.state) return null;
  const state = updates.state, copy = updateCopy[lang];
  const available = !!state.version && state.status !== "current";
  return <button type="button" className="try-select-option try-saver-row desktop-update-menu" role="menuitem" onClick={() => {
    onSelect(); updates.show();
    if (["idle", "error"].includes(state.status)) updates.run("checkForUpdates");
  }}>
    <Download className="h-4 w-4" aria-hidden />
    <span className="try-saver-text"><span className="try-select-option-label">{available ? `${copy.available} · ${state.version}` : copy.check}</span><span className="try-saver-desc">{copy.currentVersion} {state.currentVersion}</span></span>
    {available && <span className="desktop-update-dot" aria-hidden />}
  </button>;
}

export function DesktopUpdateNotice({ busy }: { busy: boolean }) {
  const updates = useContext(UpdateContext);
  const prompted = useRef(new Set<string>());
  const [visible, setVisible] = useState(document.visibilityState === "visible");
  useEffect(() => {
    const onVisibility = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);
  const state = updates?.state;
  useEffect(() => {
    if (!state?.version || state.status !== "available" || busy || !visible || updates?.open || prompted.current.has(state.version)) return;
    try { if (localStorage.getItem(DISMISSED_KEY) === state.version) return; } catch { /* show once per launch */ }
    prompted.current.add(state.version);
    updates?.show();
  }, [state, busy, visible, updates]);
  if (!updates?.open || !state) return null;
  return <DesktopUpdateDialog updates={updates} state={state} busy={busy} />;
}

function DesktopUpdateDialog({ updates, state, busy }: { updates: UpdateControl; state: DesktopUpdateState; busy: boolean }) {
  const { lang } = useTryLang();
  const copy = updateCopy[lang];
  const dialog = useRef<HTMLDivElement>(null);
  const closeRef = useRef(updates.close);
  closeRef.current = updates.close;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); closeRef.current(); }
      if (event.key !== "Tab") return;
      const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled), a[href]") ?? []);
      const first = controls[0], last = controls[controls.length - 1];
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); if (previous?.isConnected) previous.focus(); };
  }, []);
  const downloading = state.status === "downloading", opening = state.status === "opening";
  const unavailable = state.status === "disabled" || state.status === "unsupported";
  const error = state.error === "verification" ? copy.verification : state.error === "rateLimit" ? copy.rateLimit : state.error === "feed" ? copy.feed : state.error === "open" ? copy.open : copy.error;
  const status = state.status === "checking" ? copy.checking : state.status === "current" ? copy.current
    : unavailable ? copy[state.status as "disabled" | "unsupported"] : state.status === "error" ? error
    : downloading ? `${copy.downloading} ${state.progress ?? 0}%` : opening ? copy.opening : state.openedAt ? copy.opened : copy.description;
  const downloaded = state.status === "downloaded" || (state.status === "error" && state.error === "open");
  return createPortal(<div className="desktop-update-backdrop">
    <div className="desktop-update-dialog" ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="desktop-update-title" aria-describedby="desktop-update-status">
      <div className="desktop-update-heading"><Download size={22} aria-hidden /><h2 id="desktop-update-title">{state.version ? copy.available : copy.title}</h2><button type="button" onClick={updates.close} aria-label={copy.close}><X size={18} /></button></div>
      <div className="desktop-update-versions"><span>{copy.currentVersion} <strong>{state.currentVersion}</strong></span>{state.version && <span>{copy.newVersion} <strong>{state.version}</strong></span>}</div>
      <p id="desktop-update-status" role={state.status === "error" ? "alert" : "status"}>{status}</p>
      {downloading && <progress aria-label={copy.downloading} value={state.progress ?? 0} max={100} />}
      {state.version && <p className="desktop-update-help">{busy ? copy.busy : state.platform === "darwin" ? copy.mac : copy.win}</p>}
      <div className="desktop-update-actions">
        {state.releaseUrl && <a href={state.releaseUrl} target="_blank" rel="noreferrer">{copy.notes}</a>}
        <span />
        {downloading ? <button type="button" onClick={() => updates.run("cancelUpdateDownload")}>{copy.cancel}</button> : <button type="button" onClick={updates.close}>{state.version ? copy.later : copy.close}</button>}
        {!unavailable && <button type="button" className="is-primary" disabled={downloading || opening || state.status === "checking" || (downloaded && busy)} onClick={() => updates.run(downloaded ? "openUpdateInstaller" : state.status === "available" ? "downloadUpdate" : "checkForUpdates")}>
          {downloading || opening || state.status === "checking" ? <Loader2 size={15} className="spin" aria-hidden /> : downloaded || state.status === "available" ? <Download size={15} aria-hidden /> : <RefreshCw size={15} aria-hidden />}
          {downloading ? copy.downloading : opening ? copy.opening : state.status === "checking" ? copy.checking : downloaded ? copy.install : state.status === "available" ? copy.download : copy.check}
        </button>}
      </div>
    </div>
  </div>, document.body);
}
