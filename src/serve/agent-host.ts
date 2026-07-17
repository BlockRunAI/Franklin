/**
 * AgentHost — multiplexes many interactiveSession loops in one serve
 * process: dispatch new agents, reply to running ones, stream their
 * events to subscribers, and answer their permission/approval requests
 * remotely (the parked-Promise broker pattern).
 *
 * Unlike the legacy single-window desktop path (which runs in trust
 * mode), hosted agents default to permissionMode 'default' — permission
 * prompts and trade-plan approvals surface as ApprovalRequests a
 * dashboard client answers over the wire.
 *
 * Known v1 constraint: a few session-scoped subsystems keep module-level
 * state (monitor registry, scheduler/goal current-session slots, tool
 * dedup caches reset at session start). Concurrent hosted agents share a
 * process, so those degrade last-writer-wins across agents — dedup may
 * miss, monitors/goals are effectively single-agent features here. The
 * money paths (trade-plan gate, spend caps) take explicit session ids
 * and stay correct under concurrency.
 */

import { EventEmitter } from 'node:events';
import { assembleInstructions } from '../agent/context.js';
import { interactiveSession } from '../agent/loop.js';
import { allCapabilities, createSubAgentCapability } from '../tools/index.js';
import { ApprovalBroker, type ApprovalRequest } from '../agent/approvals.js';
import { bus, } from '../events/bus.js';
import { makeEvent, type AgentRunState } from '../events/types.js';
import { writeLiveAgent } from '../session/live-registry.js';
import type { AgentConfig, StreamEvent } from '../agent/types.js';

const RING_BUFFER_SIZE = 200;

export interface DispatchOptions {
  prompt: string;
  model?: string;
  label?: string;
  maxSpendUsd?: number;
  /** Default 'default' — permission prompts flow to the dashboard. */
  permissionMode?: AgentConfig['permissionMode'];
}

export interface AgentSummary {
  sessionId: string;
  label: string;
  model: string;
  state: AgentRunState;
  startedAt: number;
  lastEventAt: number;
  pendingApprovals: ApprovalRequest[];
}

interface HostedAgent {
  sessionId: string;
  label: string;
  model: string;
  state: AgentRunState;
  startedAt: number;
  lastEventAt: number;
  broker: ApprovalBroker;
  recent: StreamEvent[];
  emitter: EventEmitter; // 'event' → (StreamEvent)
  pushInput: (text: string) => void;
  endInput: () => void;
  abort?: () => void;
}

export class AgentHost {
  private agents = new Map<string, HostedAgent>();

  constructor(
    private opts: {
      workDir: string;
      chain: 'base' | 'solana';
      apiUrl: string;
      defaultModel: string;
      debug?: boolean;
    }
  ) {}

  private setState(agent: HostedAgent, state: AgentRunState): void {
    if (agent.state === state) return;
    agent.state = state;
    agent.lastEventAt = Date.now();
    writeLiveAgent({
      sessionId: agent.sessionId,
      pid: process.pid,
      state,
      label: agent.label,
      model: agent.model,
      host: 'serve',
      startedAt: agent.startedAt,
      updatedAt: Date.now(),
      pendingApprovals: agent.broker.pending().length,
    });
    void bus.emit(
      makeEvent({
        type: 'agent.state',
        source: 'core',
        data: { sessionId: agent.sessionId, state, label: agent.label, model: agent.model },
      })
    );
  }

