import { useEffect, useRef, useState } from "react";
import {
  Plus, MessageSquare, Trash2, Phone, Blocks, Images, Wallet, Sparkles, Search,
  Grid2x2, ChevronRight, Terminal, Server, Bot, Folder, FolderPlus, Pin, PinOff,
} from "lucide-react";
import { conversationActivityAt, type ChatSpace, type Conversation } from "../hooks/use-chat-history";
import type { WalletInfo } from "../lib/wire";
import type { AgentConnectionState } from "../lib/ws";
import { useTryLang } from "../lib/i18n";
import { MoreMenu } from "./MoreMenu";
import { WalletPill } from "./WalletPill";
import franklinAvatar from "../assets/franklin-avatar.png";
import type { TeamWorkspaceNavItem } from "../hooks/use-cloud-workspace";
import { useSidebarPreferences } from "../hooks/use-sidebar-preferences";

export type TryView = "chat" | "agents" | "phone" | "tools" | "gallery" | "wallet" | "skills" | "cli" | "mcp";

// Local bundled logo (no network → no offline blank).
const PORTRAIT_URL = franklinAvatar;

interface Props {
  conversations: Conversation[];
  activeId: string | null;
  onNewChat: () => void;
  onNewProject: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onTogglePinned: (id: string) => void;
  view: TryView;
  onView: (v: TryView) => void;
  open: boolean;
  /** Local CLI wallet (read-only) — replaces run's browser connect-wallet UI. */
  wallet: WalletInfo | null;
  walletLoading: boolean;
  walletError: string | null;
  walletConnectionState: AgentConnectionState;
  switchingWalletChain?: "base" | "solana" | null;
  onSwitchWalletChain?: (chain: "base" | "solana") => void | Promise<void>;
  chatSpace: ChatSpace;
  teamModeEnabled?: boolean;
  teamWorkspaces?: TeamWorkspaceNavItem[];
  activeTeamWorkspaceId?: string | null;
  teamLoading?: boolean;
  onTeamWorkspace?: (id: string) => void;
}

