/**
 * `franklin skills` — list and inspect SKILL.md files Franklin would load
 * during a session. Phase 1 of the skills MVP — bundled only.
 */

import chalk from 'chalk';

import { loadBundledSkills } from '../skills/bootstrap.js';

export interface SkillsCommandOptions {
  json?: boolean;
}

export async function skillsCommand(
  action: string | undefined,
  arg: string | undefined,
  opts: SkillsCommandOptions = {},
): Promise<void> {
  const sub = action ?? 'list';

  if (sub === 'list') {
    runList(opts);
    return;
  }
  if (sub === 'which') {
    runWhich(arg);
    return;
  }

  console.log(chalk.red(`Unknown skills subcommand: ${sub}`));
  console.log('Usage: franklin skills [list|which <name>]');
  process.exit(1);
}

function runList(opts: SkillsCommandOptions): void {
  const { registry, errors } = loadBundledSkills();
  const skills = registry.list();

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          skills: skills.map((l) => ({
            name: l.skill.name,
            description: l.skill.description,
            source: l.source,
            path: l.path,
            warnings: l.warnings,
            costReceipt: l.skill.costReceipt ?? false,
            budgetCapUsd: l.skill.budgetCapUsd ?? null,
            disableModelInvocation: l.skill.disableModelInvocation ?? false,
          })),
          errors,
          shadowed: registry.shadowed().map((s) => ({
            winner: { name: s.winner.skill.name, source: s.winner.source, path: s.winner.path },
            loser: { name: s.loser.skill.name, source: s.loser.source, path: s.loser.path },
          })),
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  if (skills.length === 0) {
    console.log(chalk.dim('No skills loaded.'));
  } else {
    console.log(chalk.bold(`Skills (${skills.length})`));
    console.log('');
    const nameWidth = Math.max(...skills.map((l) => l.skill.name.length), 4);
    for (const l of skills) {
      const flags: string[] = [];
      if (l.skill.costReceipt) flags.push('receipt');
      if (typeof l.skill.budgetCapUsd === 'number') flags.push(`cap $${l.skill.budgetCapUsd.toFixed(2)}`);
      if (l.skill.disableModelInvocation) flags.push('manual-only');
      const flagStr = flags.length > 0 ? chalk.dim(` [${flags.join(', ')}]`) : '';
      const sourceTag = chalk.dim(`(${l.source})`);
      console.log(
        `  ${chalk.cyan('/' + l.skill.name.padEnd(nameWidth))}  ${l.skill.description}${flagStr} ${sourceTag}`,
      );
    }
  }

  const shadowed = registry.shadowed();
  if (shadowed.length > 0) {
    console.log('');
    console.log(chalk.yellow('Shadowed (lost to a higher-precedence source):'));
    for (const s of shadowed) {
      console.log(
        `  /${s.loser.skill.name} from ${s.loser.source} ` +
          chalk.dim(`(winner: ${s.winner.source} at ${s.winner.path})`),
      );
    }
  }

  if (errors.length > 0) {
    console.log('');
    console.log(chalk.red(`Failed to load (${errors.length}):`));
    for (const e of errors) {
      console.log(`  ${e.path}: ${e.error}`);
    }
  }
}

function runWhich(name: string | undefined): void {
  if (!name) {
    console.log(chalk.red('Usage: franklin skills which <name>'));
    process.exit(1);
  }
  const { registry } = loadBundledSkills();
  const skill = registry.lookup(name);
  if (!skill) {
    console.log(chalk.red(`Skill not found: ${name}`));
    process.exit(1);
  }
  console.log(skill.path);
}
