# Franklin Agent by example

Every file in this directory is a **real prompt** you can paste into
Franklin at the interactive terminal. Nothing here is pseudocode, nothing
is staged — it's the exact text a user would type to drive the agent.
Each example names the tools it exercises, the expected wallet spend, and
the artifact Franklin should leave behind when it's done.

If an example breaks (a tool got renamed, a provider changed), that's a
bug worth filing. These files are also how we test that the docs keep up
with the code.

| Example | What it shows | Wallet cost |
|---|---|---|
| [01-research-topic.md](01-research-topic.md) | Research a topic with Exa web tools, save a markdown brief | ~$0.03 |
| [02-trading-daily-review.md](02-trading-daily-review.md) | Paper-trade a crypto watchlist end-to-end | $0 (free data tier) |
| [03-content-piece.md](03-content-piece.md) | Generate an image + video + caption for one Content piece | ~$0.20 |

Run Franklin:

```bash
npm install -g @blockrun/franklin   # or: npm link from this repo
franklin wallet fund                # one-time, before paid tools
franklin                            # launch the interactive shell
```

Then paste the contents of whichever example below the `You:` prompt.
