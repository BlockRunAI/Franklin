// Conversation history. Ported from franklin-run, kept in *local mode* for the
// desktop/local WebUI: `address` is always null (see use-auth), so the signed-in
// branches (the /api/try backend) never fire and everything lives in
// localStorage. The agent turn itself still streams over the WebSocket — only
// the conversation index is local here.
//
// TODO (server-session parity): back `conversations` with the CLI's own session
// store (session.list / session.load) so the desktop and the CLI share history.
// For now local storage keeps the full run UI working without that backend.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage } from "./use-franklin-chat";
import { agent } from "../lib/ws";

const LOCAL_KEY = "franklin-webui-history-v1";

export type ChatSpace = "personal" | "team";

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  /** Missing on older records, which are migrated as personal conversations. */
  space?: ChatSpace;
}

type Setter = ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[]);

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
function titleFrom(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  return firstUser?.content.slice(0, 48) || "New chat";
}

function conversationSpace(conversation: Conversation): ChatSpace {
  return conversation.space === "team" ? "team" : "personal";
}

function loadLocal(): Conversation[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    const p = raw ? JSON.parse(raw) : [];
    return Array.isArray(p) ? p : [];
  } catch {
    return [];
  }
}
function saveLocal(convos: Conversation[]) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(convos));
  } catch {
    /* quota / disabled */
  }
}

export function useChatHistory(address: string | null, space: ChatSpace = "personal") {
  // Lazy-init FROM localStorage on the very first render. Doing this in an
  // effect instead caused the save effect to fire once with the still-empty
  // initial state and wipe storage before hydration (history vanished on every
  // launch, esp. under StrictMode's double-invoke).
  const [conversations, setConversations] = useState<Conversation[]>(() => loadLocal());
  const [activeBySpace, setActiveBySpace] = useState<Record<ChatSpace, string | null>>(() => {
    const loaded = loadLocal();
    return {
      personal: loaded.find((c) => conversationSpace(c) === "personal")?.id ?? null,
      team: loaded.find((c) => conversationSpace(c) === "team")?.id ?? null,
    };
  });
  const activeBySpaceRef = useRef(activeBySpace);
  activeBySpaceRef.current = activeBySpace;
  const pendingSpaceRef = useRef<Record<string, ChatSpace>>({});
  const activeId = activeBySpace[space];
  const conversationsRef = useRef<Conversation[]>(conversations);
  conversationsRef.current = conversations;
  // Local mode always: the CLI owns the wallet, there is no SIWE backend.
  const signedIn = !!address;

  const setActiveId = useCallback((id: string | null) => {
    activeBySpaceRef.current = { ...activeBySpaceRef.current, [space]: id };
    setActiveBySpace((prev) => ({ ...prev, [space]: id }));
  }, [space]);

  // Source of truth is a FILE on disk (~/.blockrun via the agent) — reliable in
  // both dev and the packaged app, where file:// localStorage doesn't persist.
  // localStorage stays as a fast first-paint cache. On connect, load the file;
  // if it's empty but we have a local cache, migrate the cache into the file.
  useEffect(() => {
    const off = agent.onState(async (state) => {
      if (state !== "open") return;
      try {
        const r = await agent.request<undefined, { conversations?: Conversation[] }>("history.load");
        const server = Array.isArray(r?.conversations) ? r.conversations : [];
        if (server.length > 0) {
          setConversations(server);
          setActiveBySpace((prev) => ({
            personal: prev.personal ?? server.find((c) => conversationSpace(c) === "personal")?.id ?? null,
            team: prev.team ?? server.find((c) => conversationSpace(c) === "team")?.id ?? null,
          }));
        } else if (conversationsRef.current.length > 0) {
          void agent.request("history.save", { conversations: conversationsRef.current });
        }
      } catch { /* keep local cache */ }
    });
    return off;
  }, []);

  // Persist on change → localStorage cache (instant) + the file (debounced).
  useEffect(() => {
    if (signedIn) return;
    saveLocal(conversations);
    const t = setTimeout(() => {
      void agent.request("history.save", { conversations }).catch(() => {});
    }, 500);
    return () => clearTimeout(t);
  }, [conversations, signedIn]);

  const visibleConversations = conversations.filter((c) => conversationSpace(c) === space);
  const activeConversation = visibleConversations.find((c) => c.id === activeId) ?? null;
  const messages = activeConversation?.messages ?? [];

  const newChat = useCallback(() => setActiveId(null), [setActiveId]);
  const selectChat = useCallback((id: string) => setActiveId(id), [setActiveId]);

  const renameChat = useCallback((id: string, title: string) => {
    const clean = title.trim().slice(0, 80) || "New chat";
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title: clean, updatedAt: Date.now() } : c)));
  }, []);

  const deleteChat = useCallback(
    (id: string) => {
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (activeBySpaceRef.current[space] === id) setActiveId(null);
    },
    [setActiveId, space],
  );

  const deleteMedia = useCallback(
    (convId: string, url: string) => {
      setConversations((prev) => {
        const cur = prev.find((c) => c.id === convId);
        if (!cur) return prev;
        const msgs = cur.messages.filter((m) => m.image !== url && m.video !== url);
        if (msgs.length === cur.messages.length) return prev;
        if (msgs.length === 0) {
          if (activeBySpaceRef.current[space] === convId) setActiveId(null);
          return prev.filter((c) => c.id !== convId);
        }
        const updated = { ...cur, messages: msgs, updatedAt: Date.now() };
        return prev.map((c) => (c.id === convId ? updated : c));
      });
    },
    [setActiveId, space],
  );

  const ensureConvId = useCallback(() => {
    let id = activeBySpaceRef.current[space];
    if (!id) {
      id = uid();
      pendingSpaceRef.current[id] = space;
      setActiveId(id);
    }
    return id;
  }, [setActiveId, space]);

  const setMessages = useCallback(
    (next: Setter, targetId?: string) => {
      let resolved = targetId ?? activeBySpaceRef.current[space];
      if (!resolved) {
        resolved = uid();
        pendingSpaceRef.current[resolved] = space;
        setActiveId(resolved);
      }
      const id = resolved;
      setConversations((prev) => {
        const cur = prev.find((c) => c.id === id);
        const prevMsgs = cur?.messages ?? [];
        const msgs = typeof next === "function" ? next(prevMsgs) : next;
        const now = Date.now();
        if (cur && msgs.length === 0) {
          if (activeBySpaceRef.current[space] === id) setActiveId(null);
          return prev.filter((c) => c.id !== id);
        }
        let updated: Conversation;
        let arr: Conversation[];
        if (!cur) {
          if (msgs.length === 0) return prev;
          updated = {
            id,
            title: titleFrom(msgs),
            createdAt: now,
            updatedAt: now,
            messages: msgs,
            space: pendingSpaceRef.current[id] ?? space,
          };
          delete pendingSpaceRef.current[id];
          arr = [updated, ...prev];
        } else {
          updated = {
            ...cur,
            messages: msgs,
            title: cur.title && cur.title !== "New chat" ? cur.title : titleFrom(msgs),
            updatedAt: now,
          };
          arr = prev.map((c) => (c.id === id ? updated : c));
        }
        return arr;
      });
    },
    [setActiveId, space],
  );

  return { conversations, visibleConversations, activeId, activeConversation, messages, setMessages, ensureConvId, newChat, selectChat, deleteChat, renameChat, deleteMedia };
}
