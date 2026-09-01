// Model list — pulled from the CLI on first connect. The CLI is the source
// of truth (it has the live catalog + per-user overrides via /model commands),
// so we don't ship a hardcoded list like franklin-run does.
//
// Models rarely change inside a session, so one fetch per socket-open is
// enough; no broadcast subscription.

import { useEffect, useState } from "react";
import { agent } from "../lib/ws";
import type { ModelInfo } from "../lib/wire";

export function useModels(): { models: ModelInfo[]; isLoading: boolean } {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const off = agent.onState(async (state) => {
      if (state !== "open" || models.length > 0) return;
      try {
        const resp = await agent.request<undefined, { models: ModelInfo[] }>("models.list");
        setModels(Array.isArray(resp?.models) ? resp.models.slice(0, 1_000) : []);
      } catch {
        // Non-fatal; UI falls back to a single "default" entry and the CLI
        // resolves whatever the user picked at runtime.
      } finally {
        setIsLoading(false);
      }
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { models, isLoading };
}
