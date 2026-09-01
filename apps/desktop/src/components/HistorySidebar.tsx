import { useEffect, useRef, useState } from "react";
import {
  Plus, MessageSquare, Trash2, Phone, Blocks, Images, Wallet, Sparkles, Search,
  Grid2x2, ChevronRight, Terminal, Server, UserRound, Users, Bot, Cloud,
} from "lucide-react";
import type { ChatSpace, Conversation } from "../hooks/use-chat-history";
import type { WalletInfo } from "../lib/wire";
import type { AgentConnectionState } from "../lib/ws";
import { useTryLang } from "../lib/i18n";
import { MoreMenu } from "./MoreMenu";
import { WalletPill } from "./WalletPill";
import franklinAvatar from "../assets/franklin-avatar.png";
import type { TeamWorkspaceNavItem } from "../lib/team-workspace-events";
import { useSidebarPreferences } from "../hooks/use-sidebar-preferences";

export type TryView = "chat" | "agents" | "phone" | "tools" | "gallery" | "wallet" | "skills" | "cli" | "mcp";

// Local bundled logo (no network → no offline blank).
const PORTRAIT_URL = franklinAvatar;

interface Props {
  conversations: Conversation[];
  activeId: string | null;
  onNew: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
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
  onChatSpace: (space: ChatSpace) => void;
  teamModeEnabled?: boolean;
  teamWorkspaces?: TeamWorkspaceNavItem[];
  activeTeamWorkspaceId?: string | null;
  teamLoading?: boolean;
  onTeamWorkspace?: (id: string) => void;
}

export function HistorySidebar({ conversations, activeId, onNew, onSelect, onDelete, view, onView, open, wallet, walletLoading, walletError, walletConnectionState, switchingWalletChain, onSwitchWalletChain, chatSpace, onChatSpace, teamModeEnabled = true, teamWorkspaces = [], activeTeamWorkspaceId = null, teamLoading = false, onTeamWorkspace }: Props) {
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

  const sorted = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);

  const navItems: { key: TryView; icon: React.ReactNode; label: string }[] = [
    { key: "agents", icon: <Bot className="h-4 w-4" />, label: "Agents" },
    { key: "tools", icon: <Blocks className="h-4 w-4" />, label: t.marketplace },
    { key: "gallery", icon: <Images className="h-4 w-4" />, label: t.gallery },
    { key: "cli", icon: <Terminal className="h-4 w-4" />, label: t.cli },
  ];
  const nav = navItems.filter((item) => visibleItems.includes(item.key as "agents" | "tools" | "gallery" | "cli"));
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

      <div className="try-space-switch" role="group" aria-label="Conversation mode">
        <button
          className={chatSpace === "personal" ? "is-active" : ""}
          onClick={() => onChatSpace("personal")}
          title="Your private conversations"
        >
          <UserRound className="h-4 w-4" />
          Personal
        </button>
        <button
          className={chatSpace === "team" ? "is-active" : ""}
          onClick={() => onChatSpace("team")}
          disabled={!teamModeEnabled}
          title="Shared BlockRun team conversations"
        >
          <Users className="h-4 w-4" />
          Team
          <span className="try-team-beta">Beta</span>
        </button>
      </div>

      {!teamModeEnabled && <button className="try-team-disabled-note" onClick={() => onView("agents")}>Team Mode is off · Manage modules</button>}

      {chatSpace === "team" && <div className="try-team-workspaces">
        <div className="try-team-workspaces-head"><span>WORKSPACES</span><em>{teamWorkspaces.length}</em></div>
        {teamLoading ? <div className="try-team-workspace-loading">Connecting to Franklin Cloud…</div> : teamWorkspaces.length === 0 ? <div className="try-team-workspace-loading">No team workspaces yet</div> : teamWorkspaces.map((workspace) => (
          <button key={workspace.id} className={`try-team-workspace${activeTeamWorkspaceId === workspace.id && view === "chat" ? " is-active" : ""}`} onClick={() => onTeamWorkspace?.(workspace.id)}>
            <span className="try-team-mark"><Cloud className="h-4 w-4" /></span>
            <span><strong>{workspace.name}</strong><small>{workspace.memberCount} members · {workspace.role}</small></span>
            <i aria-label={`Workspace version ${workspace.version}`}>v{workspace.version}</i>
          </button>
        ))}
      </div>}

      <button className="try-nav-item" onClick={onNew}>
        <Plus className="h-4 w-4" />
        {chatSpace === "team" ? "New workspace" : t.newChat}
      </button>

      {chatSpace === "personal" && <button className="try-nav-item" onClick={() => setSearchOpen(true)}>
        <Search className="h-4 w-4" />
        {t.searchChats}
      </button>}

      <div className="try-scroll">
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

      {chatSpace === "personal" && <div className="try-history">
        {sorted.length === 0 ? (
          <p className="try-history-empty">{t.noConversations}</p>
        ) : (
          <div className="try-history-group">
            <div className="try-history-group-label">{t.history}</div>
            {sorted.map((c) => (
              <div
                key={c.id}
                className={`try-history-item${c.id === activeId && view === "chat" ? " is-active" : ""}`}
                onClick={() => {
                  onSelect(c.id);
                  onView("chat");
                }}
              >
                <MessageSquare className="try-history-icon" />
                <span className="try-history-title">{c.title || "New chat"}</span>
                <button
                  className="try-history-del"
                  aria-label="Delete conversation"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(c.id);
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>}
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
          onNew();
          setSearchOpen(false);
        }}
      />
    )}
    </>
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
    : [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);

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
                <span className="try-history-title">{c.title || "New chat"}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
