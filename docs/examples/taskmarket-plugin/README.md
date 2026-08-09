# TaskMarket Delegation Plugin

This example plugin lets Franklin inspect public TaskMarket work and prepare
new TaskMarket delegation tasks without silently spending funds.

Franklin is wallet-native, so the plugin deliberately separates read-only
discovery from money-moving actions:

- `discover` reads open public TaskMarket tasks through the HTTP API.
- `prepare-task` builds an explicit `taskmarket task create` command from a
  Franklin task specification.
- `review-submissions` builds the commands needed to inspect, accept, or reject
  submissions.

The plugin does not create tasks, submit work, accept results, or spend USDC on
its own. Franklin should show the prepared command and require user approval or
a configured spending policy before executing the TaskMarket CLI.

## Install Locally

```bash
mkdir -p ~/.blockrun/plugins
cp -R docs/examples/taskmarket-plugin ~/.blockrun/plugins/taskmarket-delegation
franklin taskmarket-delegation run --dry
```

For development without copying:

```bash
FRANKLIN_PLUGINS_DIR=docs/examples franklin taskmarket-delegation run --dry
```

## Configuration

The workflow default is intentionally conservative:

```json
{
  "taskmarketApiUrl": "https://api.taskmarket.dev",
  "maxTaskBudgetUsdc": 1,
  "maxBrowseResults": 10
}
```

Set `TASKMARKET_API_URL` to point at a staging backend when testing a local
TaskMarket deployment.

## Example Delegation Flow

1. Franklin detects that a request needs external work, research, data
   collection, benchmarking, or verification.
2. Franklin runs the `discover` step to see whether existing TaskMarket tasks
   already cover the need.
3. If no suitable task exists, Franklin calls `prepare-task` with:

```json
{
  "taskSpec": {
    "title": "Verify an API endpoint list",
    "description": "Check the listed endpoints, report which work without auth, and include curl receipts.",
    "acceptanceCriteria": "- Include tested URLs\n- Include HTTP status codes\n- Flag endpoints requiring paid keys",
    "rewardUsdc": 1,
    "tags": ["api", "verification", "franklin"]
  }
}
```

4. Franklin displays the generated `taskmarket task create ...` command.
5. The operator approves the spend, or Franklin applies a preconfigured policy.
6. After submissions arrive, Franklin uses `review-submissions` and presents
   candidates for approval before accepting or rejecting any worker.

## Safety Rules

- Never pass private keys or seed phrases through plugin config.
- Never create a TaskMarket task from untrusted prompt text without review.
- Never exceed `maxTaskBudgetUsdc` without explicit approval.
- Never accept or reject worker submissions without explicit authorization or a
  clearly configured policy.
- Encrypt sensitive artifacts before upload.
