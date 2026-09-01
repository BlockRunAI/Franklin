import { useRef, useState } from "react";
import { Server, Wrench, AlertTriangle, Sparkles, RefreshCw, Lock, LockOpen, Plus, Upload, Loader2 } from "lucide-react";
import { useMcp } from "../hooks/use-mcp";
import { useAgentSkills, type AgentSkill } from "../hooks/use-agent-skills";

const SOURCE_COLOR: Record<AgentSkill["source"], string> = {
  bundled: "#6b7280",
  user: "#2563eb",
  project: "#059669",
  learned: "#a855f7",
};

function Badge({ text, color }: { text: string; color: string }) {
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 600,
        padding: "1px 7px",
        borderRadius: 999,
        background: `${color}1a`,
        color,
        border: `1px solid ${color}55`,
        whiteSpace: "nowrap",
      }}
    >
      {text}
    </span>
  );
}

export function McpPanel() {
  const { servers, failures, loading: mcpLoading, refresh: refreshMcp } = useMcp();
  const { skills, loading: skillsLoading, refresh: refreshSkills, toggle, create, upload } = useAgentSkills();

  const [desc, setDesc] = useState("");
  const [creating, setCreating] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = () => {
    refreshMcp();
    refreshSkills();
  };

  const onCreate = async () => {
    const d = desc.trim().slice(0, 2_000);
    if (!d || creating) return;
    setCreating(true);
    setNotice(null);
    const r = await create(d);
    setCreating(false);
    if (r) { setDesc(""); setNotice(`Created /${r.name} · restart the session to invoke it`); }
    else setNotice("Couldn't generate the skill — try a clearer description.");
  };

  const onFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const selected = Array.from(files).slice(0, 10);
    if (files.length > selected.length) setNotice("Upload at most 10 skills at a time.");
    for (const f of selected) {
      if (f.size > 256 * 1024) {
        setNotice(`"${f.name}" is larger than the 256 KiB skill limit.`);
        continue;
      }
      const text = await f.text();
      const r = await upload(text);
      setNotice(r ? `Uploaded /${r.name}` : `"${f.name}" isn't a valid SKILL.md (needs name + description frontmatter)`);
    }
  };

  const totalTools = servers.reduce((s, x) => s + x.toolCount, 0);

  return (
    <div className="try-tools-panel">
      <div className="try-tools-inner">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h2 className="try-tools-h">MCP &amp; Skills</h2>
          <button
            className="try-tool-card"
            onClick={refresh}
            title="Refresh"
            style={{ padding: "6px 10px", display: "inline-flex", alignItems: "center", gap: 6, width: "auto" }}
          >
            <RefreshCw className={`h-3.5 w-3.5${mcpLoading || skillsLoading ? " spin" : ""}`} />
            <span style={{ fontSize: 12 }}>Refresh</span>
          </button>
        </div>
        <p className="try-tools-sub">
          What the local agent has connected and loaded — MCP servers (extra tools) and the skill
          registry the model can invoke.
        </p>

        {/* ── MCP servers ── */}
        <div className="try-wallet-section">
          <div className="try-tools-group-label">
            <Server className="h-3.5 w-3.5" style={{ display: "inline", marginRight: 6, verticalAlign: "-2px" }} />
            MCP servers · {servers.length} connected · {totalTools} tools
          </div>

          {servers.length === 0 && failures.length === 0 && (
            <p className="try-tool-card-desc" style={{ padding: "8px 2px" }}>
              {mcpLoading ? "Loading…" : "No MCP servers configured. Add them to ~/.blockrun/mcp.json."}
            </p>
          )}

          {servers.map((s) => (
            <div key={s.name} className="try-tool-card" style={{ display: "block", marginBottom: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span className="try-tool-card-name">{s.name}</span>
                <Badge text={s.transport} color="#0ea5e9" />
                <Badge text={`${s.toolCount} tools`} color="#6b7280" />
                {s.filtered > 0 && <Badge text={`${s.filtered} filtered`} color="#d97706" />}
                {s.hasOAuth &&
                  (s.oauthAuthorized ? (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 11, color: "#059669" }}>
                      <LockOpen className="h-3 w-3" /> OAuth
                    </span>
                  ) : (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 11, color: "#d97706" }}>
                      <Lock className="h-3 w-3" /> auth needed
                    </span>
                  ))}
              </div>
              {s.tools.length > 0 && (
                <p className="try-tool-card-desc" style={{ marginTop: 4 }}>
                  <Wrench className="h-3 w-3" style={{ display: "inline", marginRight: 4, verticalAlign: "-1px" }} />
                  {s.tools.map((t) => t.replace(/^mcp__[^_]+__/, "")).join(" · ")}
                </p>
              )}
            </div>
          ))}

          {failures.map((f) => (
            <div
              key={f.name}
              className="try-tool-card"
              style={{ display: "block", marginBottom: 8, borderColor: "#ef444455" }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <AlertTriangle className="h-3.5 w-3.5" style={{ color: "#ef4444" }} />
                <span className="try-tool-card-name">{f.name}</span>
                <Badge text={f.transportKind} color="#ef4444" />
              </div>
              <p className="try-tool-card-desc" style={{ marginTop: 4, color: "#ef4444" }}>{f.reason}</p>
              {f.stderrTail && f.stderrTail.length > 0 && (
                <pre
                  style={{
                    marginTop: 6,
                    fontSize: 11,
                    whiteSpace: "pre-wrap",
                    opacity: 0.7,
                    maxHeight: 120,
                    overflow: "auto",
                  }}
                >
                  {f.stderrTail.join("\n")}
                </pre>
              )}
            </div>
          ))}
        </div>

        {/* ── Agent skills ── */}
        <div
          className="try-wallet-section"
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); void onFiles(e.dataTransfer.files); }}
          style={dragOver ? { outline: "2px dashed #2563eb", outlineOffset: 4, borderRadius: 8 } : undefined}
        >
          <div className="try-tools-group-label">
            <Sparkles className="h-3.5 w-3.5" style={{ display: "inline", marginRight: 6, verticalAlign: "-2px" }} />
            Agent skills · {skills.length}
          </div>

          {/* Create a skill from a description (model-generated SKILL.md). */}
          <div style={{ display: "flex", gap: 6, margin: "4px 0 8px" }}>
            <input
              className="try-tool-card"
              placeholder="Describe a skill to create — e.g. “review a PR for security issues”"
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void onCreate(); }}
              style={{ flex: 1, padding: "8px 10px", fontSize: 13 }}
            />
            <button
              className="try-tool-card"
              onClick={onCreate}
              disabled={creating || !desc.trim()}
              title="Generate skill"
              style={{ padding: "0 12px", display: "inline-flex", alignItems: "center", gap: 6, width: "auto", opacity: creating || !desc.trim() ? 0.5 : 1 }}
            >
              {creating ? <Loader2 className="h-3.5 w-3.5 spin" /> : <Plus className="h-3.5 w-3.5" />}
              <span style={{ fontSize: 12 }}>{creating ? "Generating…" : "Create"}</span>
            </button>
            <button
              className="try-tool-card"
              onClick={() => fileRef.current?.click()}
              title="Upload a SKILL.md"
              style={{ padding: "0 12px", display: "inline-flex", alignItems: "center", gap: 6, width: "auto" }}
            >
              <Upload className="h-3.5 w-3.5" />
              <span style={{ fontSize: 12 }}>Upload</span>
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".md,.markdown,text/markdown"
              multiple
              style={{ display: "none" }}
              onChange={(e) => { void onFiles(e.target.files); e.target.value = ""; }}
            />
          </div>
          {notice && <p className="try-tool-card-desc" style={{ margin: "0 0 8px", color: "#2563eb" }}>{notice}</p>}
          <p className="try-tool-card-desc" style={{ margin: "0 0 8px", opacity: 0.6 }}>
            Drag a SKILL.md here to add it. Toggle a skill off to hide it from the model.
          </p>

          {skills.length === 0 && (
            <p className="try-tool-card-desc" style={{ padding: "8px 2px" }}>
              {skillsLoading ? "Loading…" : "No skills loaded."}
            </p>
          )}
          {skills.map((s) => (
            <div
              key={`${s.source}/${s.name}`}
              className="try-tool-card"
              style={{ display: "block", marginBottom: 6, opacity: s.enabled ? 1 : 0.5 }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span className="try-tool-card-name">/{s.name}</span>
                <Badge text={s.source} color={SOURCE_COLOR[s.source]} />
                {!s.modelInvocable && <Badge text="manual only" color="#6b7280" />}
                <button
                  onClick={() => void toggle(s.name, !s.enabled)}
                  title={s.enabled ? "Disable" : "Enable"}
                  style={{
                    marginLeft: "auto",
                    fontSize: 11,
                    fontWeight: 600,
                    padding: "2px 9px",
                    borderRadius: 999,
                    cursor: "pointer",
                    border: `1px solid ${s.enabled ? "#05966955" : "#9ca3af55"}`,
                    background: s.enabled ? "#0596691a" : "transparent",
                    color: s.enabled ? "#059669" : "#9ca3af",
                  }}
                >
                  {s.enabled ? "On" : "Off"}
                </button>
              </div>
              <p className="try-tool-card-desc" style={{ marginTop: 2 }}>{s.description}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
