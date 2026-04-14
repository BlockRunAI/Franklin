/**
 * Terminal UI for Franklin
 * Raw terminal input/output with markdown rendering and diff display.
 * No heavy dependencies — just chalk and readline.
 */

import readline from 'node:readline';
import chalk from 'chalk';
import { estimateCost } from '../pricing.js';
import type { StreamEvent } from '../agent/types.js';

// ─── Spinner ───────────────────────────────────────────────────────────────

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

class Spinner {
  private interval: ReturnType<typeof setInterval> | null = null;
  private frameIdx = 0;
  private label = '';

  start(label: string) {
    this.stop();
    this.label = label;
    this.frameIdx = 0;
    this.interval = setInterval(() => {
      const frame = SPINNER_FRAMES[this.frameIdx % SPINNER_FRAMES.length];
      process.stderr.write(`\r${chalk.cyan(frame)} ${chalk.dim(this.label)}  `);
      this.frameIdx++;
    }, 80);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      process.stderr.write('\r' + ' '.repeat(this.label.length + 10) + '\r');
    }
  }
}

// ─── Markdown Renderer ─────────────────────────────────────────────────────

/**
 * Simple streaming markdown renderer.
 * Buffers content and renders when complete blocks are available.
 */
class MarkdownRenderer {
  private buffer = '';
  private inCodeBlock = false;
  private codeBlockLang = '';

  /**
   * Feed text delta and return rendered ANSI output.
   */
  feed(text: string): string {
    this.buffer += text;
    let output = '';

    // Process complete lines
    while (this.buffer.includes('\n')) {
      const nlIdx = this.buffer.indexOf('\n');
      const line = this.buffer.slice(0, nlIdx);
      this.buffer = this.buffer.slice(nlIdx + 1);
      output += this.renderLine(line) + '\n';
    }

    return output;
  }

  /**
   * Flush remaining buffer.
   */
  flush(): string {
    if (this.buffer.length === 0) return '';
    const result = this.renderLine(this.buffer);
    this.buffer = '';
    return result;
  }

  private renderLine(line: string): string {
    // Code block toggle
    if (line.startsWith('```')) {
      if (this.inCodeBlock) {
        this.inCodeBlock = false;
        this.codeBlockLang = '';
        return chalk.dim('```');
      } else {
        this.inCodeBlock = true;
        const lang = line.slice(3).trim().split(/\s/)[0].toLowerCase();
        this.codeBlockLang = lang;
        const LANG_LABELS: Record<string, string> = {
          ts: 'TypeScript', typescript: 'TypeScript', js: 'JavaScript', javascript: 'JavaScript',
          py: 'Python', python: 'Python', rs: 'Rust', rust: 'Rust', go: 'Go',
          sh: 'Shell', bash: 'Shell', zsh: 'Shell', json: 'JSON', yaml: 'YAML',
          sql: 'SQL', html: 'HTML', css: 'CSS', diff: 'Diff',
          tsx: 'TSX', jsx: 'JSX',
        };
        const label = LANG_LABELS[lang] || (lang ? lang.toUpperCase() : '');
        return chalk.dim('```') + (label ? chalk.dim.italic(` ${label}`) : '');
      }
    }

    // Inside code block — diff highlighting + cyan
    if (this.inCodeBlock) {
      if (this.codeBlockLang === 'diff') {
        if (line.startsWith('+')) return chalk.green(line);
        if (line.startsWith('-')) return chalk.red(line);
        if (line.startsWith('@@')) return chalk.cyan(line);
      }
      return chalk.cyan(line);
    }

    // Headers
    if (line.startsWith('### ')) return chalk.bold(line.slice(4));
    if (line.startsWith('## ')) return chalk.bold.underline(line.slice(3));
    if (line.startsWith('# ')) return chalk.bold.underline(line.slice(2));

    // Horizontal rule
    if (/^[-=]{3,}$/.test(line.trim())) return chalk.dim('─'.repeat(40));

    // Bullet points
    if (line.match(/^(\s*)[-*] /)) {
      return line.replace(/^(\s*)[-*] /, '$1• ');
    }

    // Numbered lists
    if (/^\s*\d+\.\s/.test(line)) {
      return this.renderInline(line);
    }

    // Blockquotes
    if (line.startsWith('> ')) {
      return chalk.dim('│ ') + chalk.italic(this.renderInline(line.slice(2)));
    }

    // Tables — leave as-is (chalk doesn't help much)

    // Inline formatting
    return this.renderInline(line);
  }

