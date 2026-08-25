// Cost-saver (research-bloat compaction) toggle, backed by the agent server's
// settings.get / settings.set. The server persists it to ~/.blockrun config so
// the choice survives restarts; we just mirror it for the UI.

import { useCallback, useEffect, useState } from "react";
import { agent } from "../lib/ws";

export function useCostSaver() {
  const [enabled, setEnabled] = useState(true);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    agent
      .request<undefined, { costSaver?: boolean }>("settings.get")
      .then((r) => {
        if (alive) {
          setEnabled(r?.costSaver !== false);
          setReady(true);
        }
      })
      .catch(() => alive && setReady(true));
    return () => {
      alive = false;
    };
  }, []);

  const toggle = useCallback(async () => {
    const next = !enabled;
    setEnabled(next); // optimistic
    try {
      const r = await agent.request<{ costSaver: boolean }, { costSaver?: boolean }>("settings.set", { costSaver: next });
      if (r && typeof r.costSaver === "boolean") setEnabled(r.costSaver);
    } catch {
      setEnabled(!next); // revert on failure
    }
  }, [enabled]);

  return { enabled, ready, toggle };
}
