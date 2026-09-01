// Main chat surface — ported from franklin-run with the full feature set
// (chat / image / video modes, focus tools, image attach, gallery + panels),
// rewired to the local agent: useFranklinChat streams over the WebSocket, the
// wallet is the local CLI wallet (read-only, no connect flow).

import { useEffect, useRef, useState } from "react";
import { ArrowUp, PanelLeft, ImageIcon, Clapperboard, Music, X, Plus, Check, ChevronDown, Gauge, BarChart3, TrendingUp, MoreHorizontal, Users, Laptop2, ShieldAlert } from "lucide-react";
import { TopBarMenu } from "./TopBarMenu";
import { ModelSelect } from "./ModelSelect";
import { HistorySidebar, type TryView } from "./HistorySidebar";
import { MessageContent } from "./MessageContent";
import { ActivitySummary } from "./ActivitySummary";
import { MessageActions } from "./MessageActions";
import { ToolGroup } from "./ToolGroup";
import { ShareDialog } from "./ShareDialog";
import { PhonePanel } from "./PhonePanel";
import { ToolsPanel, type TryAction } from "./ToolsPanel";
import { GalleryPanel } from "./GalleryPanel";
import { WalletPanel } from "./WalletPanel";
import { SkillsPanel } from "./SkillsPanel";
import { McpPanel } from "./McpPanel";
import { CLIPanel } from "./CLIPanel";
import { AgentsPanel } from "./AgentsPanel";
import { CloudWorkspacePanel } from "./CloudWorkspacePanel";
import { useFranklinChat } from "../hooks/use-franklin-chat";
import { useChatHistory, type ChatSpace } from "../hooks/use-chat-history";
import { useSpend } from "../hooks/use-spend";
import { useAuth } from "../hooks/use-auth";
import { useWallet } from "../hooks/use-wallet";
import { useTryLang } from "../lib/i18n";
import { prepareImageForUpload } from "../lib/image-compress";
import { useStudioRegistry } from "../hooks/use-studio-registry";
import { requestTeamWorkspace, subscribeTeamWorkspaceNav, type TeamWorkspaceNavState } from "../lib/team-workspace-events";
import { safeExternalHttpUrl } from "../lib/external-url";

// Composer "focus" modes — force a specific live-data tool (server tool_choice).
type ToolFocus = "search_prediction_markets" | "web_search" | "get_market_price";
const TOOL_FOCUS_MODEL = "google/gemini-2.5-flash";

// Tiny aspect-ratio glyph (a proportioned rectangle) for the ratio picker.
function RatioGlyph({ ratio, className }: { ratio: string; className?: string }) {
  const [w, h] = ratio.split(":").map(Number);
  if (!w || !h) return null;
  const box = 16;
  const pad = 1;
  const max = Math.max(w, h);
  const W = (w / max) * (box - pad * 2);
  const H = (h / max) * (box - pad * 2);
  return (
    <svg width={box} height={box} viewBox={`0 0 ${box} ${box}`} className={className} aria-hidden>
      <rect x={(box - W) / 2} y={(box - H) / 2} width={W} height={H} rx={1.2} fill="none" stroke="currentColor" strokeWidth={1.4} />
    </svg>
  );
}

function EmphTitle({ text }: { text: string }) {
  const parts = text.split("Franklin");
  return (
    <>
      {parts[0]}
      <em>Franklin</em>
      {parts[1] ?? ""}
    </>
  );
}

