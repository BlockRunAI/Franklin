/**
 * RunCode ink-based terminal UI.
 * Real-time streaming, thinking animation, tool progress, markdown output.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import type { StreamEvent } from '../agent/types.js';

// ─── Types ─────────────────────────────────────────────────────────────────

interface ToolStatus {
  name: string;
  startTime: number;
  done: boolean;
  error: boolean;
  preview: string;
  elapsed: number;
}

// ─── Main App Component ────────────────────────────────────────────────────

interface AppProps {
  model: string;
  workDir: string;
  version: string;
  onSubmit: (input: string) => void;
  onExit: () => void;
}

function RunCodeApp({ model, workDir, version, onSubmit, onExit }: AppProps) {
  const { exit } = useApp();
  const [input, setInput] = useState('');
  const [streamText, setStreamText] = useState('');
  const [thinking, setThinking] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [tools, setTools] = useState<Map<string, ToolStatus>>(new Map());
  const [inputTokens, setInputTokens] = useState(0);
  const [outputTokens, setOutputTokens] = useState(0);
  const [currentModel, setCurrentModel] = useState(model);
  const [ready, setReady] = useState(true);

  const handleSubmit = useCallback((value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;

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
    (globalThis as Record<string, unknown>).__runcode_ui = {
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
      setReady: (v: boolean) => setReady(v),
    };

    return () => {
      delete (globalThis as Record<string, unknown>).__runcode_ui;
    };
  }, []);

  return (
    <Box flexDirection="column">
      {/* Banner - only show once at start */}

      {/* Active tools */}
      {Array.from(tools.values()).map((tool, i) => (
        <Box key={i} marginLeft={1}>
          {tool.done ? (
            <Text>
              {tool.error ? (
                <Text color="red">  ✗ {tool.name}</Text>
              ) : (
                <Text color="green">  ✓ {tool.name}</Text>
              )}
              <Text dimColor> {tool.elapsed}ms</Text>
              {tool.preview && !tool.error && (
                <Text dimColor> — {tool.preview.slice(0, 80)}{tool.preview.length > 80 ? '...' : ''}</Text>
              )}
              {tool.error && (
                <Text color="red"> — {tool.preview.slice(0, 100)}</Text>
              )}
            </Text>
          ) : (
            <Text>
              <Text color="cyan">  <Spinner type="dots" /> </Text>
              <Text dimColor>{tool.name}...</Text>
            </Text>
          )}
        </Box>
      ))}

      {/* Thinking indicator */}
      {thinking && (
        <Box marginLeft={1}>
          <Text color="magenta">
            <Spinner type="dots" />
            <Text dimColor> thinking...</Text>
          </Text>
        </Box>
      )}

      {/* Waiting for model */}
      {waiting && !thinking && tools.size === 0 && (
        <Box marginLeft={1}>
          <Text color="yellow">
            <Spinner type="dots" />
            <Text dimColor> {currentModel}...</Text>
          </Text>
        </Box>
      )}

      {/* Streamed response text */}
      {streamText && (
        <Box marginLeft={0} marginTop={0}>
          <Text>{streamText}</Text>
        </Box>
      )}

      {/* Input prompt */}
      {ready && (
        <Box marginTop={streamText ? 1 : 0}>
          <Text bold color="green">&gt; </Text>
          <TextInput
            value={input}
            onChange={setInput}
            onSubmit={handleSubmit}
          />
        </Box>
      )}
    </Box>
  );
}

// ─── Launcher ──────────────────────────────────────────────────────────────

export interface InkUIHandle {
  handleEvent: (event: StreamEvent) => void;
  waitForInput: () => Promise<string | null>;
  cleanup: () => void;
}

export function launchInkUI(opts: {
  model: string;
  workDir: string;
  version: string;
}): InkUIHandle {
  let resolveInput: ((value: string | null) => void) | null = null;
  let exiting = false;

  const instance = render(
    <RunCodeApp
      model={opts.model}
      workDir={opts.workDir}
      version={opts.version}
      onSubmit={(value) => {
        if (resolveInput) {
          resolveInput(value);
          resolveInput = null;
        }
      }}
      onExit={() => {
        exiting = true;
        if (resolveInput) {
          resolveInput(null);
          resolveInput = null;
        }
      }}
    />
  );

  return {
    handleEvent: (event: StreamEvent) => {
      const ui = (globalThis as Record<string, unknown>).__runcode_ui as {
        handleEvent: (e: StreamEvent) => void;
      } | undefined;
      ui?.handleEvent(event);
    },

    waitForInput: () => {
      if (exiting) return Promise.resolve(null);
      return new Promise<string | null>((resolve) => {
        resolveInput = resolve;
      });
    },

    cleanup: () => {
      instance.unmount();
    },
  };
}
