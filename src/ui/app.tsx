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
import { resolveAskUserAnswer } from './ask-user-answer.js';

// ─── Full-width input box ──────────────────────────────────────────────────

const BRACKETED_PASTE_START = '[200~';
const BRACKETED_PASTE_END = '[201~';
const ENABLE_BRACKETED_PASTE = '\x1b[?2004h';
const DISABLE_BRACKETED_PASTE = '\x1b[?2004l';
const USER_PROMPT_COLOR = '#FFD700';
const PASTE_BLOCK_START = '\uE000PASTE:';
const PASTE_BLOCK_END = ':PASTE\uE001';

const DISABLE_AUTO_WRAP = '\x1b[?7l';
const ENABLE_AUTO_WRAP = '\x1b[?7h';

function stripPasteMarkers(input: string): string {
  return input
    .replaceAll(BRACKETED_PASTE_START, '')
    .replaceAll(BRACKETED_PASTE_END, '');
}

function normalizeInputNewlines(input: string): string {
  return input.replace(/\r\n|\r|\n/g, '\n').replace(/\x1b/g, '');
}

function shouldSummarizeInput(value: string): boolean {
  return value.includes('\n') || value.length > 240;
}

interface PasteBlock {
  start: number;
  end: number;
  content: string;
}

function encodePasteBlock(content: string): string {
  return `${PASTE_BLOCK_START}${Buffer.from(content, 'utf8').toString('base64')}${PASTE_BLOCK_END}`;
}

function decodePasteBlock(token: string): string {
  if (!token.startsWith(PASTE_BLOCK_START) || !token.endsWith(PASTE_BLOCK_END)) return token;
  const payload = token.slice(PASTE_BLOCK_START.length, -PASTE_BLOCK_END.length);
  try {
    return Buffer.from(payload, 'base64').toString('utf8');
  } catch {
    return token;
  }
}

function findPasteBlocks(value: string): PasteBlock[] {
  const blocks: PasteBlock[] = [];
  let searchFrom = 0;

  while (searchFrom < value.length) {
    const start = value.indexOf(PASTE_BLOCK_START, searchFrom);
    if (start < 0) break;
    const endMarker = value.indexOf(PASTE_BLOCK_END, start + PASTE_BLOCK_START.length);
    if (endMarker < 0) break;
    const end = endMarker + PASTE_BLOCK_END.length;
    blocks.push({ start, end, content: decodePasteBlock(value.slice(start, end)) });
    searchFrom = end;
  }

  return blocks;
}

function decodePromptValue(value: string): string {
  let decoded = '';
  let cursor = 0;

  for (const block of findPasteBlocks(value)) {
    decoded += value.slice(cursor, block.start) + block.content;
    cursor = block.end;
  }

  return decoded + value.slice(cursor);
}

function pasteSummary(content: string): string {
  const lines = content.length === 0 ? 0 : content.split('\n').length;
  const lineLabel = lines > 1 ? `~${lines} lines` : '~1 line';
  return `[Pasted ${lineLabel}]`;
}

function renderInputValue(value: string, cursorOffset: number, focused: boolean): string {
  const blocks = findPasteBlocks(value);
  if (blocks.length > 0) {
    let rendered = '';
    let cursor = 0;

    for (const block of blocks) {
      rendered += renderPlainInputSegment(value.slice(cursor, block.start), cursorOffset - cursor, focused && cursorOffset >= cursor && cursorOffset <= block.start);
      if (focused && cursorOffset === block.start) rendered += chalk.inverse(' ');
      rendered += chalk.hex(USER_PROMPT_COLOR).bold(pasteSummary(block.content));
      if (focused && cursorOffset === block.end) rendered += chalk.inverse(' ');
      cursor = block.end;
    }

    rendered += renderPlainInputSegment(value.slice(cursor), cursorOffset - cursor, focused && cursorOffset >= cursor);
    return rendered || (focused ? chalk.inverse(' ') : '');
  }

  return renderPlainInputSegment(value, cursorOffset, focused);
}

