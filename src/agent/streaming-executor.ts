/**
 * Streaming Tool Executor for Franklin.
 * Starts executing concurrent-safe tools while the model is still streaming.
 * Non-concurrent tools wait until the full response is received.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  CapabilityHandler,
  CapabilityInvocation,
  CapabilityResult,
  ExecutionScope,
} from './types.js';
import type { PermissionManager } from './permissions.js';
import { recordFailure } from '../stats/failures.js';
import type { SessionToolGuard } from './tool-guard.js';
import { BLOCKRUN_DIR } from '../config.js';
import { findModel, estimateCostUsd } from '../gateway-models.js';
import { loadConfig } from '../commands/config.js';

interface PendingTool {
  invocation: CapabilityInvocation;
  promise: Promise<CapabilityResult>;
}

/** Persist a large tool result to disk and return a preview string. */
const PERSIST_THRESHOLD = 50_000;
const PREVIEW_SIZE = 2_000;

function persistLargeResult(sessionId: string, toolUseId: string, output: string): string {
  const dir = join(BLOCKRUN_DIR, 'tool-results', sessionId);
  try {
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, `${toolUseId}.txt`);
    writeFileSync(filePath, output, { flag: 'wx' }); // write-once (skip if exists)

    // Generate preview — truncate at line boundary for clean output
    let preview = output.slice(0, PREVIEW_SIZE);
    const lastNl = preview.lastIndexOf('\n');
    if (lastNl > PREVIEW_SIZE * 0.5) {
      preview = preview.slice(0, lastNl);
    }

    return `<persisted-output>\nOutput too large (${(output.length / 1024).toFixed(1)}KB). Full output saved to: ${filePath}\n\nPreview (first ${PREVIEW_SIZE / 1000}KB):\n${preview}\n...\n</persisted-output>`;
  } catch {
    // Fallback: simple truncation if disk write fails
    return output.slice(0, PERSIST_THRESHOLD) +
      `\n\n[Truncated: original was ${output.length.toLocaleString()} chars]`;
  }
}

/**
 * Default max concurrent `concurrent: 'batch'` tools per turn. Bounded so
 * we don't slam the gateway / x402 facilitator with 10+ simultaneous paid
 * requests when the model emits a big batch. 4 matches the industry default
 * (Midjourney grid, Leonardo default, OpenAI `n` cap). Overridable via
 * `franklin config set batch-concurrency <n>` (or the VS Code settings popover).
 */
const DEFAULT_BATCH_CONCURRENCY = 4;
const MIN_BATCH_CONCURRENCY = 1;
const MAX_BATCH_CONCURRENCY = 12;

function resolveBatchConcurrency(): number {
  try {
    const raw = loadConfig()['batch-concurrency'];
    if (raw === undefined || raw === '') return DEFAULT_BATCH_CONCURRENCY;
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n) || n < MIN_BATCH_CONCURRENCY) return DEFAULT_BATCH_CONCURRENCY;
    return Math.min(MAX_BATCH_CONCURRENCY, n);
  } catch {
    return DEFAULT_BATCH_CONCURRENCY;
  }
}

export class StreamingExecutor {
  private handlers: Map<string, CapabilityHandler>;
  private scope: ExecutionScope;
  private permissions?: PermissionManager;
  private guard?: SessionToolGuard;
  private onStart: (id: string, name: string, preview?: string) => void;
  private onProgress?: (id: string, text: string) => void;
  private pending: PendingTool[] = [];
  private sessionId: string;
  /**
   * Serializes onAskUser calls across concurrently-running batch tools.
   * Without this, 6 parallel ImageGens would all fire askUser at the same
   * tick and the webview's single-slot pending state would drop or
   * interleave answers. The mutex chains them: tool 2's askUser only fires
   * after tool 1's answer comes back.
   */
  private askUserChain: Promise<unknown> = Promise.resolve();
  /**
   * Invocation IDs whose per-tool askUser has been pre-approved via a
   * single merged batch confirmation. The execute path checks this and
   * sets `ctx.skipAskUser = true` so the tool skips its own cost preview.
   */
  private batchPreApproved = new Set<string>();

