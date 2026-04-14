/**
 * Verification Agent — adversarial testing gate.
 *
 * After the main agent completes substantial work (writes/edits files, runs commands),
 * this agent runs independently to try to BREAK what was built. It can only read and
 * execute — never modify files. Returns PASS/FAIL/PARTIAL verdict.
 *
 * If FAIL: injects feedback into conversation so the main agent can fix issues.
 * If PASS: work is considered verified.
 *
 * Inspired by Claude Code's verification agent architecture.
 */

import type { CapabilityHandler, Dialogue } from './types.js';
import { ModelClient } from './llm.js';

// ─── Verification System Prompt ───────────────────────────────────────────

const VERIFICATION_PROMPT = `You are a VERIFICATION agent. Your job is NOT to confirm that code works — it is to TRY TO BREAK IT.

## Rules

1. **Adversarial mindset**: Assume the code has bugs. Your goal is to find them.
2. **No modifications**: You may ONLY use Read, Bash, Glob, and Grep tools. You MUST NOT use Edit, Write, or any tool that modifies files.
3. **Evidence required**: Every check MUST include:
   - What you tested (the exact command or operation)
   - The actual output
   - Whether it PASSED or FAILED
4. **No rationalization**: These phrases are NEVER acceptable as evidence:
   - "The code looks correct"
   - "This should work"
   - "Based on the implementation, it handles..."
   - "The tests pass" (unless you actually ran them and showed output)

## What to Check

1. **Does it compile/build?** Run the build command.
2. **Do tests pass?** Run the test suite.
3. **Edge cases**: Empty inputs, very large inputs, missing files, invalid data.
4. **Error handling**: What happens when things go wrong?
5. **Consistency**: Does the change break other parts of the codebase?

## Output Format

After running your checks, output a verdict in EXACTLY this format:

VERDICT: PASS|FAIL|PARTIAL

Then explain:
- What you tested
- What passed
- What failed (if any)
- Specific issues to fix (if FAIL)

Keep it concise — focus on actionable findings, not narration.`;

// ─── Types ────────────────────────────────────────────────────────────────

export interface VerificationResult {
  verdict: 'PASS' | 'FAIL' | 'PARTIAL' | 'SKIPPED';
  summary: string;
  issues: string[];
}

// ─── Thresholds ──────────────────────────────────────────────────────────

/** Only verify turns where substantial work was done. */
const WRITE_TOOLS = new Set(['Edit', 'Write', 'Bash']);

/** Minimum tool calls to trigger verification. */
const MIN_TOOL_CALLS = 3;

/** Maximum tokens to spend on verification (prevent runaway). */
const MAX_VERIFICATION_TOKENS = 8192;

// ─── Decision Logic ──────────────────────────────────────────────────────

/**
 * Should we run verification for this turn?
 * Only for substantial work: 3+ tool calls AND at least one write/edit/bash.
 */
export function shouldVerify(
  turnToolCalls: number,
  turnToolCounts: Map<string, number>,
  userInput: string,
): boolean {
  // Skip if not enough tool calls
  if (turnToolCalls < MIN_TOOL_CALLS) return false;

  // Skip if no write-like tools were used
  let hasWriteTool = false;
  for (const [name] of turnToolCounts) {
    if (WRITE_TOOLS.has(name)) { hasWriteTool = true; break; }
  }
  if (!hasWriteTool) return false;

  // Skip if user explicitly asked for something quick
  const lower = userInput.toLowerCase();
  if (lower.startsWith('/') || lower.length < 20) return false;

  return true;
}

// ─── Read-only tool filter ───────────────────────────────────────────────

const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch']);

/**
 * Filter capability handlers to only allow read-only tools.
 * Bash is allowed (for running tests/builds) but Edit/Write are blocked.
 */
export function getVerificationTools(
  handlers: Map<string, CapabilityHandler>,
): Map<string, CapabilityHandler> {
  const filtered = new Map<string, CapabilityHandler>();
  for (const [name, handler] of handlers) {
    if (READ_ONLY_TOOLS.has(name)) {
      filtered.set(name, handler);
    }
  }
  return filtered;
}

// ─── Run Verification ────────────────────────────────────────────────────

