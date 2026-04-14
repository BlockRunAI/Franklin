/**
 * Classify model/runtime errors so recovery and UX can be more consistent.
 *
 * Inspired by Claude Code's multi-layer error classification:
 * - Separate 'overloaded' category (529) from general server errors — shorter retry budget
 * - Auth errors (401) get special handling (token refresh, not retry)
 * - EPIPE/connection reset handled as network errors (retryable)
 */
function includesAny(text, patterns) {
    return patterns.some((p) => text.includes(p));
}
export function classifyAgentError(message) {
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
    // Auth errors — not retryable (need user action: re-login, new API key)
    if (includesAny(err, [
        '401',
        'unauthorized',
        'invalid api key',
        'invalid x-api-key',
        'authentication failed',
    ])) {
        return { category: 'auth', label: 'Auth', isTransient: false };
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
        'prompt too long',
        'token limit exceeded',
    ])) {
        return { category: 'context_limit', label: 'Context', isTransient: false };
    }
    if (includesAny(err, [
        'timeout',
        'timed out',
        'deadline exceeded',
    ])) {
        return { category: 'timeout', label: 'Timeout', isTransient: true };
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
        return { category: 'network', label: 'Network', isTransient: true };
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
        return { category: 'overloaded', label: 'Overloaded', isTransient: true, maxRetries: 3 };
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
        return { category: 'server', label: 'Server', isTransient: true };
    }
    return { category: 'unknown', label: 'Unknown', isTransient: false };
}
