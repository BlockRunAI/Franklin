import { useState } from "react";
import { Terminal, Copy, Check, BookOpen, ArrowUpRight, Github } from "lucide-react";
import { useTryLang } from "../lib/i18n";
import { copyText } from "../lib/clipboard";

const INSTALL_CMD = "npm install -g @blockrun/franklin";
const RUN_CMD = "franklin";

// "Install the CLI" overview — the same agent, in your terminal.
export function CLIPanel() {
  const { t } = useTryLang();
  const [copied, setCopied] = useState<string | null>(null);

  const copy = async (cmd: string) => {
    if (await copyText(cmd)) {
      setCopied(cmd);
      setTimeout(() => setCopied((c) => (c === cmd ? null : c)), 1800);
    }
  };

  const cmdRow = (cmd: string) => (
    <button className="try-cli-cmd" onClick={() => copy(cmd)} aria-label={t.cliCopy}>
      <span className="try-cli-prompt">$</span>
      <code>{cmd}</code>
      {copied === cmd ? (
        <Check className="try-cli-copy-icon" />
      ) : (
        <Copy className="try-cli-copy-icon" />
      )}
    </button>
  );

  return (
    <div className="try-tools-panel">
      <div className="try-tools-inner try-cli-inner">
        <div className="try-cli-badge">
          <Terminal className="h-4 w-4" />
          {t.cli}
        </div>
        <h2 className="try-tools-h">{t.cliTitle}</h2>
        <p className="try-tools-sub">{t.cliSub}</p>

        <div className="try-cli-steps">
          <div className="try-cli-step">
            <div className="try-cli-step-label">{t.cliStepInstall}</div>
            {cmdRow(INSTALL_CMD)}
          </div>
          <div className="try-cli-step">
            <div className="try-cli-step-label">{t.cliStepRun}</div>
            {cmdRow(RUN_CMD)}
          </div>
        </div>

        <div className="try-cli-links">
          <a className="try-cli-link" href="https://franklin.run/docs/getting-started/installation" target="_blank" rel="noreferrer">
            <BookOpen className="h-4 w-4" />
            {t.docs}
          </a>
          <a
            className="try-cli-link"
            href="https://github.com/blockrunai/franklin"
            target="_blank"
            rel="noreferrer"
          >
            <Github className="h-4 w-4" />
            GitHub
            <ArrowUpRight className="h-3.5 w-3.5 try-cli-link-ext" />
          </a>
        </div>
      </div>
    </div>
  );
}
