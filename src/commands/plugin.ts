/**
 * Generic plugin command dispatcher.
 *
 * `runcode <plugin-id> <action>` works for ANY plugin that registers a workflow.
 * Core stays plugin-agnostic — adding a new plugin requires zero changes here.
 */

import chalk from 'chalk';
import readline from 'node:readline';
import { ModelClient } from '../agent/llm.js';
import { loadChain, API_URLS } from '../config.js';
import { loadAllPlugins, getPlugin, listWorkflowPlugins } from '../plugins/registry.js';
import {
  loadWorkflowConfig,
  saveWorkflowConfig,
  runWorkflow,
  getStats,
  getByAction,
  formatWorkflowResult,
  formatWorkflowStats,
} from '../plugins/runner.js';
import type { Workflow, WorkflowConfig } from '../plugin-sdk/workflow.js';
import { DEFAULT_MODEL_TIERS } from '../plugin-sdk/workflow.js';

export interface PluginCommandOptions {
  dryRun?: boolean;
  debug?: boolean;
}

/** Run a plugin command. Plugin id is the first arg. */
export async function pluginCommand(
  pluginId: string,
  action: string | undefined,
  options: PluginCommandOptions
): Promise<void> {
  await loadAllPlugins();

  const loaded = getPlugin(pluginId);
  if (!loaded) {
    console.log(chalk.red(`Plugin "${pluginId}" not found.`));
    listAvailablePlugins();
    return;
  }

  // Get the workflow this plugin provides (if any)
  const workflows = loaded.plugin.workflows || {};
  const workflowFactory = workflows[pluginId] || workflows[Object.keys(workflows)[0] ?? ''];
  if (!workflowFactory) {
    console.log(chalk.red(`Plugin "${pluginId}" does not provide a workflow.`));
    return;
  }

  const workflow = workflowFactory();
  const chain = loadChain();
  const apiUrl = API_URLS[chain];
  const client = new ModelClient({ apiUrl, chain, debug: options.debug });

  const existingConfig = loadWorkflowConfig(workflow.id);

  switch (action) {
    case 'init':
    case undefined:
    case '': {
      if (!existingConfig) {
        const config = await runOnboarding(workflow, client);
        if (config) saveWorkflowConfig(workflow.id, config);
      } else if (action === 'init') {
        console.log(chalk.yellow(`Already configured at ~/.blockrun/workflows/${workflow.id}.config.json`));
        console.log(chalk.dim('Delete the file to reconfigure.'));
      } else {
        // No action and already configured: show stats + dry-run hint
        const stats = getStats(workflow.id);
        console.log(formatWorkflowStats(workflow, stats));
        console.log(chalk.dim(`Run "runcode ${pluginId} run --dry" to preview.\n`));
      }
      break;
    }

    case 'run': {
      const config = existingConfig ?? await runOnboarding(workflow, client);
      if (!config) return;
      if (!existingConfig) saveWorkflowConfig(workflow.id, config);

      const dryRun = options.dryRun ?? false;
      console.log(chalk.dim(`\nRunning ${workflow.name}${dryRun ? ' (dry-run)' : ''}...\n`));
      const result = await runWorkflow(workflow, config, client, { dryRun });
      console.log(formatWorkflowResult(workflow, result));
      break;
    }

    case 'stats': {
      const stats = getStats(workflow.id);
      console.log(formatWorkflowStats(workflow, stats));
      break;
    }

    case 'leads': {
      const leads = getByAction(workflow.id, 'lead');
      if (leads.length === 0) {
        console.log(chalk.dim(`\nNo leads found yet. Run "runcode ${pluginId} run" first.\n`));
        break;
      }
      console.log(chalk.bold(`\n  LEADS (${leads.length})\n`));
      for (const lead of leads.slice(-20)) {
        const m = lead.metadata;
        const score = (m.leadScore as number) ?? 0;
        const icon = score >= 8 ? '🔥' : score >= 6 ? '⭐' : '📋';
        console.log(`  ${icon} [${score}/10] ${(m.title as string)?.slice(0, 60) ?? ''}`);
        console.log(chalk.dim(`     ${m.url} | ${m.platform} | ${m.urgency ?? ''}`));
        if (m.painPoints && Array.isArray(m.painPoints)) {
          console.log(chalk.dim(`     Pain: ${(m.painPoints as string[]).join(', ')}`));
        }
        console.log();
      }
      break;
    }

    default:
      console.log(chalk.red(`Unknown action: ${action}`));
      console.log(chalk.dim(`
Usage:
  runcode ${pluginId}              # show stats / first-run setup
  runcode ${pluginId} init         # interactive setup
  runcode ${pluginId} run          # execute workflow
  runcode ${pluginId} run --dry    # dry run (no side effects)
  runcode ${pluginId} stats        # show statistics
  runcode ${pluginId} leads        # show tracked leads (if applicable)
`));
  }
}

