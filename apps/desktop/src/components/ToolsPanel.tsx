import { useEffect, useState } from "react";
import { MessageSquare, ImageIcon, Clapperboard, Music, Globe, TrendingUp, BarChart3, Phone, ArrowRight, X } from "lucide-react";
import { useTryLang } from "../lib/i18n";
import type { TryView } from "./HistorySidebar";

const TOOL_MODEL = "google/gemini-2.5-flash";

// One "Try" tells FranklinChat what to do: switch mode/view, pick a model,
// and/or prefill the composer with a starter prompt.
export interface TryAction {
  mode?: "chat" | "image" | "video";
  model?: string;
  template?: string;
  view?: TryView;
}

interface Card {
  icon: React.ReactNode;
  name: string;
  desc: string;
  price: string;
  auto?: boolean;
  poweredBy?: string;
  detail: string;
  examples: string[];
  action: TryAction;
}
interface Group {
  label: string;
  cards: Card[];
}

const GROUPS: Group[] = [
  {
    label: "Chat & generation",
    cards: [
      {
        icon: <MessageSquare />, name: "Chat", price: "Free models + pay-per-message",
        desc: "41+ frontier models — Claude, GPT, Gemini, DeepSeek and more.",
        poweredBy: "BlockRun Router",
        detail: "One endpoint, 41+ frontier models. The router picks the right model per request and you pay per message in USDC — free models cost nothing.",
        examples: ["Explain x402 like I'm five", "Draft a launch tweet for Franklin"],
        action: { mode: "chat" },
      },
      {
        icon: <ImageIcon />, name: "Image", price: "~$0.04 / image",
        desc: "Generate images — Nano Banana, GPT Image, Grok Imagine, CogView.",
        poweredBy: "Nano Banana · GPT Image · Grok Imagine",
        detail: "Text-to-image across the best diffusion and multimodal models. Pay per image, no subscription.",
        examples: ["A cozy reading nook, warm light, film grain", "Minimal logo for a coffee robot"],
        action: { mode: "image" },
      },
      {
        icon: <Clapperboard />, name: "Video", price: "~$0.30 / clip",
        desc: "Generate short video — Seedance, Grok, Sora.",
        poweredBy: "Seedance · Grok · Sora",
        detail: "Text-to-video clips from the leading generation models. Pay per clip.",
        examples: ["A paper plane gliding over a city at dawn", "Timelapse of a flower blooming"],
        action: { mode: "video" },
      },
      {
        icon: <Music />, name: "Music", price: "pay-per-track", auto: true,
        desc: "Compose music and songs from a prompt.",
        poweredBy: "MusicGen",
        detail: "Generate original music and songs from a text description — genre, mood, lyrics. Franklin calls this automatically when you ask for a track.",
        examples: ["Compose a lo-fi beat for studying", "Write an upbeat synth-pop hook about the weekend"],
        action: { mode: "chat", model: TOOL_MODEL, template: "Compose a song about " },
      },
    ],
  },
  {
    label: "Live data",
    cards: [
      {
        icon: <Globe />, name: "Web search", price: "~$0.005 / call", auto: true,
        desc: "Cited, current answers from the live web.",
        poweredBy: "Exa",
        detail: "Neural web search with citations. Franklin pulls current sources and answers with links — called automatically when a question needs fresh info.",
        examples: ["What shipped in the latest Next.js release?", "Summarize today's AI news with sources"],
        action: { mode: "chat", model: TOOL_MODEL, template: "Search the web for " },
      },
      {
        icon: <TrendingUp />, name: "Market prices", price: "$0.001 / call", auto: true,
        desc: "Live crypto, US-stock and FX prices.",
        poweredBy: "BlockRun Markets",
        detail: "Real-time quotes for crypto, US equities and FX. Ask for a price or a quick read and Franklin fetches it live.",
        examples: ["What's BTC and ETH right now?", "Give me a quick read on NVDA"],
        action: { mode: "chat", model: TOOL_MODEL, template: "What's the current price of " },
      },
      {
        icon: <BarChart3 />, name: "Prediction markets", price: "~$0.005 / call", auto: true,
        desc: "Live odds across Polymarket, Kalshi & Limitless.",
        poweredBy: "Predexon",
        detail: "Predexon aggregates live odds across Polymarket, Kalshi and Limitless into one feed. Ask what the market thinks and Franklin returns current probabilities with the venues behind them.",
        examples: ["Odds the Fed cuts rates in March?", "Who's favored in the next US election?"],
        action: { mode: "chat", model: TOOL_MODEL, template: "What are the prediction-market odds for " },
      },
    ],
  },
  {
    label: "Actions",
    cards: [
      {
        icon: <Phone />, name: "Phone call", price: "~$0.54 / call", auto: true,
        desc: "Place a real AI voice call to handle a task.",
        poweredBy: "BlockRun Voice",
        detail: "Franklin can dial a real phone number and handle a task on a live voice call — booking, confirming, asking a question. Buy a number, then place calls.",
        examples: [],
        action: { view: "phone" },
      },
    ],
  },
];