  constructor(opts: {
    handlers: Map<string, CapabilityHandler>;
    scope: ExecutionScope;
    permissions?: PermissionManager;
    guard?: SessionToolGuard;
    onStart: (id: string, name: string, preview?: string) => void;
    onProgress?: (id: string, text: string) => void;
    sessionId?: string;
  }) {
    this.handlers = opts.handlers;
    this.scope = opts.scope;
    this.permissions = opts.permissions;
    this.guard = opts.guard;
    this.onStart = opts.onStart;
    this.onProgress = opts.onProgress;
    this.sessionId = opts.sessionId || 'default';
  }

  /**
   * Called when a tool_use block is fully received from the stream.
   * If the tool is concurrent-safe, start executing immediately.
   * Otherwise, queue it for later.
   */
  onToolReceived(invocation: CapabilityInvocation): void {
    const handler = this.handlers.get(invocation.name);
    // Dynamic concurrency check (e.g., Bash is concurrent only for read-only commands).
    // 'batch' tools are NOT started during streaming — they need permission /
    // payment / askUser confirmation, which only makes sense after the full
    // tool list is known. They get parallelized in collectResults instead.
    const flag = handler?.isConcurrentSafe
      ? handler.isConcurrentSafe(invocation.input)
      : (handler?.concurrent ?? false);
    const isStreamingConcurrent = flag === true;

    if (isStreamingConcurrent) {
      // Concurrent tools are auto-allowed — start immediately and time from here
      const preview = this.inputPreview(invocation);
      this.onStart(invocation.id, invocation.name, preview);
      const promise = this.executeWithPermissions(invocation, 1, false);
      this.pending.push({ invocation, promise });
    }
    // Non-concurrent tools are NOT started here — executed via collectResults
  }

  /**
   * After the model finishes streaming, execute any non-concurrent tools
   * and collect all results (including concurrent ones that may already be done).
   */
  async collectResults(
    allInvocations: CapabilityInvocation[]
  ): Promise<[CapabilityInvocation, CapabilityResult][]> {
    const results: [CapabilityInvocation, CapabilityResult][] = [];
    const alreadyStarted = new Set(this.pending.map(p => p.invocation.id));
    const pendingSnapshot = [...this.pending];
    this.pending = []; // Clear immediately so errors don't leave stale state

    // Pre-count pending sequential invocations per tool type.
    // Shown in permission dialog: "N pending — press [a] to allow all".
    const pendingCounts: Map<string, number> = new Map();
    for (const inv of allInvocations) {
      if (!alreadyStarted.has(inv.id)) {
        pendingCounts.set(inv.name, (pendingCounts.get(inv.name) || 0) + 1);
      }
    }
    const remainingCounts = new Map(pendingCounts);

    try {
      // Wait for concurrent results that were started during streaming
      for (const p of pendingSnapshot) {
        const result = await p.promise;
        results.push([p.invocation, result]);
      }

      // Split remaining invocations into batch-able (run in parallel pool)
      // and strictly serial. Batch tools (ImageGen / VideoGen) self-contain
      // their AskUser + payment flow; running them in parallel is safe as
      // long as askUser is serialized (see askUserChain) and output paths
      // don't collide (handled at tool level).
      const batchInvs: CapabilityInvocation[] = [];
      const serialInvs: CapabilityInvocation[] = [];
      for (const inv of allInvocations) {
        if (alreadyStarted.has(inv.id)) continue;
        const handler = this.handlers.get(inv.name);
        const flag = handler?.isConcurrentSafe
          ? handler.isConcurrentSafe(inv.input)
          : (handler?.concurrent ?? false);
        if (flag === 'batch') batchInvs.push(inv);
        else serialInvs.push(inv);
      }

      // Run batch tools through a bounded concurrency pool. Failures of one
      // do not block others — each result is captured independently.
      if (batchInvs.length > 0) {
        // Merged confirmation: when a single turn produces multiple
        // ImageGen / VideoGen calls, ask the user once with a total cost
        // estimate instead of N times. Approved IDs skip their per-tool
        // askUser so the user doesn't get hit with N cost previews on top
        // of the merged one.
        await this.preflightBatch(batchInvs);
        const batchResults = await this.runBatchPool(batchInvs, resolveBatchConcurrency());
        for (const pair of batchResults) results.push(pair);
        this.batchPreApproved.clear();
      }

      // Execute strictly sequential tools (Edit / Write / Bash mutating)
      for (const inv of serialInvs) {
        const remaining = remainingCounts.get(inv.name) ?? 1;
        remainingCounts.set(inv.name, remaining - 1);

        // NOTE: onStart is called INSIDE executeWithPermissions, AFTER permission is granted.
        // This ensures elapsed time reflects actual execution time, not permission wait time.
        const result = await this.executeWithPermissions(inv, remaining, true);
        results.push([inv, result]);
      }
    } catch (err) {
      // Return partial results rather than losing them; caller handles errors
      throw err;
    }

    return results;
  }

