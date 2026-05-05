# Franklin Plugin SDK

Franklin is plugin-first. Workflows like `social`, `trading`, `content` are
plugins, not hardcoded features. Core stays plugin-agnostic — adding a new
plugin should never require editing core.

## Architecture

```
src/
├── plugin-sdk/           # Public contract — plugins import ONLY from here
│   ├── plugin.ts         # Plugin manifest, lifecycle hooks
│   ├── workflow.ts       # Workflow interface, steps, model tiers
│   ├── channel.ts        # Channel abstraction (Reddit, X, Telegram...)
│   ├── tracker.ts        # Stats and dedup tracker
│   ├── search.ts         # Search result type
│   └── index.ts          # Public barrel
│
├── plugins/              # Core plugin runtime (plugin-agnostic)
│   ├── registry.ts       # Discover and load plugins
│   └── runner.ts         # Execute any Workflow
│
└── commands/
    └── plugin.ts         # Generic CLI dispatcher (works for any plugin)
```

> Note: Franklin currently ships **no bundled plugins** — `social`, `trading`,
> and `content` are first-class native subsystems (retired from the plugin
> path in v3.2.0 in favour of tighter agent-loop integration). The plugin
> runtime is fully live and intended for **third-party** plugins. The complete
> example below is the canonical reference; install via `$FRANKLIN_PLUGINS_DIR`
> or `~/.blockrun/plugins/`.

## Plugin Discovery

Plugins are discovered from three locations (highest priority first):

1. **Dev**: `$FRANKLIN_PLUGINS_DIR/*` — for local development (`$RUNCODE_PLUGINS_DIR` is still honored as a legacy alias)
2. **User**: `~/.blockrun/plugins/*`
3. **Bundled**: `<franklin>/dist/plugins-bundled/*` — reserved for plugins shipped inside the npm tarball (none today)

A plugin is any directory containing a `plugin.json` manifest.

## Writing a Plugin

### 1. Create the manifest

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "description": "What this plugin does",
  "version": "1.0.0",
  "provides": {
    "workflows": ["my-plugin"]
  },
  "entry": "index.js",
  "author": "Your Name",
  "license": "Apache-2.0"
}
```

### 2. Implement the Workflow

```typescript
import type {
  Plugin,
  Workflow,
  WorkflowStep,
  WorkflowStepContext,
  WorkflowStepResult,
  WorkflowConfig,
} from '@blockrun/franklin/plugin-sdk';
import { DEFAULT_MODEL_TIERS } from '@blockrun/franklin/plugin-sdk';

const myWorkflow: Workflow = {
  id: 'my-plugin',
  name: 'My Plugin',
  description: 'Does X',

  defaultConfig() {
    return { name: 'my-plugin', models: { ...DEFAULT_MODEL_TIERS } };
  },

  onboardingQuestions: [
    { id: 'foo', prompt: 'What is foo?', type: 'text' },
  ],

  async buildConfigFromAnswers(answers, llm) {
    return {
      name: 'my-plugin',
      models: { ...DEFAULT_MODEL_TIERS },
      foo: answers.foo,
    };
  },

  steps: [
    {
      name: 'fetch',
      modelTier: 'none',
      execute: async (ctx) => {
        const results = await ctx.search('something', { maxResults: 10 });
        return { data: { results }, summary: `found ${results.length}` };
      },
    },
    {
      name: 'analyze',
      modelTier: 'cheap',
      execute: async (ctx) => {
        const text = await ctx.callModel('cheap', 'analyze this');
        return { summary: 'analyzed', data: { text } };
      },
    },
  ],
};

const plugin: Plugin = {
  manifest: {
    id: 'my-plugin',
    name: 'My Plugin',
    description: 'Does X',
    version: '1.0.0',
    provides: { workflows: ['my-plugin'] },
    entry: 'index.js',
  },
  workflows: {
    'my-plugin': () => myWorkflow,
  },
};

export default plugin;
```

### 3. Use it

```bash
franklin my-plugin              # show stats / first-run setup
franklin my-plugin init         # interactive setup
franklin my-plugin run          # execute workflow
franklin my-plugin run --dry    # dry run
franklin my-plugin stats        # statistics
franklin my-plugin leads        # tracked leads (if applicable)
```

## Model Tiers

Workflows pick a tier per step; the runner resolves to actual models.

| Tier | Default | When to use |
|------|---------|-------------|
| `free` | nvidia/qwen3-coder-480b | Warmup, throwaway calls, $0 cost |
| `cheap` | nvidia/qwen3-coder-480b | Filtering, classification, $0 cost by default |
| `premium` | anthropic/claude-sonnet-4.6 | High-stakes content, ~$0.02/call |
| `none` | (no model) | Steps that don't call LLMs |
| `dynamic` | (runtime decision) | Step decides based on context |

Users can override these in their workflow config.

## Channels (Future)

Channels abstract messaging platforms. Plugins providing channels register
them in their manifest:

```json
{
  "provides": {
    "channels": ["reddit", "x"]
  }
}
```

Workflows interact with channels via `ctx.search` and `ctx.sendMessage` —
they never know about platform-specific code.

## Boundary Rules

Franklin's plugin runtime enforces strict boundaries:

1. **Plugins import ONLY from `@blockrun/franklin/plugin-sdk`** — never from
   `src/agent/`, `src/commands/`, or another plugin's `src/`.
2. **Core never references plugins by id.** No `if (pluginId === 'social')`
   in core code.
3. **Adding a plugin never requires editing core.** The CLI dynamically
   registers commands from discovered plugins.
4. **Plugin contracts are versioned.** Breaking changes require a major
   version bump.

This is what makes the system extensible: third-party plugins can be installed
without forking the codebase.
