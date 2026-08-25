// Local spend tracking — mirrors the "Total Spent" / "Cost by Model" metrics
// from Franklin's dashboard. Ported verbatim from franklin-run: it's pure
// browser-localStorage state with no Next.js / web dependency, so the WalletPanel
// reads the same shape whether it's hosted or local.

import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_KEY = "franklin-webui-usage-v1";

export interface Receipt {
  ts: number;
  model: string;
  usd: number;
}

export interface Usage {
  totalUsd: number;
  requests: number;
  byModel: Record<string, { usd: number; count: number }>;
  receipts: Receipt[];
}

const EMPTY: Usage = { totalUsd: 0, requests: 0, byModel: {}, receipts: [] };
const MAX_RECEIPTS = 100;

function load(): Usage {
  if (typeof window === "undefined") return EMPTY;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    const p = JSON.parse(raw);
    return {
      totalUsd: p.totalUsd || 0,
      requests: p.requests || 0,
      byModel: p.byModel || {},
      receipts: Array.isArray(p.receipts) ? p.receipts : [],
    };
  } catch {
    return EMPTY;
  }
}

export function useUsageStats() {
  const [usage, setUsage] = useState<Usage>(EMPTY);
  const hydrated = useRef(false);

  useEffect(() => {
    setUsage(load());
    hydrated.current = true;
  }, []);

  useEffect(() => {
    if (!hydrated.current) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(usage));
    } catch {
      /* ignore */
    }
  }, [usage]);

  const recordSpend = useCallback((model: string, usd: number) => {
    if (!usd || usd <= 0) return;
    setUsage((u) => {
      const prev = u.byModel[model] ?? { usd: 0, count: 0 };
      return {
        totalUsd: u.totalUsd + usd,
        requests: u.requests + 1,
        byModel: { ...u.byModel, [model]: { usd: prev.usd + usd, count: prev.count + 1 } },
        receipts: [{ ts: Date.now(), model, usd }, ...u.receipts].slice(0, MAX_RECEIPTS),
      };
    });
  }, []);

  const reset = useCallback(() => setUsage(EMPTY), []);

  return { usage, recordSpend, reset };
}
