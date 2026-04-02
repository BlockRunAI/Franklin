import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * RunCode ink-based terminal UI.
 * Real-time streaming, thinking animation, tool progress, slash commands.
 */
import { useState, useEffect, useCallback } from 'react';
import { render, Box, Text, useApp, useInput, useStdout } from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import { resolveModel } from './model-picker.js';
// ─── Full-width input box ──────────────────────────────────────────────────
function InputBox({ input, setInput, onSubmit, model, balance }) {
    const { stdout } = useStdout();
    const cols = stdout?.columns ?? 80;
    const innerWidth = Math.max(40, cols - 4); // 4 = borders + padding
    return (_jsxs(Box, { flexDirection: "column", marginTop: 1, children: [_jsx(Text, { dimColor: true, children: '╭' + '─'.repeat(cols - 2) + '╮' }), _jsxs(Box, { children: [_jsx(Text, { dimColor: true, children: "\u2502 " }), _jsx(Box, { width: innerWidth, children: _jsx(TextInput, { value: input, onChange: setInput, onSubmit: onSubmit, placeholder: "Ask anything... (/model to switch, /help for commands)" }) }), _jsxs(Text, { dimColor: true, children: [' '.repeat(Math.max(0, cols - innerWidth - 4)), "\u2502"] })] }), _jsx(Text, { dimColor: true, children: '╰' + '─'.repeat(cols - 2) + '╯' }), _jsx(Box, { marginLeft: 1, children: _jsxs(Text, { dimColor: true, children: [model, "  \u00B7  ", balance, "  \u00B7  esc to quit"] }) })] }));
}
// ─── Model picker data ─────────────────────────────────────────────────────
const PICKER_MODELS = [
    { id: 'zai/glm-5', shortcut: 'glm', label: '🔥 GLM-5 (promo til Apr 15)', price: '$0.001/call', highlight: true },
    { id: 'anthropic/claude-sonnet-4.6', shortcut: 'sonnet', label: 'Claude Sonnet 4.6', price: '$3/$15' },
    { id: 'anthropic/claude-opus-4.6', shortcut: 'opus', label: 'Claude Opus 4.6', price: '$5/$25' },
    { id: 'openai/gpt-5.4', shortcut: 'gpt', label: 'GPT-5.4', price: '$2.5/$15' },
    { id: 'google/gemini-2.5-pro', shortcut: 'gemini', label: 'Gemini 2.5 Pro', price: '$1.25/$10' },
    { id: 'deepseek/deepseek-chat', shortcut: 'deepseek', label: 'DeepSeek V3', price: '$0.28' },
    { id: 'google/gemini-2.5-flash', shortcut: 'flash', label: 'Gemini 2.5 Flash', price: '$0.15/$0.6' },
    { id: 'openai/gpt-5-mini', shortcut: 'mini', label: 'GPT-5 Mini', price: '$0.25/$2' },
    { id: 'anthropic/claude-haiku-4.5-20251001', shortcut: 'haiku', label: 'Claude Haiku 4.5', price: '$0.8/$4' },
    { id: 'openai/gpt-5-nano', shortcut: 'nano', label: 'GPT-5 Nano', price: '$0.05/$0.4' },
    { id: 'deepseek/deepseek-reasoner', shortcut: 'r1', label: 'DeepSeek R1', price: '$0.28' },
    { id: 'openai/o4-mini', shortcut: 'o4', label: 'O4 Mini', price: '$1.1/$4.4' },
    { id: 'nvidia/nemotron-ultra-253b', shortcut: 'free', label: 'Nemotron Ultra 253B', price: 'FREE' },
    { id: 'nvidia/qwen3-coder-480b', shortcut: 'qwen-coder', label: 'Qwen3 Coder 480B', price: 'FREE' },
    { id: 'nvidia/devstral-2-123b', shortcut: 'devstral', label: 'Devstral 2 123B', price: 'FREE' },
];
function RunCodeApp({ initialModel, workDir, walletAddress, walletBalance, chain, onSubmit, onModelChange, onExit, }) {
    const { exit } = useApp();
    const [input, setInput] = useState('');
    const [streamText, setStreamText] = useState('');
    const [thinking, setThinking] = useState(false);
    const [waiting, setWaiting] = useState(false);
    const [tools, setTools] = useState(new Map());
    const [currentModel, setCurrentModel] = useState(initialModel);
    const [ready, setReady] = useState(true);
    const [mode, setMode] = useState('input');
    const [pickerIdx, setPickerIdx] = useState(0);
    const [statusMsg, setStatusMsg] = useState('');
    const [turnTokens, setTurnTokens] = useState({ input: 0, output: 0 });
    const [totalCost, setTotalCost] = useState(0);
    const [showHelp, setShowHelp] = useState(false);
    const [showWallet, setShowWallet] = useState(false);
    useInput((ch, key) => {
        // Esc to quit (when not in picker)
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
            setTimeout(() => setStatusMsg(''), 3000);
        }
        else if (key.escape)
            setMode('input');
    });
    const handleSubmit = useCallback((value) => {
        const trimmed = value.trim();
        if (!trimmed)
            return;
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
                default:
                    setStatusMsg(`Unknown command: ${cmd}. Try /help`);
                    setTimeout(() => setStatusMsg(''), 3000);
                    return;
            }
        }
        // ── Normal prompt ──
        setInput('');
        setStreamText('');
        setThinking(false);
        setTools(new Map());
        setReady(false);
        setWaiting(true);
        setStatusMsg('');
        setShowHelp(false);
        setShowWallet(false);
        setTurnTokens({ input: 0, output: 0 });
        onSubmit(trimmed);
    }, [currentModel, totalCost, onSubmit, onModelChange, onExit, exit]);
    // Expose event handler
    useEffect(() => {
        globalThis.__runcode_ui = {
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
                                    preview: event.result.output.replace(/\n/g, ' ').slice(0, 120),
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
                        break;
                    case 'turn_done':
                        setReady(true);
                        setWaiting(false);
                        setThinking(false);
                        break;
                }
            },
        };
        return () => { delete globalThis.__runcode_ui; };
    }, []);
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
    return (_jsxs(Box, { flexDirection: "column", children: [statusMsg && (_jsx(Box, { marginLeft: 2, children: _jsx(Text, { color: "green", children: statusMsg }) })), showHelp && (_jsxs(Box, { flexDirection: "column", marginLeft: 2, marginTop: 1, marginBottom: 1, children: [_jsx(Text, { bold: true, children: "Commands" }), _jsx(Text, { children: " " }), _jsxs(Text, { children: ["  ", _jsx(Text, { color: "cyan", children: "/model" }), " [name]  Switch model (picker if no name)"] }), _jsxs(Text, { children: ["  ", _jsx(Text, { color: "cyan", children: "/wallet" }), "        Show wallet address & balance"] }), _jsxs(Text, { children: ["  ", _jsx(Text, { color: "cyan", children: "/cost" }), "          Session cost"] }), _jsxs(Text, { children: ["  ", _jsx(Text, { color: "cyan", children: "/help" }), "          This help"] }), _jsxs(Text, { children: ["  ", _jsx(Text, { color: "cyan", children: "/exit" }), "          Quit"] }), _jsx(Text, { children: " " }), _jsx(Text, { dimColor: true, children: "  Shortcuts: sonnet, opus, gpt, gemini, deepseek, flash, free, r1, o4, nano, mini, haiku" })] })), showWallet && (_jsxs(Box, { flexDirection: "column", marginLeft: 2, marginTop: 1, marginBottom: 1, children: [_jsx(Text, { bold: true, children: "Wallet" }), _jsx(Text, { children: " " }), _jsxs(Text, { children: ["  Chain:   ", _jsx(Text, { color: "magenta", children: chain })] }), _jsxs(Text, { children: ["  Address: ", _jsx(Text, { color: "cyan", children: walletAddress })] }), _jsxs(Text, { children: ["  Balance: ", _jsx(Text, { color: "green", children: walletBalance })] })] })), Array.from(tools.values()).map((tool, i) => (_jsx(Box, { marginLeft: 1, children: tool.done ? (tool.error
                    ? _jsxs(Text, { color: "red", children: ["  \u2717 ", tool.name, " ", _jsxs(Text, { dimColor: true, children: [tool.elapsed, "ms"] })] })
                    : _jsxs(Text, { color: "green", children: ["  \u2713 ", tool.name, " ", _jsxs(Text, { dimColor: true, children: [tool.elapsed, "ms \u2014 ", tool.preview.slice(0, 60), tool.preview.length > 60 ? '...' : ''] })] })) : (_jsxs(Text, { color: "cyan", children: ["  ", _jsx(Spinner, { type: "dots" }), " ", tool.name, "..."] })) }, i))), thinking && (_jsx(Box, { marginLeft: 1, children: _jsxs(Text, { color: "magenta", children: ["  ", _jsx(Spinner, { type: "dots" }), " thinking..."] }) })), waiting && !thinking && tools.size === 0 && (_jsx(Box, { marginLeft: 1, children: _jsxs(Text, { color: "yellow", children: ["  ", _jsx(Spinner, { type: "dots" }), " ", _jsx(Text, { dimColor: true, children: currentModel })] }) })), streamText && (_jsx(Box, { marginTop: 0, marginBottom: 0, children: _jsx(Text, { children: streamText }) })), ready && (turnTokens.input > 0 || turnTokens.output > 0) && streamText && (_jsx(Box, { marginLeft: 1, marginTop: 0, children: _jsxs(Text, { dimColor: true, children: [turnTokens.input.toLocaleString(), " in / ", turnTokens.output.toLocaleString(), " out"] }) })), ready && (_jsx(InputBox, { input: input, setInput: setInput, onSubmit: handleSubmit, model: currentModel, balance: walletBalance }))] }));
}
export function launchInkUI(opts) {
    let resolveInput = null;
    let exiting = false;
    const instance = render(_jsx(RunCodeApp, { initialModel: opts.model, workDir: opts.workDir, walletAddress: opts.walletAddress || 'not set — run: runcode setup', walletBalance: opts.walletBalance || 'unknown', chain: opts.chain || 'base', onSubmit: (value) => {
            if (resolveInput) {
                resolveInput(value);
                resolveInput = null;
            }
        }, onModelChange: (model) => { opts.onModelChange?.(model); }, onExit: () => {
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
        waitForInput: () => {
            if (exiting)
                return Promise.resolve(null);
            return new Promise((resolve) => { resolveInput = resolve; });
        },
        cleanup: () => { instance.unmount(); },
    };
}
