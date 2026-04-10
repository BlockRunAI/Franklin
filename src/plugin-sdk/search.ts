/**
 * Search result type — used by both web search (Exa/WebSearch) and channels.
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source: string;        // "reddit", "x", "web", "hackernews"
  author?: string;
  timestamp?: string;
  score?: number;
  commentCount?: number;
}
