# RunCode Plugin SDK

RunCode is plugin-first. Workflows like `social`, `trading`, `content` are
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
├── plugins-bundled/      # Plugins shipped with runcode
│   └── social/
│       ├── plugin.json   # Manifest
│       ├── index.ts      # Plugin entry
│       └── ...
│
└── commands/
    └── plugin.ts         # Generic CLI dispatcher (works for any plugin)
```

## Plugin Discovery

Plugins are discovered from three locations (highest priority first):

1. **Dev**: `$RUNCODE_PLUGINS_DIR/*` — for local development
2. **User**: `~/.blockrun/plugins/*` — installed via `runcode plugin install`
3. **Bundled**: `<runcode>/dist/plugins-bundled/*` — ships with runcode

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
} from '@blockrun/runcode/plugin-sdk';
import { DEFAULT_MODEL_TIERS } from '@blockrun/runcode/plugin-sdk';

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
runcode my-plugin              # show stats / first-run setup
runcode my-plugin init         # interactive setup
runcode my-plugin run          # execute workflow
runcode my-plugin run --dry    # dry run
runcode my-plugin stats        # statistics
runcode my-plugin leads        # tracked leads (if applicable)
```

## Model Tiers

Workflows pick a tier per step; the runner resolves to actual models.

| Tier | Default | When to use |
|------|---------|-------------|
| `free` | nvidia/nemotron-ultra-253b | Warmup, throwaway calls, $0 cost |
| `cheap` | zai/glm-5.1 | Filtering, classification, ~$0.001/call |
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

Like OpenClaw, RunCode enforces strict boundaries:

1. **Plugins import ONLY from `@blockrun/runcode/plugin-sdk`** — never from
   `src/agent/`, `src/commands/`, or another plugin's `src/`.
2. **Core never references plugins by id.** No `if (pluginId === 'social')`
   in core code.
3. **Adding a plugin never requires editing core.** The CLI dynamically
   registers commands from discovered plugins.
4. **Plugin contracts are versioned.** Breaking changes require a major
   version bump.

This is what makes the system extensible: third-party plugins (`runcode-trading`,
`runcode-content`) can be installed without forking the codebase.
