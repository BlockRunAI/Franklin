import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The hook talks to the CLI over a WebSocket on mount. Stub it so the tests
// exercise the reducer logic rather than the transport.
vi.mock("../lib/ws", () => ({
  agent: {
    onState: () => () => {},
    request: async () => ({}),
  },
}));

const { conversationActivityAt, useChatHistory } = await import("./use-chat-history");
type Conversation = import("./use-chat-history").Conversation;

const LOCAL_KEY = "franklin-webui-history-v1";

function seed(conversations: Partial<Conversation>[]) {
  const full = conversations.map((c, i) => ({
    id: c.id ?? `c${i}`,
    title: c.title ?? `Chat ${i}`,
    createdAt: c.createdAt ?? 1_000,
    updatedAt: c.updatedAt ?? 1_000,
    messages: c.messages ?? [{ role: "user", content: "hi" }],
    ...c,
  }));
  localStorage.setItem(LOCAL_KEY, JSON.stringify(full));
  return full as Conversation[];
}

const render = () => renderHook(() => useChatHistory(null, "personal"));

beforeEach(() => localStorage.clear());
afterEach(() => vi.useRealTimers());

describe("conversationActivityAt", () => {
  it("prefers activityAt", () => {
    expect(conversationActivityAt({ activityAt: 5, updatedAt: 9 } as Conversation)).toBe(5);
  });

  it("falls back to updatedAt for records written before the field existed", () => {
    expect(conversationActivityAt({ updatedAt: 9 } as Conversation)).toBe(9);
  });
});

describe("togglePinned", () => {
  it("sets and clears pinnedAt", () => {
    seed([{ id: "a" }]);
    const { result } = render();

    act(() => result.current.togglePinned("a"));
    expect(result.current.conversations[0].pinnedAt).toEqual(expect.any(Number));

    act(() => result.current.togglePinned("a"));
    expect(result.current.conversations[0].pinnedAt).toBeUndefined();
  });

  // The regression this hook's `activityAt` field exists to prevent: pinning
  // has to bump `updatedAt` because cloud-sync uses it as the revision marker,
  // but that must not move the conversation in the sidebar's Recent list.
  it("bumps updatedAt so cloud sync still pushes the change", () => {
    seed([{ id: "a", updatedAt: 1_000, activityAt: 1_000 }]);
    const { result } = render();

    act(() => result.current.togglePinned("a"));

    expect(result.current.conversations[0].updatedAt).toBeGreaterThan(1_000);
  });

  it("leaves activityAt alone so Recent ordering does not change", () => {
    seed([
      { id: "old", updatedAt: 1_000, activityAt: 1_000 },
      { id: "new", updatedAt: 5_000, activityAt: 5_000 },
    ]);
    const { result } = render();
    const order = () => [...result.current.conversations]
      .sort((a, b) => conversationActivityAt(b) - conversationActivityAt(a))
      .map((c) => c.id);

    expect(order()).toEqual(["new", "old"]);

    act(() => result.current.togglePinned("old"));
    act(() => result.current.togglePinned("old"));

    expect(order()).toEqual(["new", "old"]);
  });

  it("only touches the targeted conversation", () => {
    seed([{ id: "a" }, { id: "b" }]);
    const { result } = render();

    act(() => result.current.togglePinned("a"));

    expect(result.current.conversations.find((c) => c.id === "b")?.pinnedAt).toBeUndefined();
  });
});

describe("activityAt on real content changes", () => {
  it("moves when the title changes", () => {
    seed([{ id: "a", updatedAt: 1_000, activityAt: 1_000 }]);
    const { result } = render();

    act(() => result.current.renameChat("a", "Renamed"));

    const c = result.current.conversations[0];
    expect(c.title).toBe("Renamed");
    expect(conversationActivityAt(c)).toBeGreaterThan(1_000);
  });

  it("moves when messages change", () => {
    seed([{ id: "a", updatedAt: 1_000, activityAt: 1_000 }]);
    const { result } = render();

    act(() => result.current.setMessages([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ], "a"));

    expect(conversationActivityAt(result.current.conversations[0])).toBeGreaterThan(1_000);
  });
});

describe("personalConversations", () => {
  it("excludes team conversations and keeps legacy records without a space", () => {
    seed([
      { id: "legacy" },
      { id: "mine", space: "personal" },
      { id: "theirs", space: "team" },
    ]);
    const { result } = render();

    expect(result.current.personalConversations.map((c) => c.id)).toEqual(["legacy", "mine"]);
  });
});

describe("deleteChat", () => {
  it("removes the conversation", () => {
    seed([{ id: "a" }, { id: "b" }]);
    const { result } = render();

    act(() => result.current.deleteChat("a"));

    expect(result.current.conversations.map((c) => c.id)).toEqual(["b"]);
  });

  // Deleting the active chat used to clear only the space the hook was
  // currently rendering, leaving the other space pointing at a dead id.
  it("clears the active id when the active chat is deleted", () => {
    seed([{ id: "a" }, { id: "b" }]);
    const { result } = render();

    act(() => result.current.selectChatInSpace("personal", "a"));
    expect(result.current.activeId).toBe("a");

    act(() => result.current.deleteChat("a"));
    expect(result.current.activeId).toBeNull();
  });

  // The sidebar only ever hands deleteChat a personal conversation, so this
  // branch is unreachable through the UI and a mutation sweep found no test
  // killed it. It still guards the hook's public API, so it gets a fixture that
  // reaches it directly rather than being deleted as dead weight.
  it("clears the team active id when a team chat is deleted", () => {
    seed([{ id: "p" }, { id: "t", space: "team" }]);
    const { result } = renderHook(() => useChatHistory(null, "team"));

    act(() => result.current.selectChatInSpace("team", "t"));
    expect(result.current.activeId).toBe("t");

    act(() => result.current.deleteChat("t"));
    expect(result.current.activeId).toBeNull();
  });

  it("leaves the active id alone when another chat is deleted", () => {
    seed([{ id: "a" }, { id: "b" }]);
    const { result } = render();

    act(() => result.current.selectChatInSpace("personal", "a"));
    act(() => result.current.deleteChat("b"));

    expect(result.current.activeId).toBe("a");
  });
});

describe("space-scoped selection", () => {
  it("newChatInSpace clears the active id for that space", () => {
    seed([{ id: "a" }]);
    const { result } = render();

    act(() => result.current.selectChatInSpace("personal", "a"));
    act(() => result.current.newChatInSpace("personal"));

    expect(result.current.activeId).toBeNull();
  });

  it("selecting in the team space does not disturb the personal space", () => {
    seed([{ id: "a" }, { id: "t", space: "team" }]);
    const { result } = render();

    act(() => result.current.selectChatInSpace("personal", "a"));
    act(() => result.current.selectChatInSpace("team", "t"));

    // The hook is rendering the personal space, so activeId stays personal.
    expect(result.current.activeId).toBe("a");
  });
});
