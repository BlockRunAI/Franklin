# Franklin 3.15.98 — image-bearing context-token counters across the codebase

*May 12, 2026 · 1 patch release · PR #54 + 3 sibling sites caught in review*

`KillerQueen-Z` filed PR #54 with three context-window display fixes
and a clean empirical reproduction. While reviewing, I grepped the
codebase for the same `JSON.stringify(part.content)` pattern and
found three more sites with the same image-token-inflation bug.
Landing all six together.

## The bug class, one final time

Any function that handles `tool_result.content` arrays and falls back
to `JSON.stringify(content)` will tokenize image base64 as text. A
typical normalized image is ~140KB base64 → ~70K phantom
chars / ~35K phantom tokens. Anthropic actually bills `(w*h)/750`
≈ 1100-1500 tokens per image.

We've been fixing this site by site:

| Release | Site | Damage |
|---|---|---|
| 3.15.89 | `optimize.ts:budgetToolResults` | trimmed → **destroyed image** |
| 3.15.90 | `reduce.ts:ageToolResults` (PR #53) | aged → **destroyed image** |
| 3.15.90 | `reduce.ts:deduplicateToolResultLines` | deduped → **destroyed image** |
| 3.15.90 | `reduce.ts:collapseRepetitiveTools` | collapsed → **destroyed image** |
| **3.15.98** | `tokens.ts:estimateContentPartTokens` | inflated /context by 40× |
| **3.15.98** | `reduce.ts:estimateChars` | inflated → wrong collapse decisions |
| **3.15.98** | `compact.ts:tool_result preview` | base64 in summary prompt |
| **3.15.98** | `commands.ts:/context tool char display` | inflated UI char count |

Eight sites total. After this release, every place in the codebase
that touches `tool_result.content` arrays handles them correctly.

## PR #54 (landed verbatim)

### `tokens.ts:estimateContentPartTokens` — main fix

Empirically verified by the contributor: same 4-message session with
one ~100KB image showed:

- Before: `/context` = **75K / 200K (37.8%)**
- After: `/context` = **1.9K / 200K (1.0%)**

That's a 40× over-count. It also triggered premature `/compact`
calls — agent saw 37% "context fullness" on a session that was 1%
full, fired bloat compactions that weren't needed, burned tokens
unnecessarily.

The fix walks the content array block-by-block. Text blocks count as
text. Image blocks count as 1500 tokens (flat). Unknown block types
still stringify, but with `source.data` redacted to `<bytes>` so
future block kinds (audio? video?) don't regress.

### `getAnchoredTokenCount` — `contextUsagePct: 0` always

Both return paths of this function hardcoded the field. The agent
loop emits this via `kind: 'usage'` events to the renderer, so the
desktop/extension's context ring was stuck at 0% regardless of how
full the context actually was.

Fix: compute `(estimated / contextWindow) * 100` using the current
model's window from `getContextWindow(_currentModel)`.

### `loop.ts` — integer rounding froze the ring

```ts
contextPct: Math.round(contextUsagePct),
```

A 200-message session at 0.4% rounded to 0 and froze the renderer.
Now `Math.round(contextUsagePct * 10) / 10` keeps one decimal.

## Sibling sites (caught during PR #54 review)

### `reduce.ts:estimateChars`

This function gates `reduceTokens`'s passes (dedupe, collapse,
normalize). When an image inflates the char count by ~140K, the
reduce decisions trigger aggressive collapsing — including the
image-bearing tool_result, which (because of the 3.15.90 array-aware
fix) survives the collapse but only after needlessly burning the
reduce pass.

Fix walks blocks: text blocks count text length; image blocks count
~6000 chars (the char-equivalent of 1500 tokens at the 4-chars/token
rule).

### `compact.ts:tool_result preview`

When the agent's summarizer needs to compress old turns, it builds a
preview of each tool_result for the summary prompt:

```ts
const content = typeof part.content === 'string'
  ? part.content
  : JSON.stringify(part.content);
const truncated = content.length > 500 ? content.slice(0, 500) + '...' : content;
textParts.push(`[Tool result: ${truncated}]`);
```

For an image-bearing result, `JSON.stringify` produces a string that
starts with `[{"type":"text","text":"..."},{"type":"image","source":{"type":"base64","data":"AAA...`.
Slicing to 500 chars gives the summarizer a useless preview of base64
garbage.

Fix builds the preview from text blocks only, then appends `[N image
block(s)]` to mark their presence:

```ts
const pieces: string[] = [];
let imageCount = 0;
for (const block of part.content) {
  if (block.type === 'text') pieces.push(block.text);
  else if (block.type === 'image') imageCount++;
}
if (imageCount > 0) pieces.push(`[${imageCount} image block(s)]`);
```

The summarizer now sees `[Tool result: Image file: /tmp/scene.png [1 image block]]`
instead of 500 chars of base64.

### `commands.ts:/context tool char count`

`/context` displays "Total tool result chars: X" alongside the token
estimate. Pre-fix, X included the base64 bytes — so a user with the
fixed token count seeing `/context = 1.9K/200K (1.0%)` would also see
"Total tool result chars: 142,847" and be confused. Now the char
count walks blocks the same way.

## Tests

Three new in `test/local.mjs`:

1. **`estimateContentPartTokens: image block counts as ~1500 tokens, not
   base64 char length`** — pin the main PR #54 fix against a 140KB
   synthetic image. Asserts result is `< 3000` tokens and `> 1000`
   (not silently zero either).
2. **`estimateContentPartTokens: text-only string content path
   unchanged`** — 4000-char string body → ~2000 tokens (within ±25%).
   Guards against regression in the simple path.
3. **`estimateChars (reduce.ts): image blocks count as ~6K chars, not
   base64 length`** — build a 12-message history with one image
   carrying 140KB base64, run `reduceTokens`, assert the image base64
   survives. Pre-fix, the inflated char count triggered aggressive
   collapse that would have destroyed the image.

387/387 tests pass.

## What didn't change

- **Wallet billing**: unchanged — the gateway has its own (working)
  image accounting and uses its own input estimate. PR #54 explicitly
  notes this.
- **3.15.95's `cacheCreationInputTokens` / `cacheReadInputTokens`
  capture** — independent, complementary fix for wallet-truth
  accounting (different layer).
- **The `Read` tool's `sharp` normalization** (3.15.90) is unchanged.
  It caps long-edge at 1280px which is why "image ≈ 1500 tokens flat"
  is a good estimate.

## Credits

`KillerQueen-Z` (PR #54) — empirical reproduction (40× discrepancy
on a real session) and the clean three-part fix. Same contributor as
PR #53 (vision token explosion). Two sharp diagnostics in a row.

## Behavioral implications

After this release:

- `/context` shows the actual context fullness on image-bearing
  sessions. Pre-fix, it could read 37% on a 1% session.
- The desktop/extension context ring updates correctly. Pre-fix, it
  was stuck at 0% regardless of fullness.
- Compaction triggers fire on real fullness, not on image-token
  inflation. Fewer spurious `/compact` events on vision workflows.
- The summarizer (when compaction does fire) sees text previews
  marked with image counts instead of base64 garbage. Marginally
  better summaries, marginally lower summary-call costs.

If you've been seeing `/context` numbers that don't match your gut
sense of session length — they should match now.