export function HistorySidebar({ conversations, activeId, onNewChat, onNewProject, onSelect, onDelete, onTogglePinned, view, onView, open, wallet, walletLoading, walletError, walletConnectionState, switchingWalletChain, onSwitchWalletChain, chatSpace, teamModeEnabled = true, teamWorkspaces = [], activeTeamWorkspaceId = null, teamLoading = false, onTeamWorkspace }: Props) {
  const { t } = useTryLang();
  const { visibleItems } = useSidebarPreferences();
  const [searchOpen, setSearchOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  const [morePos, setMorePos] = useState<{ top: number; left: number } | null>(null);

  const openMore = () => {
    const r = moreBtnRef.current?.getBoundingClientRect();
    if (r) setMorePos({ top: r.top, left: r.right + 6 });
    setMoreOpen(true);
  };

  const sorted = [...conversations].sort((a, b) => conversationActivityAt(b) - conversationActivityAt(a));
  const pinned = sorted.filter((conversation) => conversation.pinnedAt).sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0));
  const recent = sorted.filter((conversation) => !conversation.pinnedAt);

  const navItems: { key: TryView; icon: React.ReactNode; label: string }[] = [
    { key: "tools", icon: <Blocks className="h-4 w-4" />, label: t.marketplace },
    { key: "gallery", icon: <Images className="h-4 w-4" />, label: t.gallery },
    { key: "cli", icon: <Terminal className="h-4 w-4" />, label: t.cli },
  ];
  const nav = navItems.filter((item) => visibleItems.includes(item.key as "tools" | "gallery" | "cli"));
  const moreNavItems: { key: TryView; icon: React.ReactNode; label: string }[] = [
    { key: "mcp", icon: <Server className="h-4 w-4" />, label: "MCP" },
    { key: "skills", icon: <Sparkles className="h-4 w-4" />, label: t.skills },
    { key: "phone", icon: <Phone className="h-4 w-4" />, label: t.phone },
    { key: "wallet", icon: <Wallet className="h-4 w-4" />, label: t.wallet },
  ];
  const moreNav = moreNavItems.filter((item) => visibleItems.includes(item.key as "mcp" | "skills" | "phone" | "wallet"));
  const moreActive = moreNav.some((n) => n.key === view);

  return (
    <>
    <aside className={`try-sidebar${open ? " is-open" : ""}`}>
      <button className="try-brand" onClick={() => onView("chat")}>
        <span className="try-brand-ring">
          <img src={PORTRAIT_URL} alt="Franklin" width={30} height={30} />
        </span>
        <span className="try-brand-name">Franklin</span>
      </button>

      <button className="try-nav-item" onClick={onNewChat}>
        <Plus className="h-4 w-4" />
        {t.newChat}
      </button>

      <button className="try-nav-item" onClick={() => setSearchOpen(true)}>
        <Search className="h-4 w-4" />
        {t.searchChats}
      </button>

      <div className="try-scroll">
        {visibleItems.includes("agents") && <button className={`try-nav-item${view === "agents" ? " is-active" : ""}`} onClick={() => onView("agents")}>
          <Bot className="h-4 w-4" />
          {t.agents}
        </button>}

        <button
          className="try-nav-item try-project-create"
          onClick={onNewProject}
          disabled={!teamModeEnabled}
          title={teamModeEnabled ? t.createOrJoinProject : t.enableTeamMode}
        >
          <FolderPlus className="h-4 w-4" />
          {t.newProject}
        </button>

        {!teamModeEnabled && <button className="try-team-disabled-note" onClick={() => onView("agents")}>{t.teamModeOff}</button>}

        {pinned.length > 0 && <SidebarSection label={t.pinned} count={pinned.length}>
          {pinned.map((conversation) => (
            <ConversationRow
              key={conversation.id}
              conversation={conversation}
              active={chatSpace === "personal" && conversation.id === activeId && view === "chat"}
              onSelect={onSelect}
              onDelete={onDelete}
              onTogglePinned={onTogglePinned}
            />
          ))}
        </SidebarSection>}

        <SidebarSection label={t.projects} count={teamWorkspaces.length}>
          {teamLoading ? (
            <p className="try-section-empty">{t.connectingProjects}</p>
          ) : teamWorkspaces.length === 0 ? (
            <p className="try-section-empty">{t.noProjects}</p>
          ) : teamWorkspaces.map((workspace) => (
            <button
              key={workspace.id}
              className={`try-team-workspace${chatSpace === "team" && activeTeamWorkspaceId === workspace.id && view === "chat" ? " is-active" : ""}`}
              onClick={() => onTeamWorkspace?.(workspace.id)}
              disabled={!teamModeEnabled}
              title={teamModeEnabled ? `${workspace.memberCount} members · ${workspace.role}` : t.enableTeamMode}
            >
              <Folder className="h-4 w-4" />
              <span>{workspace.name}</span>
            </button>
          ))}
        </SidebarSection>

        <SidebarSection label={t.recent} count={recent.length}>
          {recent.length === 0 ? (
            <p className="try-section-empty">{t.noConversations}</p>
          ) : recent.map((conversation) => (
            <ConversationRow
              key={conversation.id}
              conversation={conversation}
              active={chatSpace === "personal" && conversation.id === activeId && view === "chat"}
              onSelect={onSelect}
              onDelete={onDelete}
              onTogglePinned={onTogglePinned}
            />
          ))}
        </SidebarSection>

        <div className="try-sidebar-secondary">
          {nav.map((n) => (
            <button
              key={n.key}
              className={`try-nav-item${view === n.key ? " is-active" : ""}`}
              onClick={() => onView(n.key)}
            >
              {n.icon}
              {n.label}
            </button>
          ))}

          {moreNav.length > 0 && <button
            ref={moreBtnRef}
            className={`try-nav-item try-more-btn${moreActive ? " is-active" : ""}`}
            onClick={() => (moreOpen ? setMoreOpen(false) : openMore())}
          >
            <Grid2x2 className="h-4 w-4" />
            <span className="try-more-label">{t.more}</span>
            <ChevronRight className="try-more-chevron h-4 w-4" />
          </button>}
        </div>
      </div>

      <div className="try-sidebar-footer">
        <div className="try-footer-icons">
          <MoreMenu />
          <div className="try-footer-wallet">
            <WalletPill wallet={wallet} connectionState={walletConnectionState} isLoading={walletLoading} error={walletError} switchingChain={switchingWalletChain} onSwitchChain={onSwitchWalletChain} />
          </div>
        </div>
      </div>
    </aside>

    {moreOpen && morePos && (
      <>
        <div className="try-more-scrim" onClick={() => setMoreOpen(false)} />
        <div className="try-more-flyout" style={{ top: morePos.top, left: morePos.left }}>
          {moreNav.map((n) => (
            <button
              key={n.key}
              className={`try-more-item${view === n.key ? " is-active" : ""}`}
              onClick={() => {
                onView(n.key);
                setMoreOpen(false);
              }}
            >
              {n.icon}
              {n.label}
            </button>
          ))}
        </div>
      </>
    )}

    {searchOpen && (
      <SearchModal
        conversations={conversations}
        onClose={() => setSearchOpen(false)}
        onPick={(id) => {
          onSelect(id);
          onView("chat");
          setSearchOpen(false);
        }}
        onNew={() => {
          onNewChat();
          setSearchOpen(false);
        }}
      />
    )}
    </>
  );
}

