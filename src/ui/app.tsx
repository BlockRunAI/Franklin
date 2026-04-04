/**
 * RunCode ink-based terminal UI.
 * Real-time streaming, thinking animation, tool progress, slash commands.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { render, Box, Text, useApp, useInput, useStdout } from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import type { StreamEvent } from '../agent/types.js';
import { resolveModel } from './model-picker.js';
import { estimateCost } from '../pricing.js';

// ─── Full-width input box ──────────────────────────────────────────────────

function InputBox({ input, setInput, onSubmit, model, balance, focused }: {
  input: string;
  setInput: (v: string) => void;
  onSubmit: (v: string) => void;
  model: string;
  balance: string;
  focused?: boolean;
}) {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const innerWidth = Math.max(40, cols - 4);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>{'╭' + '─'.repeat(cols - 2) + '╮'}</Text>
      <Box>
        <Text dimColor>│ </Text>
        <Box width={innerWidth}>
          <TextInput
            value={input}
            onChange={setInput}
            onSubmit={onSubmit}
            placeholder="Ask anything... (/model to switch, /help for commands)"
            focus={focused !== false}
          />
        </Box>
        <Text dimColor>{' '.repeat(Math.max(0, cols - innerWidth - 4))}│</Text>
      </Box>
      <Text dimColor>{'╰' + '─'.repeat(cols - 2) + '╯'}</Text>
      <Box marginLeft={1}>
        <Text dimColor>{model}  ·  {balance}  ·  esc to abort/quit</Text>
      </Box>
    </Box>
  );
}

// ─── Model picker data ─────────────────────────────────────────────────────

const PICKER_MODELS = [
  { id: 'zai/glm-5', shortcut: 'glm', label: '🔥 GLM-5 (promo til Apr 15)', price: '$0.001/call', highlight: true },
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
  preview: string;
  elapsed: number;
}

type UIMode = 'input' | 'model-picker';

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
  const [currentModel, setCurrentModel] = useState(initialModel || PICKER_MODELS[0].id);
  const [ready, setReady] = useState(!startWithPicker);
  const [mode, setMode] = useState<UIMode>(startWithPicker ? 'model-picker' : 'input');
  const [pickerIdx, setPickerIdx] = useState(0);
  const [statusMsg, setStatusMsg] = useState('');
  const [turnTokens, setTurnTokens] = useState({ input: 0, output: 0 });
  const [totalCost, setTotalCost] = useState(0);
  const [showHelp, setShowHelp] = useState(false);
  const [showWallet, setShowWallet] = useState(false);
  const [balance, setBalance] = useState(walletBalance);
  const [thinkingText, setThinkingText] = useState('');
  const [lastPrompt, setLastPrompt] = useState('');

  // Key handler for picker + esc + abort
  const isPickerOrEsc = mode === 'model-picker' || (mode === 'input' && ready && !input) || !ready;
  useInput((ch, key) => {
    // Escape during generation → abort current turn
    if (key.escape && !ready) {
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

  const handleSubmit = useCallback((value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;

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
          setTurnTokens({ input: 0, output: 0 });
          setStatusMsg('Conversation cleared');
          setTimeout(() => setStatusMsg(''), 3000);
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
          setTurnTokens({ input: 0, output: 0 });
          onSubmit(lastPrompt);
          return;

        case '/compact':
          setStreamText('');
          setThinking(false);
          setThinkingText('');
          setTools(new Map());
          setWaiting(true);
          setReady(false);
          onSubmit('/compact');
          return;

        default:
          setStatusMsg(`Unknown command: ${cmd}. Try /help`);
          setTimeout(() => setStatusMsg(''), 3000);
          return;
      }
    }

    // ── Normal prompt ──
    setLastPrompt(trimmed);
    setInput('');
    setStreamText('');
    setThinking(false);
    setThinkingText('');
    setTools(new Map());
    setReady(false);
    setWaiting(true);
    setStatusMsg('');
    setShowHelp(false);
    setShowWallet(false);
    setTurnTokens({ input: 0, output: 0 });
    onSubmit(trimmed);
  }, [currentModel, totalCost, onSubmit, onModelChange, onExit, exit]);

  // Expose event handler + balance updater
  useEffect(() => {
    (globalThis as Record<string, unknown>).__runcode_ui = {
      updateBalance: (bal: string) => setBalance(bal),
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
                done: false, error: false, preview: '', elapsed: 0,
              });
              return next;
            });
            break;
          case 'capability_done':
            setTools(prev => {
              const next = new Map(prev);
              const t = next.get(event.id);
              if (t) {
                next.set(event.id, {
                  ...t, done: true,
                  error: !!event.result.isError,
                  preview: event.result.output.replace(/\n/g, ' ').slice(0, 200),
                  elapsed: Date.now() - t.startTime,
                });
              }
              return next;
            });
            break;
          case 'usage':
            setCurrentModel(event.model);
            setTurnTokens(prev => ({
              input: prev.input + event.inputTokens,
              output: prev.output + event.outputTokens,
            }));
            setTotalCost(prev => prev + estimateCost(event.model, event.inputTokens, event.outputTokens));
            break;
          case 'turn_done':
            setReady(true);
            setWaiting(false);
            setThinking(false);
            setThinkingText('');
            break;
        }
      },
    };
    return () => { delete (globalThis as Record<string, unknown>).__runcode_ui; };
  }, []);

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
          <Text>  <Text color="cyan">/clear</Text>         Clear conversation display</Text>
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

      {/* Active tools */}
      {Array.from(tools.values()).map((tool, i) => (
        <Box key={i} marginLeft={1}>
          {tool.done ? (
            tool.error
              ? <Text color="red">  ✗ {tool.name} <Text dimColor>{tool.elapsed}ms</Text></Text>
              : <Text color="green">  ✓ {tool.name} <Text dimColor>{tool.elapsed}ms — {tool.preview.slice(0, 200)}{tool.preview.length > 200 ? '...' : ''}</Text></Text>
          ) : (
            <Text color="cyan">  <Spinner type="dots" /> {tool.name}... <Text dimColor>{Math.round((Date.now() - tool.startTime) / 1000)}s</Text></Text>
          )}
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

      {/* Response */}
      {streamText && (
        <Box marginTop={0} marginBottom={0}>
          <Text>{streamText}</Text>
        </Box>
      )}

      {/* Token count + cost after response */}
      {ready && (turnTokens.input > 0 || turnTokens.output > 0) && streamText && (
        <Box marginLeft={1} marginTop={0}>
          <Text dimColor>
            {turnTokens.input.toLocaleString()} in / {turnTokens.output.toLocaleString()} out
            {totalCost > 0 ? `  ·  $${totalCost.toFixed(4)} session` : ''}
          </Text>
        </Box>
      )}

      {/* Full-width input box */}
      {ready && (
        <InputBox
          input={input}
          setInput={setInput}
          onSubmit={handleSubmit}
          model={currentModel}
          balance={balance}
          focused={mode === 'input'}
        />
      )}
    </Box>
  );
}

// ─── Launcher ──────────────────────────────────────────────────────────────

export interface InkUIHandle {
  handleEvent: (event: StreamEvent) => void;
  updateBalance: (balance: string) => void;
  waitForInput: () => Promise<string | null>;
  onAbort: (cb: () => void) => void;
  cleanup: () => void;
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
    waitForInput: () => {
      if (exiting) return Promise.resolve(null);
      return new Promise<string | null>((resolve) => { resolveInput = resolve; });
    },
    onAbort: (cb: () => void) => { abortCallback = cb; },
    cleanup: () => { instance.unmount(); },
  };
}