function renderPlainInputSegment(value: string, cursorOffset: number, focused: boolean): string {
  const displayValue = value.replace(/\r\n|\r|\n/g, ' ');
  if (!focused) return displayValue;

  const safeCursor = Math.max(0, Math.min(cursorOffset, displayValue.length));
  if (displayValue.length === 0) return chalk.inverse(' ');

  const before = displayValue.slice(0, safeCursor);
  const current = displayValue[safeCursor] ?? ' ';
  const after = displayValue.slice(safeCursor + (safeCursor < displayValue.length ? 1 : 0));
  return before + chalk.inverse(current) + after;
}

function PromptTextInput({ value, onChange, onSubmit, placeholder = '', focus = true }: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  placeholder?: string;
  focus?: boolean;
}) {
  const [cursorOffset, setCursorOffset] = useState(value.length);
  const valueRef = useRef(value);
  const cursorOffsetRef = useRef(value.length);
  const pasteActiveRef = useRef(false);
  const pasteBufferRef = useRef('');

  useEffect(() => {
    valueRef.current = value;
    setCursorOffset((offset) => {
      const nextOffset = Math.min(offset, value.length);
      cursorOffsetRef.current = nextOffset;
      return nextOffset;
    });
  }, [value]);

  const updateValue = useCallback((nextValue: string, nextCursorOffset: number) => {
    valueRef.current = nextValue;
    cursorOffsetRef.current = Math.max(0, Math.min(nextCursorOffset, nextValue.length));
    onChange(nextValue);
    setCursorOffset(cursorOffsetRef.current);
  }, [onChange]);

  useInput((input, key) => {
    if (!focus) return;

    const currentValue = valueRef.current;
    const currentCursorOffset = cursorOffsetRef.current;
    const pasteBlockBeforeCursor = findPasteBlocks(currentValue).find((block) => block.end === currentCursorOffset);
    const pasteBlockAfterCursor = findPasteBlocks(currentValue).find((block) => block.start === currentCursorOffset);

    const hasPasteStart = input.includes(BRACKETED_PASTE_START);
    const hasPasteEnd = input.includes(BRACKETED_PASTE_END);
    const isPasting = pasteActiveRef.current || hasPasteStart;

    if (hasPasteStart && !pasteActiveRef.current) {
      pasteActiveRef.current = true;
      pasteBufferRef.current = '';
    }

    if (key.return && !isPasting) {
      onSubmit(decodePromptValue(currentValue));
      return;
    }

    if (key.home || (key.ctrl && input === 'a')) {
      cursorOffsetRef.current = 0;
      setCursorOffset(0);
      return;
    }

    if (key.end || (key.ctrl && input === 'e')) {
      cursorOffsetRef.current = currentValue.length;
      setCursorOffset(currentValue.length);
      return;
    }

    if (key.leftArrow) {
      const previousBlock = findPasteBlocks(currentValue).find((block) => block.end === currentCursorOffset);
      const nextOffset = previousBlock ? previousBlock.start : Math.max(0, currentCursorOffset - 1);
      cursorOffsetRef.current = nextOffset;
      setCursorOffset(nextOffset);
      return;
    }

    if (key.rightArrow) {
      const nextBlock = findPasteBlocks(currentValue).find((block) => block.start === currentCursorOffset);
      const nextOffset = nextBlock ? nextBlock.end : Math.min(currentValue.length, currentCursorOffset + 1);
      cursorOffsetRef.current = nextOffset;
      setCursorOffset(nextOffset);
      return;
    }

    if (key.backspace || key.delete) {
      if (key.backspace && pasteBlockBeforeCursor) {
        updateValue(currentValue.slice(0, pasteBlockBeforeCursor.start) + currentValue.slice(pasteBlockBeforeCursor.end), pasteBlockBeforeCursor.start);
        return;
      }

      if (key.delete && pasteBlockAfterCursor) {
        updateValue(currentValue.slice(0, pasteBlockAfterCursor.start) + currentValue.slice(pasteBlockAfterCursor.end), pasteBlockAfterCursor.start);
        return;
      }

      if (currentCursorOffset > 0) {
        updateValue(
          currentValue.slice(0, currentCursorOffset - 1) + currentValue.slice(currentCursorOffset),
          currentCursorOffset - 1,
        );
      }
      return;
    }

    if (key.upArrow || key.downArrow || key.tab || key.ctrl || key.meta) return;

    let text = normalizeInputNewlines(stripPasteMarkers(input));
    if (key.return && isPasting) text = '\n';

    if (isPasting) {
      pasteBufferRef.current += text;

      if (!hasPasteEnd) return;

      text = encodePasteBlock(pasteBufferRef.current);
      pasteBufferRef.current = '';
      pasteActiveRef.current = false;
    }

    if (!text) {
      if (hasPasteEnd) pasteActiveRef.current = false;
      return;
    }

    updateValue(
      currentValue.slice(0, currentCursorOffset) + text + currentValue.slice(currentCursorOffset),
      currentCursorOffset + text.length,
    );

    if (hasPasteEnd) pasteActiveRef.current = false;
  }, { isActive: focus });

  const rendered = value.length > 0
    ? renderInputValue(value, cursorOffset, focus)
    : (focus && placeholder ? chalk.inverse(placeholder[0]) + chalk.grey(placeholder.slice(1)) : chalk.grey(placeholder));

  return <Text>{rendered}</Text>;
}

