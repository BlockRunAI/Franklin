import chalk from 'chalk';
import { loadChain, API_URLS } from '../config.js';
import {
  getGatewayModels,
  GATEWAY_MARGIN,
  type GatewayModel,
  type BillingMode,
} from '../gateway-models.js';

/**
 * `franklin models` — the live catalog.
 *
 * Reuses gateway-models.ts rather than re-fetching: it already types every
 * billing mode, caches for 5 minutes, and serves stale-on-error.
 *
 * The old version modelled pricing as `{ input, output }` for every model and
 * printed `$0.00/M` for anything that isn't token-metered — so the entire
 * image/video/music/speech catalog rendered as free under a "Paid Models"
 * heading. The gateway actually bills seven different ways, and each needs its
 * own unit; that's what BILLING_GROUPS below encodes.
 */

const RULE_WIDTH = 74;

/**
 * Compact USD — keeps sub-cent prices honest ($0.435/M must not round to
 * $0.44). Exported for tests.
 */
export function money(n: number): string {
  if (n === 0) return '$0';
  const decimals = n < 0.01 ? 4 : n < 1 ? 3 : 2;
  return `$${n.toFixed(decimals).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')}`;
}

/**
 * 1000000 → 1M, 1048576 → 1M, 1050000 → 1.1M, 262144 → 262K.
 * Both 1000000 and 1048576 are "1M context" to a reader — don't render one as
 * `1M` and the other as `1.0M` in the same column. Exported for tests.
 */
export function formatContext(n: number | undefined): string {
  if (!n) return '';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  return `${Math.round(n / 1000)}K`;
}

function pricingOf(m: GatewayModel): Record<string, number | undefined> {
  return m.pricing as unknown as Record<string, number | undefined>;
}

interface BillingGroup {
  mode: BillingMode;
  heading: string;
  /** Right-hand price/unit string for one model. */
  render: (m: GatewayModel) => string;
}

// Ordered as printed. `free` and `paid` are handled separately — free gets its
// own promoted section, and paid is the only one with an Input/Output/Context
// table rather than a single price column.
const BILLING_GROUPS: BillingGroup[] = [
  {
    mode: 'per_image',
    heading: 'Image generation (per image)',
    render: m => `${money(pricingOf(m).per_image ?? 0)}/image`,
  },
  {
    mode: 'per_second',
    heading: 'Video generation (per second)',
    render: m => {
      const p = pricingOf(m);
      const per = p.per_second ?? 0;
      const def = p.default_duration_seconds;
      const max = p.max_duration_seconds;
      const parts: string[] = [`${money(per)}/sec`];
      if (def) parts.push(`${def}s default ≈ ${money(per * def)}`);
      if (max) parts.push(`max ${max}s`);
      return parts.join('  ·  ');
    },
  },
  {
    mode: 'per_character',
    heading: 'Speech / TTS (per 1K characters)',
    render: m => {
      const p = pricingOf(m);
      const s = `${money(p.per_1k_chars ?? 0)}/1K chars`;
      return p.max_input_chars ? `${s}  ·  max ${formatContext(p.max_input_chars)} chars` : s;
    },
  },
  {
    mode: 'per_track',
    heading: 'Music (per track)',
    render: m => `${money(pricingOf(m).per_track ?? 0)}/track`,
  },
  {
    mode: 'per_generation',
    heading: 'Sound effects (per generation)',
    render: m => {
      const p = pricingOf(m);
      const s = `${money(p.per_generation ?? 0)}/generation`;
      return p.max_duration_seconds ? `${s}  ·  max ${p.max_duration_seconds}s` : s;
    },
  },
  {
    mode: 'flat',
    heading: 'Flat rate (per call)',
    render: m => `${money(pricingOf(m).flat ?? 0)}/call`,
  },
];

