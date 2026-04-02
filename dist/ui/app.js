import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
/**
 * RunCode ink-based terminal UI.
 * Real-time streaming, thinking animation, tool progress, slash commands.
 */
import { useState, useEffect, useCallback } from 'react';
import { render, Box, Text, useApp, useInput } from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import { resolveModel } from './model-picker.js';
// ─── Model picker data ─────────────────────────────────────────────────────
const PICKER_MODELS = [
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
function RunCodeApp({ initialModel, workDir, onSubmit, onModelChange, onExit }) {
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
    // Arrow key navigation for model picker
    useInput((ch, key) => {
        if (mode !== 'model-picker')
            return;
        if (key.upArrow) {
            setPickerIdx(i => Math.max(0, i - 1));
        }
        else if (key.downArrow) {
            setPickerIdx(i => Math.min(PICKER_MODELS.length - 1, i + 1));
        }
        else if (key.return) {
            const selected = PICKER_MODELS[pickerIdx];
            setCurrentModel(selected.id);
            onModelChange(selected.id);
            setStatusMsg(`Model → ${selected.label}`);
            setMode('input');
            setTimeout(() => setStatusMsg(''), 3000);
        }
        else if (key.escape) {
            setMode('input');
        }
    });
    const handleSubmit = useCallback((value) => {
        const trimmed = value.trim();
        if (!trimmed)
            return;
        // ── Slash commands (handled in-app) ──
        if (trimmed.startsWith('/')) {
            setInput('');
            const parts = trimmed.split(/\s+/);
            const cmd = parts[0].toLowerCase();
            if (cmd === '/exit' || cmd === '/quit') {
                onExit();
                exit();
                return;
            }
            if (cmd === '/model' || cmd === '/models') {
                if (parts[1]) {
                    // Direct switch: /model sonnet
                    const resolved = resolveModel(parts[1]);
                    setCurrentModel(resolved);
                    onModelChange(resolved);
                    setStatusMsg(`Model → ${resolved}`);
                    setTimeout(() => setStatusMsg(''), 3000);
                }
                else {
                    // Open picker
                    const idx = PICKER_MODELS.findIndex(m => m.id === currentModel);
                    setPickerIdx(idx >= 0 ? idx : 0);
                    setMode('model-picker');
                }
                return;
            }
            if (cmd === '/help') {
                setMode('help');
                setTimeout(() => setMode('input'), 100); // Flash help then return
                return;
            }
            if (cmd === '/cost' || cmd === '/usage') {
                setStatusMsg('Use `runcode stats` in another terminal for full stats');
                setTimeout(() => setStatusMsg(''), 4000);
                return;
            }
            setStatusMsg(`Unknown command: ${cmd}. Try /help`);
            setTimeout(() => setStatusMsg(''), 3000);
            return;
        }
        // ── Normal prompt ──
        setInput('');
        setStreamText('');
        setThinking(false);
        setTools(new Map());
        setReady(false);
        setWaiting(true);
        setStatusMsg('');
        onSubmit(trimmed);
    }, [currentModel, onSubmit, onModelChange, onExit, exit]);
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
    // ── Model Picker Mode ──
    if (mode === 'model-picker') {
        return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Text, { bold: true, children: ['\n', "  Select a model (\u2191\u2193 to navigate, Enter to select, Esc to cancel):", '\n'] }), PICKER_MODELS.map((m, i) => (_jsxs(Box, { marginLeft: 2, children: [_jsxs(Text, { color: i === pickerIdx ? 'cyan' : undefined, bold: i === pickerIdx, inverse: i === pickerIdx, children: [' ', m.label.padEnd(24), ' '] }), _jsxs(Text, { dimColor: true, children: [" ", m.shortcut.padEnd(12)] }), _jsx(Text, { color: m.price === 'FREE' ? 'green' : undefined, dimColor: m.price !== 'FREE', children: m.price }), m.id === currentModel && _jsx(Text, { color: "green", children: " \u2190" })] }, m.id)))] }));
    }
    // ── Help Mode ──
    if (mode === 'help') {
        setMode('input'); // Immediately switch back
        return (_jsxs(Box, { flexDirection: "column", marginLeft: 2, children: [_jsxs(Text, { bold: true, children: ['\n', "  Commands:"] }), _jsx(Text, { children: "  /model [name]  \u2014 switch model (arrow-key picker if no name)" }), _jsx(Text, { children: "  /models        \u2014 browse available models" }), _jsx(Text, { children: "  /cost          \u2014 session stats" }), _jsx(Text, { children: "  /exit          \u2014 quit" }), _jsx(Text, { children: "  /help          \u2014 this help" }), _jsxs(Text, { dimColor: true, children: ['\n', "  Shortcuts: sonnet, opus, gpt, gemini, deepseek, flash, free, r1, o4", '\n'] })] }));
    }
    // ── Normal Mode ──
    return (_jsxs(Box, { flexDirection: "column", children: [statusMsg && (_jsx(Box, { marginLeft: 1, children: _jsxs(Text, { color: "green", children: ["  ", statusMsg] }) })), Array.from(tools.values()).map((tool, i) => (_jsx(Box, { marginLeft: 1, children: tool.done ? (_jsx(Text, { children: tool.error
                        ? _jsxs(Text, { color: "red", children: ["  \u2717 ", tool.name, " ", _jsxs(Text, { dimColor: true, children: [tool.elapsed, "ms"] }), " \u2014 ", tool.preview.slice(0, 80)] })
                        : _jsxs(Text, { color: "green", children: ["  \u2713 ", tool.name, " ", _jsxs(Text, { dimColor: true, children: [tool.elapsed, "ms \u2014 ", tool.preview.slice(0, 80), tool.preview.length > 80 ? '...' : ''] })] }) })) : (_jsxs(Text, { color: "cyan", children: ["  ", _jsx(Spinner, { type: "dots" }), " ", tool.name, "..."] })) }, i))), thinking && (_jsx(Box, { marginLeft: 1, children: _jsxs(Text, { color: "magenta", children: ["  ", _jsx(Spinner, { type: "dots" }), " thinking..."] }) })), waiting && !thinking && tools.size === 0 && (_jsx(Box, { marginLeft: 1, children: _jsxs(Text, { color: "yellow", children: ["  ", _jsx(Spinner, { type: "dots" }), " ", currentModel, "..."] }) })), streamText && _jsx(Text, { children: streamText }), ready && (_jsxs(Box, { marginTop: streamText ? 1 : 0, children: [_jsx(Text, { bold: true, color: "green", children: "> " }), _jsx(TextInput, { value: input, onChange: setInput, onSubmit: handleSubmit })] })), ready && (_jsx(Box, { marginLeft: 2, children: _jsx(Text, { dimColor: true, children: currentModel }) }))] }));
}
export function launchInkUI(opts) {
    let resolveInput = null;
    let exiting = false;
    const instance = render(_jsx(RunCodeApp, { initialModel: opts.model, workDir: opts.workDir, onSubmit: (value) => {
            if (resolveInput) {
                resolveInput(value);
                resolveInput = null;
            }
        }, onModelChange: (model) => {
            opts.onModelChange?.(model);
        }, onExit: () => {
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
            return new Promise((resolve) => {
                resolveInput = resolve;
            });
        },
        cleanup: () => {
            instance.unmount();
        },
    };
}
