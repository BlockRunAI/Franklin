/**
 * Terminal UI for runcode
 * Raw terminal input/output with markdown rendering and diff display.
 * No heavy dependencies — just chalk and readline.
 */
import readline from 'node:readline';
import chalk from 'chalk';
import { estimateCost } from '../pricing.js';
// ─── Spinner ───────────────────────────────────────────────────────────────
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
class Spinner {
    interval = null;
    frameIdx = 0;
    label = '';
    start(label) {
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
    buffer = '';
    inCodeBlock = false;
    codeBlockLang = '';
    /**
     * Feed text delta and return rendered ANSI output.
     */
    feed(text) {
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
    flush() {
        if (this.buffer.length === 0)
            return '';
        const result = this.renderLine(this.buffer);
        this.buffer = '';
        return result;
    }
    renderLine(line) {
        // Code block toggle
        if (line.startsWith('```')) {
            if (this.inCodeBlock) {
                this.inCodeBlock = false;
                this.codeBlockLang = '';
                return chalk.dim('```');
            }
            else {
                this.inCodeBlock = true;
                this.codeBlockLang = line.slice(3).trim();
                return chalk.dim('```' + this.codeBlockLang);
            }
        }
        // Inside code block — render dim
        if (this.inCodeBlock) {
            return chalk.cyan(line);
        }
        // Headers
        if (line.startsWith('### '))
            return chalk.bold(line.slice(4));
        if (line.startsWith('## '))
            return chalk.bold.underline(line.slice(3));
        if (line.startsWith('# '))
            return chalk.bold.underline(line.slice(2));
        // Horizontal rule
        if (/^[-=]{3,}$/.test(line.trim()))
            return chalk.dim('─'.repeat(40));
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
    renderInline(text) {
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
            .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => chalk.blue.underline(label) + chalk.dim(` (${url})`))
            // Restore code markers
            .replace(/\x00CODE/g, '').replace(/\x00END/g, '');
    }
}
// ─── Terminal UI ───────────────────────────────────────────────────────────
export class TerminalUI {
    spinner = new Spinner();
    activeCapabilities = new Map();
    totalInputTokens = 0;
    totalOutputTokens = 0;
    sessionModel = '';
    mdRenderer = new MarkdownRenderer();
    // Line queue for piped (non-TTY) input — buffers all stdin lines eagerly
    lineQueue = [];
    lineWaiters = [];
    stdinEOF = false;
    constructor() {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stderr,
            terminal: false, // Always treat as non-TTY so line events fire for piped input
        });
        rl.on('line', (line) => {
            if (this.lineWaiters.length > 0) {
                // Someone is already waiting — deliver immediately
                const waiter = this.lineWaiters.shift();
                waiter(line);
            }
            else {
                // Buffer the line for the next promptUser() call
                this.lineQueue.push(line);
            }
        });
        rl.on('close', () => {
            this.stdinEOF = true;
            // Keep lineQueue intact — buffered lines should still drain before signaling EOF.
            // If there are active waiters, queue is already empty (nextLine checks queue first),
            // so it's safe to resolve them with null now.
            for (const waiter of this.lineWaiters)
                waiter(null);
            this.lineWaiters = [];
        });
    }
    /**
     * Prompt the user for input. Returns null on EOF/exit.
     * Uses a line-queue approach so piped input works across multiple calls.
     */
    async promptUser(promptText) {
        const prompt = promptText ?? chalk.bold.green('> ');
        process.stderr.write(prompt);
        const raw = await this.nextLine();
        if (raw === null)
            return null;
        const trimmed = raw.trim();
        if (trimmed === '/exit' || trimmed === '/quit')
            return null;
        return trimmed;
    }
    nextLine() {
        if (this.lineQueue.length > 0) {
            return Promise.resolve(this.lineQueue.shift());
        }
        if (this.stdinEOF) {
            return Promise.resolve(null);
        }
        return new Promise((resolve) => {
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
    handleEvent(event) {
        switch (event.kind) {
            case 'text_delta': {
                this.spinner.stop();
                // Render markdown
                const rendered = this.mdRenderer.feed(event.text);
                if (rendered)
                    process.stdout.write(rendered);
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
                if (flushed)
                    process.stdout.write(flushed + '\n');
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
                const timeStr = elapsed > 100 ? chalk.dim(` ${elapsed}ms`) : '';
                if (event.result.isError) {
                    console.error(chalk.red(`  ✗ ${capName}`) +
                        timeStr +
                        chalk.red(`: ${truncateOutput(event.result.output, 200)}`));
                }
                else {
                    // Show diff-like output for Edit tool
                    const output = event.result.output;
                    if (capName === 'Edit' && output.includes('replacement')) {
                        console.error(chalk.green(`  ✓ ${capName}`) + timeStr + chalk.dim(` — ${output}`));
                    }
                    else if (capName === 'Write') {
                        console.error(chalk.green(`  ✓ ${capName}`) + timeStr + chalk.dim(` — ${output}`));
                    }
                    else if (capName === 'Bash') {
                        // Show command output preview
                        const preview = truncateOutput(output, 120);
                        console.error(chalk.green(`  ✓ ${capName}`) + timeStr);
                        if (preview && preview !== '(no output)') {
                            const lines = output.split('\n').slice(0, 5);
                            for (const line of lines) {
                                console.error(chalk.dim(`    │ ${line.slice(0, 100)}`));
                            }
                            if (output.split('\n').length > 5) {
                                console.error(chalk.dim(`    │ ... (${output.split('\n').length - 5} more lines)`));
                            }
                        }
                    }
                    else {
                        const preview = truncateOutput(output, 120);
                        console.error(chalk.green(`  ✓ ${capName}`) + timeStr + chalk.dim(` — ${preview}`));
                    }
                }
                break;
            }
            case 'usage':
                this.totalInputTokens += event.inputTokens;
                this.totalOutputTokens += event.outputTokens;
                if (event.model)
                    this.sessionModel = event.model;
                break;
            case 'turn_done': {
                this.spinner.stop();
                // Flush any remaining markdown
                const remaining = this.mdRenderer.flush();
                if (remaining)
                    process.stdout.write(remaining);
                process.stdout.write('\n');
                if (event.reason === 'error') {
                    console.error(chalk.red(`\nAgent error: ${event.error}`));
                }
                else if (event.reason === 'max_turns') {
                    console.error(chalk.yellow('\nMax turns reached.'));
                }
                // Reset renderer for next turn
                this.mdRenderer = new MarkdownRenderer();
                break;
            }
        }
    }
    /** Check if input is a slash command. Returns true if handled locally (don't pass to agent). */
    handleSlashCommand(input) {
        const parts = input.trim().split(/\s+/);
        const cmd = parts[0].toLowerCase();
        switch (cmd) {
            case '/cost':
            case '/usage': {
                const cost = this.sessionModel
                    ? estimateCost(this.sessionModel, this.totalInputTokens, this.totalOutputTokens)
                    : 0;
                const costStr = cost > 0 ? `  ·  $${cost.toFixed(4)} USDC` : '';
                console.error(chalk.dim(`\n  Tokens: ${this.totalInputTokens.toLocaleString()} in / ${this.totalOutputTokens.toLocaleString()} out${costStr}\n`));
                return true;
            }
            default:
                // All other slash commands pass through to the agent loop (commands.ts handles them)
                return false;
        }
    }
    printWelcome(model, workDir) {
        console.error(chalk.dim(`Model: ${model}`));
        console.error(chalk.dim(`Dir:   ${workDir}`));
        console.error(chalk.dim(`Type /exit to quit, /help for commands.\n`));
    }
    printUsageSummary() {
        if (this.totalInputTokens > 0 || this.totalOutputTokens > 0) {
            console.error(chalk.dim(`\nTokens: ${this.totalInputTokens.toLocaleString()} in / ${this.totalOutputTokens.toLocaleString()} out`));
        }
    }
    printGoodbye() {
        this.closeInput();
        this.printUsageSummary();
        console.error(chalk.dim('\nGoodbye.\n'));
    }
}
// ─── Helpers ───────────────────────────────────────────────────────────────
function truncateOutput(text, maxLen) {
    const oneLine = text.replace(/\n/g, ' ').trim();
    if (oneLine.length <= maxLen)
        return oneLine;
    return oneLine.slice(0, maxLen - 3) + '...';
}
