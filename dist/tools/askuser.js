/**
 * AskUser capability — let the agent ask the user a clarifying question.
 * The question is displayed and the response is returned as tool output.
 */
import readline from 'node:readline';
import chalk from 'chalk';
async function execute(input, ctx) {
    const { question, options } = input;
    if (!question) {
        return { output: 'Error: question is required', isError: true };
    }
    // Ink UI path: use the provided callback to avoid raw-mode stdin conflict
    if (ctx.onAskUser) {
        try {
            const answer = await ctx.onAskUser(question, options);
            return { output: answer || '(no response)' };
        }
        catch {
            return { output: 'User did not respond.', isError: false };
        }
    }
    // Non-ink fallback (CLI piped / scripted mode)
    if (!process.stdin.isTTY) {
        return {
            output: `[Non-interactive mode] Cannot prompt user. Proceed with a reasonable assumption. Question was: ${question}`,
            isError: false,
        };
    }
    // Bare TTY fallback (no ink UI) — use readline
    console.error('');
    console.error(chalk.yellow('  ╭─ Question ────────────────────────────'));
    console.error(chalk.yellow(`  │ ${question}`));
    if (options && options.length > 0) {
        for (let i = 0; i < options.length; i++) {
            console.error(chalk.dim(`  │ ${i + 1}. ${options[i]}`));
        }
    }
    console.error(chalk.yellow('  ╰───────────────────────────────────────'));
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stderr,
        terminal: true,
    });
    return new Promise((resolve) => {
        let answered = false;
        rl.question(chalk.bold('  answer> '), (answer) => {
            answered = true;
            rl.close();
            resolve({ output: answer.trim() || '(no response)' });
        });
        rl.on('close', () => {
            if (!answered)
                resolve({ output: 'User closed input without responding.', isError: false });
        });
    });
}
export const askUserCapability = {
    spec: {
        name: 'AskUser',
        description: 'Ask the user a clarifying question. Use when you need more information before proceeding.',
        input_schema: {
            type: 'object',
            properties: {
                question: { type: 'string', description: 'The question to ask the user' },
                options: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional list of suggested answers to present',
                },
            },
            required: ['question'],
        },
    },
    execute,
    concurrent: false,
};
