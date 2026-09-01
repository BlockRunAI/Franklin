import { useEffect, useRef, useState } from "react";
import { Check, Cloud, FileText, FolderOpen, Laptop2, Loader2, MessageSquare, Plus, RefreshCw, Send, ShieldCheck, Users, X } from "lucide-react";
import { useCloudWorkspace } from "../hooks/use-cloud-workspace";
import { MessageContent } from "./MessageContent";
import { publishTeamWorkspaceNav, subscribeTeamWorkspaceRequest } from "../lib/team-workspace-events";
import { CloudWorkspaceDrawer } from "./CloudWorkspaceDrawer";

const friendlyCloudError = (message: string) => message.toLowerCase().includes("fetch failed")
  ? "Team Cloud is temporarily unavailable. Your shared data is safe—try again in a moment."
  : message;

function CloudRetryError({ message, className = "", onRetry }: { message: string; className?: string; onRetry: () => void }) {
  return <div className={`cloud-error cloud-retry-error ${className}`.trim()}><span>{friendlyCloudError(message)}</span><button onClick={onRetry}><RefreshCw /> Retry</button></div>;
}

export function CloudWorkspacePanel() {
  const cloud = useCloudWorkspace();
  const [workspaceName, setWorkspaceName] = useState("BlockRun Cloud Workspace");
  const [inviteInput, setInviteInput] = useState("");
  const [message, setMessage] = useState("");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState("");
  const [fileSavedContent, setFileSavedContent] = useState("");
  const [fileDraft, setFileDraft] = useState("");
  const [savingFile, setSavingFile] = useState(false);
  const [workspaceView, setWorkspaceView] = useState<"chat" | "files">("chat");
  const [fileStatus, setFileStatus] = useState<"idle" | "loading" | "saved">("idle");
  const [membersOpen, setMembersOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }, [cloud.messages, cloud.sending]);
  useEffect(() => publishTeamWorkspaceNav({
    items: cloud.workspaces.map((workspace) => ({ id: workspace.id, name: workspace.name, role: workspace.role, memberCount: workspace.members.length, version: workspace.version })),
    activeId: cloud.activeId,
    loading: cloud.loading && !cloud.session,
  }), [cloud.activeId, cloud.loading, cloud.session, cloud.workspaces]);
  useEffect(() => subscribeTeamWorkspaceRequest(cloud.setActiveId), [cloud.setActiveId]);

  const openFile = async (path: string) => {
    setSelectedFile(path);
    setWorkspaceView("files");
    setFileStatus("loading");
    try {
      const content = (await cloud.readFile(path)).content;
      setFileContent(content);
      setFileSavedContent(content);
      setFileStatus("idle");
    }
    catch (error) {
      setFileContent(error instanceof Error ? error.message : String(error));
      setFileStatus("idle");
    }
  };

  const createFile = async () => {
    const path = fileDraft.trim();
    if (!path) return;
    const content = `# ${path}\n\nCreated by ${cloud.session?.name}.\n`;
    setSavingFile(true);
    try {
      await cloud.saveFile(path, content);
      setFileDraft("");
      await openFile(path);
      setFileStatus("saved");
    } finally { setSavingFile(false); }
  };

  if (!cloud.session) {
    return (
      <div className="cloud-onboard">
        <div className="cloud-onboard-card">
          <span className="cloud-logo"><Cloud /></span>
          <div className="cloud-kicker">FRANKLIN CLOUD · TEAM WORKSPACE</div>
          <h2>{cloud.connected ? "Connect your Franklin wallet" : "Start Franklin to continue"}</h2>
          <p>Your local Franklin signs in to franklin.run with SIWE. The wallet key never leaves this computer; Team data is stored in the existing Franklin Cloud.</p>
          <button className="cloud-primary" disabled={!cloud.connected || cloud.loading} onClick={() => void cloud.connect()}>
            {cloud.loading ? <Loader2 className="spin" /> : <ShieldCheck />} {cloud.connected ? "Connect Franklin Cloud" : "Franklin is offline"}
          </button>
          {cloud.error && <div className="cloud-error">{friendlyCloudError(cloud.error)}</div>}
        </div>
      </div>
    );
  }

  if (!cloud.active) {
    return (
      <div className="cloud-onboard">
        <div className="cloud-onboard-card is-wide">
          <div className="cloud-account"><span>{cloud.session.name.slice(2, 3).toUpperCase()}</span><div><strong>{cloud.session.name}</strong><small>Wallet-authenticated Franklin Cloud</small></div></div>
          <div className="cloud-kicker">CREATE OR JOIN</div>
          <h2>Start a shared Cloud Workspace</h2>
          <div className="cloud-create-grid">
            <section><h3>Create workspace</h3><input value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} /><button className="cloud-primary" onClick={() => cloud.createWorkspace(workspaceName)} disabled={cloud.loading || !workspaceName.trim()}><Plus /> Create</button></section>
            <section><h3>Join with invite</h3><input placeholder="FW-XXXXXXXX" value={inviteInput} onChange={(event) => setInviteInput(event.target.value.toUpperCase())} /><button className="cloud-secondary" onClick={() => cloud.joinWorkspace(inviteInput)} disabled={cloud.loading || !inviteInput.trim()}><Users /> Join</button></section>
          </div>
          {cloud.workspaces.length > 0 && <div className="cloud-existing"><h3>Your workspaces</h3>{cloud.workspaces.map((workspace) => <button key={workspace.id} onClick={() => cloud.setActiveId(workspace.id)}><Cloud />{workspace.name}<small>{workspace.role}</small></button>)}</div>}
          {cloud.error && <div className="cloud-error">{friendlyCloudError(cloud.error)}</div>}
        </div>
      </div>
    );
  }

  const submit = () => {
    const content = message.trim();
    if (!content || cloud.sending) return;
    setMessage("");
    void cloud.sendMessage(content);
  };

  const selectedFileMeta = cloud.files.find((file) => file.path === selectedFile);
  const fileIsDirty = selectedFile !== null && fileContent !== fileSavedContent;
  const enterFiles = () => {
    if (!selectedFile && cloud.files[0]) void openFile(cloud.files[0].path);
    else setWorkspaceView("files");
  };

  return (
    <div className="cloud-workspace">
      <header className="cloud-head">
        <div className="cloud-head-identity"><span className="cloud-logo small"><Cloud /></span><div><strong>{cloud.active.name}</strong><small>Franklin Cloud · workspace v{cloud.active.version}</small></div></div>
        <nav className="cloud-view-tabs" aria-label="Workspace view">
          <button className={workspaceView === "chat" ? "is-active" : ""} onClick={() => setWorkspaceView("chat")}><MessageSquare /><span>Chat</span><em>{cloud.messages.length}</em></button>
          <button className={workspaceView === "files" ? "is-active" : ""} onClick={enterFiles}><FolderOpen /><span>Files</span><em>{cloud.files.length}</em></button>
        </nav>
        <div className="cloud-head-actions">
          <span className="cloud-runtime-chip" title="This turn runs on the initiating member's local Franklin"><Laptop2 /><span>Runs on this Mac</span></span>
          <button className="cloud-members-button" onClick={() => setMembersOpen(true)}><Users /><span>Members</span><em>{cloud.active.members.length}</em></button>
          <button className="cloud-icon-btn" onClick={() => void cloud.refreshActive()} title="Refresh"><RefreshCw /></button>
        </div>
      </header>

      <div className="cloud-columns">
        {workspaceView === "chat" ? (
          <main className="cloud-chat-column">
            <div className="cloud-messages" ref={scrollRef}>
              {cloud.messages.length === 0 ? <div className="cloud-empty"><Cloud /><h2>Talk with your Team Franklin</h2><p>Shared files and recent team messages are added to the initiating member&apos;s Franklin context.</p><div className="cloud-empty-actions"><button onClick={() => setMessage("Review the shared workspace and give the team a concise project status.")}>Create a workspace status update</button><button onClick={enterFiles}><FolderOpen /> Open shared files</button></div></div> : cloud.messages.map((item) => <article key={item.id} className={`cloud-message is-${item.role}`}><div className="cloud-message-meta"><strong>{item.authorName}</strong><span>{new Date(item.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span></div><MessageContent content={item.content} /></article>)}
              {cloud.sending && <div className="cloud-running"><Loader2 className="spin" /><div><strong>Team Franklin is working</strong><small>Reading shared context from workspace v{cloud.active.version}…</small></div></div>}
            </div>
            <div className="cloud-composer"><textarea value={message} disabled={cloud.active.role === "viewer"} onChange={(event) => setMessage(event.target.value)} placeholder={cloud.active.role === "viewer" ? "View-only members cannot send messages" : "Message Team Franklin…"} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); } }} /><button onClick={submit} disabled={cloud.active.role === "viewer" || !message.trim() || cloud.sending}><Send /></button><small>{cloud.active.role === "viewer" ? "Ask an owner to grant Member access" : "Runs on your local Franklin · response syncs to Franklin Cloud for the team"}</small></div>
            {cloud.error && <CloudRetryError message={cloud.error} className="inline" onRetry={() => void cloud.refreshActive()} />}
          </main>
        ) : (
          <main className="cloud-files-workspace">
            <header className="cloud-files-head">
              <div><span className="cloud-files-icon"><FolderOpen /></span><div><strong>Shared workspace</strong><small>Files are available to every member and included in Team Franklin context.</small></div></div>
              <span className="cloud-sync-status"><i /> Synced · v{cloud.active.version}</span>
            </header>
            <div className="cloud-files-layout">
              <aside className="cloud-file-browser">
                <div className="cloud-file-browser-title"><span>FILES</span><em>{cloud.files.length}</em></div>
                <div className="cloud-files">
                  {cloud.files.length === 0 && <div className="cloud-no-files"><FileText /><span>No shared files yet</span></div>}
                  {cloud.files.map((file) => <button className={selectedFile === file.path ? "is-active" : ""} key={file.path} onClick={() => void openFile(file.path)}><FileText /><span><strong>{file.path}</strong><small>v{file.version} · {file.bytes} B</small></span></button>)}
                </div>
                {cloud.active.role !== "viewer" && <div className="cloud-new-file"><input aria-label="New file path" placeholder="notes.md" value={fileDraft} onChange={(event) => setFileDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void createFile(); }} /><button aria-label="Create shared file" disabled={!fileDraft.trim() || savingFile} onClick={() => void createFile()}>{savingFile ? <Loader2 className="spin" /> : <Plus />}</button></div>}
                <small className="cloud-file-help">Markdown, text, JSON and project notes are shared with the workspace.</small>
              </aside>
              <section className="cloud-file-editor">
                {selectedFile ? <>
                  <header className="cloud-file-editor-head">
                    <div><span className="cloud-file-breadcrumb">Shared files /</span><strong>{selectedFile}</strong><small>{selectedFileMeta ? `Version ${selectedFileMeta.version} · ${selectedFileMeta.bytes} bytes` : "Shared file"}</small></div>
                    <div className="cloud-file-editor-actions">
                      {fileIsDirty && <span className="cloud-file-dirty">Unsaved changes</span>}
                      {fileStatus === "saved" && <span className="cloud-file-saved"><Check /> Saved to team</span>}
                      <button className="cloud-icon-btn" title="Close file" onClick={() => setSelectedFile(null)}><X /></button>
                    </div>
                  </header>
                  <textarea aria-label={`Edit ${selectedFile}`} value={fileContent} readOnly={cloud.active.role === "viewer" || fileStatus === "loading"} onChange={(event) => { setFileContent(event.target.value); setFileStatus("idle"); }} />
                  <footer className="cloud-file-editor-foot">
                    <span>{cloud.active.role === "viewer" ? "View only" : "Changes are shared with every workspace member."}</span>
                    {cloud.active.role !== "viewer" && <button className="cloud-save-file" disabled={savingFile || fileStatus === "loading" || !fileIsDirty} onClick={async () => { setSavingFile(true); try { await cloud.saveFile(selectedFile, fileContent); setFileSavedContent(fileContent); setFileStatus("saved"); } finally { setSavingFile(false); } }}>{savingFile ? <Loader2 className="spin" /> : <Check />} {fileIsDirty ? "Save to workspace" : "No changes"}</button>}
                  </footer>
                </> : <div className="cloud-file-empty"><span><FolderOpen /></span><h2>Select a shared file</h2><p>Open a file from the workspace directory, or create a new one. Team Franklin can read these files during every shared conversation.</p>{cloud.files[0] && <button onClick={() => void openFile(cloud.files[0].path)}><FileText /> Open {cloud.files[0].path}</button>}</div>}
              </section>
            </div>
            {cloud.error && <CloudRetryError message={cloud.error} className="cloud-files-error" onRetry={() => void cloud.refreshActive()} />}
          </main>
        )}
      </div>

      <CloudWorkspaceDrawer open={membersOpen} workspaceName={cloud.active.name} workspaceRole={cloud.active.role} members={cloud.active.members} sessionId={cloud.session?.id} onClose={() => setMembersOpen(false)} onUpdateMemberRole={cloud.updateMemberRole} onCreateInvite={cloud.createInvite} />
    </div>
  );
}