  private renderInline(text: string): string {
    // Process in order: code first (to protect from other formatting), then bold, italic, links
    return text
      // Inline code (process first to protect contents)
      .replace(/`([^`]+)`/g, (_, t) => `\x00CODE${chalk.cyan(t)}\x00END`)
      // Bold (before italic to avoid ** being consumed by *)
      .replace(/\*\*([^*]+)\*\*/g, (_, t) => chalk.bold(t))
      // Italic (only single * not preceded/followed by *)
      .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, (_, t) => chalk.italic(t))
      // Strikethrough
      .replace(/~~([^~]+)~~/g, (_, t) => chalk.strikethrough(t))
      // Links
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) =>
        chalk.blue.underline(label) + chalk.dim(` (${url})`)
      )
      // Restore code markers
      .replace(/\x00CODE/g, '').replace(/\x00END/g, '');
  }
}

// ─── Terminal UI ───────────────────────────────────────────────────────────

export class TerminalUI {
  private spinner = new Spinner();
  private activeCapabilities = new Map<string, { name: string; startTime: number }>();
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private sessionModel = '';
  private mdRenderer = new MarkdownRenderer();

  // Line queue for piped (non-TTY) input — buffers all stdin lines eagerly
  private lineQueue: string[] = [];
  private lineWaiters: Array<(line: string | null) => void> = [];
  private stdinEOF = false;

  constructor() {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: false, // Always treat as non-TTY so line events fire for piped input
    });

    rl.on('line', (line) => {
      if (this.lineWaiters.length > 0) {
        // Someone is already waiting — deliver immediately
        const waiter = this.lineWaiters.shift()!;
        waiter(line);
      } else {
        // Buffer the line for the next promptUser() call
        this.lineQueue.push(line);
      }
    });

    rl.on('close', () => {
      this.stdinEOF = true;
      // Keep lineQueue intact — buffered lines should still drain before signaling EOF.
      // If there are active waiters, queue is already empty (nextLine checks queue first),
      // so it's safe to resolve them with null now.
      for (const waiter of this.lineWaiters) waiter(null);
      this.lineWaiters = [];
    });
  }

  /**
   * Prompt the user for input. Returns null on EOF/exit.
   * Uses a line-queue approach so piped input works across multiple calls.
   */
  async promptUser(promptText?: string): Promise<string | null> {
    const prompt = promptText ?? chalk.bold.green('> ');
    process.stderr.write(prompt);

    const raw = await this.nextLine();
    if (raw === null) return null;

    const trimmed = raw.trim();
    if (trimmed === '/exit' || trimmed === '/quit') return null;
    return trimmed;
  }

  private nextLine(): Promise<string | null> {
    if (this.lineQueue.length > 0) {
      return Promise.resolve(this.lineQueue.shift()!);
    }
    if (this.stdinEOF) {
      return Promise.resolve(null);
    }
    return new Promise<string | null>((resolve) => {
      this.lineWaiters.push(resolve);
    });
  }

  /** No-op kept for API compatibility — readline closes when stdin EOF. */
  closeInput() {
    // Nothing to do — readline closes itself on stdin EOF
  }

  /**
   * Handle a stream event from the agent loop.
   */
  handleEvent(event: StreamEvent) {
    switch (event.kind) {
      case 'text_delta': {
        this.spinner.stop();
        // Render markdown
        const rendered = this.mdRenderer.feed(event.text);
        if (rendered) process.stdout.write(rendered);
        break;
      }

      case 'thinking_delta':
        this.spinner.stop();
        process.stderr.write(chalk.dim(event.text));
        break;

      case 'capability_start': {
        // Flush any pending markdown text before showing tool status
        this.spinner.stop();
        const flushed = this.mdRenderer.flush();
        if (flushed) process.stdout.write(flushed + '\n');
        this.activeCapabilities.set(event.id, {
          name: event.name,
          startTime: Date.now(),
        });
        this.spinner.start(`${event.name}...`);
        break;
      }

      case 'capability_input_delta':
        break;

      case 'capability_done': {
        this.spinner.stop();
        const cap = this.activeCapabilities.get(event.id);
        const capName = cap?.name || 'unknown';
        const elapsed = cap ? Date.now() - cap.startTime : 0;
        this.activeCapabilities.delete(event.id);

        const elapsedFmt = elapsed >= 1000
          ? `${(elapsed / 1000).toFixed(1)}s`
          : `${elapsed}ms`;
        const timeStr = elapsed > 100 ? chalk.dim(` ${elapsedFmt}`) : '';

        if (event.result.isError) {
          console.error(
            chalk.red(`  ✗ `) + chalk.bold(capName) +
            timeStr
          );
          // Show error preview lines
          const errLines = event.result.output.split('\n').filter(Boolean).slice(0, 3);
          for (const line of errLines) {
            console.error(chalk.red(`    ⎿  ${line.slice(0, 120)}`));
          }
        } else {
          const output = event.result.output;
          const icon = chalk.green('✓');
          console.error(`  ${icon} ${chalk.bold(capName)}${timeStr}`);

          if (capName === 'Bash') {
            // Show last 5 lines of command output
            const outLines = output.split('\n').filter(Boolean);
            const show = outLines.slice(-5);
            for (const line of show) {
              console.error(chalk.dim(`    ⎿  ${line.slice(0, 120)}`));
            }
            if (outLines.length > 5) {
              console.error(chalk.dim(`    ⎿  ... ${outLines.length - 5} more lines`));
            }
          } else if (output.trim()) {
            // Other tools: show first line as preview
            const preview = truncateOutput(output, 120);
            console.error(chalk.dim(`    ⎿  ${preview}`));
          }
        }
        break;
      }

      case 'usage':
        this.totalInputTokens += event.inputTokens;
        this.totalOutputTokens += event.outputTokens;
        if (event.model) this.sessionModel = event.model;
        break;

      case 'turn_done': {
        this.spinner.stop();
        // Flush any remaining markdown
        const remaining = this.mdRenderer.flush();
        if (remaining) process.stdout.write(remaining);
        process.stdout.write('\n');

        if (event.reason === 'error') {
          console.error(chalk.red(`\nAgent error: ${event.error}`));
        } else if (event.reason === 'max_turns') {
          console.error(chalk.yellow('\nMax turns reached.'));
        }

        // Reset renderer for next turn
        this.mdRenderer = new MarkdownRenderer();
        break;
      }
    }
  }

  /** Check if input is a slash command. Returns true if handled locally (don't pass to agent). */
  handleSlashCommand(input: string): boolean {
    const parts = input.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    switch (cmd) {
      case '/cost':
      case '/usage': {
        const cost = this.sessionModel
          ? estimateCost(this.sessionModel, this.totalInputTokens, this.totalOutputTokens)
          : 0;
        const costStr = cost > 0 ? `  ·  $${cost.toFixed(4)} USDC` : '';
        console.error(chalk.dim(
          `\n  Tokens: ${this.totalInputTokens.toLocaleString()} in / ${this.totalOutputTokens.toLocaleString()} out${costStr}\n`
        ));
        return true;
      }
      default:
        // All other slash commands pass through to the agent loop (commands.ts handles them)
        return false;
    }
  }

  printWelcome(model: string, workDir: string) {
    console.error(chalk.dim(`Model: ${model}`));
    console.error(chalk.dim(`Dir:   ${workDir}`));
    console.error(chalk.dim(`Type /exit to quit, /help for commands.\n`));
  }

  printUsageSummary() {
    if (this.totalInputTokens > 0 || this.totalOutputTokens > 0) {
      console.error(
        chalk.dim(
          `\nTokens: ${this.totalInputTokens.toLocaleString()} in / ${this.totalOutputTokens.toLocaleString()} out`
        )
      );
    }
  }

  printGoodbye() {
    this.closeInput();
    this.printUsageSummary();
    console.error(chalk.dim('\nGoodbye.\n'));
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function truncateOutput(text: string, maxLen: number): string {
  const oneLine = text.replace(/\n/g, ' ').trim();
  if (oneLine.length <= maxLen) return oneLine;
  return oneLine.slice(0, maxLen - 3) + '...';
}
