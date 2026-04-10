/**
 * Social plugin types — extends WorkflowConfig with social-specific fields.
 */
import type { WorkflowConfig } from '../../plugin-sdk/index.js';
export interface SocialProduct {
    name: string;
    description: string;
    keywords: string[];
    url?: string;
}
export interface SocialPlatformConfig {
    username: string;
    dailyTarget: number;
    minDelaySeconds: number;
}
export interface SocialReplyStyle {
    tone: string;
    maxLengthReddit: number;
    maxLengthX: number;
    rules: string[];
    imageForHighValue: boolean;
}
export interface SocialConfig extends WorkflowConfig {
    name: 'social';
    products: SocialProduct[];
    platforms: {
        reddit?: SocialPlatformConfig & {
            subreddits: string[];
        };
        x?: SocialPlatformConfig & {
            searchQueries: string[];
        };
    };
    replyStyle: SocialReplyStyle;
    targetUsers: string;
}
export interface ScoredPost {
    title: string;
    url: string;
    snippet: string;
    platform: 'reddit' | 'x';
    author?: string;
    timestamp?: string;
    commentCount?: number;
    relevanceScore: number;
    leadScore: number;
    urgency: 'high' | 'medium' | 'low';
    painPoints: string[];
}
export interface DraftReply {
    post: ScoredPost;
    text: string;
    model: string;
    tier: 'cheap' | 'premium';
    estimatedCost: number;
    imageUrl?: string;
}
export declare const DEFAULT_REPLY_STYLE: SocialReplyStyle;
