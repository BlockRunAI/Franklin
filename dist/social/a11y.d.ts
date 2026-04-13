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
export declare function findRefs(tree: string, role: string, label?: string): string[];
/**
 * Find refs AND their labels. Useful when you want both the click target
 * (ref) and the visible text (label) in one pass.
 */
export declare function findRefsWithLabels(tree: string, role: string, label?: string): Array<{
    ref: string;
    label: string;
}>;
/**
 * Find text content inside the tree (not a ref — just the visible string).
 * Useful for reading static text like tweet snippets.
 */
export declare function findStaticText(tree: string): string[];
/**
 * Split an X timeline/search snapshot into per-article blocks so we can
 * process each tweet independently. Returns the text slice for each article,
 * starting at the `[N-M] article:` line and ending at the next article or
 * end-of-tree.
 */
export declare function extractArticleBlocks(tree: string): Array<{
    ref: string;
    text: string;
}>;
/**
 * Regex pattern for X's "time-link" text: "Mar 16", "5h", "just now", "2d", etc.
 * This doubles as the "this is a tweet" signal in social-bot — the only link
 * inside an article block with this label shape is the permalink to the tweet.
 */
export declare const X_TIME_LINK_PATTERN = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\s+\\d+(?:,?\\s+\\d{4})?|\\d+[smhd]|\\d+\\s+(?:second|minute|hour|day|week|month|year)s?\\s+ago|just now|now|yesterday|\\d{1,2}:\\d{2}\\s*[AaPp][Mm]|\\d{4}\u5E74\\d{1,2}\u6708\\d{1,2}\u65E5";
