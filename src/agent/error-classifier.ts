/**
 * Classify model/runtime errors so recovery and UX can be more consistent.
 */

export type AgentErrorCategory =
  | 'rate_limit'
  | 'payment'
  | 'network'
  | 'timeout'
  | 'context_limit'
  | 'server'
  | 'unknown';

export interface AgentErrorInfo {
  category: AgentErrorCategory;
  label: 'RateLimit' | 'Payment' | 'Network' | 'Timeout' | 'Context' | 'Server' | 'Unknown';
  isTransient: boolean;
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
    return { category: 'payment', label: 'Payment', isTransient: false };
  }

  if (includesAny(err, [
    '429',
    'rate limit',
    'too many requests',
  ])) {
    return { category: 'rate_limit', label: 'RateLimit', isTransient: true };
  }

  if (includesAny(err, [
    'prompt is too long',
    'context length',
    'maximum context',
  ])) {
    return { category: 'context_limit', label: 'Context', isTransient: false };
  }

  if (includesAny(err, [
    'timeout',
    'timed out',
  ])) {
    return { category: 'timeout', label: 'Timeout', isTransient: true };
  }

  if (includesAny(err, [
    'fetch failed',
    'econnrefused',
    'econnreset',
    'enotfound',
    'network',
    'socket hang up',
  ])) {
    return { category: 'network', label: 'Network', isTransient: true };
  }

  if (includesAny(err, [
    '500',
    '502',
    '503',
    '504',
    'internal server error',
    'bad gateway',
    'service unavailable',
    'temporarily unavailable',     // "Service temporarily unavailable"
    'workers are busy',            // "All workers are busy"
    'server busy',
    'overloaded',
    'please retry later',
    'retry in a few',
    'upstream error',
  ])) {
    return { category: 'server', label: 'Server', isTransient: true };
  }

  return { category: 'unknown', label: 'Unknown', isTransient: false };
}
