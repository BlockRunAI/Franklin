import { useEffect, useRef, useState } from "react";
import { Settings, BookOpen, FileText, Globe, ArrowUpRight, Check, ChevronRight, Languages, Palette, Terminal, Github, PiggyBank, PanelLeft, RotateCcw, ChartCandlestick } from "lucide-react";
import { useTryLang, TRY_LANGS } from "../lib/i18n";
import { useTheme, type Theme } from "../hooks/use-theme";
import { useCostSaver } from "../hooks/use-cost-saver";
import { copyText } from "../lib/clipboard";
import { SIDEBAR_ITEMS, useSidebarPreferences } from "../hooks/use-sidebar-preferences";
import type { TradingModeControl } from "../lib/trading-mode";
import { marketCopy } from "../lib/market-i18n";

const SAVER_LABELS: Record<string, { label: string; desc: string }> = {
  en: { label: "Cost saver", desc: "Auto-compress history on long, tool-heavy turns to cut token cost" },
  zh: { label: "省钱模式", desc: "长任务自动压缩历史,降低 token 重复开销" },
  es: { label: "Ahorro de costes", desc: "Comprime el historial en turnos largos para reducir el coste" },
};

// Bottom-left settings menu (Doubao-style): language + theme as right-flyout
// submenus, then official site, docs, blog, GitHub — all in one gear menu.
export function MoreMenu({ tradingMode }: { tradingMode?: TradingModeControl }) {
  const { t, lang, setLang } = useTryLang();
  const { theme, setTheme } = useTheme();
  const costSaver = useCostSaver();
  const sidebar = useSidebarPreferences();
  const SL = SAVER_LABELS[lang] ?? SAVER_LABELS.en;
  const copy = marketCopy[lang];
  const [copied, setCopied] = useState(false);
  const copyInstall = async () => {
    if (await copyText("npm install -g @blockrun/franklin")) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }
  };
  const themeOptions: { id: Theme; label: string }[] = [
    { id: "light", label: t.themeLight },
    { id: "gold", label: t.themeGold },
    { id: "dark", label: t.themeDark },
  ];
  const [open, setOpen] = useState(false);
  const [submenu, setSubmenu] = useState<"language" | "theme" | "sidebar" | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="try-settings" ref={ref}>
      <button className="try-lang-btn" onClick={() => { setSubmenu(null); setOpen((o) => !o); }} aria-label={t.settings} aria-expanded={open}>
        <Settings className="h-[18px] w-[18px]" />
      </button>
      {open && (
        <div className="try-settings-menu" role="menu">
          {tradingMode && <>
            <button type="button" className="try-select-option try-saver-row trading-mode-setting" role="menuitemcheckbox" aria-checked={tradingMode.enabled} disabled={tradingMode.disabled}
              onClick={() => { setOpen(false); tradingMode.onChange(!tradingMode.enabled); }}>
              <ChartCandlestick className="h-4 w-4" />
              <span className="try-saver-text"><span className="try-select-option-label">{copy.tradingMode}</span><span className="try-saver-desc">{tradingMode.disabled ? copy.modeWait : copy.tradingModeDescription}</span></span>
              <span className={`try-switch${tradingMode.enabled ? " is-on" : ""}`} aria-hidden><span className="try-switch-knob" /></span>
            </button>
            <div className="try-select-divider" />
          </>}
          {/* Language → right flyout */}
          <div className={`try-sub${submenu === "language" ? " is-expanded" : ""}`}>
            <button type="button" className="try-select-option try-sub-row" aria-expanded={submenu === "language"} onClick={() => setSubmenu(submenu === "language" ? null : "language")}>
              <Languages className="h-4 w-4" />
              <span className="try-select-option-label">{t.language}</span>
              <ChevronRight className="h-4 w-4 try-sub-caret" />
            </button>
            <div className="try-submenu">
              {TRY_LANGS.map((l) => {
                const active = l.id === lang;
                return (
                  <button
                    key={l.id}
                    type="button"
                    className={`try-select-option${active ? " is-active" : ""}`}
                    onClick={() => {
                      setLang(l.id);
                      setOpen(false);
                    }}
                  >
                    <span className="try-select-option-label">{l.label}</span>
                    {active && <Check className="try-select-check" />}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Theme → right flyout */}
          <div className={`try-sub${submenu === "theme" ? " is-expanded" : ""}`}>
            <button type="button" className="try-select-option try-sub-row" aria-expanded={submenu === "theme"} onClick={() => setSubmenu(submenu === "theme" ? null : "theme")}>
              <Palette className="h-4 w-4" />
              <span className="try-select-option-label">{t.theme}</span>
              <ChevronRight className="h-4 w-4 try-sub-caret" />
            </button>
            <div className="try-submenu">
              {themeOptions.map((o) => {
                const active = o.id === theme;
                return (
                  <button
                    key={o.id}
                    type="button"
                    className={`try-select-option${active ? " is-active" : ""}`}
                    onClick={() => setTheme(o.id)}
                  >
                    <span className="try-select-option-label">{o.label}</span>
                    {active && <Check className="try-select-check" />}
                  </button>
                );
              })}
            </div>
          </div>

          {!tradingMode?.enabled && <div className={`try-sub${submenu === "sidebar" ? " is-expanded" : ""}`}>
            <button type="button" className="try-select-option try-sub-row" aria-expanded={submenu === "sidebar"} onClick={() => setSubmenu(submenu === "sidebar" ? null : "sidebar")}>
              <PanelLeft className="h-4 w-4" />
              <span className="try-select-option-label">Sidebar</span>
              <ChevronRight className="h-4 w-4 try-sub-caret" />
            </button>
            <div className="try-submenu try-sidebar-settings">
              <div className="try-sidebar-settings-head"><strong>Show in sidebar</strong><button type="button" onClick={sidebar.reset}><RotateCcw /> Reset</button></div>
              {SIDEBAR_ITEMS.map((item) => {
                const visible = sidebar.visibleItems.includes(item.id);
                return <button key={item.id} type="button" className={`try-select-option${visible ? " is-active" : ""}`} onClick={() => sidebar.setItemVisible(item.id, !visible)}><span className="try-select-option-label">{item.label}</span>{visible && <Check className="try-select-check" />}</button>;
              })}
            </div>
          </div>}

          <div className="try-select-divider" />
          {/* Cost-saver (research-bloat compaction) toggle */}
          <button
            type="button"
            className="try-select-option try-saver-row"
            onClick={costSaver.toggle}
            disabled={!costSaver.ready}
            role="menuitemcheckbox"
            aria-checked={costSaver.enabled}
          >
            <PiggyBank className="h-4 w-4" />
            <span className="try-saver-text">
              <span className="try-select-option-label">{SL.label}</span>
              <span className="try-saver-desc">{SL.desc}</span>
            </span>
            <span className={`try-switch${costSaver.enabled ? " is-on" : ""}`} aria-hidden>
              <span className="try-switch-knob" />
            </span>
          </button>

          <div className="try-select-divider" />
          <a className="try-select-option" href="https://franklin.run/about" target="_blank" rel="noreferrer">
            <Globe className="h-4 w-4" />
            <span className="try-select-option-label">{t.officialSite}</span>
          </a>
          <a className="try-select-option" href="https://franklin.run/docs" target="_blank" rel="noreferrer">
            <BookOpen className="h-4 w-4" />
            <span className="try-select-option-label">{t.docs}</span>
          </a>
          <a className="try-select-option" href="https://franklin.run/blog/en" target="_blank" rel="noreferrer">
            <FileText className="h-4 w-4" />
            <span className="try-select-option-label">{t.blog}</span>
          </a>
          <a className="try-select-option" href="https://github.com/blockrunai/franklin" target="_blank" rel="noreferrer">
            <Github className="h-4 w-4" />
            <span className="try-select-option-label">GitHub</span>
            <ArrowUpRight className="h-3.5 w-3.5 try-select-ext" />
          </a>
          {!tradingMode?.enabled && <><div className="try-select-divider" />
          <button type="button" className="try-select-option" onClick={copyInstall}>
            <Terminal className="h-4 w-4" />
            <span className="try-select-option-label">{copied ? t.copied : t.installCli}</span>
            {copied && <Check className="try-select-check" />}
          </button></>}
        </div>
      )}
    </div>
  );
}
