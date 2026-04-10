/**
 * Channel contract — abstraction over messaging/social platforms.
 *
 * Channels are platforms where messages can be searched and posted:
 * Reddit, X/Twitter, Telegram, Slack, Discord, HackerNews, etc.
 *
 * Workflows interact with channels through this contract — never with
 * platform-specific code directly.
 */
/** A message to be posted on a channel */
export interface ChannelMessage {
    /** Plain text content */
    text: string;
    /** Optional image URL or local path */
    image?: string;
    /** Reply to a specific post (URL or platform-specific id) */
    inReplyTo?: string;
    /** Platform-specific metadata (e.g. subreddit name for Reddit) */
    metadata?: Record<string, unknown>;
}
/** A post discovered via channel search */
export interface ChannelPost {
    /** Post URL */
    url: string;
    /** Post id (platform-specific) */
    id: string;
    /** Post title (or first line for X) */
    title: string;
    /** Post body */
    body: string;
    /** Author username */
    author?: string;
    /** Created timestamp (ISO) */
    createdAt?: string;
    /** Engagement metrics */
    score?: number;
    /** Reply/comment count */
    commentCount?: number;
    /** Platform identifier */
    platform: string;
    /** Platform-specific raw data */
    raw?: Record<string, unknown>;
}
/** Channel search result wrapper */
export interface ChannelSearchResult {
    posts: ChannelPost[];
    /** Total found (may be larger than posts.length if paginated) */
    total: number;
}
/** Channel context provided by core */
export interface ChannelContext {
    /** Channel-specific auth/config from user settings */
    auth?: ChannelAuth;
    /** Logger */
    log: (message: string) => void;
    /** Dry-run mode — channels should not actually post */
    dryRun: boolean;
}
/** Auth blob — channel-specific shape */
export interface ChannelAuth {
    /** Auth method */
    method: 'browser' | 'api' | 'oauth' | 'none';
    /** Browser cookies (for browser auth) */
    cookies?: string;
    /** API token (for api auth) */
    token?: string;
    /** OAuth refresh token */
    refreshToken?: string;
    /** Username on the platform */
    username?: string;
    /** Platform-specific extra fields */
    extra?: Record<string, unknown>;
}
/**
 * Channel interface — implemented by channel plugins.
 * Each channel knows how to search and post on its platform.
 */
export interface Channel {
    /** Channel id (e.g. "reddit", "x", "telegram") */
    readonly id: string;
    /** Display name */
    readonly name: string;
    /** Search posts on this channel */
    search(query: string, ctx: ChannelContext, options?: {
        maxResults?: number;
        /** Platform-specific scope (e.g. subreddit for Reddit) */
        scope?: string[];
    }): Promise<ChannelSearchResult>;
    /** Post a message (or reply) on this channel */
    post(message: ChannelMessage, ctx: ChannelContext): Promise<{
        /** URL of the posted message */
        url: string;
        /** Platform-specific id */
        id: string;
    }>;
    /** Check if the channel is properly authenticated */
    isAuthenticated(ctx: ChannelContext): Promise<boolean>;
    /** Optional: rate limiting hint (min seconds between posts) */
    readonly minDelaySeconds?: number;
}
