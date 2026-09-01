import {
  Blocks, Bot, Box, ChevronRight, CircleStop, Download, Network,
  Play, Power, RotateCcw, Settings2, ShieldCheck, Terminal, Trash2, Users,
} from "lucide-react";
import type { AgentId, StudioAgent } from "../hooks/use-studio-registry";

interface Props {
  agents: StudioAgent[];
  installedCount: number;
  connectedCount: number;
  teamModeEnabled: boolean;
  scanning: boolean;
  onScan: () => void | Promise<void>;
  onImport: (id: AgentId) => void | Promise<void>;
  onRemove: (id: AgentId) => void | Promise<void>;
  onRunning: (id: AgentId, running: boolean) => void | Promise<void>;
  onBlockRun: (id: AgentId, enabled: boolean) => void;
  onTeamMode: (enabled: boolean) => void;
}

function Toggle({ checked, onChange, label, disabled = false }: { checked: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`studio-toggle${checked ? " is-on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

function AgentMark({ id }: { id: AgentId }) {
  const labels: Record<AgentId, string> = { franklin: "F", codex: "C", claude: "A", hermes: "H", deepseek: "D" };
  return <span className={`studio-agent-mark is-${id}`}>{labels[id]}</span>;
}

export function AgentsPanel({
  agents, installedCount, connectedCount, teamModeEnabled, onImport, onRemove,
  onRunning, onBlockRun, onTeamMode, scanning, onScan,
}: Props) {
  return (
    <div className="studio-panel">
      <div className="studio-inner">
        <div className="studio-hero">
          <div>
            <div className="studio-eyebrow"><Blocks className="h-3.5 w-3.5" /> Agent studio</div>
            <h2>Franklin</h2>
            <p>Bring your own agent. Keep one workspace, one capability layer and one wallet.</p>
          </div>
          <button
            className="studio-primary-btn"
            onClick={() => void onScan()}
          >
            <RotateCcw className={`h-4 w-4${scanning ? " spin" : ""}`} /> {scanning ? "Scanning…" : "Scan local CLIs"}
          </button>
        </div>

        <div className="studio-stats" aria-label="Studio status">
          <div><strong>{installedCount}</strong><span>Agent runtimes</span></div>
          <div><strong>{connectedCount}</strong><span>Using BlockRun</span></div>
          <div><strong>1</strong><span>Shared workspace</span></div>
          <div><strong>Local</strong><span>Wallet broker</span></div>
        </div>

        <section className="studio-section" id="studio-agent-catalogue">
          <div className="studio-section-heading">
            <div>
              <h3>Agent runtimes</h3>
              <p>Each CLI is an adapter. Install, stop or remove it without changing Franklin.</p>
            </div>
            <span className="studio-section-count">{installedCount} installed</span>
          </div>

          <div className="studio-agent-grid">
            {agents.map((agent) => (
              <article key={agent.id} className={`studio-agent-card${agent.installed ? " is-installed" : ""}`}>
                <div className="studio-agent-head">
                  <AgentMark id={agent.id} />
                  <div className="studio-agent-title">
                    <div>
                      <strong>{agent.name}</strong>
                      {agent.builtIn && <span className="studio-badge is-gold">Built in</span>}
                      {agent.experimental && <span className="studio-badge">Experimental</span>}
                    </div>
                    <code>{agent.command}</code>
                  </div>
                  <span className={`studio-status${agent.running ? " is-running" : ""}`}>
                    <i />{agent.running ? "Running" : agent.installed ? "Stopped" : scanning ? "Checking" : agent.available ? "Detected" : agent.available === false ? "Not found" : "Available"}
                  </span>
                </div>

                <p className="studio-agent-description">{agent.description}</p>
                <div className="studio-protocol"><Network className="h-3.5 w-3.5" /> {agent.protocol}</div>
                {(agent.version || agent.endpoint) && <div className="studio-runtime-detail"><span>{agent.version}</span>{agent.endpoint && <code>{agent.endpoint}</code>}</div>}
                {agent.error && <div className="studio-runtime-error">{agent.error}</div>}

                {agent.installed ? (
                  <>
                    <div className="studio-capability-row">
                      <span className="studio-capability-icon"><ShieldCheck className="h-4 w-4" /></span>
                      <span><strong>BlockRun</strong><small>Router · Models · MCP · Wallet</small></span>
                      {agent.id === "franklin"
                        ? <Toggle checked={agent.blockrunEnabled} onChange={(enabled) => onBlockRun(agent.id, enabled)} label={`BlockRun for ${agent.name}`} disabled />
                        : <span className="studio-badge">Adapter pending</span>}
                    </div>
                    {!agent.builtIn && <div className="studio-card-actions">
                      <button onClick={() => onRunning(agent.id, !agent.running)}>
                        {agent.running ? <CircleStop className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                        {agent.running ? "Stop" : "Start"}
                      </button>
                      <button disabled><Settings2 className="h-3.5 w-3.5" /> Configure</button>
                      {!agent.builtIn && <button className="is-danger" onClick={() => onRemove(agent.id)}><Trash2 className="h-3.5 w-3.5" /> Remove</button>}
                    </div>}
                  </>
                ) : (
                  <button className="studio-install-btn" disabled={agent.available === false || agent.lifecycleSupported === false} onClick={() => void onImport(agent.id)}>
                    <Download className="h-4 w-4" /> {agent.available === false ? "CLI not found" : agent.lifecycleSupported === false ? "Adapter pending" : "Import runtime"} <ChevronRight className="h-4 w-4" />
                  </button>
                )}
              </article>
            ))}
          </div>
        </section>

        <section className="studio-section">
          <div className="studio-section-heading">
            <div>
              <h3>Studio modules</h3>
              <p>Product modes are modules too. Turn them on only when this workspace needs them.</p>
            </div>
          </div>
          <div className="studio-module-list">
            <div className="studio-module-row">
              <span className="studio-module-icon"><Users className="h-5 w-5" /></span>
              <span className="studio-module-copy"><strong>Team Mode</strong><small>Shared conversations, files, knowledge and reusable workflows.</small></span>
              <span className="studio-badge is-gold">Workspace module</span>
              <Toggle checked={teamModeEnabled} onChange={onTeamMode} label="Team Mode" />
            </div>
            <div className="studio-module-row">
              <span className="studio-module-icon"><Network className="h-5 w-5" /></span>
              <span className="studio-module-copy"><strong>BlockRun Capability Broker</strong><small>One local router and wallet policy shared safely by every imported agent.</small></span>
              <span className="studio-badge">Planned</span>
              <button className="studio-row-action" disabled><RotateCcw className="h-3.5 w-3.5" /> Restart</button>
            </div>
            <div className="studio-module-row">
              <span className="studio-module-icon"><Terminal className="h-5 w-5" /></span>
              <span className="studio-module-copy"><strong>Terminal fallback</strong><small>PTY compatibility for CLIs that do not expose a structured protocol.</small></span>
              <span className="studio-badge">Planned</span>
              <button className="studio-row-action" disabled><Power className="h-3.5 w-3.5" /> Enable</button>
            </div>
          </div>
        </section>

        <div className="studio-demo-note">
          <Box className="h-4 w-4" />
          <span><strong>Live runtime registry.</strong> Franklin now detects installed CLIs and manages the Codex app-server lifecycle. Router injection for imported agents remains a separate adapter layer.</span>
          <Bot className="h-4 w-4" />
        </div>
      </div>
    </div>
  );
}
