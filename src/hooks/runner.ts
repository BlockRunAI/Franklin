/**
 * HookEngine — dispatches lifecycle events to loaded hooks.
 *
 * Decision semantics (blocking events only):
 *   exit 0                              → allow
 *   exit 2                              → deny
 *   stdout {"decision":"deny",...}      → deny, regardless of exit code
 *   timeout / crash / spawn failure     → allow (fail-open) + logged
 *
 * Handlers run sequentially per event; the first deny short-circuits.
 * Non-blocking events run every matching handler and always resolve allow.
 */

import { execFile } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { logger } from '../logger.js';
import { appendApprovalRecord } from '../audit/approvals.js';
import { loadHooks } from './loader.js';
import {
  BLOCKING_EVENTS,
  type HookDecision,
  type HookEvent,
  type HookInput,
  type LoadedHook,
} from './types.js';

const DEFAULT_TIMEOUT_SECS = 5;
const MAX_STDOUT_BYTES = 64 * 1024;

export class HookEngine {
  private hooks: LoadedHook[];
  private byEvent = new Map<HookEvent, LoadedHook[]>();

  /** Hooks are read once at engine construction (session start). */
  constructor(opts: { workDir: string; hooks?: LoadedHook[] }) {
    this.hooks = opts.hooks ?? loadHooks(opts.workDir);
    for (const hook of this.hooks) {
      const list = this.byEvent.get(hook.event) ?? [];
      list.push(hook);
      this.byEvent.set(hook.event, list);
    }
  }

  /** Fast path so call sites skip envelope construction when nothing listens. */
  hasHooks(event: HookEvent): boolean {
    return (this.byEvent.get(event)?.length ?? 0) > 0;
  }

  listHooks(): ReadonlyArray<LoadedHook> {
    return this.hooks;
  }

  /**
   * Run every hook registered for `event` whose matcher accepts the tool name.
   * Returns the aggregate decision; always 'allow' for non-blocking events.
   */
  async dispatch(event: HookEvent, input: HookInput): Promise<HookDecision> {
    const candidates = this.byEvent.get(event);
    if (!candidates || candidates.length === 0) return { decision: 'allow' };

    const toolName = input.toolName ?? input.spend?.tool ?? '';
    const blocking = BLOCKING_EVENTS.has(event);

    for (const hook of candidates) {
      if (hook.matcher && !hook.matcher.test(toolName)) continue;

      const result = await this.runHandler(hook, input);
      if (blocking && result.decision === 'deny') {
        appendApprovalRecord({
          ts: Date.now(),
          sessionId: input.sessionId,
          kind: 'hook',
          subject: toolName || event,
          decision: 'deny',
          by: `hook:${path.basename(hook.sourceFile)}`,
          reason: result.reason,
        });
        return result;
      }
    }
    return { decision: 'allow' };
  }

  private runHandler(hook: LoadedHook, input: HookInput): Promise<HookDecision> {
    const timeoutMs = Math.max(1, hook.handler.timeout ?? DEFAULT_TIMEOUT_SECS) * 1000;

    // A bare relative path resolves against the hook file's directory so hook
    // bundles are relocatable; anything with shell syntax runs as written.
    let command = hook.handler.command;
    const looksLikeBarePath = !/[\s;&|<>$`]/.test(command);
    if (looksLikeBarePath && !path.isAbsolute(command)) {
      const resolved = path.resolve(path.dirname(hook.sourceFile), command);
      if (fs.existsSync(resolved)) command = resolved;
    }

    return new Promise<HookDecision>(resolve => {
      const child = execFile(
        '/bin/sh',
        ['-c', command],
        {
          timeout: timeoutMs,
          maxBuffer: MAX_STDOUT_BYTES,
          env: {
            ...process.env,
            ...hook.handler.env,
            // Reserved vars always win over handler env.
            FRANKLIN_HOOK_EVENT: input.hookEventName,
            FRANKLIN_SESSION_ID: input.sessionId,
            FRANKLIN_CWD: input.cwd,
          },
        },
        (err, stdout) => {
          // Explicit stdout deny wins regardless of exit code.
          const parsed = parseDecision(stdout);
          if (parsed?.decision === 'deny') {
            resolve({ decision: 'deny', reason: parsed.reason || `denied by ${path.basename(hook.sourceFile)}` });
            return;
          }

          if (!err) {
            resolve({ decision: 'allow' });
            return;
          }

          // child_process sets `code` to the numeric exit status on non-zero
          // exit (typed as string|number across Node versions — normalize).
          const code = (err as { code?: number | string }).code;
          if (code !== undefined && Number(code) === 2) {
            resolve({ decision: 'deny', reason: `denied by ${path.basename(hook.sourceFile)} (exit 2)` });
            return;
          }

          // Timeout, crash, missing binary, other exit codes: fail open.
          logger.warn(
            `[hooks] ${path.basename(hook.sourceFile)} ${input.hookEventName} handler failed open: ${err.message.slice(0, 160)}`
          );
          resolve({ decision: 'allow' });
        }
      );

      try {
        child.stdin?.write(JSON.stringify(input));
        child.stdin?.end();
      } catch {
        // EPIPE from a handler that never reads stdin — fine, decision comes
        // from its exit code / stdout.
      }
    });
  }
}

function parseDecision(stdout: string | Buffer): HookDecision | null {
  const text = String(stdout ?? '').trim();
  if (!text) return null;
  // Handlers may print human noise before the JSON — scan lines from the end.
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && (obj.decision === 'deny' || obj.decision === 'allow')) {
        return { decision: obj.decision, reason: typeof obj.reason === 'string' ? obj.reason : undefined };
      }
    } catch {
      /* not JSON — keep scanning */
    }
  }
  return null;
}
