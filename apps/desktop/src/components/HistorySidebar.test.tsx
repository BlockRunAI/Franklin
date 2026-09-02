import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../assets/franklin-avatar.png", () => ({ default: "avatar.png" }));

const { HistorySidebar } = await import("./HistorySidebar");
const { TryLangProvider } = await import("../lib/i18n");
type Conversation = import("../hooks/use-chat-history").Conversation;

const SIDEBAR_PREFS_KEY = "franklin-sidebar-preferences-v1";

function conversation(over: Partial<Conversation> = {}): Conversation {
  return {
    id: "c1",
    title: "A chat",
    createdAt: 1_000,
    updatedAt: 1_000,
    messages: [],
    ...over,
  } as Conversation;
}

type SidebarProps = Parameters<typeof HistorySidebar>[0];

// Every required prop gets a default here, so `over` only ever narrows. The
// merge is spelled out rather than spread into JSX because `Partial` widens
// each field with `undefined`, which a required prop like `wallet` rejects.
const baseProps: SidebarProps = {
  conversations: [],
  activeId: null,
  onNewChat: () => {},
  onNewProject: () => {},
  onSelect: () => {},
  onDelete: () => {},
  onTogglePinned: () => {},
  view: "chat",
  onView: () => {},
  open: true,
  wallet: null,
  walletLoading: false,
  walletError: null,
  walletConnectionState: "open",
  chatSpace: "personal",
};

function draw(over: Partial<SidebarProps> = {}) {
  const props: SidebarProps = { ...baseProps, ...over };
  return render(
    <TryLangProvider>
      <HistorySidebar {...props} />
    </TryLangProvider>,
  );
}

const section = (label: string) =>
  screen.getByText(label, { selector: ".try-sidebar-section-head span" }).closest("section")!;

beforeEach(() => localStorage.clear());

describe("Agents nav item", () => {
  // The sidebar reorganization hardcoded this button, so the "Show in sidebar"
  // preference in MoreMenu cleared its checkmark but left the button rendered.
  it("is shown by default", () => {
    draw();
    expect(screen.getByText("Agents")).toBeTruthy();
  });

  it("is hidden when the sidebar preference excludes it", () => {
    localStorage.setItem(SIDEBAR_PREFS_KEY, JSON.stringify(["tools", "gallery", "cli"]));
    draw();
    expect(screen.queryByText("Agents")).toBeNull();
  });

  it("still renders the other nav items when Agents is hidden", () => {
    localStorage.setItem(SIDEBAR_PREFS_KEY, JSON.stringify(["tools", "gallery", "cli"]));
    draw();
    expect(screen.getByText("Gallery")).toBeTruthy();
  });
});

describe("Pinned section", () => {
  // Pinned has no empty-state text, so rendering it empty drew a bare header.
  it("is not rendered when nothing is pinned", () => {
    draw({ conversations: [conversation({ id: "a" })] });
    expect(screen.queryByText("Pinned", { selector: ".try-sidebar-section-head span" })).toBeNull();
  });

  it("appears once a conversation is pinned", () => {
    draw({ conversations: [conversation({ id: "a", title: "Pinned one", pinnedAt: 5_000 })] });
    expect(within(section("Pinned")).getByText("Pinned one")).toBeTruthy();
  });

  it("orders pinned conversations by when they were pinned", () => {
    draw({
      conversations: [
        conversation({ id: "a", title: "First", pinnedAt: 1_000 }),
        conversation({ id: "b", title: "Second", pinnedAt: 9_000 }),
      ],
    });
    const titles = within(section("Pinned"))
      .getAllByText(/First|Second/)
      .map((n) => n.textContent);
    expect(titles).toEqual(["Second", "First"]);
  });

  it("keeps pinned conversations out of Recent", () => {
    draw({ conversations: [conversation({ id: "a", title: "Only one", pinnedAt: 5_000 })] });
    expect(within(section("Recent")).queryByText("Only one")).toBeNull();
  });
});

describe("Recent section", () => {
  it("shows the empty note when there are no conversations", () => {
    draw();
    expect(within(section("Recent")).getByText("No conversations yet.")).toBeTruthy();
  });

  // Previously gated on there being no conversations at all, so pinning every
  // conversation left the Recent header sitting above nothing.
  it("shows the empty note when every conversation is pinned", () => {
    draw({ conversations: [conversation({ id: "a", pinnedAt: 5_000 })] });
    expect(within(section("Recent")).getByText("No conversations yet.")).toBeTruthy();
  });

  it("orders by activity, not by the pin bump on updatedAt", () => {
    draw({
      conversations: [
        conversation({ id: "a", title: "Older", updatedAt: 9_999, activityAt: 1_000 }),
        conversation({ id: "b", title: "Newer", updatedAt: 2_000, activityAt: 5_000 }),
      ],
    });
    const titles = within(section("Recent"))
      .getAllByText(/Older|Newer/)
      .map((n) => n.textContent);
    expect(titles).toEqual(["Newer", "Older"]);
  });
});

describe("Projects section", () => {
  it("reports the connecting state", () => {
    draw({ teamLoading: true });
    expect(within(section("Projects")).getByText("Connecting…")).toBeTruthy();
  });

  it("reports an empty project list", () => {
    draw({ teamLoading: false });
    expect(within(section("Projects")).getByText("No projects")).toBeTruthy();
  });

  it("disables project entry when Team Mode is off", () => {
    draw({
      teamModeEnabled: false,
      teamWorkspaces: [{ id: "w1", name: "Alpha", role: "owner", memberCount: 2, version: 3 }],
    });
    expect(screen.getByText("Alpha").closest("button")!.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("New project").closest("button")!.hasAttribute("disabled")).toBe(true);
  });
});

describe("localisation", () => {
  it("translates the section headings", () => {
    localStorage.setItem("franklin-try-ui-lang", "zh");
    draw();
    expect(screen.getByText("最近", { selector: ".try-sidebar-section-head span" })).toBeTruthy();
    expect(screen.getByText("项目", { selector: ".try-sidebar-section-head span" })).toBeTruthy();
  });
});
