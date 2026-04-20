/**
 * Markdown renderer for terminal output.
 * Converts markdown to ANSI-formatted text using chalk.
 * Shared between Ink UI and basic terminal UI.
 *
 * Features beyond basic markdown:
 * - Language labels on code blocks (```ts → TS)
 * - Numbered list support
 * - Nested blockquotes
 * - Task lists (- [x] done, - [ ] todo)
 */

import chalk from 'chalk';

/** Short language label for code block headers. */
const LANG_LABELS: Record<string, string> = {
  ts: 'TypeScript', typescript: 'TypeScript',
  js: 'JavaScript', javascript: 'JavaScript',
  py: 'Python', python: 'Python',
  rs: 'Rust', rust: 'Rust',
  go: 'Go', golang: 'Go',
  sh: 'Shell', bash: 'Shell', zsh: 'Shell', shell: 'Shell',
  json: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML',
  sql: 'SQL', html: 'HTML', css: 'CSS', xml: 'XML',
  md: 'Markdown', markdown: 'Markdown',
  diff: 'Diff', dockerfile: 'Dockerfile',
  c: 'C', cpp: 'C++', java: 'Java', rb: 'Ruby', ruby: 'Ruby',
  swift: 'Swift', kt: 'Kotlin', kotlin: 'Kotlin',
  tsx: 'TSX', jsx: 'JSX',
};

/**
 * Render markdown for a *streaming* buffer: everything up to the last newline
 * is treated as complete and rendered with full inline formatting; the
 * trailing partial line is returned as plain text.
 *
 * Why this exists: running `renderInline` over a half-written `**bold`,
 * ``code`` , or `[link](` pair produces broken/unbalanced ANSI, which Ink's
 * word-wrap then mangles around the wrap boundary (observed as `1mMusic` /
 * `[Epidemic Sound (https://…)` in terminal output). Keeping the unfinished
 * line plain until a newline arrives avoids the mid-regex failure mode with
 * zero latency penalty — the partial line re-renders on the very next delta.
 */
export function renderMarkdownStreaming(text: string): { rendered: string; partial: string } {
  const lastNl = text.lastIndexOf('\n');
  if (lastNl === -1) return { rendered: '', partial: text };
  return {
    rendered: renderMarkdown(text.slice(0, lastNl)),
    partial: text.slice(lastNl + 1),
  };
}

/**
 * Render a complete markdown string to ANSI-colored terminal output.
 */
export function renderMarkdown(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let inCodeBlock = false;
  let codeBlockLang = '';

  for (const line of lines) {
    // Code block toggle
    if (line.startsWith('```')) {
      if (!inCodeBlock) {
        // Opening — extract language
        const lang = line.slice(3).trim().split(/\s/)[0].toLowerCase();
        codeBlockLang = lang;
        const label = LANG_LABELS[lang] || (lang ? lang.toUpperCase() : '');
        out.push(chalk.dim('```') + (label ? chalk.dim.italic(` ${label}`) : ''));
      } else {
        // Closing
        out.push(chalk.dim('```'));
        codeBlockLang = '';
      }
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (inCodeBlock) {
      // Diff-style highlighting inside code blocks
      if (codeBlockLang === 'diff') {
        if (line.startsWith('+')) { out.push(chalk.green(line)); continue; }
        if (line.startsWith('-')) { out.push(chalk.red(line)); continue; }
        if (line.startsWith('@@')) { out.push(chalk.cyan(line)); continue; }
      }
      out.push(chalk.cyan(line));
      continue;
    }

    // Headers
    if (line.startsWith('### ')) { out.push(chalk.bold(line.slice(4))); continue; }
    if (line.startsWith('## '))  { out.push(chalk.bold.underline(line.slice(3))); continue; }
    if (line.startsWith('# '))   { out.push(chalk.bold.underline(line.slice(2))); continue; }

    // Horizontal rule
    if (/^[-=─]{3,}$/.test(line.trim())) { out.push(chalk.dim('─'.repeat(40))); continue; }

    // Blockquotes (support nesting: >> , >>> )
    const bqMatch = line.match(/^((?:>\s*)+)(.*)/);
    if (bqMatch) {
      const depth = (bqMatch[1].match(/>/g) || []).length;
      const prefix = chalk.dim('│ '.repeat(depth));
      out.push(prefix + chalk.italic(renderInline(bqMatch[2].trim())));
      continue;
    }

    // Task lists: - [x] done, - [ ] todo
    const taskMatch = line.match(/^(\s*)[-*] \[([ xX])\] (.*)/);
    if (taskMatch) {
      const indent = taskMatch[1];
      const checked = taskMatch[2] !== ' ';
      const label = taskMatch[3];
      out.push(indent + (checked ? chalk.green('✓') : chalk.dim('○')) + ' ' + renderInline(label));
      continue;
    }

    // Bullet points
    if (line.match(/^(\s*)[-*] /)) {
      out.push(line.replace(/^(\s*)[-*] /, '$1• ').replace(/^(\s*• )(.*)/, (_, prefix, rest) => prefix + renderInline(rest)));
      continue;
    }

    // Numbered lists: 1. , 2. , etc.
    const numMatch = line.match(/^(\s*)(\d+)\. (.*)/);
    if (numMatch) {
      out.push(numMatch[1] + chalk.dim(numMatch[2] + '.') + ' ' + renderInline(numMatch[3]));
      continue;
    }

    // Table rows — render with dim separators
    if (line.includes('|') && line.trim().startsWith('|')) {
      // Separator row (|---|---|)
      if (/^\s*\|[\s-:]+\|/.test(line) && !line.match(/[a-zA-Z]/)) {
        out.push(chalk.dim(line));
        continue;
      }
      // Data row — dim pipes
      const cells = line.split('|').map(c => c.trim()).filter(Boolean);
      const formatted = cells.map(c => renderInline(c)).join(chalk.dim(' │ '));
      out.push(chalk.dim('│ ') + formatted + chalk.dim(' │'));
      continue;
    }

    // Everything else — inline formatting
    out.push(renderInline(line));
  }

  return out.join('\n');
}

/**
 * Render inline markdown formatting (bold, italic, code, links, strikethrough).
 */
function renderInline(text: string): string {
  return text
    // Inline code (process first to protect contents from other formatting)
    .replace(/`([^`]+)`/g, (_, t) => chalk.cyan(t))
    // Bold
    .replace(/\*\*([^*]+)\*\*/g, (_, t) => chalk.bold(t))
    // Italic
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, (_, t) => chalk.italic(t))
    // Strikethrough
    .replace(/~~([^~]+)~~/g, (_, t) => chalk.strikethrough(t))
    // Links — show label in blue, URL dimmed. URL must not contain parens or
    // whitespace; that's true for almost every real URL (parens in URLs are
    // percent-encoded) and rejecting the pathological case keeps the regex
    // greed from eating past a `)` in adjacent prose.
    .replace(/\[([^\]]+)\]\(([^()\s]+)\)/g, (_, label, url) =>
      chalk.blue.underline(label) + chalk.dim(` (${url})`)
    );
}
