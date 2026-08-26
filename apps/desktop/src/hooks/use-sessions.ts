// Session list hook — pulls the CLI's local session index (~/.blockrun/
// sessions/*.jsonl), watches for changes, lets the user create / select /
// delete / rename. Backend is the single source of truth; the hook is a
// thin view.
//
// Why no local cache layer like franklin-run's `useChatHistory` had: the CLI
// is always running alongside the browser, the WebSocket reconnects in <1 s,
// and disk IO on session.list is sub-millisecond. Local cache would just be
// drift waiting to happen.

import { useCallback, useEffect, useState } from "react";
import { agent } from "../lib/ws";
import type { ServerMsg, SessionSummary } from "../lib/wire";

interface UseSessionsReturn {
  sessions: SessionSummary[];
  activeId: string | null;
  isLoading: boolean;
  error: string | null;
  /** Set activeId = null and let the next agent.send create a fresh session
   *  server-side (server returns the new id in agent.* event payloads). */
  newSession: () => void;
  selectSession: (id: string) => void;
  deleteSession: (id: string) => Promise<void>;
  renameSession: (id: string, title: string) => Promise<void>;
  /** Force a re-fetch — useful after the user creates a session via CLI in
   *  another terminal and wants the UI list to update without a reconnect. */
  refresh: () => Promise<void>;
}

export function useSessions(): UseSessionsReturn {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const resp = await agent.request<undefined, { sessions: SessionSummary[] }>("session.list");
      setSessions(resp?.sessions ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to list sessions");
    } finally {
      setIsLoading(false);
    }
  }, []);

  // First load + reload whenever the socket re-opens (covers the case where
  // the CLI was started after the browser tab).
  useEffect(() => {
    const off = agent.onState((state) => {
      if (state === "open") void refresh();
    });
    return off;
  }, [refresh]);

  // Server broadcasts session.event when the CLI creates/updates/deletes a
  // session out-of-band (CLI keystroke, /resume command, panel rename).
  useEffect(() => {
    const off = agent.subscribe((msg: ServerMsg) => {
      if (msg.kind === "session.event") void refresh();
    });
    return off;
  }, [refresh]);

  const newSession = useCallback(() => {
    setActiveId(null);
  }, []);

  const selectSession = useCallback((id: string) => {
    setActiveId(id);
  }, []);

  const deleteSession = useCallback(async (id: string) => {
    await agent.request<{ id: string }>("session.delete", { id });
    setSessions((prev) => prev.filter((s) => s.id !== id));
    setActiveId((cur) => (cur === id ? null : cur));
  }, []);

  const renameSession = useCallback(async (id: string, title: string) => {
    await agent.request<{ id: string; title: string }>("session.rename", { id, title });
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title } : s)));
  }, []);

  return { sessions, activeId, isLoading, error, newSession, selectSession, deleteSession, renameSession, refresh };
}
