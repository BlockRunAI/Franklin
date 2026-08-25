// Grouped, collapsible tool-call activity — the "Used N tools" container the
// good agent UIs (Codex, assistant-ui ToolGroup, Vercel AI Elements) use to
// fold consecutive tool calls into one tidy block, rendered inline in order.
// Header shows a small icon cluster + count; the body lists each tool with its
// icon, label and live status, collapsing the tail behind "+N more".

import { useState } from "react";
import {
  ChevronDown, Check, Wrench, Globe, TrendingUp, BarChart3,
  Image as ImageIcon, Clapperboard, Music, FileText, Terminal, Phone, Search,
} from "lucide-react";
import type { ToolStep } from "../hooks/use-franklin-chat";
import { useTryLang } from "../lib/i18n";

export function iconFor(label: string) {
  const l = label.toLowerCase();
  if (l.includes("prediction")) return <BarChart3 className="h-4 w-4" />;
  if (l.includes("price") || l.includes("market")) return <TrendingUp className="h-4 w-4" />;
  if (l.includes("exa") || l.includes("web") || l.includes("search")) return <Globe className="h-4 w-4" />;
  if (l.includes("image")) return <ImageIcon className="h-4 w-4" />;
  if (l.includes("video")) return <Clapperboard className="h-4 w-4" />;
  if (l.includes("music") || l.includes("audio")) return <Music className="h-4 w-4" />;
  if (l.includes("phone") || l.includes("call")) return <Phone className="h-4 w-4" />;
  if (l.includes("bash") || l.includes("cmd") || l.includes("shell") || l.includes("run")) return <Terminal className="h-4 w-4" />;
  if (l.includes("read") || l.includes("write") || l.includes("edit") || l.includes("file")) return <FileText className="h-4 w-4" />;
  if (l.includes("activate")) return <Search className="h-4 w-4" />;
  return <Wrench className="h-4 w-4" />;
}

const COLLAPSE_AFTER = 5; // rows shown before "+N more"

export function ToolGroup({ steps, busy }: { steps: ToolStep[]; busy: boolean }) {
  const { t } = useTryLang();
  const running = steps.some((s) => s.state !== "done");
  // A group with a still-running step is ALWAYS expanded (regardless of busy or
  // its position in the thread) so live tool activity never collapses out of
  // view; a fully-finished group (e.g. reloaded history) starts folded.
  const [open, setOpen] = useState(running);
  const [showAll, setShowAll] = useState(false);
  if (steps.length === 0) return null;

  const active = busy && running;
  const shown = showAll ? steps : steps.slice(0, COLLAPSE_AFTER);
  const moreCount = steps.length - shown.length;

  return (
    <div className={`try-toolgroup${open ? " is-open" : ""}`}>
      <button className="try-toolgroup-head" onClick={() => setOpen((o) => !o)}>
        <span className="try-toolgroup-mark" aria-hidden>
          {active ? <span className="try-dots"><i /><i /><i /></span> : <Check className="h-3.5 w-3.5" />}
        </span>
        <span className="try-toolgroup-title">{t.activityUsed(steps.length)}</span>
        {/* Small icon cluster, like the reference UI. */}
        <span className="try-toolgroup-icons" aria-hidden>
          {steps.slice(0, 3).map((s) => (
            <span key={s.id} className="try-toolgroup-chip">{iconFor(s.label)}</span>
          ))}
        </span>
        <ChevronDown className="try-toolgroup-chevron h-4 w-4" aria-hidden />
      </button>
      {open && (
        <div className="try-toolgroup-body">
          {shown.map((s) => (
            <div key={s.id} className={`try-toolrow is-${s.state}`}>
              <span className="try-toolrow-icon" aria-hidden>{iconFor(s.label)}</span>
              <span className="try-toolrow-text">
                <span className="try-toolrow-label">{s.label}</span>
                {s.detail && <span className="try-toolrow-detail">{s.detail}</span>}
              </span>
              <span className="try-toolrow-mark" aria-hidden>
                {s.state === "done" ? (
                  <Check className="h-3.5 w-3.5" />
                ) : s.state === "sign" ? (
                  <span className="try-coin" />
                ) : (
                  <span className="try-dots"><i /><i /><i /></span>
                )}
              </span>
            </div>
          ))}
          {moreCount > 0 && (
            <button className="try-toolgroup-more" onClick={() => setShowAll(true)}>
              + {moreCount} more
            </button>
          )}
        </div>
      )}
    </div>
  );
}
