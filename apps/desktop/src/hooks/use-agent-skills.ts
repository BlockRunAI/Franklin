// The real agent skill registry (bundled + user + project + learned) the local
// agent loaded — name, description, source, enabled state. Distinct from the
// SkillsPanel's hard-coded prompt starters; this reflects what the model can
// actually invoke via the Skill tool, plus management actions (toggle, create,
// upload) that mirror WorkBuddy's skill UX.

import { useCallback, useEffect, useState } from "react";
import { agent } from "../lib/ws";

export interface AgentSkill {
  name: string;
  description: string;
  source: "bundled" | "user" | "project" | "learned";
  hidden: boolean;
  modelInvocable: boolean;
  enabled: boolean;
}

export function useAgentSkills(): {
  skills: AgentSkill[];
  loading: boolean;
  refresh: () => void;
  toggle: (name: string, enabled: boolean) => Promise<void>;
  create: (description: string) => Promise<{ name: string } | null>;
  upload: (content: string) => Promise<{ name: string } | null>;
} {
  const [skills, setSkills] = useState<AgentSkill[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchSkills = useCallback(async () => {
    setLoading(true);
    try {
      const r = await agent.request<undefined, { skills?: AgentSkill[] }>("skills.list");
      setSkills(r?.skills ?? []);
    } catch {
      /* best-effort */
    } finally {
      setLoading(false);
    }
  }, []);

  const toggle = useCallback(
    async (name: string, enabled: boolean) => {
      // Optimistic flip, then persist + refetch.
      setSkills((prev) => prev.map((s) => (s.name === name ? { ...s, enabled } : s)));
      try {
        await agent.request<{ name: string; enabled: boolean }, unknown>("skills.toggle", { name, enabled });
      } catch {
        void fetchSkills(); // revert to server truth on failure
      }
    },
    [fetchSkills],
  );

  const create = useCallback(
    async (description: string) => {
      try {
        const r = await agent.request<{ description: string }, { name?: string }>("skills.create", { description });
        await fetchSkills();
        return r?.name ? { name: r.name } : null;
      } catch {
        return null;
      }
    },
    [fetchSkills],
  );

  const upload = useCallback(
    async (content: string) => {
      try {
        const r = await agent.request<{ content: string }, { name?: string }>("skills.upload", { content });
        await fetchSkills();
        return r?.name ? { name: r.name } : null;
      } catch {
        return null;
      }
    },
    [fetchSkills],
  );

  useEffect(() => {
    const off = agent.onState((s) => {
      if (s === "open") void fetchSkills();
    });
    return off;
  }, [fetchSkills]);

  return { skills, loading, refresh: fetchSkills, toggle, create, upload };
}
