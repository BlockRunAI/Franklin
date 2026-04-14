/**
 * Classify model/runtime errors so recovery and UX can be more consistent.
 *
 * Inspired by Claude Code's multi-layer error classification:
 * - Separate 'overloaded' category (529) from general server errors — shorter retry budget
 * - Auth errors (401) get special handling (token refresh, not retry)
 * - EPIPE/connection reset handled as network errors (retryable)
 */

export type AgentErrorCategory =
  | 'rate_limit'
  | 'payment'
  | 'network'
  | 'timeout'
  | 'context_limit'
  | 'overloaded'
  | 'server'
  | 'auth'
  | 'unknown';

export interface AgentErrorInfo {
  category: AgentErrorCategory;
  label: 'RateLimit' | 'Payment' | 'Network' | 'Timeout' | 'Context' | 'Overloaded' | 'Server' | 'Auth' | 'Unknown';
  isTransient: boolean;
  /** Max retries for this error type (overrides default). undefined = use default. */
  maxRetries?: number;
  /** User-facing suggestion for how to recover. Appended to error message in UI. */
  suggestion?: string;
}

function includesAny(text: string, patterns: string[]): boolean {
  return patterns.some((p) => text.includes(p));
}

export function classifyAgentError(message: string): AgentErrorInfo {
  const err = message.toLowerCase();

  if (includesAny(err, [
    'insufficient',
    'payment',
    'verification failed',
    'balance',
    '402',
    'free tier',
  ])) {
    return {
      category: 'payment', label: 'Payment', isTransient: false,
      suggestion: 'Run `franklin balance` to check funds. Try /model free for free models.',
    };
  }

  // Auth errors — not retryable (need user action: re-login, new API key)
  if (includesAny(err, [
    '401',
    'unauthorized',
    'unauthenticated',
    'not authenticated',
    'invalid api key',
    'invalid x-api-key',
    'authentication failed',
    'authentication required',
  ])) {
    return {
      category: 'auth', label: 'Auth', isTransient: false,
      suggestion: 'Check your API key or wallet configuration. Run `franklin setup` to reconfigure.',
    };
  }

  if (includesAny(err, [
    '429',
    'rate limit',
    'too many requests',
  ])) {
    return {
      category: 'rate_limit', label: 'RateLimit', isTransient: true,
      suggestion: 'Try /model to switch to a different model, or wait a moment and /retry.',
    };
  }

  if (includesAny(err, [
    'prompt is too long',
    'context length',
    'maximum context',
    'prompt too long',
    'token limit exceeded',
  ])) {
    return {
      category: 'context_limit', label: 'Context', isTransient: false,
      suggestion: 'Run /compact to compress conversation history.',
    };
  }

  if (includesAny(err, [
    'timeout',
    'timed out',
    'deadline exceeded',
  ])) {
    return {
      category: 'timeout', label: 'Timeout', isTransient: true,
      suggestion: 'Check your network connection. Use /retry to try again.',
    };
  }

  if (includesAny(err, [
    'fetch failed',
    'econnrefused',
    'econnreset',
    'enotfound',
    'epipe',
    'network',
    'socket hang up',
    'connection reset',
    'dns resolution',
  ])) {
    return {
      category: 'network', label: 'Network', isTransient: true,
      suggestion: 'Check your network connection. Use /retry to try again.',
    };
  }

  // 529 / Overloaded — separate from generic server errors
  // Claude Code only allows 3 retries for these (they tend to persist)
  if (includesAny(err, [
    '529',
    'overloaded',
    'workers are busy',
    'all workers are busy',
    'server busy',
    'capacity',
  ])) {
    return {
      category: 'overloaded', label: 'Overloaded', isTransient: true, maxRetries: 3,
      suggestion: 'The model is overloaded. Try /model to switch, or wait and /retry.',
    };
  }

  if (includesAny(err, [
    '500',
    '502',
    '503',
    '504',
    'internal server error',
    'bad gateway',
    'service unavailable',
    'temporarily unavailable',
    'please retry later',
    'retry in a few',
    'upstream error',
  ])) {
    return {
      category: 'server', label: 'Server', isTransient: true,
      suggestion: 'Server error. Use /retry to try again, or /model to switch models.',
    };
  }

  return { category: 'unknown', label: 'Unknown', isTransient: false };
}
