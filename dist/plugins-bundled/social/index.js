/**
 * Social Workflow Plugin.
 *
 * IMPORTANT: This file ONLY imports from `../../plugin-sdk/`.
 * It does NOT import from `src/agent/`, `src/commands/`, `src/social/`, etc.
 * This is the boundary that keeps plugins decoupled from core internals.
 */
import { DEFAULT_MODEL_TIERS } from '../../plugin-sdk/index.js';
import { DEFAULT_REPLY_STYLE } from './types.js';
import { FILTER_SYSTEM, LEAD_SCORE_SYSTEM, buildReplyPrompt, buildKeywordPrompt, buildSubredditPrompt, } from './prompts.js';
// ─── Workflow Implementation ──────────────────────────────────────────────
const socialWorkflow = {
    id: 'social',
    name: 'Social Growth',
    description: 'AI-powered social engagement on Reddit/X',
    defaultConfig() {
        return {
            name: 'social',
            models: { ...DEFAULT_MODEL_TIERS },
            products: [],
            platforms: {},
            replyStyle: { ...DEFAULT_REPLY_STYLE },
            targetUsers: '',
        };
    },
    onboardingQuestions: [
        {
            id: 'product',
            prompt: "What's your product? (name + one-line description)",
            type: 'text',
        },
        {
            id: 'targetUsers',
            prompt: 'Who are your target users? (be specific)',
            type: 'text',
        },
        {
            id: 'platform',
            prompt: 'Which platforms?',
            type: 'select',
            options: ['X/Twitter', 'Reddit', 'Both'],
            default: 'Both',
        },
        {
            id: 'handle',
            prompt: "What's your social media handle/username?",
            type: 'text',
        },
    ],
    async buildConfigFromAnswers(answers, llm) {
        const [productName, ...descParts] = (answers.product || '').split('—').map(s => s.trim());
        const productDesc = descParts.join(' — ') || productName;
        const targetUsers = answers.targetUsers || '';
        const platform = answers.platform || 'Both';
        const handle = answers.handle || '';
        // Auto-generate keywords using LLM
        let keywords = [];
        let subreddits = [];
        try {
            const kwResponse = await llm(buildKeywordPrompt(productName, productDesc, targetUsers));
            const parsed = JSON.parse(kwResponse.replace(/```json?\n?/g, '').replace(/```/g, '').trim());
            if (Array.isArray(parsed))
                keywords = parsed;
        }
        catch { /* use empty */ }
        if (platform === 'Reddit' || platform === 'Both') {
            try {
                const srResponse = await llm(buildSubredditPrompt(productName, productDesc, targetUsers));
                const parsed = JSON.parse(srResponse.replace(/```json?\n?/g, '').replace(/```/g, '').trim());
                if (Array.isArray(parsed))
                    subreddits = parsed;
            }
            catch { /* use empty */ }
        }
        const config = {
            name: 'social',
            models: { ...DEFAULT_MODEL_TIERS },
            products: [{
                    name: productName,
                    description: productDesc,
                    keywords: keywords.slice(0, 10),
                }],
            platforms: {},
            replyStyle: { ...DEFAULT_REPLY_STYLE },
            targetUsers,
        };
        if (platform === 'X/Twitter' || platform === 'Both') {
            config.platforms.x = {
                username: handle.startsWith('@') ? handle : `@${handle}`,
                dailyTarget: 20,
                minDelaySeconds: 300,
                searchQueries: keywords.slice(0, 10),
            };
        }
        if (platform === 'Reddit' || platform === 'Both') {
            config.platforms.reddit = {
                username: handle.replace('@', ''),
                dailyTarget: 10,
                minDelaySeconds: 600,
                subreddits: subreddits.slice(0, 8),
            };
        }
        return config;
    },
    steps: [
        {
            name: 'search',
            modelTier: 'none',
            execute: searchStep,
        },
        {
            name: 'filter',
            modelTier: 'cheap',
            execute: filterStep,
        },
        {
            name: 'score',
            modelTier: 'cheap',
            execute: scoreStep,
        },
        {
            name: 'draft',
            modelTier: 'dynamic',
            execute: draftStep,
        },
        {
            name: 'preview',
            modelTier: 'none',
            execute: previewStep,
        },
        {
            name: 'post',
            modelTier: 'none',
            execute: postStep,
            skipInDryRun: true,
        },
        {
            name: 'track',
            modelTier: 'none',
            execute: trackStep,
        },
    ],
};
// ─── Step Implementations ─────────────────────────────────────────────────
async function searchStep(ctx) {
    const sc = ctx.config;
    const allResults = [];
    // Search using configured queries
    const queries = sc.platforms?.x?.searchQueries ?? sc.products?.[0]?.keywords ?? [];
    for (const query of queries.slice(0, 5)) {
        const results = await ctx.search(query, {
            maxResults: 5,
            sources: ['reddit', 'x', 'web'],
        });
        allResults.push(...results);
    }
    if (allResults.length === 0) {
        return { summary: 'No posts found (search returned empty — channel plugins may not be installed)', abort: true };
    }
    // Dedup by URL
    const seen = new Set();
    const unique = allResults.filter(r => {
        if (seen.has(r.url))
            return false;
        seen.add(r.url);
        return true;
    });
    return {
        data: { searchResults: unique, itemCount: unique.length },
        summary: `Found ${unique.length} posts`,
    };
}
async function filterStep(ctx) {
    const results = (ctx.data.searchResults ?? []);
    const sc = ctx.config;
    const product = sc.products?.[0];
    if (!product)
        return { summary: 'No product configured', abort: true };
    const relevant = [];
    for (const post of results) {
        if (await ctx.isDuplicate(post.url))
            continue;
        const prompt = `Product: ${product.name} — ${product.description}\n\nPost:\nTitle: ${post.title}\nBody: ${post.snippet}\n\nIs this post relevant?`;
        try {
            const response = await ctx.callModel('cheap', prompt, FILTER_SYSTEM);
            const parsed = JSON.parse(response.replace(/```json?\n?/g, '').replace(/```/g, '').trim());
            if (parsed.relevant && parsed.score >= 5) {
                relevant.push({ ...post, relevanceScore: parsed.score });
            }
        }
        catch { /* skip parse failures */ }
    }
    if (relevant.length === 0) {
        return { summary: 'No relevant posts after filtering', abort: true };
    }
    relevant.sort((a, b) => b.relevanceScore - a.relevanceScore);
    return {
        data: { filteredPosts: relevant, itemCount: relevant.length },
        summary: `${relevant.length}/${results.length} posts are relevant`,
    };
}
async function scoreStep(ctx) {
    const posts = (ctx.data.filteredPosts ?? []);
    const sc = ctx.config;
    const product = sc.products[0];
    const scored = [];
    for (const post of posts) {
        const prompt = `Product: ${product.name} — ${product.description}\n\nPost:\nTitle: ${post.title}\nBody: ${post.snippet}\nAuthor: ${post.author ?? 'unknown'}`;
        try {
            const response = await ctx.callModel('cheap', prompt, LEAD_SCORE_SYSTEM);
            const parsed = JSON.parse(response.replace(/```json?\n?/g, '').replace(/```/g, '').trim());
            scored.push({
                title: post.title,
                url: post.url,
                snippet: post.snippet,
                platform: post.source.includes('reddit') ? 'reddit' : 'x',
                author: post.author,
                timestamp: post.timestamp,
                commentCount: post.commentCount,
                relevanceScore: post.relevanceScore,
                leadScore: parsed.leadScore ?? 5,
                urgency: parsed.urgency ?? 'medium',
                painPoints: parsed.painPoints ?? [],
            });
        }
        catch {
            scored.push({
                title: post.title,
                url: post.url,
                snippet: post.snippet,
                platform: post.source.includes('reddit') ? 'reddit' : 'x',
                relevanceScore: post.relevanceScore,
                leadScore: 5,
                urgency: 'medium',
                painPoints: [],
            });
        }
    }
    // Track high-score leads
    for (const s of scored.filter(s => s.leadScore >= 7)) {
        await ctx.track('lead', {
            url: s.url,
            title: s.title,
            leadScore: s.leadScore,
            urgency: s.urgency,
            painPoints: s.painPoints,
            platform: s.platform,
        });
    }
    return {
        data: { scoredPosts: scored },
        summary: `${scored.filter(s => s.leadScore >= 7).length} high-value leads, ${scored.length} total`,
    };
}
async function draftStep(ctx) {
    const posts = (ctx.data.scoredPosts ?? []);
    const sc = ctx.config;
    const product = sc.products[0];
    const drafts = [];
    for (const post of posts) {
        const tier = post.leadScore >= 7 ? 'premium' : 'cheap';
        const maxLength = post.platform === 'reddit' ? sc.replyStyle.maxLengthReddit : sc.replyStyle.maxLengthX;
        const prompt = buildReplyPrompt({ title: post.title, body: post.snippet, platform: post.platform }, { name: product.name, description: product.description }, { tone: sc.replyStyle.tone, maxLength, rules: sc.replyStyle.rules });
        try {
            const text = await ctx.callModel(tier, prompt);
            drafts.push({
                post,
                text: text.trim(),
                model: tier,
                tier,
                estimatedCost: 0, // Cost tracked at runner level
            });
        }
        catch (err) {
            ctx.log(`Failed to draft reply for ${post.url}: ${err.message}`);
        }
    }
    return {
        data: { drafts, itemCount: drafts.length },
        summary: `${drafts.length} draft replies generated`,
    };
}
async function previewStep(ctx) {
    const drafts = (ctx.data.drafts ?? []);
    if (drafts.length === 0)
        return { summary: 'No drafts to preview' };
    const high = drafts.filter(d => d.post.leadScore >= 7);
    const medium = drafts.filter(d => d.post.leadScore < 7);
    ctx.log('\n' + '═'.repeat(50));
    ctx.log('DRAFT REPLIES');
    ctx.log('═'.repeat(50));
    if (high.length > 0) {
        ctx.log(`\n🎯 HIGH VALUE (${high.length} posts)`);
        for (const d of high) {
            ctx.log(`\n  ${d.post.platform}: "${d.post.title.slice(0, 60)}"`);
            ctx.log(`  ⭐ Lead: ${d.post.leadScore}/10 | Tier: ${d.tier}`);
            ctx.log(`  Reply: "${d.text.slice(0, 120)}..."`);
        }
    }
    if (medium.length > 0) {
        ctx.log(`\n📋 MEDIUM (${medium.length} posts)`);
        for (const d of medium) {
            ctx.log(`  ${d.post.platform}: "${d.post.title.slice(0, 50)}" | Lead: ${d.post.leadScore}/10`);
        }
    }
    ctx.log('═'.repeat(50));
    return { summary: `${high.length} high + ${medium.length} medium drafts` };
}
async function postStep(ctx) {
    const drafts = (ctx.data.drafts ?? []);
    let posted = 0;
    for (const draft of drafts) {
        await ctx.track('reply', {
            url: draft.post.url,
            platform: draft.post.platform,
            tier: draft.tier,
            leadScore: draft.post.leadScore,
            replyLength: draft.text.length,
        });
        // Post via channel if available
        if (ctx.sendMessage) {
            try {
                await ctx.sendMessage(draft.post.platform, {
                    text: draft.text,
                    inReplyTo: draft.post.url,
                });
                posted++;
            }
            catch (err) {
                ctx.log(`Failed to post to ${draft.post.platform}: ${err.message}`);
            }
        }
        else {
            ctx.log(`✓ Would post to ${draft.post.platform}: ${draft.post.url}`);
            posted++;
        }
    }
    return {
        data: { postedCount: posted },
        summary: `${posted} replies ${ctx.dryRun ? 'drafted' : 'posted'}`,
    };
}
async function trackStep(ctx) {
    const drafts = (ctx.data.drafts ?? []);
    return {
        summary: `${drafts.length} replies tracked`,
    };
}
// ─── Plugin Export ────────────────────────────────────────────────────────
const plugin = {
    manifest: {
        id: 'social',
        name: 'Social Growth',
        description: 'AI-powered social engagement on Reddit/X',
        version: '1.0.0',
        provides: { workflows: ['social'] },
        entry: 'index.js',
    },
    workflows: {
        social: () => socialWorkflow,
    },
};
export default plugin;
