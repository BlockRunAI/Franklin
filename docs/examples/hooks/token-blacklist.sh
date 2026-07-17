#!/bin/sh
# PreToolUse hook: deny swaps that touch a blacklisted token symbol or mint.
# TOKEN_BLACKLIST is a comma-separated list matched case-insensitively against
# the swap's input/output token fields.

BLACKLIST="${TOKEN_BLACKLIST:-}"
[ -z "$BLACKLIST" ] && exit 0

INPUT="$(cat)"
TOKENS="$(printf '%s' "$INPUT" | jq -r '[.toolInput.input_mint, .toolInput.output_mint, .toolInput.sell_token, .toolInput.buy_token] | map(select(. != null)) | join(" ")' | tr '[:lower:]' '[:upper:]')"

OLD_IFS="$IFS"; IFS=','
for banned in $BLACKLIST; do
  IFS="$OLD_IFS"
  banned_up="$(printf '%s' "$banned" | tr '[:lower:]' '[:upper:]' | sed 's/^ *//;s/ *$//')"
  [ -z "$banned_up" ] && continue
  case " $TOKENS " in
    *"$banned_up"*)
      printf '{"decision":"deny","reason":"token %s is blacklisted by policy"}\n' "$banned_up"
      exit 2
      ;;
  esac
done

exit 0
