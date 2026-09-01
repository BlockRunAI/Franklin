// MCP server status for the visualization panel. Asks the local agent (serve)
// which MCP servers it connected, with transport / tool-count / OAuth / failure
// diagnostics. Refetches on (re)connect; exposes a manual refresh.

import { useCallback, useEffect, useState } from "react";
import { agent } from "../lib/ws";

export interface McpServer {
  name: string;
  transport: "stdio" | "http" | "sse";
  toolCount: number;
  tools: string[];
  filtered: number;
  hasOAuth: boolean;
  oauthAuthorized: boolean;
}

export interface McpFailure {
  name: string;
  reason: string;
  transportKind: "stdio" | "http" | "sse";
  stderrTail?: string[];
}

interface McpListResponse {
  servers?: McpServer[];
  failures?: McpFailure[];
}

export function useMcp(): {
  servers: McpServer[];
  failures: McpFailure[];
  loading: boolean;
  refresh: () => void;
} {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [failures, setFailures] = useState<McpFailure[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchMcp = useCallback(async () => {
    setLoading(true);
    try {
      const r = await agent.request<undefined, McpListResponse>("mcp.list");
      setServers(r?.servers ?? []);
      setFailures(r?.failures ?? []);
    } catch {
      /* best-effort */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const off = agent.onState((s) => {
      if (s === "open") void fetchMcp();
    });
    return off;
  }, [fetchMcp]);

  return { servers, failures, loading, refresh: fetchMcp };
}
