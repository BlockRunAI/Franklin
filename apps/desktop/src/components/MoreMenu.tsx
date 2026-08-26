import { useEffect, useRef, useState } from "react";
import { Settings, BookOpen, FileText, Globe, ArrowUpRight, Check, ChevronRight, Languages, Palette, Terminal, Github, PiggyBank } from "lucide-react";
import { useTryLang, TRY_LANGS } from "../lib/i18n";
import { useTheme, type Theme } from "../hooks/use-theme";
import { useCostSaver } from "../hooks/use-cost-saver";
import { copyText } from "../lib/clipboard";

const SAVER_LABELS: Record<string, { label: string; desc: string }> = {
  en: { label: "Cost saver", desc: "Auto-compress history on long, tool-heavy turns to cut token cost" },
  zh: { label: "省钱模式", desc: "长任务自动压缩历史,降低 token 重复开销" },
  es: { label: "Ahorro de costes", desc: "Comprime el historial en turnos largos para reducir el coste" },
};

// Bottom-left settings menu (Doubao-style): language + theme as right-flyout
// submenus, then official site, docs, blog, GitHub — all in one gear menu.
export function MoreMenu() {
  const { t, lang, setLang } = useTryLang();
  const { theme, setTheme } = useTheme();
  const costSaver = useCostSaver();
  const SL = SAVER_LABELS[lang] ?? SAVER_LABELS.en;
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
      <button className="try-lang-btn" onClick={() => setOpen((o) => !o)} aria-label={t.settings} aria-expanded={open}>
        <Settings className="h-[18px] w-[18px]" />
      </button>
      {open && (
        <div className="try-settings-menu" role="menu">
          {/* Language → right flyout */}
          <div className="try-sub">
            <button type="button" className="try-select-option try-sub-row">
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
          <div className="try-sub">
            <button type="button" className="try-select-option try-sub-row">
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
          <div className="try-select-divider" />
          <button type="button" className="try-select-option" onClick={copyInstall}>
            <Terminal className="h-4 w-4" />
            <span className="try-select-option-label">{copied ? t.copied : t.installCli}</span>
            {copied && <Check className="try-select-check" />}
          </button>
        </div>
      )}
    </div>
  );
}