function SidebarSection({ label, count, children }: { label: string; count: number; children: React.ReactNode }) {
  return (
    <section className="try-sidebar-section">
      <div className="try-sidebar-section-head">
        <span>{label}</span>
        {count > 0 && <em>{count}</em>}
      </div>
      <div className="try-sidebar-section-items">{children}</div>
    </section>
  );
}

function ConversationRow({ conversation, active, onSelect, onDelete, onTogglePinned }: {
  conversation: Conversation;
  active: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onTogglePinned: (id: string) => void;
}) {
  const { t } = useTryLang();
  const isPinned = !!conversation.pinnedAt;
  return (
    <div className={`try-history-item${active ? " is-active" : ""}`} onClick={() => onSelect(conversation.id)}>
      <MessageSquare className="try-history-icon" />
      <span className="try-history-title">{conversation.title || t.newChat}</span>
      <span className="try-history-actions">
        <button
          className={`try-history-action${isPinned ? " is-pinned" : ""}`}
          aria-label={isPinned ? t.unpinConversation : t.pinConversation}
          title={isPinned ? t.unpinConversation : t.pinConversation}
          onClick={(event) => {
            event.stopPropagation();
            onTogglePinned(conversation.id);
          }}
        >
          {isPinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
        </button>
        <button
          className="try-history-action try-history-del"
          aria-label={t.deleteConversation}
          title={t.deleteConversation}
          onClick={(event) => {
            event.stopPropagation();
            onDelete(conversation.id);
          }}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </span>
    </div>
  );
}

function SearchModal({
  conversations,
  onClose,
  onPick,
  onNew,
}: {
  conversations: Conversation[];
  onClose: () => void;
  onPick: (id: string) => void;
  onNew: () => void;
}) {
  const { t } = useTryLang();
  const [query, setQuery] = useState("");

  const q = query.trim().toLowerCase();
  const results = q
    ? conversations.filter((c) => c.title.toLowerCase().includes(q))
    : [...conversations].sort((a, b) => conversationActivityAt(b) - conversationActivityAt(a));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="try-search-overlay" onClick={onClose}>
      <div className="try-search-modal" onClick={(e) => e.stopPropagation()}>
        <div className="try-search-bar">
          <Search className="h-4 w-4" />
          <input
            className="try-search-modal-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t.searchChats}
            autoFocus
          />
        </div>
        <div className="try-search-results">
          <button className="try-search-result is-new" onClick={onNew}>
            <Plus className="h-4 w-4" />
            {t.newChat}
          </button>
          {results.length === 0 ? (
            <p className="try-history-empty">{t.noResults}</p>
          ) : (
            results.map((c) => (
              <button key={c.id} className="try-search-result" onClick={() => onPick(c.id)}>
                <MessageSquare className="try-history-icon" />
                <span className="try-history-title">{c.title || t.newChat}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
