/**
 * AskUser capability — let the agent ask the user a clarifying question.
 * The question is displayed and the response is returned as tool output.
 */
import readline from 'node:readline';
import chalk from 'chalk';
async function execute(input, _ctx) {
    const { question, options } = input;
    if (!question) {
        return { output: 'Error: question is required', isError: true };
    }
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
        terminal: process.stdin.isTTY ?? false,
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
                resolve({ output: '(user skipped)' });
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
