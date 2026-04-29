# Franklin Skills MVP — Design

**Status:** Draft
**Date:** 2026-04-29
**Owner:** vicky.fuyu@gmail.com

## One sentence

Add a `SKILL.md` loader that registers Anthropic-spec markdown skills as Franklin slash commands, with automatic wallet/budget context injection (A) and a small budget-aware frontmatter contract (B) — so any Claude Code skill works on Franklin out of the box, and Franklin's own skills carry hard budget guarantees no other agent can deliver.

## Goals (in scope for MVP)

1. **Anthropic-spec compatibility.** Read SKILL.md files with the same frontmatter shape Claude Code uses: `name`, `description`, `argument-hint`, `disable-model-invocation`. Bodies use `$ARGUMENTS` for argument substitution.
2. **Three discovery sources, in precedence order:**
   - `<repo>/.franklin/skills/<name>/SKILL.md` and `<repo>/.claude/skills/<name>/SKILL.md` (project-local, wins over user)
   - `~/.blockrun/skills/<name>/SKILL.md` (user-global)
   - `src/skills-bundled/<name>/SKILL.md` (ships with Franklin)
3. **Wallet-aware context injection (A).** Before substituting `$ARGUMENTS`, every skill body has `{{wallet_balance}}`, `{{turn_budget_remaining}}`, `{{spent_this_turn}}`, `{{per_turn_cap}}`, `{{wallet_chain}}` substituted from the live agent context.
4. **Frontmatter budget contract (B, MVP subset):**
   - `cost-receipt: true` — when the skill's slash command finishes the resulting agent turn, append a per-action receipt under the reply.
   - `budget-cap-usd: 0.50` — soft cap recorded as the turn's `max-turn-spend-usd` for the duration of this skill's invocation; restored when the turn ends.