/** List all installed plugins */
export function listAvailablePlugins(): void {
  const plugins = listWorkflowPlugins();
  if (plugins.length === 0) {
    console.log(chalk.dim('\nNo workflow plugins installed.\n'));
    return;
  }
  console.log(chalk.bold('\n  Installed plugins:\n'));
  for (const p of plugins) {
    console.log(`  ${chalk.cyan(p.manifest.id.padEnd(15))} ${p.manifest.description}`);
  }
  console.log();
}

// ─── Onboarding ───────────────────────────────────────────────────────────

async function runOnboarding(
  workflow: Workflow,
  client: ModelClient
): Promise<WorkflowConfig | null> {
  console.log(chalk.bold(`\n  ╭─ ${workflow.name} setup ${'─'.repeat(Math.max(0, 40 - workflow.name.length))}╮`));
  console.log(chalk.bold('  │                                                  │'));
  console.log(chalk.bold(`  │  ${workflow.description.padEnd(48)}│`));
  console.log(chalk.bold('  │                                                  │'));
  console.log(chalk.bold('  ╰──────────────────────────────────────────────────╯\n'));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY ?? false,
  });

  const ask = (prompt: string): Promise<string> =>
    new Promise(resolve => rl.question(chalk.cyan(`  ${prompt}\n  > `), answer => resolve(answer.trim())));

  const answers: Record<string, string> = {};

  for (const q of workflow.onboardingQuestions) {
    if (q.type === 'select' && q.options) {
      console.log(chalk.cyan(`  ${q.prompt}`));
      for (let i = 0; i < q.options.length; i++) {
        console.log(chalk.dim(`    ${i + 1}. ${q.options[i]}`));
      }
      const choice = await ask('Pick a number');
      const idx = parseInt(choice) - 1;
      answers[q.id] = q.options[idx] ?? q.options[0];
    } else {
      answers[q.id] = await ask(q.prompt);
    }
    console.log();
  }

  rl.close();

  console.log(chalk.dim('  Building configuration...\n'));

  // Provide an LLM helper for buildConfigFromAnswers
  const llm = async (prompt: string): Promise<string> => {
    const result = await client.complete({
      model: DEFAULT_MODEL_TIERS.cheap,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 2048,
      stream: true,
    });
    let text = '';
    for (const part of result.content) {
      if (part.type === 'text') text += part.text;
    }
    return text;
  };

  try {
    const config = await workflow.buildConfigFromAnswers(answers, llm);
    console.log(chalk.green('  ✓ Configuration saved!\n'));
    console.log(chalk.dim(`  Config: ~/.blockrun/workflows/${workflow.id}.config.json\n`));
    console.log(chalk.dim(`  Run "runcode ${workflow.id} run --dry" to preview.\n`));
    return config;
  } catch (err) {
    console.error(chalk.red(`  Setup failed: ${(err as Error).message}`));
    return null;
  }
}
