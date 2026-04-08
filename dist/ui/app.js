import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * RunCode ink-based terminal UI.
 * Real-time streaming, thinking animation, tool progress, slash commands.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { render, Static, Box, Text, useApp, useInput, useStdout } from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import { resolveModel } from './model-picker.js';
import { estimateCost } from '../pricing.js';
// ─── Full-width input box ──────────────────────────────────────────────────
function InputBox({ input, setInput, onSubmit, model, balance, sessionCost, queued, focused, busy }) {
    const { stdout } = useStdout();
    const cols = stdout?.columns ?? 80;
    const innerWidth = Math.min(Math.max(30, cols - 4), cols - 2);
    const placeholder = busy
        ? (queued ? `⏎ queued: ${queued.slice(0, 40)}` : 'Working...')
        : 'Type a message...';
    return (_jsxs(Box, { flexDirection: "column", marginTop: 1, children: [_jsx(Text, { dimColor: true, children: '╭' + '─'.repeat(cols - 2) + '╮' }), _jsxs(Box, { children: [_jsx(Text, { dimColor: true, children: "\u2502 " }), busy && !input ? _jsxs(Text, { color: "yellow", children: [_jsx(Spinner, { type: "dots" }), " "] }) : null, _jsx(Box, { width: busy && !input ? innerWidth - 4 : innerWidth, children: _jsx(TextInput, { value: input, onChange: setInput, onSubmit: onSubmit, placeholder: placeholder, focus: focused !== false }) }), _jsxs(Text, { dimColor: true, children: [' '.repeat(Math.max(0, cols - innerWidth - 4)), "\u2502"] })] }), _jsx(Text, { dimColor: true, children: '╰' + '─'.repeat(cols - 2) + '╯' }), _jsx(Box, { marginLeft: 1, children: _jsxs(Text, { dimColor: true, children: [busy ? _jsx(Text, { color: "yellow", children: _jsx(Spinner, { type: "dots" }) }) : null, busy ? ' ' : '', model, "  \u00B7  ", balance, sessionCost > 0.00001 ? _jsxs(Text, { color: "yellow", children: ["  -$", sessionCost.toFixed(4)] }) : '', '  ·  esc to abort/quit'] }) })] }));
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
];
function RunCodeApp({ initialModel, workDir, walletAddress, walletBalance, chain, startWithPicker, onSubmit, onModelChange, onAbort, onExit, }) {
    const { exit } = useApp();
    const [input, setInput] = useState('');
    const [streamText, setStreamText] = useState('');
    const [thinking, setThinking] = useState(false);
    const [waiting, setWaiting] = useState(false);
    const [tools, setTools] = useState(new Map());
    // Completed tool results committed to Static (permanent scrollback — no re-render artifacts)
    const [completedTools, setCompletedTools] = useState([]);
    // Full responses committed to Static immediately — goes into terminal scrollback like Claude Code
    const [committedResponses, setCommittedResponses] = useState([]);
    // Short preview of latest response shown in dynamic area (last ~5 lines, cleared on next turn)
    const [responsePreview, setResponsePreview] = useState('');
    const [currentModel, setCurrentModel] = useState(initialModel || PICKER_MODELS[0].id);
    const [ready, setReady] = useState(!startWithPicker);
    const [mode, setMode] = useState(startWithPicker ? 'model-picker' : 'input');
    const [pickerIdx, setPickerIdx] = useState(0);
    const [statusMsg, setStatusMsg] = useState('');
    const [turnTokens, setTurnTokens] = useState({ input: 0, output: 0, calls: 0 });
    const [totalCost, setTotalCost] = useState(0);
    const [showHelp, setShowHelp] = useState(false);
    const [showWallet, setShowWallet] = useState(false);
    const [balance, setBalance] = useState(walletBalance);
    // Parse the fetched balance to a number so we can compute live balance = fetchedBalance - sessionCost.
    // costAtLastFetch tracks totalCost when balance was last fetched, to avoid double-subtracting.
    const parseBalanceNum = (s) => {
        const m = s.match(/\$([\d.]+)/);
        return m ? parseFloat(m[1]) : null;
    };
    const [baseBalanceNum, setBaseBalanceNum] = useState(() => parseBalanceNum(walletBalance));
    const [costAtLastFetch, setCostAtLastFetch] = useState(0);
    const costAtLastFetchRef = useRef(0);
    const baseBalanceNumRef = useRef(parseBalanceNum(walletBalance));
    const [thinkingText, setThinkingText] = useState('');
    const [lastPrompt, setLastPrompt] = useState('');
    const [inputHistory, setInputHistory] = useState([]);
    const [historyIdx, setHistoryIdx] = useState(-1);
    const [permissionRequest, setPermissionRequest] = useState(null);
    const [askUserRequest, setAskUserRequest] = useState(null);
    const [askUserInput, setAskUserInput] = useState('');
    // Message queued while agent is busy — auto-submitted when turn completes
    const [queuedInput, setQueuedInput] = useState('');
    const turnDoneCallbackRef = useRef(null);
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
        if (!permissionRequest)
            return;
        // Clear any character that leaked into the text input
        setInput('');
        const c = ch.toLowerCase();
        if (c === 'y') {
            const r = permissionRequest.resolve;
            setPermissionRequest(null);
            r('yes');
        }
        else if (c === 'n') {
            const r = permissionRequest.resolve;
            setPermissionRequest(null);
            r('no');
        }
        else if (c === 'a') {
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
        if (mode !== 'model-picker')
            return;
        if (key.upArrow)
            setPickerIdx(i => Math.max(0, i - 1));
        else if (key.downArrow)
            setPickerIdx(i => Math.min(PICKER_MODELS.length - 1, i + 1));
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
        }
        else if (key.downArrow) {
            if (historyIdx >= 0 && historyIdx < inputHistory.length - 1) {
                const newIdx = historyIdx + 1;
                setHistoryIdx(newIdx);
                setInput(inputHistory[newIdx]);
            }
            else {
                setHistoryIdx(-1);
                setInput('');
            }
        }
    }, { isActive: ready && mode === 'input' });
    const handleSubmit = useCallback((value) => {
        const trimmed = value.trim();
        if (!trimmed)
            return;
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
                    }
                    else {
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
        globalThis.__runcode_ui = {
            updateBalance: (bal) => {
                setBalance(bal);
                const num = parseBalanceNum(bal);
                if (num !== null) {
                    setBaseBalanceNum(num);
                    // Reset cost baseline — the fetched balance already reflects costs up to this point
                    setCostAtLastFetch(totalCostRef.current);
                }
            },
            onTurnDone: (cb) => { turnDoneCallbackRef.current = cb; },
            requestPermission: (toolName, description) => {
                return new Promise((resolve) => {
                    // Ring the terminal bell — causes tab to show notification badge in iTerm2/Terminal.app
                    process.stderr.write('\x07');
                    setPermissionRequest({ toolName, description, resolve });
                });
            },
            requestAskUser: (question, options) => {
                return new Promise((resolve) => {
                    process.stderr.write('\x07');
                    setAskUserInput('');
                    setAskUserRequest({ question, options, resolve });
                });
            },
            handleEvent: (event) => {
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
                            if (!t || t.done)
                                return prev;
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
                                const completed = {
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
                                const fn = globalThis.__runcode_submit;
                                if (typeof fn === 'function')
                                    fn(queued);
                            }, 50);
                        }
                        break;
                    }
                }
            },
        };
        globalThis.__runcode_submit = (msg) => {
            handleSubmit(msg);
        };
        return () => {
            delete globalThis.__runcode_ui;
            delete globalThis.__runcode_submit;
        };
    }, [handleSubmit]);
    // ── Model Picker ──
    if (mode === 'model-picker') {
        return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Text, { bold: true, children: ['\n', "  Select a model  ", _jsx(Text, { dimColor: true, children: "(\u2191\u2193 navigate, Enter select, Esc cancel)" })] }), _jsx(Text, { children: " " }), PICKER_MODELS.map((m, i) => {
                    const isHighlight = 'highlight' in m && m.highlight;
                    const isSelected = i === pickerIdx;
                    const isCurrent = m.id === currentModel;
                    return (_jsxs(Box, { marginLeft: 2, children: [_jsxs(Text, { inverse: isSelected, color: isSelected ? 'cyan' : isHighlight ? 'yellow' : undefined, bold: isSelected || isHighlight, children: [' ', m.label.padEnd(26), ' '] }), _jsxs(Text, { dimColor: true, children: [" ", m.shortcut.padEnd(12)] }), _jsx(Text, { color: m.price === 'FREE' ? 'green' : isHighlight ? 'yellow' : undefined, dimColor: !isHighlight && m.price !== 'FREE', children: m.price }), isCurrent && _jsx(Text, { color: "green", children: " \u2190" })] }, m.id));
                }), _jsx(Text, { children: " " })] }));
    }
    // ── Normal Mode ──
    return (_jsxs(Box, { flexDirection: "column", children: [statusMsg && (_jsx(Box, { marginLeft: 2, children: _jsx(Text, { color: "green", children: statusMsg }) })), showHelp && (_jsxs(Box, { flexDirection: "column", marginLeft: 2, marginTop: 1, marginBottom: 1, children: [_jsx(Text, { bold: true, children: "Commands" }), _jsx(Text, { children: " " }), _jsxs(Text, { children: ["  ", _jsx(Text, { color: "cyan", children: "/model" }), " [name]  Switch model (picker if no name)"] }), _jsxs(Text, { children: ["  ", _jsx(Text, { color: "cyan", children: "/wallet" }), "        Show wallet address & balance"] }), _jsxs(Text, { children: ["  ", _jsx(Text, { color: "cyan", children: "/cost" }), "          Session cost & savings"] }), _jsxs(Text, { children: ["  ", _jsx(Text, { color: "cyan", children: "/retry" }), "         Retry the last prompt"] }), _jsxs(Text, { children: ["  ", _jsx(Text, { color: "cyan", children: "/compact" }), "       Compress conversation history"] }), _jsx(Text, { dimColor: true, children: "  \u2500\u2500 Coding \u2500\u2500" }), _jsxs(Text, { children: ["  ", _jsx(Text, { color: "cyan", children: "/test" }), "          Run tests"] }), _jsxs(Text, { children: ["  ", _jsx(Text, { color: "cyan", children: "/fix" }), "           Fix last error"] }), _jsxs(Text, { children: ["  ", _jsx(Text, { color: "cyan", children: "/review" }), "        Code review"] }), _jsxs(Text, { children: ["  ", _jsx(Text, { color: "cyan", children: "/explain" }), " file  Explain code"] }), _jsxs(Text, { children: ["  ", _jsx(Text, { color: "cyan", children: "/search" }), " query  Search codebase"] }), _jsxs(Text, { children: ["  ", _jsx(Text, { color: "cyan", children: "/refactor" }), " desc Refactor code"] }), _jsxs(Text, { children: ["  ", _jsx(Text, { color: "cyan", children: "/scaffold" }), " desc Generate boilerplate"] }), _jsx(Text, { dimColor: true, children: "  \u2500\u2500 Git \u2500\u2500" }), _jsxs(Text, { children: ["  ", _jsx(Text, { color: "cyan", children: "/commit" }), "        Commit changes"] }), _jsxs(Text, { children: ["  ", _jsx(Text, { color: "cyan", children: "/push" }), "          Push to remote"] }), _jsxs(Text, { children: ["  ", _jsx(Text, { color: "cyan", children: "/pr" }), "            Create pull request"] }), _jsxs(Text, { children: ["  ", _jsx(Text, { color: "cyan", children: "/status" }), "        Git status"] }), _jsxs(Text, { children: ["  ", _jsx(Text, { color: "cyan", children: "/diff" }), "          Git diff"] }), _jsxs(Text, { children: ["  ", _jsx(Text, { color: "cyan", children: "/log" }), "           Git log"] }), _jsxs(Text, { children: ["  ", _jsx(Text, { color: "cyan", children: "/branch" }), " [name] Branches"] }), _jsxs(Text, { children: ["  ", _jsx(Text, { color: "cyan", children: "/stash" }), "         Stash changes"] }), _jsxs(Text, { children: ["  ", _jsx(Text, { color: "cyan", children: "/undo" }), "          Undo last commit"] }), _jsx(Text, { dimColor: true, children: "  \u2500\u2500 Analysis \u2500\u2500" }), _jsxs(Text, { children: ["  ", _jsx(Text, { color: "cyan", children: "/security" }), "      Security audit"] }), _jsxs(Text, { children: ["  ", _jsx(Text, { color: "cyan", children: "/lint" }), "          Quality check"] }), _jsxs(Text, { children: ["  ", _jsx(Text, { color: "cyan", children: "/optimize" }), "      Performance check"] }), _jsxs(Text, { children: ["  ", _jsx(Text, { color: "cyan", children: "/todo" }), "          Find TODOs"] }), _jsxs(Text, { children: ["  ", _jsx(Text, { color: "cyan", children: "/deps" }), "          Dependencies"] }), _jsxs(Text, { children: ["  ", _jsx(Text, { color: "cyan", children: "/clean" }), "         Dead code removal"] }), _jsxs(Text, { children: ["  ", _jsx(Text, { color: "cyan", children: "/context" }), "       Session info (model, tokens, mode)"] }), _jsxs(Text, { children: ["  ", _jsx(Text, { color: "cyan", children: "/plan" }), "          Enter plan mode (read-only tools)"] }), _jsxs(Text, { children: ["  ", _jsx(Text, { color: "cyan", children: "/execute" }), "       Exit plan mode (enable all tools)"] }), _jsxs(Text, { children: ["  ", _jsx(Text, { color: "cyan", children: "/sessions" }), "      List saved sessions"] }), _jsxs(Text, { children: ["  ", _jsx(Text, { color: "cyan", children: "/resume" }), " id     Resume a saved session"] }), _jsxs(Text, { children: ["  ", _jsx(Text, { color: "cyan", children: "/clear" }), "         Clear conversation display"] }), _jsxs(Text, { children: ["  ", _jsx(Text, { color: "cyan", children: "/doctor" }), "        Diagnose setup issues"] }), _jsxs(Text, { children: ["  ", _jsx(Text, { color: "cyan", children: "/help" }), "          This help"] }), _jsxs(Text, { children: ["  ", _jsx(Text, { color: "cyan", children: "/exit" }), "          Quit"] }), _jsx(Text, { children: " " }), _jsx(Text, { dimColor: true, children: "  Shortcuts: sonnet, opus, gpt, gemini, deepseek, flash, free, r1, o4, nano, mini, haiku" })] })), showWallet && (_jsxs(Box, { flexDirection: "column", marginLeft: 2, marginTop: 1, marginBottom: 1, children: [_jsx(Text, { bold: true, children: "Wallet" }), _jsx(Text, { children: " " }), _jsxs(Text, { children: ["  Chain:   ", _jsx(Text, { color: "magenta", children: chain })] }), _jsxs(Text, { children: ["  Address: ", _jsx(Text, { color: "cyan", children: walletAddress })] }), _jsxs(Text, { children: ["  Balance: ", _jsx(Text, { color: "green", children: balance })] })] })), _jsx(Static, { items: completedTools, children: (tool) => (_jsx(Box, { marginLeft: 1, children: tool.error
                        ? _jsxs(Text, { color: "red", children: ["  \u2717 ", tool.name, " ", _jsxs(Text, { dimColor: true, children: [tool.elapsed, "ms", tool.preview ? ` — ${tool.preview}` : ''] })] })
                        : _jsxs(Text, { color: "green", children: ["  \u2713 ", tool.name, " ", _jsxs(Text, { dimColor: true, children: [tool.elapsed, "ms", tool.preview ? ` — ${tool.preview}` : ''] })] }) }, tool.key)) }), _jsx(Static, { items: committedResponses, children: (r) => (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { children: r.text }), (r.tokens.input > 0 || r.tokens.output > 0) && (_jsx(Box, { marginLeft: 1, children: _jsxs(Text, { dimColor: true, children: [r.tokens.calls > 0 && r.tokens.input === 0
                                        ? `${r.tokens.calls} calls`
                                        : `${r.tokens.input.toLocaleString()} in / ${r.tokens.output.toLocaleString()} out${r.tokens.calls > 0 ? ` / ${r.tokens.calls} calls` : ''}`, r.cost > 0 ? `  ·  $${r.cost.toFixed(4)}` : ''] }) }))] }, r.key)) }), permissionRequest && (_jsxs(Box, { flexDirection: "column", marginTop: 1, marginLeft: 1, children: [_jsx(Text, { color: "yellow", children: "  \u256D\u2500 Permission required \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500" }), _jsxs(Text, { color: "yellow", children: ["  \u2502 ", _jsx(Text, { bold: true, children: permissionRequest.toolName })] }), permissionRequest.description.split('\n').map((line, i) => (_jsxs(Text, { dimColor: true, children: ["  \u2502 ", line] }, i))), _jsx(Text, { color: "yellow", children: "  \u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500" }), _jsx(Box, { marginLeft: 3, children: _jsxs(Text, { children: [_jsx(Text, { bold: true, color: "green", children: "[y]" }), _jsx(Text, { dimColor: true, children: " yes  " }), _jsx(Text, { bold: true, color: "cyan", children: "[a]" }), _jsx(Text, { dimColor: true, children: " always  " }), _jsx(Text, { bold: true, color: "red", children: "[n]" }), _jsx(Text, { dimColor: true, children: " no" })] }) })] })), askUserRequest && (_jsxs(Box, { flexDirection: "column", marginTop: 1, marginLeft: 1, children: [_jsx(Text, { color: "cyan", children: "  \u256D\u2500 Question \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500" }), _jsxs(Text, { color: "cyan", children: ["  \u2502 ", _jsx(Text, { bold: true, children: askUserRequest.question })] }), askUserRequest.options && askUserRequest.options.length > 0 && (askUserRequest.options.map((opt, i) => (_jsxs(Text, { dimColor: true, children: ["  \u2502 ", i + 1, ". ", opt] }, i)))), _jsx(Text, { color: "cyan", children: "  \u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500" }), _jsxs(Box, { marginLeft: 3, children: [_jsx(Text, { bold: true, children: "answer> " }), _jsx(TextInput, { value: askUserInput, onChange: setAskUserInput, onSubmit: (val) => {
                                    const answer = val.trim() || '(no response)';
                                    const r = askUserRequest.resolve;
                                    setAskUserRequest(null);
                                    setAskUserInput('');
                                    r(answer);
                                }, focus: true })] })] })), Array.from(tools.entries()).map(([id, tool]) => (_jsxs(Box, { flexDirection: "column", marginLeft: 1, children: [_jsxs(Text, { color: "cyan", children: ['  ', _jsx(Spinner, { type: "dots" }), ' ', tool.name, tool.preview ? _jsxs(Text, { dimColor: true, children: [": ", tool.preview] }) : null, _jsx(Text, { dimColor: true, children: (() => { const s = Math.round((Date.now() - tool.startTime) / 1000); return s > 0 ? ` ${s}s` : ''; })() })] }), tool.liveOutput ? (_jsxs(Text, { dimColor: true, children: ["  \u2514 ", tool.liveOutput] })) : null] }, id))), thinking && (_jsxs(Box, { flexDirection: "column", marginLeft: 1, children: [_jsxs(Text, { color: "magenta", children: ["  ", _jsx(Spinner, { type: "dots" }), " thinking..."] }), thinkingText && (_jsxs(Text, { dimColor: true, wrap: "truncate-end", children: ["  ", thinkingText.split('\n').pop()?.slice(0, 80)] }))] })), waiting && !thinking && tools.size === 0 && (_jsx(Box, { marginLeft: 1, children: _jsxs(Text, { color: "yellow", children: ["  ", _jsx(Spinner, { type: "dots" }), " ", _jsx(Text, { dimColor: true, children: currentModel })] }) })), streamText && (_jsx(Box, { marginTop: 0, marginBottom: 0, children: _jsx(Text, { children: streamText }) })), responsePreview && !streamText && (_jsx(Box, { flexDirection: "column", marginBottom: 0, children: _jsx(Text, { children: responsePreview }) })), _jsx(InputBox, { input: (permissionRequest || askUserRequest) ? '' : input, setInput: (permissionRequest || askUserRequest) ? () => { } : setInput, onSubmit: (permissionRequest || askUserRequest) ? () => { } : handleSubmit, model: currentModel, balance: liveBalance, sessionCost: totalCost, queued: queuedInput || undefined, focused: !permissionRequest && !askUserRequest, busy: !askUserRequest && (waiting || thinking || tools.size > 0) })] }));
}
export function launchInkUI(opts) {
    let resolveInput = null;
    let pendingInput = null; // Queue for inputs that arrive before waitForInput
    let exiting = false;
    let abortCallback = null;
    const instance = render(_jsx(RunCodeApp, { initialModel: opts.model, workDir: opts.workDir, walletAddress: opts.walletAddress || 'not set — run: runcode setup', walletBalance: opts.walletBalance || 'unknown', chain: opts.chain || 'base', startWithPicker: opts.showPicker, onSubmit: (value) => {
            if (resolveInput) {
                resolveInput(value);
                resolveInput = null;
            }
            else {
                // Agent loop hasn't called waitForInput yet — queue the input
                pendingInput = value;
            }
        }, onModelChange: (model) => { opts.onModelChange?.(model); }, onAbort: () => { abortCallback?.(); }, onExit: () => {
            exiting = true;
            if (resolveInput) {
                resolveInput(null);
                resolveInput = null;
            }
        } }));
    return {
        handleEvent: (event) => {
            const ui = globalThis.__runcode_ui;
            ui?.handleEvent(event);
        },
        updateBalance: (bal) => {
            const ui = globalThis.__runcode_ui;
            ui?.updateBalance(bal);
        },
        onTurnDone: (cb) => {
            const ui = globalThis.__runcode_ui;
            ui?.onTurnDone(cb);
        },
        waitForInput: () => {
            if (exiting)
                return Promise.resolve(null);
            // If user already submitted while we were processing, return immediately
            if (pendingInput !== null) {
                const input = pendingInput;
                pendingInput = null;
                return Promise.resolve(input);
            }
            return new Promise((resolve) => { resolveInput = resolve; });
        },
        onAbort: (cb) => { abortCallback = cb; },
        cleanup: () => { instance.unmount(); },
        requestPermission: (toolName, description) => {
            const ui = globalThis.__runcode_ui;
            return ui?.requestPermission(toolName, description) ?? Promise.resolve('no');
        },
        requestAskUser: (question, options) => {
            const ui = globalThis.__runcode_ui;
            return ui?.requestAskUser(question, options) ?? Promise.resolve('(no response)');
        },
    };
}
