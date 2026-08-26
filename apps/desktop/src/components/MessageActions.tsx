"use client";

import { useState } from "react";
import { ThumbsUp, ThumbsDown, RotateCcw, Copy, Check } from "lucide-react";
import { useTryLang } from "@/lib/i18n";
import { copyText } from "../lib/clipboard";

// Action row under an assistant answer: like / dislike / regenerate / copy.
// Feedback is local (visual) only; regenerate is shown for the last reply.
export function MessageActions({
  content,
  onRegenerate,
}: {
  content: string;
  onRegenerate?: () => void;
}) {
  const { t } = useTryLang();
  const [vote, setVote] = useState<"up" | "down" | null>(null);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (await copyText(content)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <div className="try-actions">
      <button
        className={`try-action${vote === "up" ? " is-on" : ""}`}
        onClick={() => setVote((v) => (v === "up" ? null : "up"))}
        aria-label={t.actionLike}
        title={t.actionLike}
      >
        <ThumbsUp className="h-4 w-4" />
      </button>
      <button
        className={`try-action${vote === "down" ? " is-on" : ""}`}
        onClick={() => setVote((v) => (v === "down" ? null : "down"))}
        aria-label={t.actionDislike}
        title={t.actionDislike}
      >
        <ThumbsDown className="h-4 w-4" />
      </button>
      {onRegenerate && (
        <button className="try-action" onClick={onRegenerate} aria-label={t.actionRetry} title={t.actionRetry}>
          <RotateCcw className="h-4 w-4" />
        </button>
      )}
      <button className="try-action" onClick={copy} aria-label={t.actionCopy} title={t.actionCopy}>
        {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      </button>
    </div>
  );
}