  /**
   * Run a list of batch-eligible invocations through a bounded promise pool.
   * Up to `concurrency` run at once; each completion immediately pulls the
   * next from the queue (work-stealing) so the long tail doesn't stall the
   * batch. One failure doesn't abort the others — each result is captured
   * via the executor's normal error path.
   */
  private async runBatchPool(
    invs: CapabilityInvocation[],
    concurrency: number,
  ): Promise<[CapabilityInvocation, CapabilityResult][]> {
    const queue = invs.map((inv, index) => ({ inv, index }));
    const results: [CapabilityInvocation, CapabilityResult][] = new Array(invs.length);
    let cursor = 0;

    const worker = async (): Promise<void> => {
      while (cursor < queue.length) {
        const slot = queue[cursor++];
        if (!slot) break;
        const result = await this.executeWithPermissions(slot.inv, 1, true);
        results[slot.index] = [slot.inv, result];
      }
    };

    const workers = Array.from(
      { length: Math.min(concurrency, invs.length) },
      () => worker(),
    );
    await Promise.all(workers);
    return results;
  }

  /**
   * Merged batch confirmation. Groups invocations by tool name and, for any
   * group with >= 2 calls, fires ONE askUser covering the whole group.
   * Approved invocations get added to `batchPreApproved` so their per-tool
   * cost-preview askUser is skipped.
   *
   * Single-call groups are not merged (the per-tool preview is already
   * the right granularity — gives the user model choice / refined prompt).
   */
  private async preflightBatch(invs: CapabilityInvocation[]): Promise<void> {
    const askUser = this.scope.onAskUser;
    if (!askUser) return; // no UI to ask through
    if (process.env.FRANKLIN_MEDIA_AUTO_APPROVE_ALL === '1') {
      // Env-flag autoapprove: skip merged askUser too, just mark approved.
      for (const inv of invs) this.batchPreApproved.add(inv.id);
      return;
    }

    // Group by tool name (ImageGen, VideoGen, ...)
    const groups = new Map<string, CapabilityInvocation[]>();
    for (const inv of invs) {
      const list = groups.get(inv.name) ?? [];
      list.push(inv);
      groups.set(inv.name, list);
    }

    for (const [name, group] of groups) {
      if (group.length < 2) continue; // single calls keep per-tool preview

      // Estimate per-call cost, sum to total. Each invocation may name a
      // different model — show the range. Unknown models fall back to 0
      // (the per-tool flow will handle it; our preflight just gives the
      // user a heads-up).
      let totalEst = 0;
      const lines: string[] = [];
      // Defaults must match each tool's actual default selection logic so
      // the cost shown in the merged card matches what gets billed when
      // the user picks "Approve all" + skipAskUser flips.
      const defaultModelFor = (toolName: string): string => {
        if (toolName === 'ImageGen') return 'openai/gpt-image-1';
        if (toolName === 'VideoGen') return 'xai/grok-imagine-video';
        return '';
      };

      for (let i = 0; i < group.length; i++) {
        const inv = group[i];
        const modelId = (inv.input.model as string) || defaultModelFor(name);
        let costStr = '~?';
        if (modelId) {
          try {
            const m = await findModel(modelId);
            if (m) {
              const c = estimateCostUsd(m, {
                quantity: 1,
                duration_seconds: (inv.input.duration_seconds as number) || undefined,
              });
              totalEst += c;
              costStr = `$${c.toFixed(2)}`;
            }
          } catch { /* fall through with ~? */ }
        }
        const promptRaw = (inv.input.prompt as string) || '';
        const prompt = promptRaw.length > 60 ? promptRaw.slice(0, 60) + '…' : promptRaw;
        lines.push(`  ${i + 1}. ${prompt} — ${modelId || 'auto'} — ${costStr}`);
      }

      const noun = name === 'ImageGen' ? 'images' : name === 'VideoGen' ? 'videos' : 'calls';
      const totalStr = totalEst > 0 ? `~$${totalEst.toFixed(2)}` : 'unknown';
      const question =
        `Generate ${group.length} ${noun}? Estimated total: ${totalStr}\n\n` +
        lines.join('\n');

      // Wrap the askUser in try/catch so a UI failure (webview disconnect,
      // user closes panel, etc.) doesn't abort the entire batch — we fall
      // back to per-tool askUser, which is safe because each tool can
      // still cancel itself.
      try {
        const answer = await askUser(question, ['Approve all', 'Cancel']);
        if (answer === 'Approve all') {
          for (const inv of group) this.batchPreApproved.add(inv.id);
        }
        // 'Cancel' or anything else → don't pre-approve. Each tool's own
        // askUser flow will then run inside the batch pool, and the user
        // can cancel each individually. (We don't short-circuit the whole
        // batch on cancel because the user might have meant "let me pick
        // per-image" — reverting to per-tool flow gives them that option.)
      } catch {
        // askUser threw — leave group un-approved, per-tool flow will run.
      }
    }
  }

