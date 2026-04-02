import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
/**
 * RunCode ink-based terminal UI.
 * Real-time streaming, thinking animation, tool progress, markdown output.
 */
import { useState, useEffect, useCallback } from 'react';
import { render, Box, Text, useApp } from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
function RunCodeApp({ model, workDir, version, onSubmit, onExit }) {
    const { exit } = useApp();
    const [input, setInput] = useState('');
    const [streamText, setStreamText] = useState('');
    const [thinking, setThinking] = useState(false);
    const [waiting, setWaiting] = useState(false);
    const [tools, setTools] = useState(new Map());
    const [inputTokens, setInputTokens] = useState(0);
    const [outputTokens, setOutputTokens] = useState(0);
    const [currentModel, setCurrentModel] = useState(model);
    const [ready, setReady] = useState(true);
    const handleSubmit = useCallback((value) => {
        const trimmed = value.trim();
        if (!trimmed)
            return;
        if (trimmed === '/exit' || trimmed === '/quit') {
            onExit();
            exit();
            return;
        }
        setInput('');
        setStreamText('');
        setThinking(false);
        setTools(new Map());
        setReady(false);
        setWaiting(true);
        onSubmit(trimmed);
    }, [onSubmit, onExit, exit]);
    // Expose event handler for the agent loop to call
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
                                name: event.name,
                                startTime: Date.now(),
                                done: false,
                                error: false,
                                preview: '',
                                elapsed: 0,
                            });
                            return next;
                        });
                        break;
                    case 'capability_done':
                        setTools(prev => {
                            const next = new Map(prev);
                            const tool = next.get(event.id);
                            if (tool) {
                                next.set(event.id, {
                                    ...tool,
                                    done: true,
                                    error: !!event.result.isError,
                                    preview: event.result.output.replace(/\n/g, ' ').slice(0, 120),
                                    elapsed: Date.now() - tool.startTime,
                                });
                            }
                            return next;
                        });
                        break;
                    case 'usage':
                        setInputTokens(prev => prev + event.inputTokens);
                        setOutputTokens(prev => prev + event.outputTokens);
                        setCurrentModel(event.model);
                        break;
                    case 'turn_done':
                        setReady(true);
                        setWaiting(false);
                        setThinking(false);
                        break;
                }
            },
            setReady: (v) => setReady(v),
        };
        return () => {
            delete globalThis.__runcode_ui;
        };
    }, []);
    return (_jsxs(Box, { flexDirection: "column", children: [Array.from(tools.values()).map((tool, i) => (_jsx(Box, { marginLeft: 1, children: tool.done ? (_jsxs(Text, { children: [tool.error ? (_jsxs(Text, { color: "red", children: ["  \u2717 ", tool.name] })) : (_jsxs(Text, { color: "green", children: ["  \u2713 ", tool.name] })), _jsxs(Text, { dimColor: true, children: [" ", tool.elapsed, "ms"] }), tool.preview && !tool.error && (_jsxs(Text, { dimColor: true, children: [" \u2014 ", tool.preview.slice(0, 80), tool.preview.length > 80 ? '...' : ''] })), tool.error && (_jsxs(Text, { color: "red", children: [" \u2014 ", tool.preview.slice(0, 100)] }))] })) : (_jsxs(Text, { children: [_jsxs(Text, { color: "cyan", children: ["  ", _jsx(Spinner, { type: "dots" }), " "] }), _jsxs(Text, { dimColor: true, children: [tool.name, "..."] })] })) }, i))), thinking && (_jsx(Box, { marginLeft: 1, children: _jsxs(Text, { color: "magenta", children: [_jsx(Spinner, { type: "dots" }), _jsx(Text, { dimColor: true, children: " thinking..." })] }) })), waiting && !thinking && tools.size === 0 && (_jsx(Box, { marginLeft: 1, children: _jsxs(Text, { color: "yellow", children: [_jsx(Spinner, { type: "dots" }), _jsxs(Text, { dimColor: true, children: [" ", currentModel, "..."] })] }) })), streamText && (_jsx(Box, { marginLeft: 0, marginTop: 0, children: _jsx(Text, { children: streamText }) })), ready && (_jsxs(Box, { marginTop: streamText ? 1 : 0, children: [_jsx(Text, { bold: true, color: "green", children: "> " }), _jsx(TextInput, { value: input, onChange: setInput, onSubmit: handleSubmit })] }))] }));
}
export function launchInkUI(opts) {
    let resolveInput = null;
    let exiting = false;
    const instance = render(_jsx(RunCodeApp, { model: opts.model, workDir: opts.workDir, version: opts.version, onSubmit: (value) => {
            if (resolveInput) {
                resolveInput(value);
                resolveInput = null;
            }
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
