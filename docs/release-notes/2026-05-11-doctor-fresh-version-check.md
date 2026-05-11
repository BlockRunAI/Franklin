# Franklin 3.15.93 — `franklin doctor` no longer lies when you're behind

*May 11, 2026 · 1 patch release · same-day follow-up to 3.15.92*

Found while investigating the user's own wallet ledger: they had spent
$22 USDC over 48 hours but **only $1 of it landed in any local tracker**
(cost_log + stats). Where did $21 go?

Tracking it down: their globally-installed `franklin` was at version
**3.15.88** for the entire 48 hours during which 3.15.89, 3.15.90, and
3.15.91 shipped. The agent-side cost_log writer (added in 3.15.89) and
the real-charge stats writer (also 3.15.89) couldn't run in production
for them — the binary on disk didn't have those functions. Every paid
LLM call hit the wallet correctly but neither ledger captured it.

The natural question: why didn't they notice? Two reasons:

1. The startup banner DOES print an upgrade nudge when out of date. But
   `franklin start` runs as a long-lived TTY session — you see the
   banner once, the session lasts hours, you've moved on.

2. `franklin doctor` — the diagnostic everyone runs when troubleshooting —
   was reading from a **24-hour-cached** version file. Between
   same-day releases, that cache lagged the npm registry. The user could
   run `franklin doctor`, get `✓ Franklin v3.15.88` (a green check!),
   and have no idea they were 4 versions behind.

Verified by inspecting `~/.blockrun/version-check.json` after the user
ran doctor: cache contained `3.15.92` (correct, after I bumped them),
but in the window between 3.15.92 publishing and the daily refresh
firing, the cache would have still said an older version.

## The fix

```ts
export async function getAvailableUpdateFresh(): Promise<UpdateInfo | null> {
  if (isDisabled()) return getAvailableUpdate();
  const latest = await fetchLatestVersion();
  if (latest) {
    writeCache({ latestVersion: latest, checkedAt: Date.now() });
    if (compareSemver(latest, VERSION) > 0) {
      return { current: VERSION, latest };
    }
    return null;
  }
  // Fetch failed — fall back to whatever the cache says.
  return getAvailableUpdate();
}
```

Doctor now calls `getAvailableUpdateFresh()` instead of the cached
synchronous `getAvailableUpdate()`. The fetch fires in parallel with
the other checks (Node version, wallet, gateway, MCP, telemetry) and
typically settles in well under 300 ms — total doctor wall-clock stays
under 2 seconds even on a slow connection.

If the fetch fails (offline, npm hiccup, 2 s timeout exceeded), doctor
falls back to the cached value rather than throwing — same behavior as
before, just refreshed when possible.

## What didn't change

- The daily `kickoffVersionCheck()` path used by `franklin start`'s
  banner is unchanged. We don't want to hammer npm on every startup;
  for the banner, a 24h cache is the right ergonomic.
- The opt-outs (`FRANKLIN_NO_UPDATE_CHECK=1`, CI environment
  detection) still apply to both paths.
- The `version-check.json` cache file format is unchanged.

## Tests

`compareSemver` got explicit unit coverage in `test/local.mjs`:

- `3.15.92` > `3.15.88` returns 1.
- `3.15.88` < `3.15.92` returns -1.
- Equal versions return 0.
- Leading `v` is stripped (`v3.15.92` == `3.15.92`).
- Pre-release suffix is ignored (`3.15.92-beta.1` == `3.15.92`).
- Unparseable input returns 0 (never throws).

The fresh-fetch integration itself is exercised by the smoke test in
the release-PR description — `franklin doctor` rendered correctly in
1.6 s wall-clock on a fresh build.

382/382 tests pass.

## Why this is the actual bug that matters

The cost_log gap I "fixed" in 3.15.89 wasn't broken — it was already
fixed in code. It was broken because **the code wasn't running**. The
gap was operational, not technical. This release closes that
operational gap: from now on, anyone running `franklin doctor` gets an
authoritative answer about whether they're up to date, even if the
last release shipped 12 minutes ago.

Take this as a meta-lesson for the harness-engineering line of work
we just kicked off in 3.15.92's anomaly detector: **shipping a fix is
necessary but not sufficient**. The fix has to actually be running on
the user's machine. Update-nudges are part of the harness; treat them
as production code, not best-effort polish.

## Behavioral implications

If you've been running `franklin doctor` periodically and getting all
green, this release will reveal staleness you didn't know you had.
Run it once after upgrading:

```
franklin doctor
```

If it says `⚠ Franklin vX.Y.Z — update available: vA.B.C` — your
previous "all clear" was a lie. Upgrade with the suggested command.

If it says `✓ Franklin vX.Y.Z` (green) — you really are on the latest,
verified against npm's registry just now, not against a 24-hour-old
cached guess.
