/**
 * AskUser capability — let the agent ask the user a clarifying question.
 * The question is displayed and the response is returned as tool output.
 */

import readline from 'node:readline';
import chalk from 'chalk';
import type { CapabilityHandler, CapabilityResult, ExecutionScope } from '../agent/types.js';

interface AskUserInput {
  question: string;
  options?: string[];
}

async function execute(input: Record<string, unknown>, _ctx: ExecutionScope): Promise<CapabilityResult> {
  const { question, options } = input as unknown as AskUserInput;

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

  return new Promise<CapabilityResult>((resolve) => {
    let answered = false;
    rl.question(chalk.bold('  answer> '), (answer) => {
      answered = true;
      rl.close();
      resolve({ output: answer.trim() || '(no response)' });
    });
    rl.on('close', () => {
      if (!answered) resolve({ output: 'User did not respond (EOF/piped input).', isError: true });
    });
  });
}

export const askUserCapability: CapabilityHandler = {
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
