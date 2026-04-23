/**
 * RunCode ink-based terminal UI.
 * Real-time streaming, thinking animation, tool progress, slash commands.
 */

import chalk from 'chalk';
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { render, Static, Box, Text, useApp, useInput, useStdout } from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import VimInput, { type VimMode } from './vim-input.js';
import type { StreamEvent } from '../agent/types.js';
import { renderMarkdown, renderMarkdownStreaming } from './markdown.js';
import {
  resolveModel,
  PICKER_CATEGORIES,
  PICKER_MODELS_FLAT,
} from './model-picker.js';
import { estimateCost } from '../pricing.js';
import { formatTokens, shortModelName } from '../stats/format.js';
import { mouse, forceDisableMouseTracking, type MouseEvent as TermMouseEvent } from './mouse.js';

// ─── Full-width input box ──────────────────────────────────────────────────

// Subscribe to terminal resize so React re-renders with fresh dimensions.
// Without this, useStdout() returns a stable ref and children that read
// stdout.columns on each render still need React to re-execute them — which
// only happens if some state changes. stdout.on('resize') → setState does that.
function useTerminalSize() {
  const { stdout } = useStdout();
  const [size, setSize] = useState(() => ({
    cols: stdout?.columns ?? 80,
    rows: stdout?.rows ?? 24,
  }));
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setSize({
      cols: stdout.columns ?? 80,
      rows: stdout.rows ?? 24,
    });
    stdout.on('resize', onResize);
    return () => { stdout.off('resize', onResize); };
  }, [stdout]);
  return size;
}

function InputBox({ input, setInput, onSubmit, model, balance, sessionCost, queued, queuedCount, focused, busy, contextPct, vimMode, onVimModeChange }: {
  input: string;
  setInput: (v: string) => void;
  onSubmit: (v: string) => void;
  model: string;
  balance: string;
  sessionCost: number;
  queued?: string;
  queuedCount?: number;
  focused?: boolean;
  busy?: boolean;
  contextPct?: number;
  vimMode?: boolean;
  onVimModeChange?: (mode: VimMode) => void;
}) {
  const { cols } = useTerminalSize();
  // Avoid drawing right up to the terminal edge. Several terminals auto-wrap
  // a full-width border glyph onto the next row, which leaves "ghost" top
  // borders behind on re-render after errors / status changes.
  const boxWidth = Math.max(20, cols - 2);

  const placeholder = busy
    ? (queued
        ? `⏎ ${queuedCount ?? 1} queued: ${queued.slice(0, 40)}`
        : 'Working...')
    : 'Type a message...';

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box borderStyle="round" borderDimColor paddingX={1} width={boxWidth}>
        {busy && !input ? <Text color="yellow"><Spinner type="dots" /> </Text> : null}
        <Box flexGrow={1}>
          {vimMode ? (
            <VimInput
              value={input}
              onChange={setInput}
              onSubmit={onSubmit}
              placeholder={placeholder}
              focus={focused !== false}
              showMode={true}
              onModeChange={onVimModeChange}
            />
          ) : (
            <TextInput
              value={input}
              onChange={setInput}
              onSubmit={onSubmit}
              placeholder={placeholder}
              focus={focused !== false}
            />
          )}
        </Box>
      </Box>
      <Box marginLeft={1}>
        <Text dimColor>
          {busy ? <Text color="yellow"><Spinner type="dots" /></Text> : null}
          {busy ? ' ' : ''}{shortModelName(model)}  ·  {balance}
          {sessionCost > 0.00001 ? <Text color="yellow">  -${sessionCost.toFixed(4)}</Text> : ''}
          {contextPct !== undefined && contextPct > 0 ? (() => {
            // Visual context bar: ▓▓▓▓▓▓░░░░ 75%
            const filled = Math.round(contextPct / 10);
            const empty = 10 - filled;
            const barColor = contextPct > 85 ? 'red' : contextPct > 70 ? 'yellow' : 'green';
            return (
              <Text>
                {'  '}
                <Text color={barColor}>{'▓'.repeat(filled)}</Text>
                <Text dimColor>{'░'.repeat(empty)}</Text>
                <Text color={barColor}>{' '}{contextPct}%</Text>
              </Text>
            );
          })() : null}
          {(queuedCount ?? 0) > 0 ? <Text color="cyan">  ·  {queuedCount} queued</Text> : null}
          {'  ·  esc'}
        </Text>
      </Box>
    </Box>
  );
}

function formatAgentErrorForDisplay(error: string): string {
  const lines = error.split('\n').map((line) => line.trim()).filter(Boolean);
  const tipIndex = lines.findIndex((line) => /^tip:/i.test(line));
  const mainLines = tipIndex >= 0 ? lines.slice(0, tipIndex) : lines;
  const tipLines = tipIndex >= 0 ? lines.slice(tipIndex) : [];

  let main = mainLines.join(' ').replace(/\s+/g, ' ').trim();
  let tip = tipLines.join(' ').replace(/\s+/g, ' ').trim();

  const labelMatch = /^\[([^\]]+)\]\s*/.exec(main);
  const label = labelMatch?.[1];
  if (labelMatch) main = main.slice(labelMatch[0].length).trim();
  if (tip) tip = tip.replace(/^tip:\s*/i, '');

  const out = ['**Request failed**'];
  if (label) out.push(`- Type: ${label}`);
  if (main) out.push(`- Message: ${main}`);
  if (tip) out.push(`- Tip: ${tip}`);
  return out.join('\n');
}

// Picker model list is imported from ./model-picker.js (single source of truth).
// PICKER_CATEGORIES provides grouped data for rendering; PICKER_MODELS_FLAT
// provides a flat array for pickerIdx navigation.

interface ToolStatus {
  name: string;
  startTime: number;
  done: boolean;
  error: boolean;
  preview: string;    // input preview (command/path) shown in spinner
  liveOutput: string; // latest output line while running
  liveLines: string[]; // accumulated output lines (last 5) for multi-line display
  elapsed: number;
  fullOutput: string; // complete tool output for expandable display
  diff?: { file: string; oldLines: string[]; newLines: string[]; count: number }; // structured diff for Edit
  expanded: boolean;  // whether this tool result is expanded (shows full output)
}

type UIMode = 'input' | 'model-picker';

interface PermissionRequest {
  toolName: string;
  description: string;
  resolve: (result: 'yes' | 'no' | 'always') => void;
}

interface AskUserRequest {
  question: string;
  options?: string[];
  resolve: (answer: string) => void;
}

type StatusTone = 'success' | 'warning' | 'error';

// ─── Main App ──────────────────────────────────────────────────────────────

interface AppProps {
  initialModel: string;
  workDir: string;
  walletAddress: string;
  walletBalance: string;
  startWithPicker?: boolean;
  chain: string;
  onSubmit: (input: string) => void;
  onModelChange: (model: string, reason?: 'user' | 'system') => void;
  onAbort: () => void;
  onExit: () => void;
}

