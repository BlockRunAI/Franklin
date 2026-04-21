# Example 03 — A single content piece, end to end

## What this shows

Franklin producing one complete Content piece with an image, a short
video, and a caption — all of it tracked against a per-piece budget
so the wallet can't run away from you. Exercises:

- `ActivateTool` — pulls the media and content tools
- `ContentCreate` — spin up a Content piece with a $1 budget
- `ImageGen` — generate the cover image (charged against the piece)
- `VideoGen` — generate a short loop clip
- `ContentAddAsset` — attach generated media to the piece
- `ContentShow` — summarize the finished piece and remaining budget

## Expected wallet cost

- 1 ImageGen (DALL-E-3 1024×1024): ~$0.04
- 1 VideoGen (xai/grok-imagine-video, 3 seconds): ~$0.15
- **Total: ~$0.20 USDC**

The `ContentCreate` step sets a budget of $1; everything generated
gets charged against that ceiling. Exceed it and the next generation
call refuses — Franklin won't silently overrun the piece.

## The prompt

```
Produce one social content piece:

- Title: "Dawn over the Aegean"
- Theme: cinematic, warm golden light, minimalist aesthetic
- Budget: $1.00

Steps:

1. Activate these tools: ContentCreate, ImageGen, VideoGen,
   ContentAddAsset, ContentShow.
2. Create the piece with ContentCreate.
3. Generate a 1024×1024 cover image (one prompt, DALL-E-3).
4. Generate a 3-second 720p video loop using the same visual direction.
5. Attach both assets to the piece via ContentAddAsset.
6. Write a 180-character Instagram caption for the piece.
7. Call ContentShow to print the final summary — title, asset paths,
   caption, spend to date, remaining budget.

Stop after ContentShow. Do not post the piece anywhere.
```

## What Franklin should do

1. `ActivateTool` with the five content/media tool names.
2. `ContentCreate({ title: "...", budgetUsd: 1.0 })`.
3. `ImageGen` with the cover prompt.
4. `VideoGen` with the video prompt. Downloads the MP4 to the working
   directory immediately (CDN URLs expire in ~24h).
5. Two `ContentAddAsset` calls — image first, then video.
6. `ContentShow` to print the piece.

## Why the budget matters

Without a budget, a generative pipeline is an open spigot. The wallet
can still stop Franklin from spending more than it holds, but that's a
hard stop at the process level, not a per-piece discipline. The
`ContentCreate`/`ContentAddAsset` flow gives you a local ceiling per
artifact — the same accountability the wallet gives you globally.
