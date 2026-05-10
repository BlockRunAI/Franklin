# Franklin 3.15.90 — vision sweep: PR #53 + sibling sites

*May 10, 2026 · 1 patch release · same-day follow-up to 3.15.89*

3.15.89 fixed `optimize.ts:budgetToolResults`. **PR #53** (`KillerQueen-Z`)
shipped a few hours after, catching the same `JSON.stringify(part.content)`
bug pattern in `reduce.ts:ageToolResults` and adding a `sharp`-based
client-side image resize on the `Read` tool. Reviewing #53 surfaced two
more destructive sibling sites in `reduce.ts` that the PR didn't patch.
This release lands the PR (with the duplicated optimize.ts hunk dropped)
plus the missing patches.

## The bug class, one more time

Five places in the codebase ran:

```ts
const content = typeof part.content === 'string'
  ? part.content
  : JSON.stringify(part.content);
const size = content.length;
// ... if (size > THRESHOLD) replace part.content with a string
```

When `part.content` is an array containing a vision-tool image block,
`JSON.stringify` serializes the base64 bytes into a giant string that
trivially trips whatever threshold the function is enforcing. The
truncation/replacement step then writes back a *string*, destroying
every block — including the image. The model never sees the picture
and either hallucinates a description or refuses.

| Site | Function | Status before this release |
|---|---|---|
| `optimize.ts:99` | `budgetToolResults` (per-tool 32 K cap) | fixed in 3.15.89 |
| `reduce.ts:58` | `ageToolResults` (decay older than 3 turns) | **fixed by PR #53** |
| `reduce.ts:233` | `deduplicateToolResultLines` (line dedupe) | **fixed here** |
| `reduce.ts:326` | `collapseRepetitiveTools` (>6 same-tool calls) | **fixed here** |
| `reduce.ts:419` | `reduceTokens` length-only counter | inflates token estimate, not destructive — left as-is |

## PR #53 changes (landed verbatim)

### `reduce.ts:ageToolResults`

When a tool_result is older than 3 turns, decay the text down to a
500-char preview (4–8 turns) or a stub (9+ turns). Pre-fix, the
function stringified arrays before measuring, then wrote the truncated
result back as a string. Post-fix, image-bearing results short-circuit
the decay entirely. Image bytes are already cache-cheap upstream once
prompt-cached; the cost-control intent of decay only applied to text.

### `Read` + `sharp` client-side normalization

`src/tools/read.ts` now imports `sharp@^0.34.5`. Files over 150 KB get:

- resized to long-edge 1280 px (`fit: 'inside'`, `withoutEnlargement: true`)
- re-encoded as JPEG q85 (`mozjpeg: true`)
- preserved as PNG with `compressionLevel: 9` when `sharp.stats()` shows
  non-opaque alpha (transparency matters for screenshots, UI mocks, etc.)

The resize note ("Normalized: X → Y, …") is appended to the tool's text
output so the user sees what happened.

This is a **client-side workaround** for a gateway-side issue: the
`/v1/messages` forward path tokenizes image base64 as text instead of
using vision multipart, so a 1.9 MB PNG cost ~1,361,420 input tokens
(~$0.53) per call. With the resize: 1898.7 KB → 117.6 KB, ~16× cut.
Even after the gateway fix lands, the resize is still net positive
(less network, faster transit, lower vision cost on platforms that DO
tokenize natively).

## What PR #53 didn't catch (added here)

### `reduce.ts:deduplicateToolResultLines`

Strips ANSI codes + collapses consecutive repeated lines (`Fetching... ×3`).
Pre-fix, the function stringified arrays, ran the line-level dedupe
over the resulting JSON dump, then wrote the deduped string back as
content. Image bytes lost.

Post-fix, the function decomposes arrays, runs dedupe only on text
segments, and rebuilds as `[{type:'text', text: deduped}, ...imageBlocks]`.
Bare-string content takes the original code path.

### `reduce.ts:collapseRepetitiveTools`

When the same tool (e.g. WebSearch) is called 6+ times, all results
older than the most recent 3 get replaced with a `[first-line-of-content...]`
stub. Pre-fix, this stringified arrays before stubbing → image
destroyed. Post-fix, image-bearing results bypass the collapser
entirely. Same reasoning as `ageToolResults`: image bytes are
prompt-cached upstream and cheap to keep.

## Tests

Two regression tests added in `test/local.mjs`:

1. **`deduplicateToolResultLines preserves image blocks while deduping
   text`** — content array of `[repeated text, image]` → text is
   deduped, image segment with original `data: 'IMGDATA'` survives.

2. **`collapseRepetitiveTools leaves image-bearing tool_results alone`**
   — six WebSearch-like assistant turns, one with an image-bearing
   tool_result. After collapse: text-only results become `[xxxx...]`
   stubs, the image-bearing result keeps its `KEEPME` data intact.

368/368 tests pass.

## CONTRIBUTING.md refresh

Three obvious bugs:

- `cd franklin` → `cd Franklin` (the GitHub repo name is capitalized).
- Lines 33-34 had two `5.` items — fixed to `5.` and `6.`.
- Architecture paragraph said "RunCode" — old project name from before
  the rename. Now says "Franklin" and points at the architecture docs.

Plus a new **Quality bar for fixes** section that captures how the
project actually operates: receipts-driven fixes (quote the failing
log line in the PR body), search for sibling instances of a bug class
before opening a PR, one regression test per behavior fixed. PR #53 was
the immediate prompt — it fixed 1 of 5 sites, the review caught the
remaining 4. A "fix one instance, leave four" PR is more cycles than a
"fix the class" PR.

The English-only-source policy is now explicit (was implicit until the
tracked-text guard landed in 3.15.88).

## Credits

`KillerQueen-Z` for PR #53 — the `ageToolResults` fix and the `sharp`
image normalization. The optimize.ts hunk in the PR duplicated 3.15.89
and was dropped during cherry-pick; everything else landed.

## Behavioral implications

After this release, vision flows through Franklin should match the
ablation result against direct Anthropic / Bedrock: the model actually
sees the image attached. Per-call cost on large `Read`-an-image flows
drops from $0.5+ to under $0.05 for typical screenshots, mostly from
the `sharp` normalization. Long conversations no longer silently lose
images partway through (each of the four reduce/optimize functions
that age or collapse tool_results was destroying images at its own
threshold).

If you've been working around this by re-attaching images or breaking
sessions short — you don't need to anymore.
