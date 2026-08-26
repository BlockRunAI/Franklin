import { useEffect, useRef, useState } from "react";
import {
  Plus, MessageSquare, Trash2, Phone, Blocks, Images, Wallet, Sparkles, Search,
  Grid2x2, ChevronRight, Terminal, UsersRound, FolderKanban, BookOpen, Workflow,
} from "lucide-react";
import type { Conversation } from "../hooks/use-chat-history";
import type { WalletInfo } from "../lib/wire";
import { useTryLang } from "../lib/i18n";
import { MoreMenu } from "./MoreMenu";
import { WalletPill } from "./WalletPill";
import franklinAvatar from "../assets/franklin-avatar.png";

export type TryView = "chat" | "phone" | "tools" | "gallery" | "wallet" | "skills" | "cli" | "team";
export type WorkspaceMode = "personal" | "team";

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
  workspaceMode: WorkspaceMode;
  onWorkspaceMode: (mode: WorkspaceMode) => void;
  /** Local CLI wallet (read-only) — replaces run's browser connect-wallet UI. */
  wallet: WalletInfo | null;
}

export function HistorySidebar({ conversations, activeId, onNew, onSelect, onDelete, view, onView, open, workspaceMode, onWorkspaceMode, wallet }: Props) {
  const { t, lang } = useTryLang();
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

  const nav: { key: TryView; icon: React.ReactNode; label: string }[] = [
    { key: "tools", icon: <Blocks className="h-[18px] w-[18px]" />, label: t.marketplace },
    { key: "gallery", icon: <Images className="h-[18px] w-[18px]" />, label: t.gallery },
    { key: "cli", icon: <Terminal className="h-[18px] w-[18px]" />, label: t.cli },
  ];
  const moreNav: { key: TryView; icon: React.ReactNode; label: string }[] = [
    { key: "skills", icon: <Sparkles className="h-[18px] w-[18px]" />, label: t.skills },
    { key: "phone", icon: <Phone className="h-[18px] w-[18px]" />, label: t.phone },
    { key: "wallet", icon: <Wallet className="h-[18px] w-[18px]" />, label: t.wallet },
  ];
  const moreActive = moreNav.some((n) => n.key === view);
  const teamCopy = lang === "zh"
    ? { personal: "个人", team: "团队", home: "团队首页", chats: "共享对话", files: "共享文件", knowledge: "团队知识", workflows: "工作流", soon: "即将开放" }
    : lang === "es"
      ? { personal: "Personal", team: "Equipo", home: "Inicio del equipo", chats: "Conversaciones", files: "Archivos", knowledge: "Conocimiento", workflows: "Flujos", soon: "Próximamente" }
      : { personal: "Personal", team: "Team", home: "Team home", chats: "Shared chats", files: "Shared files", knowledge: "Knowledge", workflows: "Workflows", soon: "Coming soon" };
  const teamNav = [
    { icon: <MessageSquare className="h-[18px] w-[18px]" />, label: teamCopy.chats },
    { icon: <FolderKanban className="h-[18px] w-[18px]" />, label: teamCopy.files },
    { icon: <BookOpen className="h-[18px] w-[18px]" />, label: teamCopy.knowledge },
    { icon: <Workflow className="h-[18px] w-[18px]" />, label: teamCopy.workflows },
  ];

  return (
    <>
    <aside className={`try-sidebar${open ? " is-open" : ""}`}>
      <button className="try-brand" onClick={() => onWorkspaceMode("personal")}>
        <span className="try-brand-ring">
          <img src={PORTRAIT_URL} alt="Franklin" width={30} height={30} />
        </span>
        <span className="try-brand-name">Franklin</span>
      </button>

      <div className="try-workspace-switch" aria-label="Workspace mode">
        <button
          className={workspaceMode === "personal" ? "is-active" : ""}
          onClick={() => onWorkspaceMode("personal")}
        >
          {teamCopy.personal}
        </button>
        <button
          className={workspaceMode === "team" ? "is-active" : ""}
          onClick={() => onWorkspaceMode("team")}
        >
          <UsersRound className="h-3.5 w-3.5" />{teamCopy.team}<span>Beta</span>
        </button>
      </div>

      {workspaceMode === "personal" ? (
      <>
      <button className="try-nav-item" onClick={onNew}>
        <Plus className="h-[18px] w-[18px]" />
        {t.newChat}
      </button>

      <button className="try-nav-item" onClick={() => setSearchOpen(true)}>
        <Search className="h-[18px] w-[18px]" />
        {t.searchChats}
      </button>

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

      <button
        ref={moreBtnRef}
        className={`try-nav-item try-more-btn${moreActive ? " is-active" : ""}`}
        onClick={() => (moreOpen ? setMoreOpen(false) : openMore())}
      >
        <Grid2x2 className="h-[18px] w-[18px]" />
        <span className="try-more-label">{t.more}</span>
        <ChevronRight className="try-more-chevron h-[17px] w-[17px]" />
      </button>

      <div className="try-history">
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
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      </div>
      </>
      ) : (
      <div className="try-scroll try-team-sidebar-content">
        <button className="try-nav-item is-active" onClick={() => onView("team")}>
          <UsersRound className="h-[18px] w-[18px]" />{teamCopy.home}<span className="try-nav-beta">Beta</span>
        </button>
        <div className="try-team-sidebar-label">{teamCopy.soon}</div>
        {teamNav.map((item) => (
          <button key={item.label} className="try-nav-item try-nav-disabled" disabled>
            {item.icon}<span>{item.label}</span><span className="try-nav-soon">{teamCopy.soon}</span>
          </button>
        ))}
      </div>
      )}

      <div className="try-sidebar-footer">
        <div className="try-footer-icons">
          <MoreMenu />
          <div className="try-footer-wallet">
            <WalletPill wallet={wallet} />
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
