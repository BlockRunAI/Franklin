import { useEffect, useMemo, useState } from "react";

export type AgentId = "franklin" | "codex" | "claude" | "hermes" | "deepseek";

export interface StudioAgent {
  id: AgentId;
  name: string;
  command: string;
  protocol: string;
  description: string;
  installed: boolean;
  running: boolean;
  blockrunEnabled: boolean;
  builtIn?: boolean;
  experimental?: boolean;
  available?: boolean;
  version?: string;
  path?: string;
  endpoint?: string;
  lifecycleSupported?: boolean;
  error?: string;
}

interface StudioState {
  agents: StudioAgent[];
  teamModeEnabled: boolean;
}

const STORAGE_KEY = "franklin-agent-studio-registry-v2";

const DEFAULT_AGENTS: StudioAgent[] = [
  {
    id: "franklin",
    name: "Franklin",
    command: "franklin",
    protocol: "Franklin WebSocket",
    description: "BlockRun's first-party agent, bundled with Franklin.",
    installed: true,
    running: true,
    blockrunEnabled: true,
    builtIn: true,
  },
  {
    id: "codex",
    name: "Codex CLI",
    command: "codex app-server",
    protocol: "JSON-RPC",
    description: "Import Codex sessions, approvals and tool events through app-server.",
    installed: false,
    running: false,
    blockrunEnabled: false,
  },
  {
    id: "claude",
    name: "Claude Code",
    command: "claude -p",
    protocol: "Agent SDK / stream-json",
    description: "Run Claude Code with structured streaming and native permissions.",
    installed: false,
    running: false,
    blockrunEnabled: false,
  },
  {
    id: "hermes",
    name: "Hermes Agent",
    command: "hermes serve",
    protocol: "TUI Gateway JSON-RPC",
    description: "Connect Hermes sessions, tools and approvals to the same workspace.",
    installed: false,
    running: false,
    blockrunEnabled: false,
  },
  {
    id: "deepseek",
    name: "DeepSeek Harness",
    command: "dsh web",
    protocol: "Harness plugin",
    description: "Experimental adapter for DeepSeek's plugin-based agent runtime.",
    installed: false,
    running: false,
    blockrunEnabled: false,
    experimental: true,
  },
];

function initialState(): StudioState {
  if (typeof window === "undefined") return { agents: DEFAULT_AGENTS, teamModeEnabled: true };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<StudioState> | null;
    const savedAgents = saved?.agents;
    if (!savedAgents) return { agents: DEFAULT_AGENTS, teamModeEnabled: true };
    // Merge stored state into the current catalogue so newly shipped adapters appear.
    return {
      agents: DEFAULT_AGENTS.map((agent) => ({
        ...agent,
        ...savedAgents.find((savedAgent) => savedAgent.id === agent.id),
      })),
      teamModeEnabled: saved.teamModeEnabled ?? true,
    };
  } catch {
    return { agents: DEFAULT_AGENTS, teamModeEnabled: true };
  }
}

export function useStudioRegistry() {
  const [state, setState] = useState<StudioState>(initialState);
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* local cache unavailable */ }
  }, [state]);

  const updateAgent = (id: AgentId, patch: Partial<StudioAgent>) => {
    setState((current) => ({
      ...current,
      agents: current.agents.map((agent) => agent.id === id ? { ...agent, ...patch } : agent),
    }));
  };

  const scanRuntimes = async () => {
    const scan = window.__FRANKLIN__?.scanAgentRuntimes;
    if (!scan) return;
    setScanning(true);
    try {
      const detected = await scan();
      setState((current) => ({
        ...current,
        agents: current.agents.map((agent) => {
          const runtime = detected.find((item) => item.id === agent.id);
          return runtime ? {
            ...agent,
            available: runtime.available,
            running: runtime.running,
            path: runtime.path,
            version: runtime.version,
            endpoint: runtime.endpoint,
            lifecycleSupported: runtime.lifecycleSupported,
            error: runtime.error,
          } : agent;
        }),
      }));
    } finally { setScanning(false); }
  };

  useEffect(() => { void scanRuntimes(); }, []);

  const importAgent = async (id: AgentId) => {
    if (id === "franklin") return;
    const start = window.__FRANKLIN__?.startAgentRuntime;
    if (!start) { updateAgent(id, { installed: true, running: true }); return; }
    updateAgent(id, { error: undefined });
    const result = await start(id);
    updateAgent(id, {
      installed: result.ok,
      running: result.running,
      available: result.available,
      version: result.version,
      path: result.path,
      endpoint: result.endpoint,
      lifecycleSupported: result.lifecycleSupported,
      error: result.error,
    });
  };
  const removeAgent = async (id: AgentId) => {
    await window.__FRANKLIN__?.stopAgentRuntime?.(id);
    updateAgent(id, { installed: false, running: false, blockrunEnabled: false, endpoint: undefined, error: undefined });
  };
  const setRunning = async (id: AgentId, running: boolean) => {
    const action = running ? window.__FRANKLIN__?.startAgentRuntime : window.__FRANKLIN__?.stopAgentRuntime;
    if (!action) { updateAgent(id, { running }); return; }
    const result = await action(id);
    const endpoint = (result as { endpoint?: string }).endpoint;
    updateAgent(id, { running: result.running, endpoint: result.running ? endpoint : undefined, error: result.error });
  };
  const setBlockRun = (id: AgentId, blockrunEnabled: boolean) => {
    if (id === "franklin") updateAgent(id, { blockrunEnabled });
  };
  const setTeamModeEnabled = (teamModeEnabled: boolean) => setState((current) => ({ ...current, teamModeEnabled }));

  const installedCount = useMemo(() => state.agents.filter((agent) => agent.installed).length, [state.agents]);
  const connectedCount = useMemo(() => state.agents.filter((agent) => agent.installed && agent.blockrunEnabled).length, [state.agents]);

  return {
    ...state,
    installedCount,
    connectedCount,
    scanning,
    scanRuntimes,
    importAgent,
    removeAgent,
    setRunning,
    setBlockRun,
    setTeamModeEnabled,
  };
}