function printSection(heading: string, models: GatewayModel[], render: (m: GatewayModel) => string) {
  if (models.length === 0) return;
  console.log(chalk.yellow.bold(heading));
  console.log(chalk.dim('─'.repeat(RULE_WIDTH)));
  for (const m of models) {
    console.log(`  ${chalk.cyan(m.id.padEnd(44))} ${render(m)}`);
  }
  console.log('');
}

export async function modelsCommand() {
  const chain = loadChain();
  const apiUrl = API_URLS[chain];

  console.log(chalk.bold('Available Models\n'));
  console.log(`Chain: ${chalk.magenta(chain)} — ${chalk.dim(apiUrl)}\n`);

  let models: GatewayModel[];
  try {
    models = await getGatewayModels();
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    if (/fetch|ECONNREFUSED|ENOTFOUND|abort/i.test(msg)) {
      console.log(chalk.red(`Cannot reach BlockRun API at ${apiUrl}`));
      console.log(chalk.dim('Check your internet connection or try again later.'));
    } else {
      console.log(chalk.red(`Error: ${msg}`));
    }
    return;
  }

  if (models.length === 0) {
    console.log(chalk.yellow('No models returned from API.'));
    return;
  }

  // Free first — it's the "no USDC needed" on-ramp and the reason many people
  // install Franklin at all.
  const free = models.filter(m => m.billing_mode === 'free');
  if (free.length > 0) {
    console.log(chalk.green.bold('Free Models (no USDC needed)'));
    console.log(chalk.dim('─'.repeat(RULE_WIDTH)));
    for (const m of free) {
      const ctx = formatContext(m.context_window);
      console.log(`  ${chalk.cyan(m.id.padEnd(44))} ${chalk.dim(ctx ? `${ctx} ctx` : '')}`);
    }
    console.log('');
  }

  // Token-metered — the only group with a two-price table.
  const paid = models
    .filter(m => m.billing_mode === 'paid')
    .sort((a, b) => {
      const ap = a.pricing as { input?: number };
      const bp = b.pricing as { input?: number };
      return (ap.input ?? 0) - (bp.input ?? 0);
    });

  if (paid.length > 0) {
    console.log(chalk.yellow.bold('Chat & Reasoning (per 1M tokens)'));
    console.log(chalk.dim('─'.repeat(RULE_WIDTH)));
    console.log(
      chalk.dim(`  ${'Model'.padEnd(44)} ${'Input'.padEnd(11)} ${'Output'.padEnd(11)} Context`)
    );
    console.log(chalk.dim('─'.repeat(RULE_WIDTH)));
    for (const m of paid) {
      const p = pricingOf(m);
      const input = `${money(p.input ?? 0)}/M`;
      const output = `${money(p.output ?? 0)}/M`;
      console.log(
        `  ${chalk.cyan(m.id.padEnd(44))} ${input.padEnd(11)} ${output.padEnd(11)} ${chalk.dim(formatContext(m.context_window))}`
      );
    }
    console.log('');
  }

  for (const group of BILLING_GROUPS) {
    const inGroup = models.filter(m => m.billing_mode === group.mode);
    printSection(group.heading, inGroup, group.render);
  }

  // Anything the gateway starts billing a way this build doesn't know about
  // must still be listed — silently dropping a model is how the $0.00/M bug
  // stayed invisible. Show it with its raw pricing rather than a wrong unit.
  const known = new Set<string>(['free', 'paid', ...BILLING_GROUPS.map(g => g.mode)]);
  const unknown = models.filter(m => !known.has(m.billing_mode));
  printSection(
    'Other billing modes (not yet modelled by this Franklin build)',
    unknown,
    m => chalk.dim(`${m.billing_mode}: ${JSON.stringify(m.pricing)}`)
  );

  const margin = Math.round((GATEWAY_MARGIN - 1) * 100);
  console.log(
    chalk.dim(
      `${models.length} models available. Prices are gateway list — x402 settlement adds ~${margin}%.`
    )
  );
  console.log(`${chalk.dim('Use:')} ${chalk.bold('franklin start --model <model-id>')}`);
}
