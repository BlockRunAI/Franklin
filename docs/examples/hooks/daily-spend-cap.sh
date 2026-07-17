#!/bin/sh
# PreSpend hook: deny spends once today's estimated total crosses a USD cap.
# State: one counter file per day under ~/.blockrun/hook-state/.
# Unknown amounts (estimatedUsd null) are allowed but not counted — pair with
# a stricter policy if you need unpriceable spends blocked too.

CAP="${DAILY_SPEND_CAP_USD:-25}"
STATE_DIR="$HOME/.blockrun/hook-state"
STATE_FILE="$STATE_DIR/spend-$(date +%Y-%m-%d).total"
mkdir -p "$STATE_DIR"

INPUT="$(cat)"
AMOUNT="$(printf '%s' "$INPUT" | jq -r '.spend.estimatedUsd // empty')"

[ -z "$AMOUNT" ] && exit 0  # unpriceable — allow

TOTAL="$(cat "$STATE_FILE" 2>/dev/null || echo 0)"
NEW_TOTAL="$(printf '%s %s' "$TOTAL" "$AMOUNT" | awk '{print $1 + $2}')"

OVER="$(printf '%s %s' "$NEW_TOTAL" "$CAP" | awk '{print ($1 > $2) ? 1 : 0}')"
if [ "$OVER" = "1" ]; then
  printf '{"decision":"deny","reason":"daily spend cap: $%s spent + $%s requested exceeds $%s/day"}\n' "$TOTAL" "$AMOUNT" "$CAP"
  exit 2
fi

printf '%s' "$NEW_TOTAL" > "$STATE_FILE"
exit 0
