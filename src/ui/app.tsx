/**
 * RunCode ink-based terminal UI.
 * Real-time streaming, thinking animation, tool progress, slash commands.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { render, Static, Box, Text, useApp, useInput, useStdout } from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import type { StreamEvent } from '../agent/types.js';
import { resolveModel } from './model-picker.js';
import { estimateCost } from '../pricing.js';

// ─── Full-width input box ──────────────────────────────────────────────────

function InputBox({ input, setInput, onSubmit, model, balance, sessionCost, queued, focused, busy }: {
  input: string;
  setInput: (v: string) => void;
  onSubmit: (v: string) => void;
  model: string;
  balance: string;
  sessionCost: number;
  queued?: string;
  focused?: boolean;
  busy?: boolean;
}) {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const innerWidth = Math.min(Math.max(30, cols - 4), cols - 2);

  const placeholder = busy
    ? (queued ? `⏎ queued: ${queued.slice(0, 40)}` : 'Working...')
    : 'Type a message...';

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>{'╭' + '─'.repeat(cols - 2) + '╮'}</Text>
      <Box>
        <Text dimColor>│ </Text>
        {busy && !input ? <Text color="yellow"><Spinner type="dots" /> </Text> : null}
        <Box width={busy && !input ? innerWidth - 4 : innerWidth}>
          <TextInput
            value={input}
            onChange={setInput}
            onSubmit={onSubmit}
            placeholder={placeholder}
            focus={focused !== false}
          />
        </Box>
        <Text dimColor>{' '.repeat(Math.max(0, cols - innerWidth - 4))}│</Text>
      </Box>
      <Text dimColor>{'╰' + '─'.repeat(cols - 2) + '╯'}</Text>
      <Box marginLeft={1}>
        <Text dimColor>
          {busy ? <Text color="yellow"><Spinner type="dots" /></Text> : null}
          {busy ? ' ' : ''}{model}  ·  {balance}
          {sessionCost > 0.00001 ? <Text color="yellow">  -${sessionCost.toFixed(4)}</Text> : ''}
          {'  ·  esc to abort/quit'}
        </Text>
      </Box>
    </Box>
  );
}

// ─── Model picker data ─────────────────────────────────────────────────────

const PICKER_MODELS = [
  { id: 'zai/glm-5.1', shortcut: 'glm', label: '🔥 GLM-5.1 (promo til Apr 15)', price: '$0.001/call', highlight: true },
  { id: 'zai/glm-5.1-turbo', shortcut: 'glm-turbo', label: 'GLM-5.1 Turbo', price: '$0.001/call' },
  { id: 'anthropic/claude-sonnet-4.6', shortcut: 'sonnet', label: 'Claude Sonnet 4.6', price: '$3/$15' },
  { id: 'anthropic/claude-opus-4.6', shortcut: 'opus', label: 'Claude Opus 4.6', price: '$5/$25' },
  { id: 'openai/gpt-5.4', shortcut: 'gpt', label: 'GPT-5.4', price: '$2.5/$15' },
  { id: 'google/gemini-2.5-pro', shortcut: 'gemini', label: 'Gemini 2.5 Pro', price: '$1.25/$10' },
  { id: 'deepseek/deepseek-chat', shortcut: 'deepseek', label: 'DeepSeek V3', price: '$0.28/$0.42' },
  { id: 'google/gemini-2.5-flash', shortcut: 'flash', label: 'Gemini 2.5 Flash', price: '$0.15/$0.6' },
  { id: 'openai/gpt-5-mini', shortcut: 'mini', label: 'GPT-5 Mini', price: '$0.25/$2' },
  { id: 'anthropic/claude-haiku-4.5-20251001', shortcut: 'haiku', label: 'Claude Haiku 4.5', price: '$1/$5' },
  { id: 'openai/gpt-5-nano', shortcut: 'nano', label: 'GPT-5 Nano', price: '$0.05/$0.4' },
  { id: 'deepseek/deepseek-reasoner', shortcut: 'r1', label: 'DeepSeek R1', price: '$0.28/$0.42' },
  { id: 'openai/o4-mini', shortcut: 'o4', label: 'O4 Mini', price: '$1.1/$4.4' },
  { id: 'nvidia/nemotron-ultra-253b', shortcut: 'free', label: 'Nemotron Ultra 253B', price: 'FREE' },
  { id: 'nvidia/qwen3-coder-480b', shortcut: 'qwen-coder', label: 'Qwen3 Coder 480B', price: 'FREE' },
  { id: 'nvidia/devstral-2-123b', shortcut: 'devstral', label: 'Devstral 2 123B', price: 'FREE' },
] as const satisfies readonly { id: string; shortcut: string; label: string; price: string; highlight?: boolean }[];

interface ToolStatus {
  name: string;
  startTime: number;
  done: boolean;
  error: boolean;
  preview: string;    // input preview (command/path) shown in spinner
  liveOutput: string; // latest output line while running
  elapsed: number;
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

// ─── Main App ──────────────────────────────────────────────────────────────

interface AppProps {
  initialModel: string;
  workDir: string;
  walletAddress: string;
  walletBalance: string;
  startWithPicker?: boolean;
  chain: string;
  onSubmit: (input: string) => void;
  onModelChange: (model: string) => void;
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
  // Full responses committed to Static immediately — goes into terminal scrollback like Claude Code
  const [committedResponses, setCommittedResponses] = useState<Array<{ key: string; text: string; tokens: { input: number; output: number; calls: number }; cost: number }>>([]);
  // Short preview of latest response shown in dynamic area (last ~5 lines, cleared on next turn)
  const [responsePreview, setResponsePreview] = useState('');
  const [currentModel, setCurrentModel] = useState(initialModel || PICKER_MODELS[0].id);
  const [ready, setReady] = useState(!startWithPicker);
  const [mode, setMode] = useState<UIMode>(startWithPicker ? 'model-picker' : 'input');
  const [pickerIdx, setPickerIdx] = useState(0);
  const [statusMsg, setStatusMsg] = useState('');
  const [turnTokens, setTurnTokens] = useState({ input: 0, output: 0, calls: 0 });
  const [totalCost, setTotalCost] = useState(0);
  const [showHelp, setShowHelp] = useState(false);
  const [showWallet, setShowWallet] = useState(false);
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
  // Message queued while agent is busy — auto-submitted when turn completes
  const [queuedInput, setQueuedInput] = useState('');
  const turnDoneCallbackRef = useRef<(() => void) | null>(null);
  // Refs to read current state values inside memoized event handlers (avoids stale closures)
  const streamTextRef = useRef('');
  const turnTokensRef = useRef({ input: 0, output: 0, calls: 0 });
  const totalCostRef = useRef(0);
  const turnCostRef = useRef(0); // per-turn cost (reset each turn)
  const queuedInputRef = useRef('');

  // Keep refs in sync so memoized event handlers can read current values
  streamTextRef.current = streamText;
  turnTokensRef.current = turnTokens;
  totalCostRef.current = totalCost;
  queuedInputRef.current = queuedInput;
  costAtLastFetchRef.current = costAtLastFetch;
  baseBalanceNumRef.current = baseBalanceNum;

  // Compute live balance = fetchedBalance - spend_since_last_fetch
  const liveBalance = baseBalanceNum !== null
    ? `$${Math.max(0, baseBalanceNum - (totalCost - costAtLastFetch)).toFixed(2)} USDC`
    : balance;

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
      setStatusMsg('Aborted');
      setReady(true);
      setWaiting(false);
      setThinking(false);
      setTimeout(() => setStatusMsg(''), 3000);
      return;
    }

    // Esc to quit (only when input is empty and in input mode)
    if (key.escape && mode === 'input' && ready && !input) {
      onExit();
      exit();
      return;
    }

    // Arrow key navigation for model picker
    if (mode !== 'model-picker') return;
    if (key.upArrow) setPickerIdx(i => Math.max(0, i - 1));
    else if (key.downArrow) setPickerIdx(i => Math.min(PICKER_MODELS.length - 1, i + 1));
    else if (key.return) {
      const selected = PICKER_MODELS[pickerIdx];
      setCurrentModel(selected.id);
      onModelChange(selected.id);
      setStatusMsg(`Model → ${selected.label}`);
      setMode('input');
      setReady(true);
      setTimeout(() => setStatusMsg(''), 3000);
    }
    else if (key.escape) {
      setMode('input');
      setReady(true);
    }
  }, { isActive: isPickerOrEsc });

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

    // If agent is busy, queue the message — it will be auto-submitted when the turn finishes
    if (!ready) {
      setQueuedInput(trimmed);
      setInput('');
      return;
    }

    // Bare exit/quit (no slash needed)
    const lower = trimmed.toLowerCase();
    if (lower === 'exit' || lower === 'quit' || lower === 'q') {
      onExit();
      exit();
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
        case '/exit':
        case '/quit':
          onExit();
          exit();
          return;

        case '/model':
        case '/models':
          if (parts[1]) {
            const resolved = resolveModel(parts[1]);
            setCurrentModel(resolved);
            onModelChange(resolved);
            setStatusMsg(`Model → ${resolved}`);
            setTimeout(() => setStatusMsg(''), 3000);
          } else {
            const idx = PICKER_MODELS.findIndex(m => m.id === currentModel);
            setPickerIdx(idx >= 0 ? idx : 0);
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
          setStatusMsg(`Cost: $${totalCost.toFixed(4)} this session`);
          setTimeout(() => setStatusMsg(''), 4000);
          return;

        case '/help':
          setShowHelp(true);
          setShowWallet(false);
          return;

        case '/clear':
          setStreamText('');
          setTools(new Map());
          setTurnTokens({ input: 0, output: 0, calls: 0 });
          turnCostRef.current = 0;
          setWaiting(true);
          setReady(false);
          // Pass through to agent loop to clear the actual conversation history
          onSubmit('/clear');
          return;

        case '/retry':
          if (!lastPrompt) {
            setStatusMsg('No previous prompt to retry');
            setTimeout(() => setStatusMsg(''), 3000);
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
    setResponsePreview('');
    setLastPrompt(trimmed);
    setInputHistory(prev => [...prev.slice(-49), trimmed]); // Keep last 50
    setHistoryIdx(-1);
    setInput('');
    setStreamText('');
    setThinking(false);
    setThinkingText('');
    setTools(new Map());
    setCompletedTools([]);
    setReady(false);
    setWaiting(true);
    setStatusMsg('');
    setShowHelp(false);
    setShowWallet(false);
    setTurnTokens({ input: 0, output: 0, calls: 0 });
    turnCostRef.current = 0;
    onSubmit(trimmed);
  }, [currentModel, totalCost, onSubmit, onModelChange, onAbort, onExit, exit, lastPrompt, inputHistory]);

  // Expose event handler, balance updater, and permission bridge
  useEffect(() => {
    (globalThis as Record<string, unknown>).__runcode_ui = {
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
            setWaiting(false);
            setThinking(false);
            setStreamText(prev => prev + event.text);
            break;
          case 'thinking_delta':
            setWaiting(false);
            setThinking(true);
            setThinkingText(prev => {
              // Keep last 500 chars of thinking for display
              const updated = prev + event.text;
              return updated.length > 500 ? updated.slice(-500) : updated;
            });
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
              next.set(event.id, { ...t, liveOutput: event.text });
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
                  elapsed: Date.now() - t.startTime,
                };
                // Move to Static (permanent scrollback) — prevents re-render artifacts
                setCompletedTools(prev2 => [...prev2, completed]);
                next.delete(event.id);
              }
              return next;
            });
            break;
          }
          case 'usage': {
            setCurrentModel(event.model);
            setTurnTokens(prev => ({
              input: prev.input + event.inputTokens,
              output: prev.output + event.outputTokens,
              calls: prev.calls + (event.calls ?? 1),
            }));
            const turnCallCost = estimateCost(event.model, event.inputTokens, event.outputTokens, event.calls ?? 1);
            turnCostRef.current += turnCallCost;
            setTotalCost(prev => prev + turnCallCost);
            break;
          }
          case 'turn_done': {
            // Commit full response to Static immediately — enters terminal scrollback like Claude Code.
            // Also keep a short preview (last 5 lines) visible in the dynamic area.
            const text = streamTextRef.current;
            if (text.trim()) {
              setCommittedResponses(rs => [...rs, {
                key: String(Date.now()),
                text,
                tokens: turnTokensRef.current,
                cost: turnCostRef.current, // per-turn cost, not cumulative
              }]);
              // Preview = last 20 lines of the response so the user sees enough context
              const allLines = text.split('\n');
              const wasTruncated = allLines.length > 20;
              const previewLines = (wasTruncated ? '  ↑ scroll to see full reply\n' : '') + allLines.slice(-20).join('\n');
              setResponsePreview(previewLines);
              setStreamText('');
            }
            setReady(true);
            setWaiting(false);
            setThinking(false);
            setThinkingText('');
            // Trigger balance refresh after each completed turn
            turnDoneCallbackRef.current?.();
            // Ring the terminal bell so the user knows the AI finished
            // (shows notification badge in iTerm2/Terminal.app when tabbed away)
            process.stderr.write('\x07');
            // Auto-submit any message queued while agent was busy
            const queued = queuedInputRef.current;
            if (queued) {
              setQueuedInput('');
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
  }, [handleSubmit]);

  // ── Model Picker ──
  if (mode === 'model-picker') {
    return (
      <Box flexDirection="column">
        <Text bold>{'\n'}  Select a model  <Text dimColor>(↑↓ navigate, Enter select, Esc cancel)</Text></Text>
        <Text> </Text>
        {PICKER_MODELS.map((m, i) => {
          const isHighlight = 'highlight' in m && m.highlight;
          const isSelected = i === pickerIdx;
          const isCurrent = m.id === currentModel;
          return (
            <Box key={m.id} marginLeft={2}>
              <Text
                inverse={isSelected}
                color={isSelected ? 'cyan' : isHighlight ? 'yellow' : undefined}
                bold={isSelected || isHighlight}
              >
                {' '}{m.label.padEnd(26)}{' '}
              </Text>
              <Text dimColor> {m.shortcut.padEnd(12)}</Text>
              <Text color={m.price === 'FREE' ? 'green' : isHighlight ? 'yellow' : undefined} dimColor={!isHighlight && m.price !== 'FREE'}>
                {m.price}
              </Text>
              {isCurrent && <Text color="green"> ←</Text>}
            </Box>
          );
        })}
        <Text> </Text>
      </Box>
    );
  }

  // ── Normal Mode ──
  return (
    <Box flexDirection="column">
      {/* Status message */}
      {statusMsg && (
        <Box marginLeft={2}><Text color="green">{statusMsg}</Text></Box>
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
          <Text>  <Text color="cyan">/clear</Text>         Clear conversation display</Text>
          <Text>  <Text color="cyan">/doctor</Text>        Diagnose setup issues</Text>
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

      {/* Completed tools — Static commits them permanently to scrollback, no re-render artifacts */}
      <Static items={completedTools}>
        {(tool) => (
          <Box key={tool.key} marginLeft={1}>
            {tool.error
              ? <Text color="red">  ✗ {tool.name} <Text dimColor>{tool.elapsed}ms{tool.preview ? ` — ${tool.preview}` : ''}</Text></Text>
              : <Text color="green">  ✓ {tool.name} <Text dimColor>{tool.elapsed}ms{tool.preview ? ` — ${tool.preview}` : ''}</Text></Text>
            }
          </Box>
        )}
      </Static>

      {/* Full responses — committed to Static immediately so all content enters terminal scrollback */}
      <Static items={committedResponses}>
        {(r) => (
          <Box key={r.key} flexDirection="column">
            <Text>{r.text}</Text>
            {(r.tokens.input > 0 || r.tokens.output > 0) && (
              <Box marginLeft={1}>
                <Text dimColor>
                  {r.tokens.calls > 0 && r.tokens.input === 0
                    ? `${r.tokens.calls} calls`
                    : `${r.tokens.input.toLocaleString()} in / ${r.tokens.output.toLocaleString()} out${r.tokens.calls > 0 ? ` / ${r.tokens.calls} calls` : ''}`}
                  {r.cost > 0 ? `  ·  $${r.cost.toFixed(4)}` : ''}
                </Text>
              </Box>
            )}
          </Box>
        )}
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

      {/* Active (in-progress) tools — shows command preview + live output line */}
      {Array.from(tools.entries()).map(([id, tool]) => (
        <Box key={id} flexDirection="column" marginLeft={1}>
          <Text color="cyan">
            {'  '}<Spinner type="dots" />{' '}{tool.name}
            {tool.preview ? <Text dimColor>: {tool.preview}</Text> : null}
            <Text dimColor>{(() => { const s = Math.round((Date.now() - tool.startTime) / 1000); return s > 0 ? ` ${s}s` : ''; })()}</Text>
          </Text>
          {tool.liveOutput ? (
            <Text dimColor>  └ {tool.liveOutput}</Text>
          ) : null}
        </Box>
      ))}

      {/* Thinking */}
      {thinking && (
        <Box flexDirection="column" marginLeft={1}>
          <Text color="magenta">  <Spinner type="dots" /> thinking...</Text>
          {thinkingText && (
            <Text dimColor wrap="truncate-end">  {thinkingText.split('\n').pop()?.slice(0, 80)}</Text>
          )}
        </Box>
      )}

      {/* Waiting */}
      {waiting && !thinking && tools.size === 0 && (
        <Box marginLeft={1}>
          <Text color="yellow">  <Spinner type="dots" /> <Text dimColor>{currentModel}</Text></Text>
        </Box>
      )}

      {/* Streaming response — visible while the model is generating */}
      {streamText && (
        <Box marginTop={0} marginBottom={0}>
          <Text>{streamText}</Text>
        </Box>
      )}

      {/* Preview of latest response — last 5 lines shown in dynamic area for quick reference.
          Full text is already in Static/scrollback above. Cleared when next turn starts. */}
      {responsePreview && !streamText && (
        <Box flexDirection="column" marginBottom={0}>
          <Text>{responsePreview}</Text>
        </Box>
      )}

      {/* Full-width input box — blocked when permission or askUser dialog is active */}
      <InputBox
        input={(permissionRequest || askUserRequest) ? '' : input}
        setInput={(permissionRequest || askUserRequest) ? () => {} : setInput}
        onSubmit={(permissionRequest || askUserRequest) ? () => {} : handleSubmit}
        model={currentModel}
        balance={liveBalance}
        sessionCost={totalCost}
        queued={queuedInput || undefined}
        focused={!permissionRequest && !askUserRequest}
        busy={!askUserRequest && (waiting || thinking || tools.size > 0)}
      />
    </Box>
  );
}

// ─── Launcher ──────────────────────────────────────────────────────────────

export interface InkUIHandle {
  handleEvent: (event: StreamEvent) => void;
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
  onModelChange?: (model: string) => void;
}): InkUIHandle {
  let resolveInput: ((value: string | null) => void) | null = null;
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
        if (resolveInput) { resolveInput(value); resolveInput = null; }
      }}
      onModelChange={(model) => { opts.onModelChange?.(model); }}
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
        updateBalance: (bal: string) => void;
      } | undefined;
      ui?.handleEvent(event);
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
      return new Promise<string | null>((resolve) => { resolveInput = resolve; });
    },
    onAbort: (cb: () => void) => { abortCallback = cb; },
    cleanup: () => { instance.unmount(); },
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