function RunCodeApp({
  initialModel, workDir, walletAddress, walletBalance, chain,
  startWithPicker, onSubmit, onModelChange, onAbort, onExit,
}: AppProps) {
  const { exit } = useApp();
  const [input, setInput] = useState('');
  const [streamText, setStreamText] = useState('');
  const [thinking, setThinking] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [tools, setTools] = useState<Map<string, ToolStatus>>(new Map());
  // Completed tool results committed to Static (permanent scrollback — no re-render artifacts)
  const [completedTools, setCompletedTools] = useState<Array<ToolStatus & { key: string }>>([]);
  // Last completed tool — shown in dynamic area so it can be expanded/collapsed with Tab
  const [expandableTool, setExpandableTool] = useState<(ToolStatus & { key: string }) | null>(null);
  // Full responses committed to Static immediately — goes into terminal scrollback
  const [committedResponses, setCommittedResponses] = useState<Array<{ key: string; text: string; tokens: { input: number; output: number; calls: number }; cost: number; model?: string; tier?: string; savings?: number; thinkMs?: number; thinkChars?: number }>>([]);
  // Short preview of latest response shown in dynamic area (last ~5 lines, cleared on next turn)
  const [responsePreview, setResponsePreview] = useState('');
  const [currentModel, setCurrentModel] = useState(initialModel || PICKER_MODELS_FLAT[0].id);
  const [ready, setReady] = useState(!startWithPicker);
  const [mode, setMode] = useState<UIMode>(startWithPicker ? 'model-picker' : 'input');
  const [pickerIdx, setPickerIdx] = useState(0);
  const [statusMsg, setStatusMsg] = useState('');
  const [statusTone, setStatusTone] = useState<StatusTone>('success');
  const [turnTokens, setTurnTokens] = useState({ input: 0, output: 0, calls: 0 });
  const [contextPct, setContextPct] = useState(0);
  const [totalCost, setTotalCost] = useState(0);
  const [showHelp, setShowHelp] = useState(false);
  const [showWallet, setShowWallet] = useState(false);
  const [vimEnabled, setVimEnabled] = useState(false);
  const [currentVimMode, setCurrentVimMode] = useState<VimMode>('insert');
  const [balance, setBalance] = useState(walletBalance);
  // Parse the fetched balance to a number so we can compute live balance = fetchedBalance - sessionCost.
  // costAtLastFetch tracks totalCost when balance was last fetched, to avoid double-subtracting.
  const parseBalanceNum = (s: string): number | null => {
    const m = s.match(/\$([\d.]+)/);
    return m ? parseFloat(m[1]) : null;
  };
  const [baseBalanceNum, setBaseBalanceNum] = useState<number | null>(() => parseBalanceNum(walletBalance));
  const [costAtLastFetch, setCostAtLastFetch] = useState(0);
  const costAtLastFetchRef = useRef(0);
  const baseBalanceNumRef = useRef<number | null>(parseBalanceNum(walletBalance));
  const [thinkingText, setThinkingText] = useState('');
  const [lastPrompt, setLastPrompt] = useState('');
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [permissionRequest, setPermissionRequest] = useState<PermissionRequest | null>(null);
  const [askUserRequest, setAskUserRequest] = useState<AskUserRequest | null>(null);
  const [askUserInput, setAskUserInput] = useState('');
  // Messages queued while agent is busy — auto-submitted FIFO when turns complete.
  const [queuedInputs, setQueuedInputs] = useState<string[]>([]);
  const turnDoneCallbackRef = useRef<(() => void) | null>(null);

  // ── Render throttling: batch rapid text_delta/thinking_delta into 50ms frames ──
  // Without this, each delta (20-100/sec) triggers a full React re-render.
  // With this, we accumulate in refs and flush at ~20fps — smooth and efficient.
  const pendingTextRef = useRef('');
  const pendingThinkingRef = useRef('');
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Per-turn reasoning meter: first thinking delta starts the clock, first text
  // delta (or turn_done) stops it. Persists on the committed response as
  // "✻ Thought for 3.2s · ~420 tokens" so users see the cost of reasoning even
  // after the live thinking spinner collapses.
  const thinkStartRef = useRef<number | null>(null);
  const thinkCharsRef = useRef(0);
  const thinkMsRef = useRef<number | null>(null);

  const flushPendingText = useCallback(() => {
    flushTimerRef.current = null;
    const text = pendingTextRef.current;
    const thinking = pendingThinkingRef.current;
    if (text) {
      pendingTextRef.current = '';
      setWaiting(false);
      setThinking(false);
      // Text started: freeze the reasoning meter
      if (thinkStartRef.current !== null && thinkMsRef.current === null) {
        thinkMsRef.current = Date.now() - thinkStartRef.current;
      }
      setStreamText(prev => prev + text);
    }
    if (thinking) {
      pendingThinkingRef.current = '';
      setWaiting(false);
      setThinking(true);
      if (thinkStartRef.current === null) thinkStartRef.current = Date.now();
      thinkCharsRef.current += thinking.length;
      setThinkingText(prev => {
        const updated = prev + thinking;
        return updated.length > 500 ? updated.slice(-500) : updated;
      });
    }
  }, []);

  const scheduleFlush = useCallback(() => {
    if (!flushTimerRef.current) {
      flushTimerRef.current = setTimeout(flushPendingText, 50);
    }
  }, [flushPendingText]);

  // Refs to read current state values inside memoized event handlers (avoids stale closures)
  const streamTextRef = useRef('');
  const turnTokensRef = useRef({ input: 0, output: 0, calls: 0 });
  const totalCostRef = useRef(0);
  const turnCostRef = useRef(0); // per-turn cost (reset each turn)
  const turnModelRef = useRef<string | undefined>(undefined);
  const turnTierRef = useRef<string | undefined>(undefined);
  const turnSavingsRef = useRef<number | undefined>(undefined);
  const queuedInputsRef = useRef<string[]>([]);

  // Keep refs in sync so memoized event handlers can read current values
  streamTextRef.current = streamText;
  turnTokensRef.current = turnTokens;
  totalCostRef.current = totalCost;
  queuedInputsRef.current = queuedInputs;
  costAtLastFetchRef.current = costAtLastFetch;
  baseBalanceNumRef.current = baseBalanceNum;

  // Compute live balance = fetchedBalance - spend_since_last_fetch
  const liveBalance = baseBalanceNum !== null
    ? `$${Math.max(0, baseBalanceNum - (totalCost - costAtLastFetch)).toFixed(2)} USDC`
    : balance;

  const showStatus = useCallback((text: string, tone: StatusTone = 'success', durationMs = 3000) => {
    setStatusTone(tone);
    setStatusMsg(text);
    if (durationMs > 0) {
      setTimeout(() => setStatusMsg(''), durationMs);
    }
  }, []);

  const commitResponse = useCallback((
    text: string,
    tokens = turnTokensRef.current,
    cost = turnCostRef.current
  ) => {
    if (!text.trim()) return;

    // Snapshot the thinking meter for this turn (reset happens in turn_done,
    // which covers the empty-response-but-thinking case too)
    const thinkMs = thinkMsRef.current ?? (thinkStartRef.current !== null
      ? Date.now() - thinkStartRef.current
      : undefined);
    const thinkChars = thinkCharsRef.current || undefined;

    setCommittedResponses((rs) => {
      const next = [...rs, {
        key: String(Date.now() + Math.random()),
        text,
        tokens,
        cost,
        model: turnModelRef.current,
        tier: turnTierRef.current,
        savings: turnSavingsRef.current,
        thinkMs,
        thinkChars,
      }];
      // Cap at 300 items — older items are already in terminal scrollback
      return next.length > 300 ? next.slice(-300) : next;
    });

    const allLines = text.split('\n');
    if (allLines.length > 20) {
      setResponsePreview('  ↑ scroll to see full reply\n' + allLines.slice(-20).join('\n'));
    } else {
      setResponsePreview('');
    }
  }, []);

  // Permission dialog key handler — captures y/n/a when dialog is visible.
  // ink 6.x: useInput handlers all fire regardless of TextInput focus prop,
  // so we handle here AND block TextInput onChange (see focused prop below).
  useInput((ch, _key) => {
    if (!permissionRequest) return;
    // Clear any character that leaked into the text input
    setInput('');
    const c = ch.toLowerCase();
    if (c === 'y') {
      const r = permissionRequest.resolve;
      setPermissionRequest(null);
      r('yes');
    } else if (c === 'n') {
      const r = permissionRequest.resolve;
      setPermissionRequest(null);
      r('no');
    } else if (c === 'a') {
      const r = permissionRequest.resolve;
      setPermissionRequest(null);
      r('always');
    }
  }, { isActive: !!permissionRequest });

  // Key handler for picker + esc + abort
  const isPickerOrEsc = mode === 'model-picker' || (mode === 'input' && ready && !input) || !ready;
  useInput((ch, key) => {
    // Escape during generation → abort current turn (skip if permission dialog open)
    if (key.escape && !ready && !permissionRequest) {
      onAbort();
      showStatus('Aborted', 'warning', 3000);
      setReady(true);
      setWaiting(false);
      setThinking(false);
      return;
    }

    // Esc to quit (only when input is empty and in input mode)
    // In Vim mode: Esc goes to normal mode (handled by VimInput), only quit on Esc in normal mode with empty input
    if (key.escape && mode === 'input' && ready && !input) {
      if (vimEnabled && currentVimMode === 'insert') return; // Let VimInput handle Esc → normal
      onExit();
      exit();
      return;
    }

    // Arrow key navigation for model picker
    if (mode !== 'model-picker') return;
    if (key.upArrow) setPickerIdx(i => Math.max(0, i - 1));
    else if (key.downArrow) setPickerIdx(i => Math.min(PICKER_MODELS_FLAT.length - 1, i + 1));
    else if (key.return) {
      const selected = PICKER_MODELS_FLAT[pickerIdx];
      setCurrentModel(selected.id);
      onModelChange(selected.id, 'user');
      showStatus(`Model → ${selected.label}`, 'success', 3000);
      // Clear any stale draft that was in the input when the picker opened —
      // previously a paste/typed value could leak back into the chat box after
      // the picker closed, which is both confusing and a privacy risk.
      setInput('');
      setHistoryIdx(-1);
      setMode('input');
      setReady(true);
    }
    else if (key.escape) {
      setInput('');
      setHistoryIdx(-1);
      setMode('input');
      setReady(true);
    }
  }, { isActive: isPickerOrEsc });

  // Tab key: toggle expand/collapse on the last completed tool
  useInput((_ch, key) => {
    if (key.tab && expandableTool) {
      setExpandableTool(prev => prev ? { ...prev, expanded: !prev.expanded } : null);
    }
  }, { isActive: mode === 'input' && !permissionRequest && !askUserRequest });

  // Input history: Up/Down arrow when in ready input mode
  useInput((_ch, key) => {
    if (key.upArrow && inputHistory.length > 0) {
      const newIdx = historyIdx < 0 ? inputHistory.length - 1 : Math.max(0, historyIdx - 1);
      setHistoryIdx(newIdx);
      setInput(inputHistory[newIdx]);
    } else if (key.downArrow) {
      if (historyIdx >= 0 && historyIdx < inputHistory.length - 1) {
        const newIdx = historyIdx + 1;
        setHistoryIdx(newIdx);
        setInput(inputHistory[newIdx]);
      } else {
        setHistoryIdx(-1);
        setInput('');
      }
    }
  }, { isActive: ready && mode === 'input' });

  const handleSubmit = useCallback((value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;

    // Exit commands bypass the busy-queue gate — if the user wants out,
    // they want out immediately, not after whatever turn is in flight.
    // Covers bare 'exit' / 'quit' / 'q' and slash-prefixed /exit / /quit.
    const lower = trimmed.toLowerCase();
    const isExit =
      lower === 'exit' || lower === 'quit' || lower === 'q' ||
      lower === '/exit' || lower === '/quit';
    if (isExit) {
      onAbort();
      onExit();
      exit();
      return;
    }

    // If agent is busy, queue the message — it will be auto-submitted when the turn finishes
    if (!ready) {
      setQueuedInputs(prev => [...prev, trimmed]);
      setInput('');
      showStatus(`Queued message (${queuedInputsRef.current.length + 1} pending)`, 'warning', 1500);
      return;
    }

    // ── Slash commands ──
    if (trimmed.startsWith('/')) {
      setInput('');
      setShowHelp(false);
      setShowWallet(false);
      const parts = trimmed.split(/\s+/);
      const cmd = parts[0].toLowerCase();

      switch (cmd) {
        // /exit and /quit are handled earlier (before the busy-queue gate)
        // so they exit the session immediately even mid-turn.

        case '/model':
        case '/models':
          if (parts[1]) {
            const resolved = resolveModel(parts[1]);
            setCurrentModel(resolved);
            onModelChange(resolved, 'user');
            showStatus(`Model → ${resolved}`, 'success', 3000);
          } else {
            const idx = PICKER_MODELS_FLAT.findIndex(m => m.id === currentModel);
            setPickerIdx(idx >= 0 ? idx : 0);
            // Defensive: ensure no draft text survives into the picker —
            // closing handlers clear input too, so both ends are covered.
            setInput('');
            setHistoryIdx(-1);
            setMode('model-picker');
          }
          return;

        case '/wallet':
        case '/balance':
          setShowWallet(true);
          setShowHelp(false);
          return;

        case '/cost':
        case '/usage':
          showStatus(`Cost: $${totalCost.toFixed(4)} this session`, 'success', 4000);
          return;

        case '/help':
          setShowHelp(true);
          setShowWallet(false);
          return;

        case '/vim':
          setVimEnabled(prev => !prev);
          showStatus(vimEnabled ? 'Vim mode OFF' : 'Vim mode ON — Esc for normal, i for insert', 'success', 3000);
          return;

        case '/clear':
          setStreamText('');
          setTools(new Map());
          setTurnTokens({ input: 0, output: 0, calls: 0 });
          turnCostRef.current = 0;
          turnModelRef.current = undefined;
          turnTierRef.current = undefined;
          turnSavingsRef.current = undefined;
          setWaiting(true);
          setReady(false);
          // Pass through to agent loop to clear the actual conversation history
          onSubmit('/clear');
          return;

        case '/retry':
          if (!lastPrompt) {
            showStatus('No previous prompt to retry', 'warning', 3000);
            return;
          }
          setStreamText('');
          setThinking(false);
          setThinkingText('');
          setTools(new Map());
          setReady(false);
          setWaiting(true);
          setTurnTokens({ input: 0, output: 0, calls: 0 });
          turnCostRef.current = 0;
          turnModelRef.current = undefined;
          turnTierRef.current = undefined;
          turnSavingsRef.current = undefined;
          onSubmit(lastPrompt);
          return;

        default:
          // All other slash commands pass through to the agent loop's command registry
          setStreamText('');
          setThinking(false);
          setThinkingText('');
          setTools(new Map());
          setWaiting(true);
          setReady(false);
          onSubmit(trimmed);
          return;
      }
    }

    // ── Normal prompt ──
    // Show user message in scrollback so the conversation is readable
    setCommittedResponses(rs => [...rs, {
      key: `user-${Date.now()}`,
      // Gold matches the top of the Franklin banner gradient (#FFD700).
      // Brand-consistent, readable on dark terminals, evokes $100-bill identity.
      text: chalk.hex('#FFD700').bold('❯ ') + chalk.hex('#FFD700').bold(trimmed),
      tokens: { input: 0, output: 0, calls: 0 },
      cost: 0,
    }]);
    setResponsePreview('');
    setLastPrompt(trimmed);
    setInputHistory(prev => [...prev.slice(-49), trimmed]); // Keep last 50
    setHistoryIdx(-1);
    setInput('');
    setStreamText('');
    setThinking(false);
    setThinkingText('');
    setTools(new Map());
    // Flush expandable tool to Static before clearing
    setExpandableTool(prev => {
      if (prev) setCompletedTools(prev2 => [...prev2, { ...prev, expanded: false }]);
      return null;
    });
    setCompletedTools([]);
    setReady(false);
    setWaiting(true);
    setStatusMsg('');
    setShowHelp(false);
    setShowWallet(false);
    setTurnTokens({ input: 0, output: 0, calls: 0 });
    turnCostRef.current = 0;
    turnModelRef.current = undefined;
    turnTierRef.current = undefined;
    turnSavingsRef.current = undefined;
    onSubmit(trimmed);
  }, [ready, currentModel, totalCost, onSubmit, onModelChange, onAbort, onExit, exit, lastPrompt, inputHistory, showStatus]);

  // Mouse support — OFF by default because Node stdin is shared: mouse escape
  // sequences leak into Ink's input handler as typed text. Opt in with
  // FRANKLIN_MOUSE=1 if you want click-to-expand-tool + drag-to-copy.
  useEffect(() => {
    // Always disable any leftover mouse tracking from a previous session
    forceDisableMouseTracking();
    if (process.env.FRANKLIN_MOUSE !== '1') return;

    const cleanup = mouse.enable();

    const handleClick = (event: TermMouseEvent) => {
      // Ignore clicks in the input area (bottom 4 rows of the terminal)
      const termRows = process.stdout.rows ?? 24;
      if (event.row >= termRows - 4) return;
      // Click: toggle expandable tool
      setExpandableTool(prev => prev ? { ...prev, expanded: !prev.expanded } : null);
    };

    const handleCopied = (info: { text: string; length: number }) => {
      // Show status when text is copied via drag-select
      showStatus(`Copied ${info.length} chars to clipboard`, 'success', 2000);
    };

    mouse.on('click', handleClick);
    mouse.on('copied', handleCopied);

    return () => {
      mouse.removeListener('click', handleClick);
      mouse.removeListener('copied', handleCopied);
      cleanup();
    };
  }, []);

  // Expose event handler, balance updater, and permission bridge
  useEffect(() => {
    (globalThis as Record<string, unknown>).__runcode_ui = {
      updateModel: (model: string) => { setCurrentModel(model); },
      updateBalance: (bal: string) => {
        setBalance(bal);
        const num = parseBalanceNum(bal);
        if (num !== null) {
          setBaseBalanceNum(num);
          // Reset cost baseline — the fetched balance already reflects costs up to this point
          setCostAtLastFetch(totalCostRef.current);
        }
      },
      onTurnDone: (cb: () => void) => { turnDoneCallbackRef.current = cb; },
      requestPermission: (toolName: string, description: string): Promise<'yes' | 'no' | 'always'> => {
        return new Promise((resolve) => {
          // Ring the terminal bell — causes tab to show notification badge in iTerm2/Terminal.app
          process.stderr.write('\x07');
          setPermissionRequest({ toolName, description, resolve });
        });
      },
      requestAskUser: (question: string, options?: string[]): Promise<string> => {
        return new Promise((resolve) => {
          process.stderr.write('\x07');
          setAskUserInput('');
          setAskUserRequest({ question, options, resolve });
        });
      },
      handleEvent: (event: StreamEvent) => {
        switch (event.kind) {
          case 'text_delta':
            // Throttled: accumulate in ref, flush every 50ms (~20fps)
            pendingTextRef.current += event.text;
            scheduleFlush();
            break;
          case 'thinking_delta':
            // Throttled: accumulate in ref, flush every 50ms
            pendingThinkingRef.current += event.text;
            scheduleFlush();
            break;
          case 'capability_start':
            setWaiting(false);
            setTools(prev => {
              const next = new Map(prev);
              next.set(event.id, {
                name: event.name, startTime: Date.now(),
                done: false, error: false,
                preview: event.preview || '',
                liveOutput: '',
                liveLines: [],
                fullOutput: '',
                expanded: false,
                elapsed: 0,
              });
              return next;
            });
            break;
          case 'capability_progress':
            setTools(prev => {
              const t = prev.get(event.id);
              if (!t || t.done) return prev;
              const next = new Map(prev);
              // Accumulate output lines for multi-line display (keep last 5)
              const newLines = [...t.liveLines];
              const incoming = event.text.split('\n').filter(Boolean);
              newLines.push(...incoming);
              while (newLines.length > 5) newLines.shift();
              next.set(event.id, { ...t, liveOutput: event.text, liveLines: newLines });
              return next;
            });
            break;
          case 'capability_done': {
            setTools(prev => {
              const next = new Map(prev);
              const t = next.get(event.id);
              if (t) {
                // On success: show input preview (command/path). On error: show error output.
                const resultPreview = event.result.isError
                  ? event.result.output.replace(/\n/g, ' ').slice(0, 150)
                  : (t.preview || event.result.output.replace(/\n/g, ' ').slice(0, 120));
                const completed: ToolStatus & { key: string } = {
                  ...t,
                  key: event.id,
                  done: true,
                  error: !!event.result.isError,
                  preview: resultPreview,
                  liveOutput: '',
                  liveLines: [],
                  fullOutput: event.result.output || '',
                  diff: event.result.diff,
                  expanded: false,
                  elapsed: Date.now() - t.startTime,
                };
                // Move previous expandable tool to Static, set new one as expandable
                setExpandableTool(prevExpTool => {
                  if (prevExpTool) {
                    setCompletedTools(prev2 => [...prev2, { ...prevExpTool, expanded: false }]);
                  }
                  return completed;
                });
                next.delete(event.id);
              }
              return next;
            });
            break;
          }
          case 'usage': {
            // DO NOT setCurrentModel(event.model) here. currentModel
            // represents the user's selection (e.g. 'blockrun/auto'),
            // not what the router resolved for this specific turn. The
            // per-turn resolved model is already captured in
            // turnModelRef (rendered in the turn-summary line below
            // each response) and in onModelChange('system') when the
            // loop itself decides to swap (empty-response / 402 fallback).
            // Overriding currentModel from every usage event made the
            // status bar permanently show the last resolved model and
            // create a false impression that auto mode was stuck.
            setTurnTokens(prev => ({
              input: prev.input + event.inputTokens,
              output: prev.output + event.outputTokens,
              calls: prev.calls + (event.calls ?? 1),
            }));
            const turnCallCost = estimateCost(event.model, event.inputTokens, event.outputTokens, event.calls ?? 1);
            turnCostRef.current += turnCallCost;
            setTotalCost(prev => prev + turnCallCost);
            // Capture routing metadata for this turn
            turnModelRef.current = event.model;
            if (event.tier) turnTierRef.current = event.tier;
            if (event.savings !== undefined) turnSavingsRef.current = event.savings;
            if (event.contextPct !== undefined) setContextPct(event.contextPct);
            break;
          }
          case 'turn_done': {
            // Flush any pending throttled text immediately
            if (flushTimerRef.current) {
              clearTimeout(flushTimerRef.current);
              flushTimerRef.current = null;
            }
            // Merge pending text into the ref so commitResponse sees the full text
            if (pendingTextRef.current) {
              streamTextRef.current += pendingTextRef.current;
              pendingTextRef.current = '';
            }
            pendingThinkingRef.current = '';
            // Freeze reasoning meter if turn ended while thinking (no text emitted)
            if (thinkStartRef.current !== null && thinkMsRef.current === null) {
              thinkMsRef.current = Date.now() - thinkStartRef.current;
            }

            // Flush expandable tool to Static before committing response
            setExpandableTool(prev => {
              if (prev) setCompletedTools(prev2 => [...prev2, { ...prev, expanded: false }]);
              return null;
            });

            const text = streamTextRef.current;
            if (text.trim()) {
              commitResponse(text, turnTokensRef.current, turnCostRef.current);
              setStreamText('');
            }

            if (event.reason === 'error' && event.error) {
              commitResponse(formatAgentErrorForDisplay(event.error), turnTokensRef.current, turnCostRef.current);
              showStatus('Turn failed', 'error', 5000);
            } else if (event.reason === 'aborted') {
              showStatus('Aborted', 'warning', 3000);
            } else if (event.reason === 'max_turns') {
              showStatus('Stopped after reaching max turns', 'warning', 5000);
            } else {
              setStatusMsg('');
            }

            setReady(true);
            setWaiting(false);
            setThinking(false);
            setThinkingText('');
            // Reset reasoning meter for the next turn
            thinkStartRef.current = null;
            thinkMsRef.current = null;
            thinkCharsRef.current = 0;
            // Trigger balance refresh after each completed turn
            turnDoneCallbackRef.current?.();
            // Ring the terminal bell so the user knows the AI finished
            // (shows notification badge in iTerm2/Terminal.app when tabbed away)
            process.stderr.write('\x07');
            // Auto-submit any queued message while agent was busy
            const queued = queuedInputsRef.current[0];
            if (queued) {
              setQueuedInputs((prev) => prev.slice(1));
              // Small delay so React can flush the ready=true state first
              setTimeout(() => {
                const fn = (globalThis as Record<string, unknown>).__runcode_submit;
                if (typeof fn === 'function') fn(queued);
              }, 50);
            }
            break;
          }
        }
      },
    };
    (globalThis as Record<string, unknown>).__runcode_submit = (msg: string) => {
      handleSubmit(msg);
    };
    return () => {
      delete (globalThis as Record<string, unknown>).__runcode_ui;
      delete (globalThis as Record<string, unknown>).__runcode_submit;
    };
  }, [handleSubmit, commitResponse, showStatus]);

  // ── Render ──
  // Note: the tree is ALWAYS the same shape across mode changes. Static
  // components (completedTools, committedResponses) stay mounted so Ink
  // doesn't discard already-committed scrollback when the model picker
  // opens/closes. The picker is rendered inline below scrollback, and the
  // InputBox is hidden while it's active.
  const inPicker = mode === 'model-picker';

  return (
    <Box flexDirection="column">
      {/* Status message */}
      {statusMsg && (
        <Box marginLeft={2}>
          <Text color={statusTone === 'error' ? 'red' : statusTone === 'warning' ? 'yellow' : 'green'}>
            {statusMsg}
          </Text>
        </Box>
      )}

      {/* Help panel */}
      {showHelp && (
        <Box flexDirection="column" marginLeft={2} marginTop={1} marginBottom={1}>
          <Text bold>Commands</Text>
          <Text> </Text>
          <Text>  <Text color="cyan">/model</Text> [name]  Switch model (picker if no name)</Text>
          <Text>  <Text color="cyan">/wallet</Text>        Show wallet address & balance</Text>
          <Text>  <Text color="cyan">/cost</Text>          Session cost & savings</Text>
          <Text>  <Text color="cyan">/retry</Text>         Retry the last prompt</Text>
          <Text>  <Text color="cyan">/compact</Text>       Compress conversation history</Text>
          <Text dimColor>  ── Coding ──</Text>
          <Text>  <Text color="cyan">/test</Text>          Run tests</Text>
          <Text>  <Text color="cyan">/fix</Text>           Fix last error</Text>
          <Text>  <Text color="cyan">/review</Text>        Code review</Text>
          <Text>  <Text color="cyan">/explain</Text> file  Explain code</Text>
          <Text>  <Text color="cyan">/search</Text> query  Search codebase</Text>
          <Text>  <Text color="cyan">/session-search</Text> q  Search past sessions</Text>
          <Text>  <Text color="cyan">/refactor</Text> desc Refactor code</Text>
          <Text>  <Text color="cyan">/scaffold</Text> desc Generate boilerplate</Text>
          <Text dimColor>  ── Git ──</Text>
          <Text>  <Text color="cyan">/commit</Text>        Commit changes</Text>
          <Text>  <Text color="cyan">/push</Text>          Push to remote</Text>
          <Text>  <Text color="cyan">/pr</Text>            Create pull request</Text>
          <Text>  <Text color="cyan">/status</Text>        Git status</Text>
          <Text>  <Text color="cyan">/diff</Text>          Git diff</Text>
          <Text>  <Text color="cyan">/log</Text>           Git log</Text>
          <Text>  <Text color="cyan">/branch</Text> [name] Branches</Text>
          <Text>  <Text color="cyan">/stash</Text>         Stash changes</Text>
          <Text>  <Text color="cyan">/undo</Text>          Undo last commit</Text>
          <Text dimColor>  ── Analysis ──</Text>
          <Text>  <Text color="cyan">/security</Text>      Security audit</Text>
          <Text>  <Text color="cyan">/lint</Text>          Quality check</Text>
          <Text>  <Text color="cyan">/optimize</Text>      Performance check</Text>
          <Text>  <Text color="cyan">/todo</Text>          Find TODOs</Text>
          <Text>  <Text color="cyan">/deps</Text>          Dependencies</Text>
          <Text>  <Text color="cyan">/clean</Text>         Dead code removal</Text>
          <Text>  <Text color="cyan">/context</Text>       Session info (model, tokens, mode)</Text>
          <Text>  <Text color="cyan">/plan</Text>          Enter plan mode (read-only tools)</Text>
          <Text>  <Text color="cyan">/execute</Text>       Exit plan mode (enable all tools)</Text>
          <Text>  <Text color="cyan">/sessions</Text>      List saved sessions</Text>
          <Text>  <Text color="cyan">/resume</Text> id     Resume a saved session</Text>
          <Text>  <Text color="cyan">/clear</Text>         Clear conversation history</Text>
          <Text>  <Text color="cyan">/doctor</Text>        Diagnose setup issues</Text>
          <Text>  <Text color="cyan">/vim</Text>           Toggle Vim input mode</Text>
          <Text>  <Text color="cyan">/help</Text>          This help</Text>
          <Text>  <Text color="cyan">/exit</Text>          Quit</Text>
          <Text> </Text>
          <Text dimColor>  Shortcuts: sonnet, opus, gpt, gemini, deepseek, flash, free, r1, o4, nano, mini, haiku</Text>
        </Box>
      )}

      {/* Wallet panel */}
      {showWallet && (
        <Box flexDirection="column" marginLeft={2} marginTop={1} marginBottom={1}>
          <Text bold>Wallet</Text>
          <Text> </Text>
          <Text>  Chain:   <Text color="magenta">{chain}</Text></Text>
          <Text>  Address: <Text color="cyan">{walletAddress}</Text></Text>
          <Text>  Balance: <Text color="green">{balance}</Text></Text>
        </Box>
      )}

      {/* Completed tools — rich display with structured diffs for Edit */}
      <Static items={completedTools}>
        {(tool) => {
          const elapsedFmt = tool.elapsed >= 1000
            ? `${(tool.elapsed / 1000).toFixed(1)}s`
            : `${tool.elapsed}ms`;
          return (
            <Box key={tool.key} flexDirection="column" marginLeft={2}>
              <Text>
                {tool.error
                  ? <Text color="red">✗</Text>
                  : <Text color="green">✓</Text>
                }
                {' '}<Text bold>{tool.name}</Text>
                {tool.preview ? <Text dimColor>({tool.preview.slice(0, 80)})</Text> : null}
                <Text dimColor> {elapsedFmt}</Text>
              </Text>
              {/* Structured diff for Edit tool — colored red/green lines */}
              {tool.diff && !tool.error && tool.diff.oldLines.length <= 8 && tool.diff.newLines.length <= 8 && (
                <Box flexDirection="column" marginLeft={2}>
                  {tool.diff.oldLines.map((line, i) => (
                    <Text key={`old-${i}`} color="red" wrap="truncate-end">{'⎿  '}- {line.slice(0, 120)}</Text>
                  ))}
                  {tool.diff.newLines.map((line, i) => (
                    <Text key={`new-${i}`} color="green" wrap="truncate-end">{'⎿  '}+ {line.slice(0, 120)}</Text>
                  ))}
                </Box>
              )}
              {/* Large diff summary */}
              {tool.diff && !tool.error && (tool.diff.oldLines.length > 8 || tool.diff.newLines.length > 8) && (
                <Box marginLeft={2}>
                  <Text dimColor>{'⎿  '}{tool.diff.oldLines.length} lines → {tool.diff.newLines.length} lines</Text>
                </Box>
              )}
              {/* Error output preview */}
              {tool.error && tool.fullOutput && (
                <Box flexDirection="column" marginLeft={2}>
                  {tool.fullOutput.split('\n').filter(Boolean).slice(0, 3).map((line, i) => (
                    <Text key={i} color="red" wrap="truncate-end">{'⎿  '}{line.slice(0, 120)}</Text>
                  ))}
                </Box>
              )}
            </Box>
          );
        }}
      </Static>

      {/* Full responses — committed to Static with turn separators for readability */}
      <Static items={committedResponses}>
        {(r) => {
          const isUserMsg = r.key.startsWith('user-');
          return (
            <Box key={r.key} flexDirection="column">
              {/* Turn separator — thin line before assistant responses */}
              {!isUserMsg && (r.tokens.input > 0 || r.tokens.output > 0) && (
                <Box marginTop={1}>
                  <Text dimColor>{'─'.repeat(60)}</Text>
                </Box>
              )}
              {/* User messages get a left border bar + top margin for visual separation */}
              {isUserMsg && (
                <Box marginTop={1}/>
              )}
              {/* Reasoning meter — shown once above the response, only if the
                  model actually thought. Compact, dim; no spinner. */}
              {!isUserMsg && r.thinkMs !== undefined && r.thinkMs >= 500 && (
                <Box paddingLeft={2}>
                  <Text color="magenta" dimColor>
                    ✻ Thought for {(r.thinkMs / 1000).toFixed(1)}s
                    {r.thinkChars && r.thinkChars > 20
                      ? ` · ~${Math.round(r.thinkChars / 4)} tokens`
                      : ''}
                  </Text>
                </Box>
              )}
              <Box paddingLeft={isUserMsg ? 0 : 2}>
                <Text wrap="wrap">{renderMarkdown(r.text)}</Text>
              </Box>
              {(r.tokens.input > 0 || r.tokens.output > 0) && (
                <Box marginLeft={1} marginBottom={1}>
                  <Text dimColor>
                    {r.tier && <Text color="cyan">[{r.tier}] </Text>}
                    {r.model ? shortModelName(r.model) : ''}
                    {r.model ? '  ·  ' : ''}
                    {r.tokens.calls > 0 && r.tokens.input === 0
                      ? `${r.tokens.calls} calls`
                      : `${formatTokens(r.tokens.input)} in / ${formatTokens(r.tokens.output)} out`}
                    {r.cost > 0 ? `  ·  $${r.cost.toFixed(4)}` : ''}
                    {r.savings !== undefined && r.savings > 0 ? <Text color="green">  saved {Math.round(r.savings * 100)}%</Text> : ''}
                  </Text>
                </Box>
              )}
            </Box>
          );
        }}
      </Static>

      {/* Permission dialog — rendered inline, captured via useInput above */}
      {permissionRequest && (
        <Box flexDirection="column" marginTop={1} marginLeft={1}>
          <Text color="yellow">  ╭─ Permission required ─────────────────</Text>
          <Text color="yellow">  │ <Text bold>{permissionRequest.toolName}</Text></Text>
          {permissionRequest.description.split('\n').map((line, i) => (
            <Text key={i} dimColor>  │ {line}</Text>
          ))}
          <Text color="yellow">  ╰─────────────────────────────────────</Text>
          <Box marginLeft={3}>
            <Text>
              <Text bold color="green">[y]</Text>
              <Text dimColor> yes  </Text>
              <Text bold color="cyan">[a]</Text>
              <Text dimColor> always  </Text>
              <Text bold color="red">[n]</Text>
              <Text dimColor> no</Text>
            </Text>
          </Box>
        </Box>
      )}

      {/* AskUser dialog — text input for agent questions */}
      {askUserRequest && (
        <Box flexDirection="column" marginTop={1} marginLeft={1}>
          <Text color="cyan">  ╭─ Question ─────────────────────────────</Text>
          <Text color="cyan">  │ <Text bold>{askUserRequest.question}</Text></Text>
          {askUserRequest.options && askUserRequest.options.length > 0 && (
            askUserRequest.options.map((opt, i) => (
              <Text key={i} dimColor>  │ {i + 1}. {opt}</Text>
            ))
          )}
          <Text color="cyan">  ╰─────────────────────────────────────</Text>
          <Box marginLeft={3}>
            <Text bold>answer&gt; </Text>
            <TextInput
              value={askUserInput}
              onChange={setAskUserInput}
              onSubmit={(val) => {
                const answer = val.trim() || '(no response)';
                const r = askUserRequest.resolve;
                setAskUserRequest(null);
                setAskUserInput('');
                r(answer);
              }}
              focus={true}
            />
          </Box>
        </Box>
      )}

      {/* Expandable tool — last completed tool, can be toggled with Tab */}
      {expandableTool && (() => {
        const tool = expandableTool;
        const elapsedFmt = tool.elapsed >= 1000
          ? `${(tool.elapsed / 1000).toFixed(1)}s`
          : `${tool.elapsed}ms`;
        const hasExpandableContent = !!(tool.diff || (tool.fullOutput && tool.fullOutput.split('\n').length > 1));
        return (
          <Box flexDirection="column" marginLeft={2}>
            <Text>
              {tool.error ? <Text color="red">✗</Text> : <Text color="green">✓</Text>}
              {' '}<Text bold>{tool.name}</Text>
              {tool.preview ? <Text dimColor>({tool.preview.slice(0, 80)})</Text> : null}
              <Text dimColor> {elapsedFmt}</Text>
              {hasExpandableContent && (
                <Text dimColor> {tool.expanded ? '(tab to collapse)' : '(tab to expand)'}</Text>
              )}
            </Text>
            {/* Collapsed: show diff summary or nothing */}
            {!tool.expanded && tool.diff && !tool.error && tool.diff.oldLines.length <= 8 && tool.diff.newLines.length <= 8 && (
              <Box flexDirection="column" marginLeft={2}>
                {tool.diff.oldLines.map((line, i) => (
                  <Text key={`old-${i}`} color="red" wrap="truncate-end">{'⎿  '}- {line.slice(0, 120)}</Text>
                ))}
                {tool.diff.newLines.map((line, i) => (
                  <Text key={`new-${i}`} color="green" wrap="truncate-end">{'⎿  '}+ {line.slice(0, 120)}</Text>
                ))}
              </Box>
            )}
            {/* Expanded: show full output */}
            {tool.expanded && tool.fullOutput && (
              <Box flexDirection="column" marginLeft={2}>
                {tool.fullOutput.split('\n').slice(0, 30).map((line, i) => (
                  <Text key={i} dimColor wrap="truncate-end">{'⎿  '}{line.slice(0, 120)}</Text>
                ))}
                {tool.fullOutput.split('\n').length > 30 && (
                  <Text dimColor>{'⎿  '}... {tool.fullOutput.split('\n').length - 30} more lines</Text>
                )}
              </Box>
            )}
            {/* Error output */}
            {tool.error && !tool.expanded && tool.fullOutput && (
              <Box flexDirection="column" marginLeft={2}>
                {tool.fullOutput.split('\n').filter(Boolean).slice(0, 3).map((line, i) => (
                  <Text key={i} color="red" wrap="truncate-end">{'⎿  '}{line.slice(0, 120)}</Text>
                ))}
              </Box>
            )}
          </Box>
        );
      })()}

      {/* Active (in-progress) tools — bordered box with multi-line streaming output */}
      {Array.from(tools.entries()).map(([id, tool]) => {
        const elapsed = Math.round((Date.now() - tool.startTime) / 1000);
        const elapsedStr = elapsed > 0 ? ` ${elapsed}s` : '';
        return (
          <Box key={id} flexDirection="column" marginLeft={2}>
            <Text>
              <Text color="cyan"><Spinner type="dots" /></Text>
              {' '}<Text bold color="cyan">{tool.name}</Text>
              {tool.preview ? <Text dimColor>({tool.preview.slice(0, 70)})</Text> : null}
              <Text dimColor>{elapsedStr}</Text>
            </Text>
            {tool.liveLines.length > 0 && (
              <Box flexDirection="column" marginLeft={2}>
                {tool.liveLines.map((line, i) => (
                  <Text key={i} dimColor wrap="truncate-end">{'⎿  '}{line.slice(0, 120)}</Text>
                ))}
              </Box>
            )}
          </Box>
        );
      })}

      {/* Thinking — compact by default (just spinner). Preview shown only when
          FRANKLIN_SHOW_THINKING=1 is set, so terminal stays clean for reasoning
          models like o3 that emit long chains of thought. */}
      {thinking && (
        <Box flexDirection="column" marginLeft={2}>
          <Text color="magenta">
            <Spinner type="dots" />{' '}
            <Text bold>thinking</Text>
            {completedTools.length > 0 ? <Text dimColor>{' '}· step {completedTools.length + 1}</Text> : null}
          </Text>
          {process.env.FRANKLIN_SHOW_THINKING === '1' && thinkingText && (() => {
            const lines = thinkingText.split('\n').filter(Boolean).slice(-3);
            return (
              <Box flexDirection="column" marginLeft={2}>
                {lines.map((line, i) => (
                  <Text key={i} dimColor wrap="truncate-end">{'⎿  '}{line.slice(0, 120)}</Text>
                ))}
              </Box>
            );
          })()}
        </Box>
      )}

      {/* Waiting — model name and step counter */}
      {waiting && !thinking && tools.size === 0 && (
        <Box marginLeft={2}>
          <Text color="yellow">
            <Spinner type="dots" />{' '}
            <Text dimColor>{shortModelName(currentModel)}{completedTools.length > 0 ? ` · step ${completedTools.length + 1}` : ''}</Text>
          </Text>
        </Box>
      )}

      {/* Streaming response — visible while the model is generating.
          Closed lines render with full markdown; the trailing partial line
          renders as plain text until its newline arrives, so mid-stream
          `**bold` or `[link](` half-pairs can't emit unbalanced ANSI that
          Ink's wrap would then mangle. */}
      {streamText && (() => {
        const { rendered, partial } = renderMarkdownStreaming(streamText);
        return (
          <Box marginTop={0} marginBottom={0}>
            <Text wrap="wrap">
              {rendered}
              {rendered && partial ? '\n' : ''}
              {partial}
            </Text>
          </Box>
        );
      })()}

      {/* Preview of latest response — last 5 lines shown in dynamic area for quick reference.
          Full text is already in Static/scrollback above. Cleared when next turn starts. */}
      {responsePreview && !streamText && (
        <Box flexDirection="column" marginBottom={0}>
          <Text wrap="wrap">{renderMarkdown(responsePreview)}</Text>
        </Box>
      )}

      {/* Model picker — rendered inline below scrollback. Categories shown as
          dim headers, flat cursor (pickerIdx) navigates all non-header rows.
          Hides the InputBox while active but leaves all Static scrollback
          above it mounted, so conversation history visually survives a switch. */}
      {inPicker && (() => {
        let flatIdx = 0;
        return (
          <Box flexDirection="column" marginTop={1}>
            <Box marginLeft={2}>
              <Text bold>Select a model </Text>
              <Text dimColor>(↑↓ navigate, Enter select, Esc cancel)</Text>
            </Box>
            {PICKER_CATEGORIES.map((cat) => (
              <Box key={cat.category} flexDirection="column" marginTop={1}>
                <Box marginLeft={2}>
                  <Text dimColor>── {cat.category} ──</Text>
                </Box>
                {cat.models.map((m) => {
                  const myIdx = flatIdx++;
                  const isSelected = myIdx === pickerIdx;
                  const isCurrent = m.id === currentModel;
                  const isHighlight = m.highlight === true;
                  return (
                    <Box key={m.id} marginLeft={2}>
                      <Text
                        inverse={isSelected}
                        color={isSelected ? 'cyan' : isHighlight ? 'yellow' : undefined}
                        bold={isSelected || isHighlight}
                      >
                        {' '}{m.label.padEnd(26)}{' '}
                      </Text>
                      <Text dimColor> {m.shortcut.padEnd(14)}</Text>
                      <Text
                        color={m.price === 'FREE' ? 'green' : isHighlight ? 'yellow' : undefined}
                        dimColor={!isHighlight && m.price !== 'FREE'}
                      >
                        {m.price}
                      </Text>
                      {isCurrent && <Text color="green"> ←</Text>}
                    </Box>
                  );
                })}
              </Box>
            ))}
            <Box marginTop={1} marginLeft={2}>
              <Text dimColor>Your conversation stays above — picking a model keeps all history intact.</Text>
            </Box>
          </Box>
        );
      })()}

      {/* Full-width input box — blocked when permission or askUser dialog is active
          or while the model picker is open. */}
      {!inPicker && (
        <InputBox
          input={(permissionRequest || askUserRequest) ? '' : input}
          setInput={(permissionRequest || askUserRequest) ? () => {} : setInput}
          onSubmit={(permissionRequest || askUserRequest) ? () => {} : handleSubmit}
          model={currentModel}
          balance={liveBalance}
          sessionCost={totalCost}
          queued={queuedInputs[0] || undefined}
          queuedCount={queuedInputs.length}
          focused={!permissionRequest && !askUserRequest}
          busy={!askUserRequest && (waiting || thinking || tools.size > 0)}
          contextPct={contextPct}
          vimMode={vimEnabled}
          onVimModeChange={setCurrentVimMode}
        />
      )}
    </Box>
  );
}