  /**
   * Serialized askUser dispatcher. Wraps the shared scope's onAskUser so
   * that even if N batch tools call it concurrently, the prompts hit the
   * UI one at a time, in arrival order.
   */
  private askUserSerialized(
    base: NonNullable<ExecutionScope['onAskUser']>,
  ): NonNullable<ExecutionScope['onAskUser']> {
    return (question: string, options?: string[]) => {
      const next = this.askUserChain.then(() => base(question, options));
      // Don't let one rejection break the chain for subsequent callers.
      this.askUserChain = next.catch(() => undefined);
      return next;
    };
  }

  private async executeWithPermissions(
    invocation: CapabilityInvocation,
    pendingCount = 1,
    callStart = true  // false for concurrent tools (already called in onToolReceived)
  ): Promise<CapabilityResult> {
    const guardResult = this.guard
      ? await this.guard.beforeExecute(invocation, this.scope)
      : null;
    if (guardResult) {
      return guardResult;
    }

    // Permission check
    if (this.permissions) {
      const decision = await this.permissions.check(invocation.name, invocation.input);
      if (decision.behavior === 'deny') {
        this.guard?.cancelInvocation(invocation.id);
        return {
          output: `Permission denied for ${invocation.name}: ${decision.reason || 'denied by policy'}. Do not retry — explain to the user what you were trying to do and ask how they'd like to proceed.`,
          isError: true,
        };
      }
      if (decision.behavior === 'ask') {
        const allowed = await this.permissions.promptUser(invocation.name, invocation.input, pendingCount);
        if (!allowed) {
          this.guard?.cancelInvocation(invocation.id);
          return {
            output: `User denied permission for ${invocation.name}. Do not retry — ask the user what they'd like to do instead.`,
            isError: true,
          };
        }
      }
    }

    // Start timing AFTER permission is granted (accurate elapsed time)
    if (callStart) {
      const preview = this.inputPreview(invocation);
      this.onStart(invocation.id, invocation.name, preview);
    }

    let handler = this.handlers.get(invocation.name);
    if (!handler) {
      // Attempt repair: lowercase, normalize hyphens/spaces → match
      const attempted = invocation.name;
      const lower = attempted.toLowerCase();
      for (const [name, h] of this.handlers) {
        if (name.toLowerCase() === lower || name.toLowerCase().replace(/[-_ ]/g, '') === lower.replace(/[-_ ]/g, '')) {
          handler = h;
          invocation = { ...invocation, name };
          break;
        }
      }
      if (!handler) {
        this.guard?.cancelInvocation(invocation.id);
        const available = [...this.handlers.keys()].join(', ');
        return {
          output: `Unknown tool "${attempted}". Available tools: ${available}. Check spelling and try again.`,
          isError: true,
        };
      }
    }

    // Wire per-invocation progress to onProgress callback. Also serialize
    // onAskUser so concurrent batch tools (ImageGen / VideoGen ×6) don't
    // race the webview's single-slot pending prompt state. If this
    // invocation was pre-approved via the merged batch askUser, set
    // skipAskUser so the tool skips its own per-call cost preview.
    const baseAskUser = this.scope.onAskUser;
    const progressScope: ExecutionScope = {
      ...this.scope,
      ...(this.onProgress
        ? { onProgress: (text: string) => this.onProgress!(invocation.id, text) }
        : {}),
      ...(baseAskUser
        ? { onAskUser: this.askUserSerialized(baseAskUser) }
        : {}),
      ...(this.batchPreApproved.has(invocation.id)
        ? { skipAskUser: true }
        : {}),
    };

    try {
      // Runtime input validation: check required fields and types
      const schema = handler.spec.input_schema;
      if (schema?.required) {
        for (const field of schema.required) {
          if (invocation.input[field] === undefined || invocation.input[field] === null) {
            const desc = (schema.properties?.[field] as { description?: string } | undefined)?.description || '';
            return {
              output: `Error: missing required parameter "${field}" for ${handler.spec.name}. ${desc}`,
              isError: true,
            };
          }
        }
      }
      // Type coercion for common model mistakes (string↔number, string↔boolean)
      if (schema?.properties) {
        for (const [key, value] of Object.entries(invocation.input)) {
          if (value == null) continue;
          const prop = schema.properties[key] as { type?: string } | undefined;
          if (!prop?.type) continue;
          if (prop.type === 'number' && typeof value === 'string' && !isNaN(Number(value))) {
            invocation.input[key] = Number(value);
          } else if (prop.type === 'boolean' && typeof value === 'string') {
            if (value === 'true') invocation.input[key] = true;
            else if (value === 'false') invocation.input[key] = false;
          }
        }
      }

      let result = await handler.execute(invocation.input, progressScope);
      this.guard?.afterExecute(invocation, result);

      // Persist large results to disk with preview.
      // Instead of just truncating, save the full result to disk so it can be re-read later.
      if (result.output.length > PERSIST_THRESHOLD) {
        result = {
          output: persistLargeResult(this.sessionId, invocation.id, result.output),
          isError: result.isError,
        };
      }

      return result;
    } catch (err) {
      this.guard?.cancelInvocation(invocation.id);
      recordFailure({
        timestamp: Date.now(),
        model: '', // not available at tool level
        failureType: 'tool_error',
        toolName: invocation.name,
        errorMessage: (err as Error).message,
      });
      return {
        output: `Error executing ${invocation.name}: ${(err as Error).message}`,
        isError: true,
      };
      }
  }

