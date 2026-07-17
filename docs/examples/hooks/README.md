# Lifecycle hooks

Hooks are external commands Franklin runs at fixed lifecycle points. They receive a
JSON envelope on stdin and can veto blocking events by exiting `2` or printing
`{"decision":"deny","reason":"..."}` on stdout.

## Install

Copy a hook's `.json` file (and its script) into `~/.blockrun/hooks/`:

```bash
mkdir -p ~/.blockrun/hooks
cp daily-spend-cap.json daily-spend-cap.sh ~/.blockrun/hooks/
chmod +x ~/.blockrun/hooks/daily-spend-cap.sh
```

Project-scoped hooks live in `<repo>/.franklin/hooks/` and load only after the
project is trusted (`/mcp trust`).

## Events

| Event | Blocking | Fires |
|---|---|---|
| `SessionStart` | no | session begins |
| `UserPromptSubmit` | no | each user prompt |
| `PreToolUse` | **yes** | before any tool executes |
| `PostToolUse` | no | after a tool executes |
| `PreSpend` | **yes** | before a tool that moves real money executes |
| `PostSpend` | no | after a successful spend |
| `Stop` | no | agent completes a turn |
| `SessionEnd` | no | session ends |

`matcher` is a regex tested against the tool name (tool events only).

## Semantics

- exit `0` → allow; exit `2` → deny; stdout `{"decision":"deny"}` → deny regardless of exit code
- timeout (default 5s), crash, or missing binary → **fail open** (allow + logged)
- `PreSpend` input carries `spend: {estimatedUsd, tool, params}`; `estimatedUsd`
  is `null` when the amount isn't priceable at call time
- every deny is recorded in `~/.blockrun/approvals.jsonl`
- disable all hooks with `FRANKLIN_HOOKS=0`

## Examples in this directory

- **daily-spend-cap** — PreSpend: rejects spends once the day's estimated total crosses a cap
- **token-blacklist** — PreToolUse on swap tools: rejects trades touching blacklisted mints
- **session-spend-log** — PostSpend: appends every spend to a JSONL ledger
