import chalk from 'chalk';
import { loadChain, API_URLS } from '../config.js';
export async function modelsCommand() {
    const chain = loadChain();
    const apiUrl = API_URLS[chain];
    console.log(chalk.bold('Available Models\n'));
    console.log(`Chain: ${chalk.magenta(chain)} — ${chalk.dim(apiUrl)}\n`);
    try {
        const response = await fetch(`${apiUrl}/v1/models`);
        if (!response.ok) {
            console.log(chalk.red(`Failed to fetch models: ${response.status}`));
            return;
        }
        const data = (await response.json());
        const models = data.data
            .sort((a, b) => (a.pricing?.input ?? 0) - (b.pricing?.input ?? 0));
        const free = models.filter((m) => m.billing_mode === 'free');
        const paid = models.filter((m) => m.billing_mode !== 'free');
        if (free.length > 0) {
            console.log(chalk.green.bold('Free Models (no USDC needed)'));
            console.log(chalk.dim('─'.repeat(70)));
            for (const m of free) {
                console.log(`  ${chalk.cyan(m.id)}`);
            }
            console.log('');
        }
        console.log(chalk.yellow.bold('Paid Models'));
        console.log(chalk.dim('─'.repeat(70)));
        console.log(chalk.dim(`  ${'Model'.padEnd(35)} ${'Input'.padEnd(12)} ${'Output'.padEnd(12)} Context`));
        console.log(chalk.dim('─'.repeat(70)));
        for (const m of paid) {
            const input = `$${(m.pricing?.input ?? 0).toFixed(2)}/M`;
            const output = `$${(m.pricing?.output ?? 0).toFixed(2)}/M`;
            const ctx = '';
            console.log(`  ${chalk.cyan(m.id.padEnd(35))} ${input.padEnd(12)} ${output.padEnd(12)} ${ctx}`);
        }
        console.log(`\n${chalk.dim(`${models.length} models available. Use:`)} ${chalk.bold('brcc start --model <model-id>')}`);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown error';
        if (msg.includes('fetch') || msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND')) {
            console.log(chalk.red(`Cannot reach BlockRun API at ${apiUrl}`));
            console.log(chalk.dim('Check your internet connection or try again later.'));
        }
        else {
            console.log(chalk.red(`Error: ${msg}`));
        }
    }
}