5. **Four bundled skills** (see [Bundled skills](#bundled-skills) below).
6. **CLI surface:** `franklin skills list`, `franklin skills install <git-url-or-name>`, `franklin skills which <name>`. No removal in MVP — just delete the directory.
7. **`/help` integration:** skills appear under their own header with description.
8. **`franklin doctor`:** new row showing `skills: N loaded from K dirs`.

## Non-goals (deferred to v2)

- `BudgetCheck` model-callable tool (Approach C from brainstorming)
- Skill bundled-resource sandboxing (skills with sibling files like `references/foo.md`)
- Skill signing / trust prompt
- Per-skill spend telemetry (would require weaving into agent loop's spend tracker)
- Skill marketplace UI
- Hot-reload of skills mid-session

## Architecture

### File layout

```
src/skills/
├── loader.ts              # discover + parse SKILL.md, validate frontmatter
├── registry.ts            # in-memory skill registry, name conflict resolution
├── invoke.ts              # interpolate variables, call into existing slash-command path
├── budget.ts              # frontmatter contract enforcement (receipt + cap)
└── types.ts               # Skill, SkillManifest, SkillSource

src/skills-bundled/
├── budget-grill/
│   └── SKILL.md
├── spend-tdd/
│   └── SKILL.md
├── cost-zoom/
│   └── SKILL.md
└── wallet-receipt/
    └── SKILL.md

src/commands/skills.ts     # `franklin skills` CLI subcommand
```

### Loading sequence

1. **Startup** (`src/agent/loop.ts` boot path): call `loadAllSkills()` which scans bundled → user → project, returns a deduplicated `SkillRegistry`. Project beats user beats bundled.
2. **Slash dispatch** (`src/agent/commands.ts::handleSlashCommand`): after `DIRECT_COMMANDS` and built-in `REWRITE_COMMANDS`/`ARG_COMMANDS` checks, fall through to a new `handleSkill(input, ctx, registry)` step. If matched, interpolate `{{...}}` vars and `$ARGUMENTS`, then synthesize the same `prompt-rewrite` flow used today (set the user-message to the interpolated body, run the agent loop).
3. **Budget contract** (`src/skills/budget.ts`): if `budget-cap-usd` is set, snapshot the current `max-turn-spend-usd` on `ctx.config`, override for the turn, restore on turn-complete event. If `cost-receipt: true`, register a one-shot post-turn hook that emits a receipt block.

### Variable substitution

Two-phase, in order:

1. **Wallet variables** (always, on every skill invocation):

   | Variable | Source | Default if unavailable |
   |---|---|---|
   | `{{wallet_balance}}` | `Wallet.balance()` | `unknown` |
   | `{{turn_budget_remaining}}` | `per_turn_cap - spent_this_turn` | falls back to `per_turn_cap` |
   | `{{spent_this_turn}}` | `ctx.spendTracker.current()` | `0.00` |
   | `{{per_turn_cap}}` | `ctx.config['max-turn-spend-usd']` | `1.00` |
   | `{{wallet_chain}}` | `ctx.config.chain` | `base` |

2. **`$ARGUMENTS`** (Anthropic spec): replaced with the trailing argument string after the command name. Preserved verbatim, no escaping.

Unknown `{{vars}}` are left intact (no error) so future variables don't break old skills.

### Frontmatter parsing

YAML frontmatter between leading `---` lines. Required: `name`, `description`. Optional: `argument-hint`, `disable-model-invocation`, `budget-cap-usd`, `cost-receipt`.

Validation rules:
- `name`: kebab-case, must match parent directory; otherwise warn and use directory name.
- `description`: ≤ 200 chars; truncate with warning.
- `disable-model-invocation: true` means the skill is user-invocation-only — it appears in `/help` but is not advertised in the auto-skill-discovery prompt that the model sees. (We don't ship auto-skill-discovery in MVP, but this flag is honored from day one so future v2 can add it.)
- `budget-cap-usd`: parsed as float ≥ 0; if negative or NaN, warn and ignore.
- `cost-receipt`: parsed as boolean; non-boolean → warn and ignore.

### Conflict resolution

When two sources expose the same skill `name`:

- Project local wins over user-global wins over bundled.
- A built-in slash command (e.g. `/security`) takes precedence over a same-named skill — built-ins are never shadowed. `franklin skills list` flags shadowed skills.
- Two skills at the same precedence level (e.g. two project files): first one wins, second is logged as `skipped (duplicate)`.

## Bundled skills

Each shipped under `src/skills-bundled/<name>/SKILL.md`. All use `cost-receipt: true`.

### `/budget-grill`

Wallet-flavored grilling. Inspired by mattpocock's `/grill-me`, with budget framing baked into the prompt: every question must include a cost-impact angle.

- `name: budget-grill`
- `description: Wallet-aware grilling — interview me about a plan with budget impact estimated for each branch of the decision tree`
- Body excerpt: *"Wallet shows {{wallet_balance}} on {{wallet_chain}}; this turn has {{turn_budget_remaining}} of {{per_turn_cap}} left. Interview me one question at a time, with each question framed: 'option A spends roughly $X via tool/model Y, option B spends $Z because…'."*
- No `budget-cap-usd` — pure interview, low spend.

### `/spend-tdd`

Red-green-refactor TDD with cost framing per cycle. Inspired by mattpocock's `/tdd`.

- `name: spend-tdd`
- `description: TDD red-green-refactor with per-cycle budget tracking and rollback on cap exceeded`
- `budget-cap-usd: 0.50` (default; arg can override via `/spend-tdd cap=1.0 …`)
- Body forces: write failing test → run → confirm fail → minimum impl → run → confirm pass → refactor → run → commit. After each cycle, print `cycle N: spent $X, remaining $Y`.

### `/cost-zoom`

Zoom-out + telemetry-derived spend annotations.

- `name: cost-zoom`
- `description: Explain a section of code in the broader system context, annotated with observed USDC spend per module from telemetry`
- Body reads `~/.blockrun/telemetry.jsonl` (if enabled) and tags each module discussed with its 30-day spend.
- No cap (read-only analysis).

### `/wallet-receipt`

End-of-task receipt. Different from a session summary: itemized per-paid-call.

- `name: wallet-receipt`
- `description: Produce an itemized USDC receipt for the current session — every x402 paid call with timestamp, model/tool, amount`
- Body queries the existing `SessionMeta` + `telemetry.jsonl` and emits a markdown table.
- Pure read; no cap.

## CLI surface

```
franklin skills              # alias for `skills list`
franklin skills list         # show all loaded skills, source dir, conflicts
franklin skills which <name> # print absolute path to the SKILL.md being used
franklin skills install <ref>
  # <ref> = git URL → clone into ~/.blockrun/skills/<repo-name>/
  # <ref> = github user/repo → clone into ~/.blockrun/skills/<repo-name>/
  # <ref> = path → copy SKILL.md tree into ~/.blockrun/skills/<name>/
```

Removal: `rm -rf ~/.blockrun/skills/<name>` — by design, no `franklin skills remove`. Skills are dirs.

## `/help` integration

The skills section is a new block in `/help` output:

```
Skills:
  /budget-grill           Wallet-aware grilling — ...
  /spend-tdd              TDD red-green-refactor with per-cycle budget tracking
  /cost-zoom              Explain a section of code with observed USDC spend...
  /wallet-receipt         Produce an itemized USDC receipt for the session
  ...user/project skills also listed here
```

`disable-model-invocation: true` skills appear under a sub-header `Skills (manual only):`.

## `franklin doctor` integration

Add one row:

```
[OK]  skills: 4 loaded (4 bundled, 0 user, 0 project)
```

`[WARN]` if any skill failed to parse; row text becomes `… (1 failed: <name>)`.

## Telemetry

Skills are usage-tracked the same way slash commands are today: a single counter increment in `SessionMeta` per invocation, no content. No new telemetry fields in MVP.

## Testing strategy

`test/skills.local.mjs` covers (no live API):

1. Loader finds and parses a valid SKILL.md.
2. Loader rejects malformed frontmatter cleanly (warn, don't crash).
3. Variable substitution: `{{wallet_balance}}`, `{{turn_budget_remaining}}`, `$ARGUMENTS` substitute correctly.
4. Conflict resolution: project beats user beats bundled.
5. Built-in slash commands beat skills with same name.
6. `cost-receipt: true` → post-turn hook fires; mock spend → receipt content.
7. `budget-cap-usd: 0.50` → snapshots and restores `max-turn-spend-usd` correctly across turn.

Live skill tests deferred — integration testing through the agent loop costs USDC. The four bundled skills will be smoke-tested manually before release and again in the live-e2e checklist.

## Phased rollout

Three commits, each shippable independently:

1. **Phase 1 — Loader + registry + variable injection (A).** No frontmatter contract yet. Load only bundled skills. `franklin skills list` works. Existing slash-command path is the only invocation surface. Ship as 3.9.0-rc1 to internal users.
2. **Phase 2 — Frontmatter contract (B).** Honor `cost-receipt` and `budget-cap-usd`. Add user-global and project-local discovery. `franklin skills install` and `which`. Ship as 3.9.0.
3. **Phase 3 — Bundled skills polish.** All four skills hand-tuned with at least one round of red-team prompting on each. Documentation added to README and a new `docs/skills.md`. Ship as 3.9.1 (or 3.9.0 if Phase 2 timing aligns).

## Risks

- **Frontmatter sprawl.** If we say yes to too many fields too early, we own them forever. MVP holds the line at 4 frontmatter keys (`name`, `description`, plus `cost-receipt` and `budget-cap-usd` from B). Anthropic's spec keys (`argument-hint`, `disable-model-invocation`) are honored on parse but no behavior in MVP beyond the `/help` filter.
- **Skill name conflicts with built-ins.** A user with a `security/` skill would otherwise shadow `/security`. Mitigation: built-ins always win; warn in `franklin skills list`.
- **Variable substitution leaking sensitive context.** `{{wallet_balance}}` inside a skill body that the model relays to a third-party tool could exfiltrate balance. Mitigation: document this in `docs/skills.md`; the user is choosing to install third-party skills knowingly. Acceptable risk in MVP.
- **Cap restoration bug.** A `budget-cap-usd` skill that crashes mid-turn could leave `max-turn-spend-usd` reduced. Mitigation: restore in a `finally` block inside the turn-complete hook; cover with a unit test.

## Open questions for next pass

- Should `franklin skills install` git-clone require a SHA pin? (security: no surprise updates)
- When a project has both `.claude/skills/foo/` and `.franklin/skills/foo/`, do we prefer Franklin's? (proposed: yes; warn about duplicate)
- Do we want `skill-aliases` in frontmatter for shortened invocations like `/bg` for `/budget-grill`? (proposed: no for MVP; aliases handled by user-side shell aliasing)

## Estimated effort

- Phase 1: ~1.5 days. Loader, registry, variable substitution, doctor row, `franklin skills list`/`which`. Tests in same commit.
- Phase 2: ~1.5 days. Frontmatter contract enforcement, `install`, project + user discovery, conflict UX.
- Phase 3: ~2 days. Four skill bodies hand-tuned, README copy, `docs/skills.md`, manual smoke through the live-e2e checklist.

Total: ~5 working days for 3.9.0 release.
