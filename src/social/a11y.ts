/**
 * Helpers for finding elements in the flat [depth-idx] ref tree produced by
 * SocialBrowser.snapshot(). Ported from social-bot's bot/browser.py regex
 * model, where elements are located by role + label rather than CSS/XPath.
 *
 * The mental model: snapshot() returns a string like
 *
 *   [0-0] main: Timeline
 *     [1-0] article: post by user
 *       [2-0] link: Mar 16
 *       [2-1] StaticText: hello world
 *     [1-1] button: Reply
 *     [1-2] textbox: Post text
 *
 * …and these helpers find the refs via regex on that string.
 */

/**
 * Find all refs matching a role and a label pattern.
 *
 * @param tree    The snapshot output string
 * @param role    AX role, e.g. "button", "link", "textbox", "article"
 * @param label   Regex source for the label (default `.*` — any). Substring matches count.
 * @returns       Array of ref ids like ["0-0", "1-3"] in document order
 */
export function findRefs(tree: string, role: string, label = '.*'): string[] {
  const re = new RegExp(`\\[(\\d+-\\d+)\\]\\s+${escapeRegex(role)}:\\s*${label}`, 'g');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(tree)) !== null) {
    out.push(m[1]);
  }
  return out;
}

/**
 * Find refs AND their labels. Useful when you want both the click target
 * (ref) and the visible text (label) in one pass.
 */
export function findRefsWithLabels(
  tree: string,
  role: string,
  label = '.*'
): Array<{ ref: string; label: string }> {
  const re = new RegExp(`\\[(\\d+-\\d+)\\]\\s+${escapeRegex(role)}:\\s*(${label})`, 'g');
  const out: Array<{ ref: string; label: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(tree)) !== null) {
    out.push({ ref: m[1], label: m[2].trim() });
  }
  return out;
}

/**
 * Find text content inside the tree (not a ref — just the visible string).
 * Useful for reading static text like tweet snippets.
 */
export function findStaticText(tree: string): string[] {
  const re = /\[\d+-\d+\]\s+StaticText:\s*(.+)/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(tree)) !== null) {
    out.push(m[1].trim());
  }
  return out;
}

/**
 * Split an X timeline/search snapshot into per-article blocks so we can
 * process each tweet independently. Returns the text slice for each article,
 * starting at the `[N-M] article:` line and ending at the next article or
 * end-of-tree.
 */
export function extractArticleBlocks(tree: string): Array<{
  ref: string;
  text: string;
}> {
  const articleStarts: Array<{ ref: string; pos: number }> = [];
  const re = /\[(\d+-\d+)\]\s+article:/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tree)) !== null) {
    articleStarts.push({ ref: m[1], pos: m.index });
  }

  const out: Array<{ ref: string; text: string }> = [];
  for (let i = 0; i < articleStarts.length; i++) {
    const start = articleStarts[i].pos;
    const end = i + 1 < articleStarts.length ? articleStarts[i + 1].pos : tree.length;
    out.push({ ref: articleStarts[i].ref, text: tree.slice(start, end) });
  }
  return out;
}

/**
 * Regex pattern for X's "time-link" text: "Mar 16", "5h", "just now", "2d", etc.
 * This doubles as the "this is a tweet" signal in social-bot — the only link
 * inside an article block with this label shape is the permalink to the tweet.
 */
// Matches all known X time-link formats:
//   "Mar 16", "Apr 12, 2026", "5h", "5m", "2d", "30s", "just now", "now"
//   "Yesterday", "Apr 12", "12:30 AM", "2026年4月12日" (CJK)
export const X_TIME_LINK_PATTERN =
  '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\s+\\d+(?:,?\\s+\\d{4})?|\\d+[smhd]|just now|now|yesterday|\\d{1,2}:\\d{2}\\s*[AaPp][Mm]|\\d{4}年\\d{1,2}月\\d{1,2}日';

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