// ─── Launcher ──────────────────────────────────────────────────────────────

export interface InkUIHandle {
  handleEvent: (event: StreamEvent) => void;
  updateModel: (model: string) => void;
  updateBalance: (balance: string) => void;
  onTurnDone: (cb: () => void) => void;
  waitForInput: () => Promise<string | null>;
  onAbort: (cb: () => void) => void;
  cleanup: () => void;
  requestPermission: (toolName: string, description: string) => Promise<'yes' | 'no' | 'always'>;
  requestAskUser: (question: string, options?: string[]) => Promise<string>;
}

export function launchInkUI(opts: {
  model: string;
  workDir: string;
  version: string;
  walletAddress?: string;
  walletBalance?: string;
  chain?: string;
  showPicker?: boolean;
  onModelChange?: (model: string, reason?: 'user' | 'system') => void;
}): InkUIHandle {
  let resolveInput: ((value: string | null) => void) | null = null;
  let pendingInput: string | null = null; // Queue for inputs that arrive before waitForInput
  let exiting = false;
  let abortCallback: (() => void) | null = null;

  const instance = render(
    <RunCodeApp
      initialModel={opts.model}
      workDir={opts.workDir}
      walletAddress={opts.walletAddress || 'not set — run: runcode setup'}
      walletBalance={opts.walletBalance || 'unknown'}
      chain={opts.chain || 'base'}
      startWithPicker={opts.showPicker}
      onSubmit={(value) => {
        if (resolveInput) {
          resolveInput(value);
          resolveInput = null;
        } else {
          // Agent loop hasn't called waitForInput yet — queue the input
          pendingInput = value;
        }
      }}
      onModelChange={(model, reason) => { opts.onModelChange?.(model, reason); }}
      onAbort={() => { abortCallback?.(); }}
      onExit={() => {
        exiting = true;
        if (resolveInput) { resolveInput(null); resolveInput = null; }
      }}
    />
  );

  return {
    handleEvent: (event: StreamEvent) => {
      const ui = (globalThis as Record<string, unknown>).__runcode_ui as {
        handleEvent: (e: StreamEvent) => void;
        updateModel: (m: string) => void;
        updateBalance: (bal: string) => void;
      } | undefined;
      ui?.handleEvent(event);
    },
    updateModel: (model: string) => {
      const ui = (globalThis as Record<string, unknown>).__runcode_ui as {
        updateModel: (m: string) => void;
      } | undefined;
      ui?.updateModel(model);
    },
    updateBalance: (bal: string) => {
      const ui = (globalThis as Record<string, unknown>).__runcode_ui as {
        updateBalance: (bal: string) => void;
      } | undefined;
      ui?.updateBalance(bal);
    },
    onTurnDone: (cb: () => void) => {
      const ui = (globalThis as Record<string, unknown>).__runcode_ui as {
        onTurnDone: (cb: () => void) => void;
      } | undefined;
      ui?.onTurnDone(cb);
    },
    waitForInput: () => {
      if (exiting) return Promise.resolve(null);
      // If user already submitted while we were processing, return immediately
      if (pendingInput !== null) {
        const input = pendingInput;
        pendingInput = null;
        return Promise.resolve(input);
      }
      return new Promise<string | null>((resolve) => { resolveInput = resolve; });
    },
    onAbort: (cb: () => void) => { abortCallback = cb; },
    cleanup: () => { mouse.disable(); instance.unmount(); },
    requestPermission: (toolName: string, description: string) => {
      const ui = (globalThis as Record<string, unknown>).__runcode_ui as {
        requestPermission: (toolName: string, description: string) => Promise<'yes' | 'no' | 'always'>;
      } | undefined;
      return ui?.requestPermission(toolName, description) ?? Promise.resolve('no' as const);
    },
    requestAskUser: (question: string, options?: string[]) => {
      const ui = (globalThis as Record<string, unknown>).__runcode_ui as {
        requestAskUser: (question: string, options?: string[]) => Promise<string>;
      } | undefined;
      return ui?.requestAskUser(question, options) ?? Promise.resolve('(no response)');
    },
  };
}