  /** Extract a short preview string from a tool invocation's input. */
  private inputPreview(invocation: CapabilityInvocation): string | undefined {
    const input = invocation.input;
    switch (invocation.name) {
      case 'Bash': {
        const cmd = (input.command as string) || '';
        return cmd.length > 80 ? cmd.slice(0, 80) + '…' : cmd;
      }
      case 'Write':
      case 'Read':
      case 'Edit':
        return (input.file_path as string) || undefined;
      case 'Grep':
        return (input.pattern as string) || undefined;
      case 'Glob':
        return (input.pattern as string) || undefined;
      case 'WebFetch':
      case 'WebSearch':
        return ((input.url ?? input.query) as string) || undefined;
      case 'ImageGen':
      case 'VideoGen': {
        // When N batch invocations stack vertically in the timeline, naked
        // "ImageGen" labels are indistinguishable. Show model + a short
        // prompt snippet so each dot is identifiable. Defaults to the
        // tool's auto-pick model so the label is never empty.
        const explicitModel = (input.model as string) || '';
        const fallbackModel = invocation.name === 'ImageGen'
          ? 'openai/gpt-image-1'
          : 'xai/grok-imagine-video';
        const modelId = explicitModel || fallbackModel;
        const modelLabel = modelId.split('/').pop() || modelId;
        const promptRaw = (input.prompt as string) || '';
        const promptSnippet = promptRaw.length > 32
          ? promptRaw.slice(0, 32).replace(/\s+/g, ' ').trim() + '…'
          : promptRaw.replace(/\s+/g, ' ').trim();
        return promptSnippet
          ? `${modelLabel} · ${promptSnippet}`
          : modelLabel;
      }
      default:
        return undefined;
    }
  }
}