/**
 * Run the verification agent on the current conversation state.
 * Uses a cheap model to minimize cost. Returns verdict + issues.
 */
export async function runVerification(
  history: Dialogue[],
  handlers: Map<string, CapabilityHandler>,
  client: ModelClient,
  config: {
    model: string;
    workDir: string;
    abortSignal: AbortSignal;
    onEvent?: (event: { kind: string; text?: string }) => void;
  },
): Promise<VerificationResult> {
  const verificationTools = getVerificationTools(handlers);

  // Build verification prompt from recent history context
  const recentWork = extractRecentWork(history);
  if (!recentWork) {
    return { verdict: 'SKIPPED', summary: 'No recent work to verify.', issues: [] };
  }

  const verificationHistory: Dialogue[] = [
    {
      role: 'user',
      content: `The following work was just completed. Your job is to VERIFY it by running adversarial checks.\n\n${recentWork}\n\nRun build, tests, and edge case checks. Output your VERDICT.`,
    },
  ];

  config.onEvent?.({ kind: 'text_delta', text: '\n*Verifying...*\n' });

  // Use cheap model for verification
  const verificationModel = 'nvidia/nemotron-ultra-253b'; // Free model to keep cost zero

  try {
    // Simple single-turn verification call
    const response = await client.complete({
      model: verificationModel,
      system: VERIFICATION_PROMPT,
      messages: verificationHistory,
      tools: Array.from(verificationTools.values()).map(h => h.spec),
      max_tokens: MAX_VERIFICATION_TOKENS,
    });

    // Extract text from response
    let responseText = '';
    if (response.content) {
      for (const part of response.content) {
        if (typeof part === 'string') {
          responseText += part;
        } else if (part.type === 'text') {
          responseText += part.text;
        }
      }
    }

    // Parse verdict
    const verdictMatch = responseText.match(/VERDICT:\s*(PASS|FAIL|PARTIAL)/i);
    const verdict = verdictMatch
      ? (verdictMatch[1].toUpperCase() as 'PASS' | 'FAIL' | 'PARTIAL')
      : 'PARTIAL';

    // Extract issues
    const issues: string[] = [];
    const issueLines = responseText.split('\n').filter(l =>
      l.match(/^[-•*]\s*(FAIL|ERROR|BUG|ISSUE|PROBLEM)/i) ||
      l.match(/^[-•*]\s+.*fail/i)
    );
    for (const line of issueLines) {
      issues.push(line.replace(/^[-•*]\s*/, '').trim());
    }

    return { verdict, summary: responseText.slice(0, 500), issues };
  } catch (err) {
    // Verification failure should never block the main flow
    return {
      verdict: 'SKIPPED',
      summary: `Verification error: ${(err as Error).message}`,
      issues: [],
    };
  }
}

/**
 * Extract a summary of recent work from the conversation history.
 * Looks at the last assistant turn and its tool calls.
 */
function extractRecentWork(history: Dialogue[]): string | null {
  const parts: string[] = [];

  // Walk backwards through history to find recent tool uses and assistant messages
  let found = 0;
  for (let i = history.length - 1; i >= 0 && found < 10; i--) {
    const msg = history[i];
    const role = msg.role;

    // Stop at a pure user message boundary (not a tool_result user message)
    if (role === 'user' && !Array.isArray(msg.content)) break;

    if (role === 'assistant' && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (typeof part === 'object') {
          if (part.type === 'text' && part.text) {
            parts.unshift(`Assistant: ${part.text.slice(0, 500)}`);
            found++;
          } else if (part.type === 'tool_use') {
            parts.unshift(`Tool: ${part.name}(${JSON.stringify(part.input).slice(0, 200)})`);
            found++;
          }
        }
      }
    } else if (role === 'user' && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (typeof part === 'object' && part.type === 'tool_result') {
          const output = typeof part.content === 'string'
            ? part.content
            : Array.isArray(part.content)
              ? (part.content as Array<{ text?: string }>).map(c => c.text || '').join('\n')
              : '';
          parts.unshift(`Result: ${output.slice(0, 300)}`);
          found++;
        }
      }
    }
  }

  return parts.length > 0 ? parts.join('\n\n') : null;
}
