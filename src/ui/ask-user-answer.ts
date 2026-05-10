/**
 * Resolve a user-typed AskUser answer against the option list.
 *
 * The TUI renders option labels as a numbered list ("1. X", "2. Y", …),
 * so users naturally type the digit. Every tool-side onAskUser caller
 * (videogen.ts:113, modal.ts:371, jupiter.ts:368, zerox-base.ts:453,
 * zerox-gasless.ts:446) does an exact-string match against the full
 * label, so a bare "1" silently falls through to the caller's default
 * branch — which is typically "cancel".
 *
 * Verified 2026-05-04 in a live session: user typed "1" twice in a
 * VideoGen flow, both invocations returned "Video generation cancelled
 * (No USDC was spent)" even though the wallet had $94.72 and the
 * Content budget had $2.00 untouched.
 *
 * Translation rules:
 *   - "" → "(no response)" (preserve the existing empty-input fallback)
 *   - "<digit>" with options.length > 0 and 1 ≤ digit ≤ options.length
 *     → the matching label string
 *   - anything else → the trimmed input verbatim (callers that match
 *     against label can still get a literal answer when the user types
 *     it out, and free-form text questions still work the same way)
 */
export function resolveAskUserAnswer(
  raw: string,
  options: readonly string[] | undefined,
): string {
  const trimmed = raw.trim();
  if (!trimmed) return '(no response)';
  if (options && options.length > 0 && /^\d+$/.test(trimmed)) {
    const idx = parseInt(trimmed, 10) - 1;
    if (idx >= 0 && idx < options.length) return options[idx];
  }
  return trimmed;
}
