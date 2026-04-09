/**
 * Social workflow types.
 */

import type { WorkflowConfig } from '../workflow/types.js';

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
  /** Generate images for high-value replies */
  imageForHighValue: boolean;
}

export interface SocialConfig extends WorkflowConfig {
  name: 'social';
  products: SocialProduct[];
  platforms: {
    reddit?: SocialPlatformConfig & { subreddits: string[] };
    x?: SocialPlatformConfig & { searchQueries: string[] };
  };
  replyStyle: SocialReplyStyle;
  /** Target users description (for auto-generating keywords/subreddits) */
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

export const DEFAULT_REPLY_STYLE: SocialReplyStyle = {
  tone: 'knowledgeable developer sharing experience',
  maxLengthReddit: 400,
  maxLengthX: 260,
  rules: [
    'Lead with a genuine insight or question about the post',
    'Mention product naturally as "what I use/built" — not as an ad',
    'Never start with "Great post!" or "I agree!"',
    'Sound like a real developer who has faced this problem',
    'If post is not directly relevant, skip — do not force a mention',
  ],
  imageForHighValue: true,
};