function formatUserPromptForDisplay(value: string): string {
  return `❯ ${decodePromptValue(value)}`;
}

function disableTerminalAutoWrap(): (() => void) | undefined {
  if (!process.stdout.isTTY) return undefined;

  let restored = false;
  const restore = () => {
    if (restored || !process.stdout.writable) return;
    restored = true;
    process.stdout.write(ENABLE_AUTO_WRAP);
  };

  process.stdout.write(DISABLE_AUTO_WRAP);
  process.once('exit', restore);

  return () => {
    process.off('exit', restore);
    restore();
  };
}

function enableBracketedPaste(): (() => void) | undefined {
  if (!process.stdout.isTTY) return undefined;

  let restored = false;
  const restore = () => {
    if (restored || !process.stdout.writable) return;
    restored = true;
    process.stdout.write(DISABLE_BRACKETED_PASTE);
  };

  process.stdout.write(ENABLE_BRACKETED_PASTE);
  process.once('exit', restore);

  return () => {
    process.off('exit', restore);
    restore();
  };
}

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

function InputBox({ input, setInput, onSubmit, model, balance, chain, walletTail, sessionCost, queued, queuedCount, focused, busy, awaitingApproval, awaitingAnswer, contextPct, vimMode, onVimModeChange }: {
  input: string;
  setInput: (v: string) => void;
  onSubmit: (v: string) => void;
  model: string;
  balance: string;
  /** 'base' | 'solana' — shown next to the balance so users with wallets on both chains can tell which one they're seeing. */
  chain?: string;
  /** Last 4 chars of the wallet address — disambiguates installations on the same chain. */
  walletTail?: string;
  sessionCost: number;
  queued?: string;
  queuedCount?: number;
  focused?: boolean;
  busy?: boolean;
  /** True when a Permission required dialog is up — input box swaps its
   *  spinner+placeholder for an unmissable "approve above" pointer so users
   *  in another window don't see "Working..." and assume the agent is busy. */
  awaitingApproval?: boolean;
  /** True when an AskUser dialog is up. Same idea, different wording. */
  awaitingAnswer?: boolean;
  contextPct?: number;
  vimMode?: boolean;
  onVimModeChange?: (mode: VimMode) => void;
}) {
  const { cols } = useTerminalSize();
  // Avoid drawing right up to the terminal edge. Several terminals auto-wrap
  // a full-width border glyph onto the next row, which leaves "ghost" top
  // borders behind on re-render after errors / status changes.
  const boxWidth = Math.max(20, cols - 2);

  // Awaiting-input states beat "Working..." — the agent isn't busy, it's
  // blocked on the user. Saying "Working..." here while a permission dialog
  // sits in the scrollback above is exactly how users miss it (verified
  // 2026-05-04 from a real screenshot — "Working..." spinner kept turning
  // while the agent waited on a Bash approval).
  const placeholder = awaitingApproval
    ? '⚠  Approval needed — press [y]/[a]/[n] in the prompt above'
    : awaitingAnswer
    ? '⚠  Question above — type your answer'
    : busy
    ? (queued
        ? `⏎ ${queuedCount ?? 1} queued: ${queued.slice(0, 40)}`
        : 'Working...')
    : 'Type a message...';

  // Color the input-box border to match the urgency. Awaiting-user states
  // get a bright yellow border so the focal point physically moves down to
  // the input field, even peripheral vision picks it up.
  const borderColor = awaitingApproval || awaitingAnswer ? 'yellow' : undefined;
  const showSpinner = busy && !input && !awaitingApproval && !awaitingAnswer;
  const leadingGlyph = (awaitingApproval || awaitingAnswer)
    ? <Text color="yellow" bold>⚠ </Text>
    : (showSpinner ? <Text color="yellow"><Spinner type="dots" /> </Text> : null);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box borderStyle="round" borderColor={borderColor} borderDimColor={!borderColor} paddingX={1} width={boxWidth}>
        {leadingGlyph}
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
            <PromptTextInput
              value={input}
              onChange={setInput}
              onSubmit={onSubmit}
              placeholder={placeholder}
              focus={focused !== false}
            />
          )}
        </Box>
      </Box>
      <Box marginLeft={2}>
        <Text dimColor>
          {busy ? <Text color="yellow"><Spinner type="dots" /></Text> : null}
          {busy ? ' ' : ''}{shortModelName(model)}  ·  {(() => {
            // Color the balance by funding state. Real session 2026-05-04
            // had a user staring at "$0.08 USDC" in dim text wondering
            // whether it meant "out of money" or "wrong chain". Make
            // low/critical balances unmistakable. Thresholds match the
            // ~$0.10 / ~$0.50 ranges where a typical Opus turn ($0.08–
            // $0.15) tips over: <$0.50 = red bold + low hint;
            // <$1.00 = yellow; otherwise plain dim.
            const m = balance.match(/\$([\d.]+)/);
            const num = m ? parseFloat(m[1]) : null;
            if (num !== null && num < 0.50) {
              return <><Text color="red" bold>{balance}</Text><Text color="red"> ⚠ low — fund wallet or /model free</Text></>;
            }
            if (num !== null && num < 1.00) {
              return <Text color="yellow">{balance}</Text>;
            }
            return balance;
          })()}
          {chain ? <Text>  ·  <Text color="magenta">{chain}</Text>{walletTail ? <Text dimColor>:{walletTail}</Text> : ''}</Text> : ''}
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
  // Track terminal rows so we can cap the dynamic-region height. Ink wipes the
  // terminal scrollback (via ansiEscapes.clearTerminal → \x1b[3J) whenever the
  // dynamic output exceeds rows, so any tall live region (streaming text,
  // model picker) must be windowed to preserve "scroll to the start" history.
  const { rows: termRows } = useTerminalSize();
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
  const [committedResponses, setCommittedResponses] = useState<Array<{ key: string; text: string; tokens: { input: number; output: number; calls: number }; cost: number; model?: string; tier?: string; savings?: number; thinkMs?: number; thinkChars?: number; ctxPct?: number }>>([]);
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

  // Ring the terminal bell exactly once when a permission/askUser dialog
  // first appears. Helpful when the user has Franklin in a background
  // tab and the agent stops to ask for approval — verified 2026-05-04
  // from a real screenshot where the user missed the dialog because the
  // input box still read "Working...". Opt-out via FRANKLIN_NO_BELL=1.
  const bellPlayedRef = useRef(false);
  useEffect(() => {
    const dialogActive = !!permissionRequest || !!askUserRequest;
    if (dialogActive && !bellPlayedRef.current) {
      bellPlayedRef.current = true;
      if (process.env.FRANKLIN_NO_BELL !== '1') {
        try { process.stderr.write('\x07'); } catch { /* swallow — never break the UI on a TTY without bell */ }
      }
    } else if (!dialogActive) {
      bellPlayedRef.current = false;
    }
  }, [permissionRequest, askUserRequest]);
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
  const turnCtxPctRef = useRef<number | undefined>(undefined);
  const queuedInputsRef = useRef<string[]>([]);
  const lastCtrlCRef = useRef(0);

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

  const requestExit = useCallback((abortTurn = false) => {
    if (abortTurn) onAbort();
    onExit();
    exit();
  }, [onAbort, onExit, exit]);

  useInput((ch, key) => {
    if (!(key.ctrl && ch === 'c')) return;

    const now = Date.now();
    if (now - lastCtrlCRef.current < 2000) {
      requestExit(true);
      return;
    }

    lastCtrlCRef.current = now;
    showStatus('Press Ctrl+C again to exit', 'warning', 2000);
  });

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
        ctxPct: turnCtxPctRef.current,
        thinkMs,
        thinkChars,
      }];
      // Cap at 300 items — older items are already in terminal scrollback
      return next.length > 300 ? next.slice(-300) : next;
    });

    setResponsePreview('');
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
  useInput((_ch, key) => {
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
      requestExit(false);
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
      requestExit(true);
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
          turnCtxPctRef.current = undefined;
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
          turnCtxPctRef.current = undefined;
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
      text: formatUserPromptForDisplay(trimmed),
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
    turnCtxPctRef.current = undefined;
    onSubmit(trimmed);
  }, [ready, currentModel, totalCost, onSubmit, onModelChange, requestExit, lastPrompt, inputHistory, showStatus]);

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
    (globalThis as Record<string, unknown>).__franklin_ui = {
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
            if (event.contextPct !== undefined) {
              setContextPct(event.contextPct);
              turnCtxPctRef.current = event.contextPct;
            }
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
                const fn = (globalThis as Record<string, unknown>).__franklin_submit;
                if (typeof fn === 'function') fn(queued);
              }, 50);
            }
            break;
          }
        }
      },
    };
    (globalThis as Record<string, unknown>).__franklin_submit = (msg: string) => {
      handleSubmit(msg);
    };
    return () => {
      delete (globalThis as Record<string, unknown>).__franklin_ui;
      delete (globalThis as Record<string, unknown>).__franklin_submit;
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
                {isUserMsg ? (
                  <Text wrap="wrap" color={USER_PROMPT_COLOR} bold>{r.text}</Text>
                ) : (
                  <Text wrap="wrap">{renderMarkdown(r.text)}</Text>
                )}
              </Box>
              {(r.tokens.input > 0 || r.tokens.output > 0) && (
                <Box marginLeft={2} marginBottom={1}>
                  <Text dimColor>
                    {r.tier
                      ? <Text color="cyan">[{r.tier}] </Text>
                      : (r.model ? <Text dimColor>[direct] </Text> : null)}
                    {r.model ? shortModelName(r.model) : ''}
                    {r.model ? '  ·  ' : ''}
                    {r.tokens.calls > 0 && r.tokens.input === 0
                      ? `${r.tokens.calls} calls`
                      : `${formatTokens(r.tokens.input)} in / ${formatTokens(r.tokens.output)} out`}
                    {r.cost > 0 ? `  ·  $${r.cost.toFixed(4)}` : ''}
                    {r.savings !== undefined && r.savings > 0 ? <Text color="green">  saved {Math.round(r.savings * 100)}%</Text> : ''}
                    {r.ctxPct !== undefined && r.ctxPct >= 5
                      ? <Text color={r.ctxPct >= 80 ? 'red' : r.ctxPct >= 50 ? 'yellow' : undefined} dimColor={r.ctxPct < 50}>  ·  ctx {r.ctxPct}%</Text>
                      : ''}
                  </Text>
                </Box>
              )}
            </Box>
          );
        }}
      </Static>

      {/* Permission dialog — rendered inline, captured via useInput above.
          Visual prominence is critical here. The pre-3.15.27 yellow box was
          easy to miss in a busy scrollback (verified from a real screenshot
          where the user didn't notice the prompt and the bottom spinner
          kept reading "Working..."). Now: red ACTION REQUIRED header, the
          input box below changes its placeholder to match (see InputBox),
          and we hide the waiting spinner / stream / response preview while
          this is up so the dialog sits alone right above the input field. */}
      {permissionRequest && (
        <Box flexDirection="column" marginTop={1} marginLeft={2}>
          <Text color="red" bold>━━━━━━━━━━ ⚠  ACTION REQUIRED  ⚠ ━━━━━━━━━━</Text>
          <Text color="yellow">╭─ Permission required ─────────────────</Text>
          <Text color="yellow">│ <Text bold>{permissionRequest.toolName}</Text></Text>
          {permissionRequest.description.split('\n').map((line, i) => (
            <Text key={i} dimColor>│ {line}</Text>
          ))}
          <Text color="yellow">╰─────────────────────────────────────</Text>
          <Box marginLeft={2}>
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

      {/* AskUser dialog — text input for agent questions. Same urgency
          treatment as permission: bright header, hidden noise around it. */}
      {askUserRequest && (
        <Box flexDirection="column" marginTop={1} marginLeft={2}>
          <Text color="magenta" bold>━━━━━━━━━━ ⚠  ANSWER REQUIRED  ⚠ ━━━━━━━━━━</Text>
          <Text color="cyan">╭─ Question ─────────────────────────────</Text>
          <Text color="cyan">│ <Text bold>{askUserRequest.question}</Text></Text>
          {askUserRequest.options && askUserRequest.options.length > 0 && (
            askUserRequest.options.map((opt, i) => (
              <Text key={i} dimColor>│ {i + 1}. {opt}</Text>
            ))
          )}
          <Text color="cyan">╰─────────────────────────────────────</Text>
          <Box marginLeft={2}>
            <Text bold>answer&gt; </Text>
            <TextInput
              value={askUserInput}
              onChange={setAskUserInput}
              onSubmit={(val) => {
                // resolveAskUserAnswer translates "1" / "2" / ... into the
                // matching label string when the dialog showed a numbered
                // option list. Without it, every onAskUser caller's
                // exact-label match fails for digit answers and silently
                // falls through to the default branch (typically cancel).
                const answer = resolveAskUserAnswer(val, askUserRequest.options);
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

      {/* Expandable tool — last completed tool, can be toggled with Tab.
          Hidden while a dialog is active so the dialog stays at the bottom. */}
      {expandableTool && !permissionRequest && !askUserRequest && (() => {
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

      {/* Active (in-progress) tools — bordered box with multi-line streaming output.
          Hidden during permission/askUser dialogs so the dialog can sit alone
          right above the input field — the user's focal point shouldn't be
          divided while we're waiting on them. */}
      {!permissionRequest && !askUserRequest && Array.from(tools.entries()).map(([id, tool]) => {
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
      {thinking && !permissionRequest && !askUserRequest && (
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
      {waiting && !thinking && tools.size === 0 && !permissionRequest && !askUserRequest && (
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
          Ink's wrap would then mangle.

          Capped to the last ~(rows - 12) lines: the full text is committed to
          Static at turn end (committedResponses), so scrollback retains every
          word. Capping here is purely to keep Ink's dynamic region under the
          terminal height — when it exceeds rows, Ink fires clearTerminal
          which wipes the user's entire scrollback buffer. */}
      {streamText && !permissionRequest && !askUserRequest && (() => {
        const maxLines = Math.max(8, termRows - 12);
        const lines = streamText.split('\n');
        const truncated = lines.length > maxLines;
        const visible = truncated ? lines.slice(-maxLines).join('\n') : streamText;
        const { rendered, partial } = renderMarkdownStreaming(visible);
        return (
          <Box flexDirection="column" marginTop={0} marginBottom={0} marginLeft={2}>
            {truncated && (
              <Text dimColor>↑ {lines.length - maxLines} earlier line{lines.length - maxLines === 1 ? '' : 's'} — full response will appear in scrollback when this turn finishes</Text>
            )}
            <Text wrap="wrap">
              {rendered}
              {rendered && partial ? '\n' : ''}
              {partial}
            </Text>
          </Box>
        );
      })()}

      {/* Preview of latest response — last 5 lines shown in dynamic area for quick reference.
          Full text is already in Static/scrollback above. Cleared when next turn starts.
          Hidden while a dialog is active so the dialog stays at the bottom. */}
      {responsePreview && !streamText && !permissionRequest && !askUserRequest && (
        <Box flexDirection="column" marginBottom={0} marginLeft={2}>
          <Text wrap="wrap">{renderMarkdown(responsePreview)}</Text>
        </Box>
      )}

      {/* Model picker — rendered inline below scrollback. Categories shown as
          dim headers, flat cursor (pickerIdx) navigates all non-header rows.
          Hides the InputBox while active but leaves all Static scrollback
          above it mounted, so conversation history visually survives a switch.

          Viewport: at most ~(rows - 12) model rows are shown at once, windowed
          around pickerIdx. Beyond that we render "↑ N more" / "↓ N more"
          markers. Same reason as streamText — Ink wipes scrollback the moment
          dynamic output exceeds the terminal height. */}
      {inPicker && (() => {
        const totalModels = PICKER_MODELS_FLAT.length;
        const maxModels = Math.max(6, termRows - 12);
        let start = Math.max(0, pickerIdx - Math.floor(maxModels / 2));
        let end = Math.min(totalModels, start + maxModels);
        // Expand window backward if we hit the bottom of the list, so we
        // always fill `maxModels` rows when the list is long enough.
        if (end - start < maxModels) start = Math.max(0, end - maxModels);
        const hiddenAbove = start;
        const hiddenBelow = totalModels - end;
        // Pre-compute each category's base offset into the flat model list so
        // we can map (cat, localIdx) → globalIdx in one pass without re-walking.
        let cursor = 0;
        const catBases = PICKER_CATEGORIES.map((cat) => {
          const base = cursor;
          cursor += cat.models.length;
          return base;
        });
        return (
          <Box flexDirection="column" marginTop={1}>
            <Box marginLeft={2}>
              <Text bold>Select a model </Text>
              <Text dimColor>(↑↓ navigate, Enter select, Esc cancel)</Text>
            </Box>
            {hiddenAbove > 0 && (
              <Box marginLeft={2} marginTop={1}>
                <Text dimColor>↑ {hiddenAbove} more above</Text>
              </Box>
            )}
            {PICKER_CATEGORIES.map((cat, catIdx) => {
              const base = catBases[catIdx];
              const visible = cat.models
                .map((m, localIdx) => ({ m, globalIdx: base + localIdx }))
                .filter(({ globalIdx }) => globalIdx >= start && globalIdx < end);
              if (visible.length === 0) return null;
              return (
                <Box key={cat.category} flexDirection="column" marginTop={1}>
                  <Box marginLeft={2}>
                    <Text dimColor>── {cat.category} ──</Text>
                  </Box>
                  {visible.map(({ m, globalIdx }) => {
                    const isSelected = globalIdx === pickerIdx;
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
              );
            })}
            {hiddenBelow > 0 && (
              <Box marginLeft={2} marginTop={1}>
                <Text dimColor>↓ {hiddenBelow} more below</Text>
              </Box>
            )}
            <Box marginTop={1} marginLeft={2}>
              <Text dimColor>Your conversation stays above — picking a model keeps all history intact.</Text>
            </Box>
          </Box>
        );
      })()}

      {/* Full-width input box — hidden while a dialog is active (dialog has its own
          input row) or while the model picker is open. Hiding it when the dialog
          shows lets the dialog sit at the visual bottom instead of stranding an
          empty input below it. */}
      {!inPicker && !permissionRequest && !askUserRequest && (
        <InputBox
          input={input}
          setInput={setInput}
          onSubmit={handleSubmit}
          model={currentModel}
          balance={liveBalance}
          chain={chain}
          walletTail={walletAddress && walletAddress.length >= 4 && !walletAddress.startsWith('not set') ? walletAddress.slice(-4) : undefined}
          sessionCost={totalCost}
          queued={queuedInputs[0] || undefined}
          queuedCount={queuedInputs.length}
          focused={!permissionRequest && !askUserRequest}
          busy={!askUserRequest && (waiting || thinking || tools.size > 0)}
          awaitingApproval={!!permissionRequest}
          awaitingAnswer={!!askUserRequest}
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
  const restoreTerminalAutoWrap = disableTerminalAutoWrap();
  const restoreBracketedPaste = enableBracketedPaste();
  let cleanedUp = false;
  let instance: ReturnType<typeof render> | undefined;

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    mouse.disable();
    restoreBracketedPaste?.();
    restoreTerminalAutoWrap?.();
    instance?.unmount();
  };

  instance = render(
    <RunCodeApp
      initialModel={opts.model}
      workDir={opts.workDir}
      walletAddress={opts.walletAddress || 'not set — run: franklin setup'}
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
        cleanup();
      }}
    />,
    { exitOnCtrlC: false }
  );

  return {
    handleEvent: (event: StreamEvent) => {
      const ui = (globalThis as Record<string, unknown>).__franklin_ui as {
        handleEvent: (e: StreamEvent) => void;
        updateModel: (m: string) => void;
        updateBalance: (bal: string) => void;
      } | undefined;
      ui?.handleEvent(event);
    },
    updateModel: (model: string) => {
      const ui = (globalThis as Record<string, unknown>).__franklin_ui as {
        updateModel: (m: string) => void;
      } | undefined;
      ui?.updateModel(model);
    },
    updateBalance: (bal: string) => {
      const ui = (globalThis as Record<string, unknown>).__franklin_ui as {
        updateBalance: (bal: string) => void;
      } | undefined;
      ui?.updateBalance(bal);
    },
    onTurnDone: (cb: () => void) => {
      const ui = (globalThis as Record<string, unknown>).__franklin_ui as {
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
    cleanup,
    requestPermission: (toolName: string, description: string) => {
      const ui = (globalThis as Record<string, unknown>).__franklin_ui as {
        requestPermission: (toolName: string, description: string) => Promise<'yes' | 'no' | 'always'>;
      } | undefined;
      return ui?.requestPermission(toolName, description) ?? Promise.resolve('no' as const);
    },
    requestAskUser: (question: string, options?: string[]) => {
      const ui = (globalThis as Record<string, unknown>).__franklin_ui as {
        requestAskUser: (question: string, options?: string[]) => Promise<string>;
      } | undefined;
      return ui?.requestAskUser(question, options) ?? Promise.resolve('(no response)');
    },
  };
}