export function FranklinChat() {
  const { t } = useTryLang();
  const auth = useAuth();
  const {
    wallet,
    isLoading: walletLoading,
    error: walletError,
    connectionState: walletConnectionState,
    switchingChain: switchingWalletChain,
    switchChain: switchWalletChain,
  } = useWallet();
  const [chatSpace, setChatSpaceState] = useState<ChatSpace>(() => {
    if (typeof window === "undefined") return "personal";
    try {
      return localStorage.getItem("franklin-desktop-chat-space-v1") === "team" ? "team" : "personal";
    } catch {
      return "personal";
    }
  });
  const history = useChatHistory(auth.address, chatSpace);
  const usage = useSpend();
  const studio = useStudioRegistry();
  const [teamNav, setTeamNav] = useState<TeamWorkspaceNavState>({ items: [], activeId: null, loading: true });
  useEffect(() => subscribeTeamWorkspaceNav(setTeamNav), []);
  const chat = useFranklinChat(history.messages, history.setMessages, history.ensureConvId);
  const { mode, setMode, model, setModel, models, selectedModel, status, activeTool, needsToolWallet, genConvId, mediaJobs, error, pendingPermission, respondToPermission, isBusy, isConnected, send, stop, stopMedia, regenerate, imageSize, setImageSize, imageSizes, videoRatio, setVideoRatio, videoRatios, videoResolution, setVideoResolution, videoResolutions } = chat;
  const genHere = genConvId === null || genConvId === history.activeId;
  const activeMediaJob = history.activeId ? mediaJobs[history.activeId] : undefined;
  const busy = isBusy || !!activeMediaJob;

  const [input, setInput] = useState("");
  const [attachment, setAttachment] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [view, setView] = useState<TryView>("chat");
  const MOBILE_BP = 880;
  const closeSidebarOnMobile = () => {
    if (typeof window !== "undefined" && window.innerWidth <= MOBILE_BP) setSidebarOpen(false);
  };
  useEffect(() => {
    if (window.innerWidth <= MOBILE_BP) setSidebarOpen(false);
  }, []);
  const [focus, setFocus] = useState<ToolFocus | null>(null);
  const [ratioOpen, setRatioOpen] = useState(false);
  const [resOpen, setResOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const setChatSpace = (next: ChatSpace) => {
    if (next === "team" && !studio.teamModeEnabled) return;
    setChatSpaceState(next);
    try { localStorage.setItem("franklin-desktop-chat-space-v1", next); } catch { /* local cache unavailable */ }
    setEditingTitle(false);
    setView("chat");
    closeSidebarOnMobile();
  };
  // Image mode → aspect-ratio whitelist (value = size like "1536x1024"); video
  // mode → ratio list (value = the ratio itself). Picker hidden when ≤1 option.
  const ratioOptions: { ratio: string; value: string }[] =
    mode === "image"
      ? imageSizes.map((s) => ({ ratio: s.ratio, value: s.size }))
      : mode === "video"
        ? videoRatios.map((r) => ({ ratio: r, value: r }))
        : [];
  const ratioValue = mode === "image" ? imageSize : mode === "video" ? videoRatio : "";
  const setRatioValue = mode === "image" ? setImageSize : mode === "video" ? setVideoRatio : () => {};
  const currentRatio = ratioOptions.find((o) => o.value === ratioValue)?.ratio ?? ratioOptions[0]?.ratio ?? "";
  const FOCUSES: { key: ToolFocus; icon: React.ReactNode; label: string; ph: string }[] = [
    { key: "search_prediction_markets", icon: <BarChart3 className="h-4 w-4" />, label: t.focusPrediction, ph: t.phPrediction },
    { key: "get_market_price", icon: <TrendingUp className="h-4 w-4" />, label: t.focusPrice, ph: t.phPrice },
  ];
  const activeFocus = FOCUSES.find((f) => f.key === focus);

  const pickSkill = (template: string, model?: string) => {
    setView("chat");
    setMode("chat");
    if (model) setModel(model);
    setInput(template);
  };
  const tryMarketplace = (a: TryAction) => {
    if (a.view && a.view !== "chat") {
      setView(a.view);
      return;
    }
    setView("chat");
    if (a.mode) setMode(a.mode);
    if (a.model) setModel(a.model);
    if (a.template !== undefined) setInput(a.template);
  };
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");

  const activeConvo = history.activeConversation;
  const commitTitle = () => {
    if (activeConvo) history.renameChat(activeConvo.id, titleDraft);
    setEditingTitle(false);
  };

  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setLightbox(null);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [lightbox]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const messages = history.messages;

  const [attachError, setAttachError] = useState<string | null>(null);
  const onPickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setAttachError(null);
    try {
      setAttachment(await prepareImageForUpload(file));
    } catch (err) {
      setAttachError(err instanceof Error ? err.message : "Could not load that image.");
    }
  };

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, status]);

  // Local CLI wallet signs everything — there is no per-turn wallet gate.
  const needsWallet = (mode !== "chat" || !selectedModel?.free || !!attachment) && !isConnected;
  const canSend = (!!input.trim() || !!attachment) && !busy && !needsWallet;
  const suggestions = mode === "image" ? t.sugImage : mode === "video" ? t.sugVideo : mode === "music" ? t.sugMusic : t.sugChat;

  const CASES: { mode: "chat" | "image" | "video"; prompt: string }[] = [
    { mode: "chat", prompt: t.casePrediction },
    { mode: "chat", prompt: t.casePrice },
    { mode: "chat", prompt: t.caseSearch },
    { mode: "chat", prompt: t.casePrediction2 },
    { mode: "chat", prompt: t.caseMovers },
    { mode: "video", prompt: t.sugVideo[0] },
    { mode: "chat", prompt: t.caseSports },
    { mode: "chat", prompt: t.caseMusic },
    { mode: "chat", prompt: t.caseTech },
  ];
  const runCase = (c: { mode: "chat" | "image" | "video"; prompt: string }) => {
    // Clicking a starter case must NOT switch the model — run it on whatever
    // model the user currently has selected.
    setMode(c.mode);
    send(c.prompt, undefined, c.mode);
  };

  const submit = () => {
    if (!canSend) return;
    if (focus) {
      const m = model.startsWith("nvidia/") ? TOOL_FOCUS_MODEL : model;
      send(input, attachment ?? undefined, "chat", m, focus);
    } else {
      send(input, attachment ?? undefined);
    }
    setInput("");
    setAttachment(null);
  };

  const placeholder = needsWallet
    ? t.phConnect
    : mode === "image"
      ? t.phImage
      : mode === "video"
        ? t.phVideo
        : mode === "music"
          ? t.phMusic
          : activeFocus
            ? activeFocus.ph
            : chatSpace === "team"
              ? "Message the BlockRun team agent…"
              : t.phMessage;

  return (
    <div className="try-shell">
      <HistorySidebar
        conversations={history.visibleConversations}
        activeId={history.activeId}
        onNew={() => {
          if (chatSpace === "team") requestTeamWorkspace(null);
          else history.newChat();
          setView("chat");
          closeSidebarOnMobile();
        }}
        onSelect={(id) => {
          history.selectChat(id);
          setView("chat");
          closeSidebarOnMobile();
        }}
        onDelete={history.deleteChat}
        view={view}
        onView={(v) => {
          setView(v);
          closeSidebarOnMobile();
        }}
        open={sidebarOpen}
        wallet={wallet}
        walletLoading={walletLoading}
        walletError={walletError}
        walletConnectionState={walletConnectionState}
        switchingWalletChain={switchingWalletChain}
        onSwitchWalletChain={switchWalletChain}
        chatSpace={chatSpace}
        onChatSpace={setChatSpace}
        teamModeEnabled={studio.teamModeEnabled}
        teamWorkspaces={teamNav.items}
        activeTeamWorkspaceId={teamNav.activeId}
        teamLoading={teamNav.loading}
        onTeamWorkspace={(id) => {
          requestTeamWorkspace(id);
          setView("chat");
          closeSidebarOnMobile();
        }}
      />

      {sidebarOpen && <div className="try-sidebar-scrim" onClick={() => setSidebarOpen(false)} />}

      <div className="try-chat">
        <div className="try-chat-bar">
          <button
            className="try-sidebar-toggle"
            onClick={() => setSidebarOpen((o) => !o)}
            aria-label="Toggle history"
          >
            <PanelLeft className="h-[18px] w-[18px]" />
          </button>

          {view === "chat" && (activeConvo || chatSpace === "team") && (
            <div className="try-bar-title">
              <div className="try-bar-title-line">
              {chatSpace === "team" ? (
                <span className="try-bar-title-static">Team workspaces</span>
              ) : activeConvo && editingTitle ? (
                <input
                  className="try-bar-title-input"
                  value={titleDraft}
                  autoFocus
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onBlur={commitTitle}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commitTitle();
                    } else if (e.key === "Escape") {
                      setEditingTitle(false);
                    }
                  }}
                />
              ) : activeConvo ? (
                <button
                  className="try-bar-title-btn"
                  onClick={() => {
                    setTitleDraft(activeConvo.title);
                    setEditingTitle(true);
                  }}
                  title={t.rename}
                >
                  {activeConvo.title}
                </button>
              ) : (
                <span className="try-bar-title-static">BlockRun Team</span>
              )}
              {chatSpace === "team" && teamNav.activeId && (
                <span className="try-team-mode-pill is-local"><Laptop2 className="h-3.5 w-3.5" /> Local runtime</span>
              )}
              </div>
            </div>
          )}

          {view === "chat" && messages.length > 0 && (
            <div className="try-bar-menu-wrap">
              <button
                className={`try-bar-more${menuOpen ? " is-open" : ""}`}
                onClick={() => setMenuOpen((o) => !o)}
                aria-label="More"
                title="More"
              >
                <MoreHorizontal className="h-[18px] w-[18px]" />
              </button>
              {menuOpen && (
                <TopBarMenu
                  onClose={() => setMenuOpen(false)}
                  onShare={() => {
                    setMenuOpen(false);
                    setShareOpen(true);
                  }}
                />
              )}
            </div>
          )}
        </div>

        {chatSpace === "team" && view === "chat" ? (
          <CloudWorkspacePanel />
        ) : view === "agents" ? (
          <AgentsPanel
            agents={studio.agents}
            installedCount={studio.installedCount}
            connectedCount={studio.connectedCount}
            teamModeEnabled={studio.teamModeEnabled}
            scanning={studio.scanning}
            onScan={studio.scanRuntimes}
            onImport={studio.importAgent}
            onRemove={studio.removeAgent}
            onRunning={studio.setRunning}
            onBlockRun={studio.setBlockRun}
            onTeamMode={(enabled) => {
              studio.setTeamModeEnabled(enabled);
              if (!enabled && chatSpace === "team") setChatSpace("personal");
            }}
          />
        ) : view === "phone" ? (
          <PhonePanel />
        ) : view === "tools" ? (
          <ToolsPanel onTry={tryMarketplace} />
        ) : view === "cli" ? (
          <CLIPanel />
        ) : view === "skills" ? (
          <SkillsPanel onPick={pickSkill} />
        ) : view === "mcp" ? (
          <McpPanel />
        ) : view === "gallery" ? (
          <GalleryPanel conversations={history.visibleConversations} onZoom={setLightbox} onDelete={history.deleteMedia} />
        ) : view === "wallet" ? (
          <WalletPanel usage={usage} />
        ) : (
        <>
        <div className="try-messages" ref={scrollRef}>
          {messages.length === 0 ? (
            <div className="try-empty">
              {chatSpace === "team" && mode === "chat" ? (
                <div className="try-team-empty">
                  <div className="try-team-empty-icon"><Users className="h-6 w-6" /></div>
                  <div className="try-team-avatars" aria-label="Team members">
                    <span className="is-andy">A</span>
                    <span className="is-vicky">V</span>
                    <span className="is-franklin">F</span>
                  </div>
                  <h2 className="try-empty-title">Talk with your <em>Team Agent</em></h2>
                  <p className="try-team-empty-copy">Preview a shared room for BlockRun. Franklin is presented as the team agent while this demo keeps its data on this device.</p>
                  <div className="try-team-capabilities">
                    <span>Shared conversation</span><span>Team knowledge</span><span>Reusable workflows</span>
                  </div>
                </div>
              ) : (
                <h2 className="try-empty-title">
                  <EmphTitle text={mode === "image" ? t.emptyImage : mode === "video" ? t.emptyVideo : mode === "music" ? t.emptyMusic : t.emptyChat} />
                </h2>
              )}
              <div className="try-suggestions">
                {mode === "chat"
                  ? CASES.map((c) => (
                      <button key={c.prompt} className="try-suggestion" onClick={() => runCase(c)}>
                        {c.prompt}
                      </button>
                    ))
                  : suggestions.map((s) => (
                      <button key={s} className="try-suggestion" onClick={() => send(s)} disabled={needsWallet}>
                        {s}
                      </button>
                    ))}
              </div>
            </div>
          ) : (
            messages.map((m, i) =>
              m.kind === "tools" ? (
                <ToolGroup key={i} steps={m.tools ?? []} busy={busy} />
              ) : (
              <div key={i} className={`try-msg try-msg-${m.role}${chatSpace === "team" ? " is-team" : ""}`}>
                {/* Show the role label only on the FIRST bubble of a turn — scan
                    back past tool groups; if an assistant text/media bubble
                    already showed it this turn, skip (one "Franklin" per turn). */}
                {(() => {
                  if (m.role === "user") return true;
                  for (let j = i - 1; j >= 0; j--) {
                    if (messages[j].role === "user") return true;
                    if (messages[j].role === "assistant" && messages[j].kind !== "tools") return false;
                  }
                  return true;
                })() && <div className="try-msg-role">{m.role === "user" ? (chatSpace === "team" ? "Andy · You" : "You") : (chatSpace === "team" ? "Franklin · Team Agent" : "Franklin")}</div>}
                {m.kind === "image" && m.image ? (
                  <div className="try-msg-media">
                    <img
                      src={m.image}
                      alt={m.content}
                      loading="lazy"
                      className="try-zoomable"
                      onClick={() => setLightbox(m.image!)}
                    />
                    {safeExternalHttpUrl(m.image) && <a className="try-media-link" href={safeExternalHttpUrl(m.image)!} target="_blank" rel="noopener noreferrer">
                      {t.openFull}
                    </a>}
                  </div>
                ) : m.kind === "video" && m.video ? (
                  <div className="try-msg-media">
                    <video src={m.video} controls playsInline preload="metadata" />
                    {safeExternalHttpUrl(m.video) && <a className="try-media-link" href={safeExternalHttpUrl(m.video)!} target="_blank" rel="noopener noreferrer">
                      {t.downloadMp4}
                    </a>}
                  </div>
                ) : m.kind === "music" && m.music ? (
                  <div className="try-msg-media try-msg-audio">
                    <audio src={m.music} controls preload="metadata" />
                    {safeExternalHttpUrl(m.music) && <a className="try-media-link" href={safeExternalHttpUrl(m.music)!} target="_blank" rel="noopener noreferrer">
                      {t.downloadAudio}
                    </a>}
                  </div>
                ) : (
                  <>
                    {m.image && (
                      <div className="try-msg-attach">
                        <img src={m.image} alt="attachment" loading="lazy" className="try-zoomable" onClick={() => setLightbox(m.image!)} />
                      </div>
                    )}
                    {m.activity && <ActivitySummary activity={m.activity} />}
                    {m.reasoning && (
                      <details className="try-reasoning">
                        <summary>{t.reasoning}</summary>
                        <div className="try-reasoning-body">{m.reasoning}</div>
                      </details>
                    )}
                    {m.content &&
                      (m.role === "assistant" ? (
                        <div className="try-msg-body">
                          <MessageContent content={m.content} />
                        </div>
                      ) : (
                        <div className="try-msg-body">{m.content}</div>
                      ))}
                  </>
                )}
                {/* Actions (👍/👎/copy) only on a turn's FINAL answer, after the
                    model has fully finished — not on intermediate narration
                    bubbles (those are followed by a tool group, i.e. the next
                    message isn't a user turn). */}
                {m.role === "assistant" &&
                  !busy &&
                  (i === messages.length - 1 || messages[i + 1]?.role === "user") && (
                    <MessageActions
                      content={m.content}
                      onRegenerate={i === messages.length - 1 ? regenerate : undefined}
                    />
                  )}
              </div>
            ))
          )}

          {activeMediaJob && (
            <div className="try-msg try-msg-assistant">
              <div className="try-msg-role">Franklin</div>
              <div className={`try-gen-skeleton${activeMediaJob.kind === "video" ? " is-video" : ""}${activeMediaJob.kind === "music" ? " is-music" : ""}`}>
                {activeMediaJob.kind === "video" ? (
                  <Clapperboard className="try-gen-skeleton-icon" />
                ) : activeMediaJob.kind === "music" ? (
                  <Music className="try-gen-skeleton-icon" />
                ) : (
                  <ImageIcon className="try-gen-skeleton-icon" />
                )}
                <span className="try-gen-skeleton-shimmer" aria-hidden />
              </div>
            </div>
          )}

          {/* Tool activity now renders inline (kind:"tools" messages above).
              This is just the live "thinking / signing" indicator for the tail
              of the turn (e.g. before the first token, or while the model
              reasons between tools). */}
          {genHere && status === "signing" && (
            <div className="try-status">
              <span className="try-coin" aria-hidden />
              <span className="try-status-text">{t.statusSigning}</span>
            </div>
          )}
          {genHere && (status === "thinking" || status === "generating") && (
            <div className="try-status">
              <span className="try-dots" aria-hidden><i /><i /><i /></span>
              <span className="try-status-text">
                {activeTool
                  ? t.toolRunning(activeTool)
                  : mode === "image"
                    ? t.statusImage
                    : mode === "video"
                      ? t.statusVideo
                      : t.statusWorking}
              </span>
            </div>
          )}
          {error && <div className="try-error">{error}</div>}
        </div>

        <div className="try-input-wrap">
          {chatSpace === "team" && (
            <div className="try-team-sharing-note"><Users className="h-3.5 w-3.5" /> Shared with BlockRun Team · demo data stays on this device</div>
          )}
          {needsToolWallet && (
            <div className="try-input-hint try-input-hint-action">
              <span>{t.hintToolWallet}</span>
              <button className="try-hint-connect" onClick={() => auth.connect()} disabled={auth.signingIn}>
                {auth.signingIn ? t.connecting : t.connectWallet}
              </button>
            </div>
          )}
          {needsWallet && (
            <div className="try-input-hint">
              {mode === "image"
                ? t.hintImage
                : mode === "video"
                  ? t.hintVideo
                  : t.hintChat(selectedModel?.label ?? "")}
            </div>
          )}

          <div className="try-composer">
            {attachment && (
              <div className="try-attach">
                <img src={attachment} alt="attachment" />
                <button className="try-attach-x" onClick={() => setAttachment(null)} aria-label="Remove attachment">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
            {attachError && <div className="try-attach-error">{attachError}</div>}
            <textarea
              className="try-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder={placeholder}
              rows={1}
              disabled={busy}
            />
            <div className="try-tools">
              <div className="try-tools-left">
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  className="try-file-input"
                  onChange={onPickFile}
                />
                <button
                  className="try-tool-icon"
                  onClick={() => fileRef.current?.click()}
                  disabled={busy}
                  aria-label={t.attachImage}
                  title={mode === "video" ? t.attachSeed : mode === "image" ? t.attachRef : t.attachImage}
                >
                  <Plus className="h-[18px] w-[18px]" />
                </button>
                <ModelSelect models={models} model={model} onChange={setModel} disabled={busy} />
                {mode === "chat" ? (
                  <>
                    <button className="try-tool" onClick={() => { setFocus(null); setMode("image"); }} disabled={busy}>
                      <ImageIcon className="h-4 w-4" /> {t.image}
                    </button>
                    <button className="try-tool" onClick={() => { setFocus(null); setMode("video"); }} disabled={busy}>
                      <Clapperboard className="h-4 w-4" /> {t.video}
                    </button>
                    <button className="try-tool" onClick={() => { setFocus(null); setMode("music"); }} disabled={busy}>
                      <Music className="h-4 w-4" /> {t.music}
                    </button>
                    {FOCUSES.map((f) => (
                      <button
                        key={f.key}
                        className={`try-tool try-focus${focus === f.key ? " is-active" : ""}`}
                        onClick={() => setFocus((cur) => (cur === f.key ? null : f.key))}
                        disabled={busy}
                        title={f.label}
                      >
                        {f.icon} {f.label}
                      </button>
                    ))}
                  </>
                ) : (
                  <>
                    <span className="try-mode-pill">
                      {mode === "image" ? <ImageIcon className="h-4 w-4" /> : mode === "video" ? <Clapperboard className="h-4 w-4" /> : <Music className="h-4 w-4" />}
                      {mode === "image" ? t.image : mode === "video" ? t.video : t.music}
                      <button
                        className="try-mode-pill-x"
                        onClick={() => setMode("chat")}
                        disabled={busy}
                        aria-label="Back to chat"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </span>
                    {ratioOptions.length > 1 && (
                      <div className="try-ratio">
                        <button
                          className={`try-tool try-ratio-btn${ratioOpen ? " is-active" : ""}`}
                          onClick={() => setRatioOpen((o) => !o)}
                          disabled={busy}
                          title={t.ratio}
                          aria-haspopup="listbox"
                          aria-expanded={ratioOpen}
                        >
                          <RatioGlyph ratio={currentRatio} className="try-ratio-glyph" />
                          {currentRatio}
                          <ChevronDown className="try-ratio-chev h-3.5 w-3.5" />
                        </button>
                        {ratioOpen && (
                          <>
                            <div className="try-ratio-scrim" onClick={() => setRatioOpen(false)} />
                            <div className="try-ratio-menu" role="listbox" aria-label={t.ratio}>
                              {ratioOptions.map((o) => (
                                <button
                                  key={o.value}
                                  role="option"
                                  aria-selected={o.value === ratioValue}
                                  className={`try-ratio-item${o.value === ratioValue ? " is-active" : ""}`}
                                  onClick={() => {
                                    setRatioValue(o.value);
                                    setRatioOpen(false);
                                  }}
                                >
                                  <RatioGlyph ratio={o.ratio} className="try-ratio-item-glyph" />
                                  {o.ratio}
                                  <Check className="try-ratio-item-check h-3.5 w-3.5" />
                                </button>
                              ))}
                            </div>
                          </>
                        )}
                      </div>
                    )}
                    {mode === "video" && videoResolutions.length > 1 && (
                      <div className="try-ratio">
                        <button
                          className={`try-tool try-ratio-btn${resOpen ? " is-active" : ""}`}
                          onClick={() => setResOpen((o) => !o)}
                          disabled={busy}
                          title={t.resolution}
                          aria-haspopup="listbox"
                          aria-expanded={resOpen}
                        >
                          <Gauge className="h-4 w-4" />
                          {videoResolution}
                          <ChevronDown className="try-ratio-chev h-3.5 w-3.5" />
                        </button>
                        {resOpen && (
                          <>
                            <div className="try-ratio-scrim" onClick={() => setResOpen(false)} />
                            <div className="try-ratio-menu" role="listbox" aria-label={t.resolution}>
                              {videoResolutions.map((r) => (
                                <button
                                  key={r}
                                  role="option"
                                  aria-selected={r === videoResolution}
                                  className={`try-ratio-item${r === videoResolution ? " is-active" : ""}`}
                                  onClick={() => {
                                    setVideoResolution(r);
                                    setResOpen(false);
                                  }}
                                >
                                  {r}
                                  <Check className="try-ratio-item-check h-3.5 w-3.5" />
                                </button>
                              ))}
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
              {busy ? (
                <button
                  className="try-send try-send-stop"
                  onClick={() => (activeMediaJob ? stopMedia(history.activeId!) : stop())}
                  aria-label="Stop"
                >
                  <span className="try-stop-sq" />
                </button>
              ) : (
                <button className="try-send" onClick={submit} disabled={!canSend} aria-label="Send">
                  <ArrowUp className="h-5 w-5" />
                </button>
              )}
            </div>
          </div>
        </div>
        </>
        )}
      </div>

      {lightbox && (
        <div className="try-lightbox" onClick={() => setLightbox(null)} role="dialog" aria-modal="true">
          <img src={lightbox} alt="" onClick={(e) => e.stopPropagation()} />
          <button className="try-lightbox-x" onClick={() => setLightbox(null)} aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
      )}

      {pendingPermission && (
        <div className="try-mkt-overlay" role="presentation">
          <div className="try-mkt-modal" role="dialog" aria-modal="true" aria-labelledby="franklin-permission-title">
            <div className="try-mkt-modal-head">
              <span className="try-mkt-modal-icon"><ShieldAlert /></span>
              <div>
                <div id="franklin-permission-title" className="try-mkt-modal-name">Franklin needs your approval</div>
                <div className="try-mkt-modal-by">Tool <strong>{pendingPermission.toolName}</strong></div>
              </div>
            </div>
            <p className="try-mkt-modal-detail">{pendingPermission.description}</p>
            <div className="try-mkt-modal-foot">
              <button className="cloud-secondary" onClick={() => respondToPermission("n")}>Deny</button>
              <button className="try-mkt-try" onClick={() => respondToPermission("y")}>Allow once</button>
            </div>
          </div>
        </div>
      )}

      {shareOpen && <ShareDialog messages={messages} onClose={() => setShareOpen(false)} />}
    </div>
  );
}
