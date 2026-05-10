# Franklin 3.15.89 — vision images survive the budgeter

*May 10, 2026 · 1 patch release*

A single-issue patch. Vision calls (sonnet-4.6, opus-4.7, anything that can
read images) had been silently hallucinating against attached PNGs. The
images were never reaching the wire — Franklin's own context budgeter was
destroying them before the request left the agent.

This release fixes that.

## The bug

`src/agent/optimize.ts:budgetToolResults` is the per-message char budget
that caps oversized tool outputs. Pre-fix, when a tool returned an array
of content segments (e.g. `[{type:'text', text:'Image file: /tmp/foo.png'},
{type:'image', source:{type:'base64', data:'<275KB of bytes>'}}]`), the
budgeter ran:

```ts
const content = typeof part.content === 'string'
  ? part.content
  : JSON.stringify(part.content);
const size = content.length;

if (size > MAX_TOOL_RESULT_CHARS) { /* truncate to text preview */ }
```

A 275KB base64 image inflates `JSON.stringify(content)` to ~275K chars,
which trivially trips the 32K cap. The truncation branch then replaced
the entire content array with a string preview — destroying the image
block entirely. The model only ever saw a 2KB self-referential string
that started with `"[Output truncated: 275,952 chars → 2000 preview]\n\n[{\"type\":\"text\"…"`
followed by half a JSON dump of the metadata.

That's why all the vision descriptions were hallucinated: the model was
guessing without ever seeing the image.

## How it surfaced

A user reported sonnet-4.6 confidently answering "Benjamin Franklin
portrait" against a screenshot that contained no Franklin portrait.
opus-4.7 invented a "round, light-pink/rose colored circular button" in
a screenshot that had no buttons. Same flow, two different models, both
hallucinating — pointing at the agent layer rather than the model.

A direct ablation test (Python script, raw API, image attached the same
way) reproduced correct vision on both models. So it wasn't the model
or the gateway — it was something Franklin's outgoing payload was doing
differently.

A gateway log dump confirmed: the tool body had been pre-truncated by
Franklin before the gateway ever saw it. From a real production call
(sonnet-4.6, 20,723 input tokens — should have been ~150K with the image
present):

```
[3] tool: STRING(2078 chars) = '[Output truncated: 275,952 chars → 2000 preview]\n\n[{"type":"text","text":"Image '
```

## The fix

Decompose `tool_result.content` before measuring size. Only text segments
count toward `MAX_TOOL_RESULT_CHARS`. Image segments pass through
untouched on every code path:

```ts
const isArrayContent = Array.isArray(part.content);
const textBlocks = isArrayContent
  ? content.filter((b): b is TextSegment => b.type === 'text')
  : [];
const imageBlocks = isArrayContent
  ? content.filter((b): b is ImageSegment => b.type === 'image')
  : [];
const textOnly = isArrayContent
  ? textBlocks.map(b => b.text).join('\n')
  : (part.content as string);
const size = textOnly.length;

if (size > MAX_TOOL_RESULT_CHARS) {
  // Truncate text only; keep image array alongside.
  budgeted.push({
    ...,
    content: imageBlocks.length > 0
      ? [{ type: 'text', text: truncatedText }, ...imageBlocks]
      : truncatedText,
  });
}
```

The same rule applies to the per-message aggregate cap at line 122:
when a chatty text payload pushes a multi-image message over the
100K budget, the text gets dropped to a placeholder but the images
stay.

The bare-string content path (the original code) is unchanged — only
the array path was broken.

## Tests

Three regression tests added in `test/local.mjs`:

1. **300KB image + small text** → image survives, base64 not truncated.
2. **60K text + small image** → text truncated to a preview, image still
   in the content array.
3. **50K bare string** → still truncates to a string preview (the
   original path doesn't regress).

`npm test` runs 366/366 green (was 363; +3 for this fix).

## What didn't change

- `MAX_TOOL_RESULT_CHARS` (32K) and `MAX_TOOL_RESULTS_PER_MESSAGE_CHARS`
  (100K) caps are unchanged. They still protect against runaway text
  growth from chatty Bash / WebFetch / etc. outputs.
- Image bytes still consume real input tokens upstream — they're not
  free. Anthropic's per-image pixel limits enforce the actual ceiling;
  Franklin no longer pretends to enforce it via char count.
- The four other optimizers (`stripOldThinking`, `timeBasedCleanup`,
  `stripHeavyContent`, the streaming-executor side-write logic) are
  untouched.

## Behavioral implications

Vision-capable workflows that route an image through a tool result —
ImageGen, Read on a `.png`/`.jpg`, browser screenshots fed back to the
model — will now actually let the model see the image. Expect input
token counts on those calls to jump (a screenshot can easily add
100K+ vision tokens) and answers to become accurate instead of
hallucinatory. Wallet impact: real, but expected — this is the cost
of the model actually seeing what you sent.

If you were relying on vision and noticed answers drifting from the
attached image, this is the fix.
