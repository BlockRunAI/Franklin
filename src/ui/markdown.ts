/**
 * Markdown renderer for terminal output.
 * Converts markdown to ANSI-formatted text using chalk.
 * Shared between Ink UI and basic terminal UI.
 */

import chalk from 'chalk';

/**
 * Render a complete markdown string to ANSI-colored terminal output.
 */
export function renderMarkdown(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    // Code block toggle
    if (line.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      out.push(chalk.dim(line));
      continue;
    }

    if (inCodeBlock) {
      out.push(chalk.cyan(line));
      continue;
    }

    // Headers
    if (line.startsWith('### ')) { out.push(chalk.bold(line.slice(4))); continue; }
    if (line.startsWith('## '))  { out.push(chalk.bold.underline(line.slice(3))); continue; }
    if (line.startsWith('# '))   { out.push(chalk.bold.underline(line.slice(2))); continue; }

    // Horizontal rule
    if (/^[-=─]{3,}$/.test(line.trim())) { out.push(chalk.dim('─'.repeat(40))); continue; }

    // Blockquotes
    if (line.startsWith('> ')) {
      out.push(chalk.dim('│ ') + chalk.italic(renderInline(line.slice(2))));
      continue;
    }

    // Bullet points
    if (line.match(/^(\s*)[-*] /)) {
      out.push(line.replace(/^(\s*)[-*] /, '$1• ').replace(/^(\s*• )(.*)/, (_, prefix, rest) => prefix + renderInline(rest)));
      continue;
    }

    // Table rows — render with dim separators
    if (line.includes('|') && line.trim().startsWith('|')) {
      // Separator row (|---|---|)
      if (/^\s*\|[\s-:]+\|/.test(line) && !line.match(/[a-zA-Z]/)) {
        out.push(chalk.dim(line));
        continue;
      }
      // Data row — bold headers in first row, dim pipes
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
 * Render inline markdown formatting (bold, italic, code, links).
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
    // Links — show label in blue, URL dimmed
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) =>
      chalk.blue.underline(label) + chalk.dim(` (${url})`)
    );
}