export function ToolsPanel({ onTry }: { onTry: (a: TryAction) => void }) {
  const { t } = useTryLang();
  const [selected, setSelected] = useState<Card | null>(null);

  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSelected(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  return (
    <div className="try-tools-panel">
      <div className="try-tools-inner">
        <h2 className="try-tools-h">{t.marketplaceTitle}</h2>
        <p className="try-tools-sub">{t.toolsSub}</p>
        {GROUPS.map((g) => (
          <div key={g.label} className="try-tools-group">
            <div className="try-tools-group-label">{g.label}</div>
            <div className="try-tools-grid">
              {g.cards.map((c) => (
                <button key={c.name} className="try-tool-card try-mkt-card" onClick={() => setSelected(c)}>
                  <span className="try-tool-card-icon">{c.icon}</span>
                  <div className="try-tool-card-body">
                    <div className="try-tool-card-top">
                      <span className="try-tool-card-name">{c.name}</span>
                      {c.auto && <span className="try-badge-free">auto</span>}
                    </div>
                    <p className="try-tool-card-desc">{c.desc}</p>
                    <div className="try-mkt-foot">
                      {c.poweredBy && <span className="try-mkt-provider">{c.poweredBy}</span>}
                      <span className="try-tool-card-price">{c.price}</span>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {selected && (
        <div className="try-mkt-overlay" onClick={() => setSelected(null)}>
          <div className="try-mkt-modal" onClick={(e) => e.stopPropagation()}>
            <button className="try-mkt-close" onClick={() => setSelected(null)} aria-label="Close">
              <X className="h-4 w-4" />
            </button>
            <div className="try-mkt-modal-head">
              <span className="try-mkt-modal-icon">{selected.icon}</span>
              <div>
                <div className="try-mkt-modal-name">{selected.name}</div>
                {selected.poweredBy && (
                  <div className="try-mkt-modal-by">{t.poweredBy} <strong>{selected.poweredBy}</strong></div>
                )}
              </div>
            </div>
            <p className="try-mkt-modal-detail">{selected.detail}</p>

            {selected.examples.length > 0 && (
              <div className="try-mkt-examples">
                <div className="try-tools-group-label">{t.examples}</div>
                {selected.examples.map((ex) => (
                  <button
                    key={ex}
                    className="try-mkt-example"
                    onClick={() => {
                      onTry({ ...selected.action, template: ex });
                      setSelected(null);
                    }}
                  >
                    {ex}
                  </button>
                ))}
              </div>
            )}

            <div className="try-mkt-modal-foot">
              <span className="try-tool-card-price">{selected.price}</span>
              <button
                className="try-mkt-try"
                onClick={() => {
                  onTry(selected.action);
                  setSelected(null);
                }}
              >
                {t.tryIt}
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
