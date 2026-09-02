import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface CloudUser { id: string; name: string }
export interface CloudMember { userId: string; name: string; role: "owner" | "admin" | "member" | "viewer"; joinedAt: string }
export interface CloudWorkspace {
  id: string; name: string; createdAt: string; updatedAt?: string; version: number; runtime: string;
  role: CloudMember["role"]; members: CloudMember[];
}
export interface CloudMessage {
  id: string; role: "user" | "assistant"; authorId: string; authorName: string; content: string; createdAt: string;
}
export interface CloudFile {
  path: string; bytes: number; version: number; updatedAt: string; updatedBy: string;
}

const WORKSPACE_KEY = "franklin-team-workspace-v2";
const walletLabel = (wallet: string) => `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;

async function teamRequest<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const base = window.__FRANKLIN__?.cloudUrl || "http://127.0.0.1:3740";
  const response = await fetch(`${base}/v1/franklin-team`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Franklin-Desktop-Token": window.__FRANKLIN__?.cloudToken || "",
    },
    body: JSON.stringify({ action, ...payload }),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Franklin Cloud request failed (${response.status})`);
  return result as T;
}

async function agentTurn(workspaceId: string, content: string): Promise<void> {
  const base = window.__FRANKLIN__?.cloudUrl || "http://127.0.0.1:3740";
  const response = await fetch(`${base}/v1/franklin-team/agent-turn`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Franklin-Desktop-Token": window.__FRANKLIN__?.cloudToken || "",
    },
    body: JSON.stringify({ workspaceId, content }),
    redirect: "error",
    signal: AbortSignal.timeout(180_000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Team Franklin failed (${response.status})`);
}

export interface CloudWorkspaceOptions {
  /** Team Mode toggle. When off, Franklin never reaches the cloud service. */
  enabled?: boolean;
  /** True while the team workspace UI is on screen. Gates the snapshot fetch and
   *  drives the connect retry, so a service that started after the app did is
   *  still reachable without a restart. */
  viewing?: boolean;
}

export function useCloudWorkspace({ enabled = true, viewing = false }: CloudWorkspaceOptions = {}) {
  const [connected, setConnected] = useState(false);
  const [session, setSession] = useState<CloudUser | null>(null);
  const [workspaces, setWorkspaces] = useState<CloudWorkspace[]>([]);
  const [activeId, setActiveIdState] = useState<string | null>(() => {
    try { return localStorage.getItem(WORKSPACE_KEY); } catch { return null; }
  });
  const [messages, setMessages] = useState<CloudMessage[]>([]);
  const [files, setFiles] = useState<CloudFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const contentWorkspaceRef = useRef<string | null>(null);

  const active = useMemo(() => workspaces.find((workspace) => workspace.id === activeId) || null, [workspaces, activeId]);

  const setActiveId = useCallback((id: string | null) => {
    if (id && contentWorkspaceRef.current && id !== contentWorkspaceRef.current) {
      setMessages([]);
      setFiles([]);
    }
    setActiveIdState(id);
    try {
      if (id) localStorage.setItem(WORKSPACE_KEY, id);
      else localStorage.removeItem(WORKSPACE_KEY);
    } catch { /* local storage unavailable */ }
  }, []);

  const refreshWorkspaces = useCallback(async () => {
    const result = await teamRequest<{ workspaces: CloudWorkspace[]; wallet: string }>("workspace.list");
    setSession({ id: result.wallet, name: walletLabel(result.wallet) });
    setWorkspaces(result.workspaces);
    setActiveIdState((current) => {
      const next = current && result.workspaces.some((workspace) => workspace.id === current)
        ? current
        : result.workspaces[0]?.id || null;
      try {
        if (next) localStorage.setItem(WORKSPACE_KEY, next);
        else localStorage.removeItem(WORKSPACE_KEY);
      } catch { /* noop */ }
      return next;
    });
  }, []);

  const refreshActive = useCallback(async () => {
    if (!activeId) return;
    setError(null);
    try {
      const snapshot = await teamRequest<{ workspace: CloudWorkspace; messages: CloudMessage[]; files: CloudFile[] }>("workspace.snapshot", { workspaceId: activeId });
      setWorkspaces((current) => current.map((workspace) => workspace.id === activeId ? snapshot.workspace : workspace));
      setMessages(snapshot.messages);
      setFiles(snapshot.files);
      contentWorkspaceRef.current = activeId;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [activeId]);

  const connect = useCallback(async () => {
    // Guarded here rather than at each call site: `connect` is exposed on the
    // controller (the panel's Retry button calls it), so Team Mode has to hold
    // at the one place every path routes through.
    if (!enabled) return;
    setLoading(true); setError(null);
    try {
      const base = window.__FRANKLIN__?.cloudUrl || "http://127.0.0.1:3740";
      const health = await fetch(`${base}/health`, {
        headers: { "X-Franklin-Desktop-Token": window.__FRANKLIN__?.cloudToken || "" },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (!health.ok) throw new Error("Franklin Desktop service is unavailable");
      setConnected(true);
      await refreshWorkspaces();
    }
    catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
    finally { setLoading(false); }
  }, [enabled, refreshWorkspaces]);

  // `session` is the liveness signal: it is set only after a successful
  // workspace.list. A failed attempt leaves it null, so opening the team UI
  // retries instead of stranding the user on a dead controller until restart.
  useEffect(() => {
    if (!enabled || session) return;
    void connect();
  }, [connect, enabled, session, viewing]);

  // Team Mode off means off: drop anything already fetched so the sidebar does
  // not keep listing projects the user just disabled.
  useEffect(() => {
    if (enabled) return;
    setConnected(false);
    setSession(null);
    setWorkspaces([]);
    setMessages([]);
    setFiles([]);
    setError(null);
    contentWorkspaceRef.current = null;
  }, [enabled]);

  // Pulling a full snapshot (every message + file) is deferred until the team UI
  // is actually open — booting the app should not fetch a project nobody opened.
  useEffect(() => {
    if (!enabled || !viewing) return;
    if (!connected || !session || !activeId) return;
    setLoading(true);
    refreshActive().finally(() => setLoading(false));
  }, [activeId, connected, enabled, refreshActive, session, viewing]);

  const createWorkspace = async (name: string) => {
    setLoading(true); setError(null);
    try {
      const result = await teamRequest<{ workspace: CloudWorkspace }>("workspace.create", { name });
      await refreshWorkspaces();
      setActiveId(result.workspace.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setLoading(false); }
  };

  const joinWorkspace = async (code: string) => {
    setLoading(true); setError(null);
    try {
      const result = await teamRequest<{ workspace: CloudWorkspace }>("workspace.join", { code });
      await refreshWorkspaces();
      setActiveId(result.workspace.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setLoading(false); }
  };

  const createInvite = async (role: "member" | "viewer" = "member") => {
    if (!activeId) throw new Error("Select a workspace first");
    return teamRequest<{ invite: { code: string; expiresAt: string } }>("workspace.invite", { workspaceId: activeId, role });
  };

  const updateMemberRole = async (targetWallet: string, role: "admin" | "member" | "viewer") => {
    if (!activeId) return;
    await teamRequest("member.role", { workspaceId: activeId, targetWallet, role });
    await refreshActive();
  };

  const sendMessage = async (content: string) => {
    if (!activeId) return;
    setSending(true); setError(null);
    try {
      await agentTurn(activeId, content);
      await refreshActive();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSending(false); }
  };

  const saveFile = async (filePath: string, content: string) => {
    if (!activeId) return;
    const existing = files.find((file) => file.path === filePath);
    await teamRequest("file.save", { workspaceId: activeId, path: filePath, content, expectedVersion: existing?.version });
    await refreshActive();
  };

  const readFile = async (filePath: string) => {
    if (!activeId) throw new Error("Select a workspace first");
    return teamRequest<{ path: string; content: string; version: number }>("file.read", { workspaceId: activeId, path: filePath });
  };

  return {
    connected, session, workspaces, active, activeId, messages, files, loading, sending, error,
    setActiveId, connect, createWorkspace, joinWorkspace, createInvite, updateMemberRole, sendMessage, saveFile, readFile,
    refreshActive,
  };
}

export type CloudWorkspaceController = ReturnType<typeof useCloudWorkspace>;
