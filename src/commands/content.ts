/**
 * `franklin content` CLI surface — human-facing read access to the
 * Content library that lives at ~/.blockrun/content.json.
 *
 * Tools (ContentCreate / ContentAddAsset) write the library during agent
 * sessions; before this command, there was no way to see the resulting
 * spend without scripting against the JSON file. Verified 2026-05-04 in
 * a live session: user asked "我花了多少钱做这个", agent ran
 * `franklin content list` and got "no content subcommand", fell back to
 * estimating from memory.
 *
 * Subcommands:
 *   - list             : table of id, type, title, status, spent/budget, assets
 *   - show <idOrPrefix>: full detail of one Content, including each asset
 */

import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { loadLibrary } from '../content/store.js';
import type { Content } from '../content/library.js';

const DEFAULT_PATH = path.join(os.homedir(), '.blockrun', 'content.json');

function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/**
 * Resolve a user-typed id-or-prefix to a single Content record. Returns
 * either the matching record or an error message; the caller prints.
 *
 * Accepts the full UUID, a prefix (≥4 chars), or — for convenience — a
 * substring match against the title (case-insensitive). Ambiguity returns
 * the candidates so the user can disambiguate without rerunning blind.
 */
function resolveContent(all: Content[], input: string): { found: Content } | { error: string } {
  const q = input.trim();
  if (!q) return { error: 'Provide an id, id-prefix, or title substring.' };
  const exact = all.find(c => c.id === q);
  if (exact) return { found: exact };
  const prefix = q.length >= 4 ? all.filter(c => c.id.startsWith(q)) : [];
  if (prefix.length === 1) return { found: prefix[0] };
  if (prefix.length > 1) {
    return { error: `Ambiguous prefix "${q}" — matches:\n${prefix.map(c => `  ${c.id}  ${c.title}`).join('\n')}` };
  }
  const lower = q.toLowerCase();
  const titled = all.filter(c => c.title.toLowerCase().includes(lower));
  if (titled.length === 1) return { found: titled[0] };
  if (titled.length > 1) {
    return { error: `Ambiguous title "${q}" — matches:\n${titled.map(c => `  ${c.id}  ${c.title}`).join('\n')}` };
  }
  return { error: `No Content matches "${q}".` };
}

export function buildContentCommand(): Command {
  const cmd = new Command('content').description('Inspect Content library (assets, spend, budget)');

  cmd
    .command('list')
    .description('List all Content records, newest first')
    .action(() => {
      const lib = loadLibrary(DEFAULT_PATH);
      if (!lib) {
        console.log('No Content library yet. Tools like ContentCreate populate it during agent sessions.');
        return;
      }
      const all = lib.list();
      if (all.length === 0) {
        console.log('No Content records.');
        return;
      }
      // Header + rows. Truncate id to 8-char prefix and title to 40 chars
      // so common terminal widths (80-100) fit a row on one line.
      console.log(
        ['id'.padEnd(8), 'type'.padEnd(8), 'status'.padEnd(10), 'spent/cap'.padEnd(13), 'assets', 'title'].join('  '),
      );
      for (const c of all) {
        const id8 = c.id.slice(0, 8);
        const spend = `${fmtUsd(c.spentUsd)}/${fmtUsd(c.budgetUsd)}`;
        const title = c.title.length > 40 ? c.title.slice(0, 39) + '…' : c.title;
        console.log(
          [
            id8.padEnd(8),
            c.type.padEnd(8),
            c.status.padEnd(10),
            spend.padEnd(13),
            String(c.assets.length).padEnd(6),
            title,
          ].join('  '),
        );
      }
      // Footer with rolled-up spend.
      const totalSpent = all.reduce((s, c) => s + c.spentUsd, 0);
      const totalBudget = all.reduce((s, c) => s + c.budgetUsd, 0);
      console.log();
      console.log(`Total: ${fmtUsd(totalSpent)} spent across ${all.length} content${all.length === 1 ? '' : 's'} (cap ${fmtUsd(totalBudget)}).`);
    });

  cmd
    .command('show <idOrPrefix>')
    .description('Show full detail for one Content record (id, prefix, or title substring)')
    .action((input: string) => {
      const lib = loadLibrary(DEFAULT_PATH);
      if (!lib) {
        console.log('No Content library yet.');
        process.exit(1);
      }
      const result = resolveContent(lib.list(), input);
      if ('error' in result) {
        console.error(result.error);
        process.exit(1);
      }
      const c = result.found;
      console.log(`# ${c.title}`);
      console.log();
      console.log(`id:        ${c.id}`);
      console.log(`type:      ${c.type}`);
      console.log(`status:    ${c.status}`);
      console.log(`spent:     ${fmtUsd(c.spentUsd)} / ${fmtUsd(c.budgetUsd)} cap`);
      console.log(`created:   ${new Date(c.createdAt).toISOString()}`);
      if (c.publishedAt) console.log(`published: ${new Date(c.publishedAt).toISOString()}`);
      console.log();
      if (c.assets.length > 0) {
        console.log(`## Assets (${c.assets.length})`);
        for (const a of c.assets) {
          console.log(`- ${a.kind.padEnd(6)} ${fmtUsd(a.costUsd).padStart(7)}  ${a.source}`);
          console.log(`    ${a.data}`);
        }
        console.log();
      }
      if (c.drafts.length > 0) {
        console.log(`## Drafts (${c.drafts.length})`);
        c.drafts.forEach((d, i) => {
          const preview = d.text.length > 80 ? d.text.slice(0, 79) + '…' : d.text;
          console.log(`- #${i + 1}  ${preview}`);
        });
        console.log();
      }
      if (c.distribution.length > 0) {
        console.log(`## Distribution (${c.distribution.length})`);
        for (const dist of c.distribution) {
          console.log(`- ${dist.channel}${dist.url ? `  ${dist.url}` : ''}  (${new Date(dist.at).toISOString()})`);
        }
      }
    });

  return cmd;
}
