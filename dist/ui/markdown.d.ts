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
/**
 * Render a complete markdown string to ANSI-colored terminal output.
 */
export declare function renderMarkdown(text: string): string;
