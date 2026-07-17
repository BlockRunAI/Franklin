#!/bin/sh
# PostSpend hook: append every successful spend to a JSONL ledger.

LOG="$HOME/.blockrun/hook-state/spend-log.jsonl"
mkdir -p "$(dirname "$LOG")"

cat | jq -c '{ts: .timestamp, session: .sessionId, tool: .spend.tool, estimatedUsd: .spend.estimatedUsd}' >> "$LOG"
exit 0
