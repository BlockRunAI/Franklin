// The server's installed slash-command skills, including persistent enabled state.
import { useCallback, useEffect, useRef, useState } from "react";
import { agent } from "../lib/ws";

export interface AgentSkill {
  name: string;
  description: string;
  source: "bundled" | "user" | "project" | "learned";
  hidden: boolean;
  modelInvocable: boolean;
  enabled: boolean;
  removable: boolean;
  notes: string[];
}

export function useAgentSkills() {
  const [skills, setSkills] = useState<AgentSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const r = await agent.request<undefined, { skills: AgentSkill[]; errors?: string[] }>("skills.list");
      if (current !== generation.current) return;
      if (!Array.isArray(r.skills)) throw new Error("Skill registry is unavailable. Update the local agent runtime.");
      setSkills(r.skills);
      if (r.errors?.length) setError(r.errors.join(" · "));
    } catch (err) {
      if (current === generation.current) setError(err instanceof Error ? err.message : "Couldn't load skills");
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, []);
  const upload = useCallback(async (content: string) => {
    setError(null);
    try {
      const result = await agent.request<{ content: string }, { name: string }>("skills.upload", { content });
      await refresh();
      return result;
    } catch (err) { setError(err instanceof Error ? err.message : "Import failed"); return null; }
  }, [refresh]);
  const toggle = useCallback(async (name: string, enabled: boolean) => {
    try {
      await agent.request("skills.toggle", { name, enabled });
      await refresh();
    } catch (err) { setError(err instanceof Error ? err.message : "Update failed"); }
  }, [refresh]);
  const remove = useCallback(async (name: string) => {
    try {
      await agent.request("skills.remove", { name });
      await refresh();
    } catch (err) { setError(err instanceof Error ? err.message : "Remove failed"); }
  }, [refresh]);
  useEffect(() => {
    const off = agent.onState((state) => { if (state === "open") void refresh(); });
    const invalidate = () => { generation.current++; };
    return () => { off(); invalidate(); };
  }, [refresh]);
  return { skills, loading, error, refresh, toggle, upload, remove };
}