  /** Start a new hosted agent; resolves with its sessionId once known. */
  async dispatch(options: DispatchOptions): Promise<string> {
    const prompt = options.prompt.trim();
    if (!prompt) throw new Error('prompt must not be empty');
    const model = options.model || this.opts.defaultModel;
    const label = options.label?.trim() || prompt.replace(/\s+/g, ' ').slice(0, 60);

    // Per-agent input queue (same contract the loop's own multiplexer wraps).
    const queue: string[] = [];
    let resolver: ((v: string | null) => void) | null = null;
    let ended = false;
    const getUserInput = (): Promise<string | null> =>
      new Promise(resolve => {
        if (queue.length > 0) return resolve(queue.shift()!);
        if (ended) return resolve(null);
        resolver = resolve;
      });
    const deliver = (v: string | null) => {
      if (resolver) {
        const r = resolver;
        resolver = null;
        r(v);
      } else if (v !== null) {
        queue.push(v);
      } else {
        ended = true;
      }
    };

    const agent: HostedAgent = {
      sessionId: '',
      label,
      model,
      state: 'working',
      startedAt: Date.now(),
      lastEventAt: Date.now(),
      broker: new ApprovalBroker(),
      recent: [],
      emitter: new EventEmitter(),
      pushInput: (text) => deliver(text),
      endInput: () => deliver(null),
    };
    agent.emitter.setMaxListeners(50);

    // Approvals park the agent in needs-input until a client responds.
    agent.broker.onRequest(req => {
      this.setState(agent, 'needs-input');
      void bus.emit(
        makeEvent({
          type: 'approval.requested',
          source: 'core',
          data: {
            sessionId: agent.sessionId,
            requestId: req.requestId,
            kind: req.kind,
            title: req.title,
            options: req.options,
          },
        })
      );
    });

    let sessionIdResolve!: (id: string) => void;
    const sessionIdReady = new Promise<string>(resolve => {
      sessionIdResolve = resolve;
    });

    const onEvent = (event: StreamEvent): void => {
      agent.lastEventAt = Date.now();
      agent.recent.push(event);
      if (agent.recent.length > RING_BUFFER_SIZE) agent.recent.shift();
      agent.emitter.emit('event', event);
      if (event.kind === 'turn_done') {
        this.setState(agent, event.reason === 'completed' ? 'idle' : agent.state);
        void bus.emit(
          makeEvent({
            type: 'agent.turn',
            source: 'core',
            data: { sessionId: agent.sessionId, phase: 'done', reason: event.reason },
          })
        );
      }
    };

    const systemInstructions = assembleInstructions(this.opts.workDir, model);
    const subAgent = createSubAgentCapability(this.opts.apiUrl, this.opts.chain, allCapabilities, model);
    const config: AgentConfig = {
      model,
      apiUrl: this.opts.apiUrl,
      chain: this.opts.chain,
      systemInstructions,
      capabilities: [...allCapabilities, subAgent],
      maxTurns: 100,
      workingDir: this.opts.workDir,
      permissionMode: options.permissionMode ?? 'default',
      debug: !!this.opts.debug,
      showPrefetchStatus: false,
      ...(options.maxSpendUsd != null ? { maxSpendUsd: options.maxSpendUsd } : {}),
      onSessionStart: (sessionId) => {
        agent.sessionId = sessionId;
        this.agents.set(sessionId, agent);
        this.setState(agent, 'working');
        sessionIdResolve(sessionId);
      },
      // Remote answering: park on the broker; a dashboard client resolves.
      permissionPromptFn: async (toolName, description) => {
        const decision = await agent.broker.request({
          sessionId: agent.sessionId,
          kind: 'tool-permission',
          title: `Allow ${toolName}?`,
          description,
          options: ['yes', 'no', 'always'],
        });
        this.setState(agent, 'working');
        const choice = decision.choice.toLowerCase();
        return choice === 'yes' || choice === 'always' ? (choice as 'yes' | 'always') : 'no';
      },
      onAskUser: async (question, options2) => {
        const decision = await agent.broker.request({
          sessionId: agent.sessionId,
          kind: 'ask-user',
          title: 'Agent question',
          description: question,
          options: options2 && options2.length ? options2 : [],
        });
        this.setState(agent, 'working');
        return decision.message ?? decision.choice;
      },
      approvalPromptFn: async (req) => {
        const decision = await agent.broker.request({ ...req, sessionId: agent.sessionId });
        this.setState(agent, 'working');
        return decision;
      },
    };

    interactiveSession(config, getUserInput, onEvent, (abort) => { agent.abort = abort; })
      .then(() => this.setState(agent, 'completed'))
      .catch(() => this.setState(agent, 'failed'))
      .finally(() => {
        agent.broker.cancelAll('agent ended');
      });

    agent.pushInput(prompt);
    return sessionIdReady;
  }

  list(): AgentSummary[] {
    return [...this.agents.values()].map(a => ({
      sessionId: a.sessionId,
      label: a.label,
      model: a.model,
      state: a.state,
      startedAt: a.startedAt,
      lastEventAt: a.lastEventAt,
      pendingApprovals: a.broker.pending(),
    }));
  }

  get(sessionId: string): AgentSummary | null {
    const a = this.agents.get(sessionId);
    return a
      ? {
          sessionId: a.sessionId,
          label: a.label,
          model: a.model,
          state: a.state,
          startedAt: a.startedAt,
          lastEventAt: a.lastEventAt,
          pendingApprovals: a.broker.pending(),
        }
      : null;
  }

  /** Queue a follow-up prompt for a hosted agent (idle → starts a turn). */
  reply(sessionId: string, text: string): boolean {
    const agent = this.agents.get(sessionId);
    if (!agent || agent.state === 'completed' || agent.state === 'failed') return false;
    agent.pushInput(text);
    this.setState(agent, 'working');
    return true;
  }

  cancel(sessionId: string): boolean {
    const agent = this.agents.get(sessionId);
    if (!agent) return false;
    agent.broker.cancelAll('cancelled by user');
    agent.abort?.();
    agent.endInput();
    return true;
  }

  respond(sessionId: string, requestId: string, choice: string, message?: string): boolean {
    const agent = this.agents.get(sessionId);
    if (!agent) return false;
    const ok = agent.broker.respond(requestId, { choice, message });
    if (ok) {
      void bus.emit(
        makeEvent({
          type: 'approval.resolved',
          source: 'core',
          data: { sessionId, requestId, choice, by: 'remote' },
        })
      );
    }
    return ok;
  }

  subscribe(sessionId: string, cb: (event: StreamEvent) => void): (() => void) | null {
    const agent = this.agents.get(sessionId);
    if (!agent) return null;
    agent.emitter.on('event', cb);
    return () => agent.emitter.off('event', cb);
  }

  /** Ring-buffer replay for peek panels. */
  output(sessionId: string): StreamEvent[] {
    return this.agents.get(sessionId)?.recent.slice() ?? [];
  }

  shutdown(): void {
    for (const agent of this.agents.values()) {
      agent.broker.cancelAll('server shutting down');
      agent.abort?.();
      agent.endInput();
    }
  }
}
