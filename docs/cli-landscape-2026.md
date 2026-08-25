# Franklin CLI landscape review (August 2026)

This review compares Franklin with active open-source agent CLIs using their
official documentation and repositories. It focuses on product surfaces that
matter when Franklin is embedded in Desktop/Studio, not model quality.

## Current position

Franklin already has a broad agent runtime: interactive and one-shot sessions,
resume/continue, plan mode, model routing, MCP, skills, plugins, memory, goals,
hooks, multi-agent hosting, Base/Solana wallets, and explicit spend controls.
Its strongest differentiation remains wallet-native execution and budget-aware
tools rather than coding-only ergonomics.

The clearest integration gap was the process boundary. Franklin could stream
human-readable text, but a host application could not reliably distinguish
assistant text, tool lifecycle, token usage, errors, or completion. It also had
to launch the process from the desired project directory, and the only public
permission shortcut was `--trust`.

## Feature comparison

| Area | Franklin after this update | Relevant open-source precedent | Remaining gap |
| --- | --- | --- | --- |
| Host/automation output | `text`, one-result `json`, and versioned `stream-json` | Gemini CLI documents JSON and stream-JSON output; Codex exposes a JSONL app-server protocol | Publish a formal protocol schema and compatibility tests for Desktop |
| Working directory | `-C, --work-dir` for selected project launches | Gemini CLI exposes directory/workspace controls; Hermes exposes worktree operation | Add managed Git worktrees for concurrent tasks |
| Tool permissions | `default`, `plan`, `trust`, `deny-all`; `--trust` remains compatible | Gemini has approval modes; OpenCode supports allow/ask/deny rules with patterns | Expose Franklin's existing per-tool rules as named CLI profiles |
| Planning | `/plan` and `/execute`, plus headless `--approval-mode plan` | OpenCode separates plan/build agents; Aider has architect and code modes | Persist a reviewable plan artifact before execution |
| Session continuity | Resume by id, continue latest in directory, session search, Claude/Codex import | Gemini exposes resume plus session listing/deletion | Add first-class `franklin sessions list/show/delete` commands |
| Execution isolation | Permission layer and working-directory scoping | Gemini and Codex both document OS/container sandboxing | Add an actual process/filesystem sandbox; directory scoping is not a security sandbox |
| Recovery | Session history and Git-aware tools | Gemini checkpointing creates shadow-Git snapshots before file edits | Add opt-in pre-edit checkpoints and one-command restore |
| Extensibility | MCP, skills, plugin SDK, hooks, hosted agents | Hermes emphasizes reusable skills; Codex app-server separates UI from runtime | Stabilize a provider-neutral Agent Adapter interface for Studio |

## Changes implemented from the review

1. `--output-format text|json|stream-json` gives Desktop, CI, and external
   agents an explicit output contract. Every JSONL event carries
   `schemaVersion: 1`.
2. `--approval-mode default|plan|trust|deny-all` makes the safety boundary
   visible and scriptable. One-shot `default` fails fast instead of hanging on
   an invisible prompt.
3. `-C, --work-dir <dir>` lets Studio launch Franklin for a selected project
   without mutating its own process directory. The path is resolved and
   validated before wallet, model, session, or network startup.
4. Machine events omit `fullOutput` and image Base64 data to keep Electron IPC
   bounded. The ordinary tool result and diff remain available.
5. Existing text behavior and `--trust` remain compatible.

## Recommended next sequence

1. Wire Franklin Desktop to `stream-json`, treating `turn.done` as the only
   terminal event and `session.started` as the durable conversation identity.
2. Add named permission profiles backed by the existing Franklin permission
   configuration, for example `review`, `develop`, and `operations`.
3. Add managed Git worktrees and checkpoint/restore before attempting a full
   container sandbox. They deliver immediate multi-session safety and are easy
   for users to understand.
4. Design the OS sandbox as a separate security project. `--work-dir` improves
   project selection but must never be marketed as filesystem isolation.
5. Define a provider-neutral Studio adapter around lifecycle events so Codex,
   Claude Code, Hermes, DeepSeek Harness, and Franklin can be installed or
   removed without changing the Team UI.

## Primary sources

- [Gemini CLI configuration and output formats](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md)
- [Gemini CLI command reference](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/cli-reference.md)
- [Gemini CLI sandboxing](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/sandbox.md)
- [Gemini CLI checkpointing](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/checkpointing.md)
- [Codex CLI README](https://github.com/openai/codex/blob/main/codex-rs/README.md)
- [Codex app-server protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- [OpenCode agents and permissions](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/agents.mdx)
- [Aider editing modes](https://github.com/Aider-AI/aider/blob/main/aider/website/docs/usage/modes.md)
- [Hermes Agent documentation](https://hermes-agent.nousresearch.com/docs/)
- [Hermes skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills/)
