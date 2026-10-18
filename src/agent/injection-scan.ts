/**
 * Prompt-injection scanning for text that enters the system prompt from
 * outside Franklin's own code: project config files, and lessons written
 * back by the goal-outcome reflector. Shared so every such path applies the
 * same patterns.
 */

// ─── Prompt Injection Detection ────────────────────────────────────────────

/** Patterns that indicate potential prompt injection in context files. */
const INJECTION_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  // Direct instruction override attempts
  { pattern: /ignore\s+(all\s+)?previous\s+instructions/i, description: 'instruction override' },
  { pattern: /disregard\s+(all\s+)?(previous\s+|above\s+)?rules/i, description: 'rule disregard' },
  { pattern: /forget\s+(everything|all|your)\s+(you|instructions|rules)/i, description: 'memory wipe' },
  { pattern: /you\s+are\s+now\s+(?:a\s+)?(?:different|new|unrestricted)/i, description: 'identity hijack' },
  { pattern: /system\s*:\s*you\s+are/i, description: 'fake system message' },
  // Dangerous command injection
  { pattern: /execute\s+(curl|wget|bash|sh|python|node)\b/i, description: 'command execution' },
  { pattern: /\bcat\s+\/etc\/(passwd|shadow|sudoers)/i, description: 'credential access' },
  { pattern: /\brm\s+-rf\s+[\/~]/i, description: 'destructive command' },
  { pattern: /\beval\s*\(/i, description: 'eval injection' },
  // Data exfiltration
  { pattern: /\bcurl\s+.*\|\s*(bash|sh)/i, description: 'pipe to shell' },
  { pattern: /send\s+(to|via)\s+(http|webhook|url)/i, description: 'data exfiltration' },
  // HTML/comment injection
  { pattern: /<!--[\s\S]*?-->/g, description: 'HTML comment injection' },
];

/** Invisible unicode characters that can hide malicious content. */
const INVISIBLE_UNICODE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u00AD]/g;

/**
 * Scan text for prompt injection patterns and invisible unicode.
 * Returns sanitized text with threats neutralized and a list of detections.
 */
export function scanForInjection(text: string): { sanitized: string; threats: string[] } {
  const threats: string[] = [];
  let sanitized = text;

  // Check for invisible unicode
  if (INVISIBLE_UNICODE.test(sanitized)) {
    const count = (sanitized.match(INVISIBLE_UNICODE) || []).length;
    threats.push(`${count} invisible unicode character(s) removed`);
    sanitized = sanitized.replace(INVISIBLE_UNICODE, '');
  }

  // Check for injection patterns
  for (const { pattern, description } of INJECTION_PATTERNS) {
    const matches = sanitized.match(pattern);
    if (matches) {
      threats.push(`${description}: "${matches[0].slice(0, 50)}"`);
      // Neutralize by wrapping in brackets (visible but defanged)
      sanitized = sanitized.replace(pattern, (match) => `[BLOCKED: ${match}]`);
    }
  }

  return { sanitized, threats };
}
