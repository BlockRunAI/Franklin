/**
 * CLI command: runcode social
 *
 * Social growth workflow — search, filter, draft, post.
 */

import chalk from 'chalk';
import readline from 'node:readline';
import { ModelClient } from '../agent/llm.js';
import { loadChain, API_URLS } from '../config.js';
import { SocialWorkflow } from '../social/index.js';
import { loadWorkflowConfig } from '../workflow/config.js';
import type { SocialConfig } from '../social/types.js';

interface SocialOptions {
  dryRun?: boolean;
  debug?: boolean;
}

export async function socialCommand(action: string, options: SocialOptions) {
  const chain = loadChain();
  const apiUrl = API_URLS[chain];
  const client = new ModelClient({ apiUrl, chain, debug: options.debug });

  // Load existing config or create new
  const existingConfig = loadWorkflowConfig<SocialConfig>('social');
  const workflow = new SocialWorkflow(client, existingConfig ?? undefined);

  switch (action) {
    case 'init':
    case undefined:
    case '': {
      if (!workflow.isConfigured()) {
        await runOnboarding(workflow);
      }

      // If just `runcode social` with no action and already configured, do a dry run
      if (action !== 'init' && workflow.isConfigured()) {
        console.log(chalk.dim('\nRunning social engagement (dry-run)...\n'));
        const result = await workflow.run(true);
        console.log(workflow.formatResult(result));
        console.log(chalk.dim('To post for real: runcode social run'));
      }
      break;
    }

    case 'run': {
      if (!workflow.isConfigured()) {
        console.log(chalk.yellow('Not configured yet. Running setup first...\n'));
        await runOnboarding(workflow);
      }
      const dryRun = options.dryRun ?? false;
      console.log(chalk.dim(`\nRunning social engagement${dryRun ? ' (dry-run)' : ''}...\n`));
      const result = await workflow.run(dryRun);
      console.log(workflow.formatResult(result));
      break;
    }

    case 'stats': {
      const stats = workflow.getStats();
      console.log(workflow.formatStats(stats));
      break;
    }

    case 'leads': {
      const leads = workflow.getLeads();
      if (leads.length === 0) {
        console.log(chalk.dim('\nNo leads found yet. Run `runcode social run` first.\n'));
        break;
      }
      console.log(chalk.bold(`\n  LEADS (${leads.length})\n`));
      for (const lead of leads.slice(-20)) {
        const score = lead.leadScore as number;
        const icon = score >= 8 ? '🔥' : score >= 6 ? '⭐' : '📋';
        console.log(`  ${icon} [${score}/10] ${(lead.title as string)?.slice(0, 60)}`);
        console.log(chalk.dim(`     ${lead.url} | ${lead.platform} | ${lead.urgency}`));
        if (lead.painPoints && (lead.painPoints as string[]).length > 0) {
          console.log(chalk.dim(`     Pain: ${(lead.painPoints as string[]).join(', ')}`));
        }
        console.log();
      }
      break;
    }

    default:
      console.log(chalk.red(`Unknown action: ${action}`));
      console.log(chalk.dim(`
Usage:
  runcode social              # first run = setup, then dry-run
  runcode social init         # interactive setup
  runcode social run          # search + draft + post
  runcode social run --dry    # search + draft (no posting)
  runcode social stats        # show statistics
  runcode social leads        # show potential customers
`));
  }
}

/** Interactive onboarding — ask questions, auto-generate config */
async function runOnboarding(workflow: SocialWorkflow): Promise<void> {
  console.log(chalk.bold('\n  ╭─ RunCode Social ──────────────────────────────╮'));
  console.log(chalk.bold('  │                                                │'));
  console.log(chalk.bold('  │  Let\'s set up AI social engagement for your    │'));
  console.log(chalk.bold('  │  product. I\'ll ask you 4 questions.            │'));
  console.log(chalk.bold('  │                                                │'));
  console.log(chalk.bold('  ╰────────────────────────────────────────────────╯\n'));

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

  console.log(chalk.dim('  Generating search keywords and subreddits...\n'));

  try {
    const config = await workflow.buildConfigFromAnswers(answers);
    workflow.saveConfig(config);

    console.log(chalk.green('  ✓ Configuration saved!\n'));
    console.log(chalk.dim(`  Products: ${config.products.map(p => p.name).join(', ')}`));
    if (config.platforms.x) {
      console.log(chalk.dim(`  X: ${config.platforms.x.username} | ${config.platforms.x.searchQueries.length} search queries`));
    }
    if (config.platforms.reddit) {
      console.log(chalk.dim(`  Reddit: ${config.platforms.reddit.username} | ${config.platforms.reddit.subreddits.join(', ')}`));
    }
    console.log(chalk.dim(`  Config: ~/.blockrun/social.json\n`));
    console.log(chalk.dim('  Run `runcode social run --dry` to see draft replies without posting.'));
  } catch (err) {
    console.error(chalk.red(`  Setup failed: ${(err as Error).message}`));
  }
}
