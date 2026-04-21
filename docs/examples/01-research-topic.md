# Example 01 — Research a topic end to end

## What this shows

Franklin spending a few cents on paid web research and handing back a
self-contained markdown brief. Exercises:

- `ActivateTool` — the agent pulls web tools into its active set
- `ExaSearch` / `ExaAnswer` — paid neural search + cited Q&A ($0.01 each)
- `ExaReadUrls` — batch-fetch full markdown content for up to 100 URLs
  ($0.002 per URL)
- `Write` — save the brief to the working directory

## Expected wallet cost

- 1 ExaAnswer: $0.01
- 1 ExaSearch: $0.01
- ExaReadUrls for 5 URLs: $0.01
- **Total: ~$0.03 USDC**

## The prompt

```
I want a research brief on "retrieval-augmented generation in 2026".
Please do the following:

1. Activate the web-research tools: ExaSearch, ExaAnswer, ExaReadUrls.
2. Use ExaAnswer to get a current grounded summary of the state of RAG.
3. Use ExaSearch (category: research paper, last 6 months) to find the
   top five relevant papers.
4. Use ExaReadUrls to pull the full text of those five URLs.
5. Synthesize everything into a brief with these sections:
   - Executive summary (3 sentences)
   - What changed in 2025-2026 (bullet list)
   - Open problems (bullet list)
   - Five citations with one-line descriptions each
6. Write the brief to ./research-brief.md.

Stop after writing the file. Print only the filename on the final line.
```

## What Franklin should do

1. Call `ActivateTool({ names: ["ExaSearch","ExaAnswer","ExaReadUrls"] })`.
2. Call `ExaAnswer` once.
3. Call `ExaSearch` with `category: "research paper"` and a date range.
4. Call `ExaReadUrls` once with an array of five URLs.
5. Call `Write` to create `research-brief.md`.
6. Stop. Final text is the filename.

## Why this is the canonical shape

Every paid step is logged with a signed micropayment. You can confirm
the spend with `franklin wallet` after the run — the balance reflects
exactly what the research cost, no monthly fee amortized over it. That
visibility is the whole point of the wallet.
