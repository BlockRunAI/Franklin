/**
 * Social Workflow — AI-powered social media engagement.
 *
 * Search Reddit/X for relevant posts → filter with cheap LLM → score leads →
 * generate replies with multi-model routing → preview → post → track.
 */
import { WorkflowEngine } from '../workflow/engine.js';
import { DEFAULT_MODEL_TIERS } from '../workflow/types.js';
import { DEFAULT_REPLY_STYLE } from './types.js';
import { FILTER_SYSTEM, LEAD_SCORE_SYSTEM, buildReplyPrompt, buildKeywordPrompt, buildSubredditPrompt, } from './prompts.js';
export class SocialWorkflow extends WorkflowEngine {
    get name() { return 'social'; }
    get steps() {
        return [
            { name: 'search', modelTier: 'none', execute: (ctx) => this.searchStep(ctx) },
            { name: 'filter', modelTier: 'cheap', execute: (ctx) => this.filterStep(ctx) },
            { name: 'score', modelTier: 'cheap', execute: (ctx) => this.scoreStep(ctx) },
            { name: 'draft', modelTier: 'dynamic', execute: (ctx) => this.draftStep(ctx) },
            { name: 'preview', modelTier: 'none', execute: (ctx) => this.previewStep(ctx) },
            { name: 'post', modelTier: 'none', execute: (ctx) => this.postStep(ctx), skipInDryRun: true },
            { name: 'track', modelTier: 'none', execute: (ctx) => this.trackStep(ctx) },
        ];
    }
    defaultConfig() {
        return {
            name: 'social',
            models: { ...DEFAULT_MODEL_TIERS },
            products: [],
            platforms: {},
            replyStyle: { ...DEFAULT_REPLY_STYLE },
            targetUsers: '',
        };
    }
    get socialConfig() {
        return this.config;
    }
    // ─── Onboarding ─────────────────────────────────────────────────────────
    get onboardingQuestions() {
        return [
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
        ];
    }
    async buildConfigFromAnswers(answers) {
        const [productName, ...descParts] = (answers.product || '').split('—').map(s => s.trim());
        const productDesc = descParts.join(' — ') || productName;
        const targetUsers = answers.targetUsers || '';
        const platform = answers.platform || 'Both';
        const handle = answers.handle || '';
        // Auto-generate keywords using cheap model
        let keywords = [];
        let subreddits = [];
        try {
            const kwResult = await this.router.call('cheap', buildKeywordPrompt(productName, productDesc, targetUsers));
            const parsed = JSON.parse(kwResult.text.replace(/```json?\n?/g, '').replace(/```/g, '').trim());
            if (Array.isArray(parsed))
                keywords = parsed;
        }
        catch { /* use empty */ }
        if (platform === 'Reddit' || platform === 'Both') {
            try {
                const srResult = await this.router.call('cheap', buildSubredditPrompt(productName, productDesc, targetUsers));
                const parsed = JSON.parse(srResult.text.replace(/```json?\n?/g, '').replace(/```/g, '').trim());
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
    }
    // ─── Steps ──────────────────────────────────────────────────────────────
    /** Step 1: Search for relevant posts */
    async searchStep(ctx) {
        const sc = ctx.config;
        const allResults = [];
        // Search using configured queries
        const queries = sc.platforms.x?.searchQueries ?? sc.products[0]?.keywords ?? [];
        for (const query of queries.slice(0, 5)) {
            const results = await ctx.search(query, { maxResults: 5 });
            allResults.push(...results);
        }
        if (allResults.length === 0) {
            return { summary: 'No posts found', abort: true };
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
    /** Step 2: Filter for relevance using cheap model */
    async filterStep(ctx) {
        const results = (ctx.data.searchResults ?? []);
        const sc = ctx.config;
        const product = sc.products[0];
        if (!product)
            return { summary: 'No product configured', abort: true };
        const relevant = [];
        for (const post of results) {
            // Skip if already replied
            if (await ctx.isDuplicate(post.url))
                continue;
            const prompt = `Product: ${product.name} — ${product.description}\n\nPost:\nTitle: ${post.title}\nBody: ${post.snippet}\n\nIs this post relevant for engagement?`;
            try {
                const response = await ctx.callModel('cheap', prompt, FILTER_SYSTEM);
                const parsed = JSON.parse(response.replace(/```json?\n?/g, '').replace(/```/g, '').trim());
                if (parsed.relevant && parsed.score >= 5) {
                    relevant.push({ ...post, relevanceScore: parsed.score });
                }
            }
            catch {
                // Skip posts that fail to parse
            }
        }
        if (relevant.length === 0) {
            return { summary: 'No relevant posts after filtering', abort: true };
        }
        // Sort by relevance score descending
        relevant.sort((a, b) => b.relevanceScore - a.relevanceScore);
        return {
            data: { filteredPosts: relevant, itemCount: relevant.length },
            summary: `${relevant.length}/${results.length} posts are relevant`,
        };
    }
    /** Step 3: Score leads */
    async scoreStep(ctx) {
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
                // Use default score
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
    /** Step 4: Draft replies (multi-model by lead score) */
    async draftStep(ctx) {
        const posts = (ctx.data.scoredPosts ?? []);
        const sc = ctx.config;
        const product = sc.products[0];
        const drafts = [];
        let totalCost = 0;
        for (const post of posts) {
            const tier = post.leadScore >= 7 ? 'premium' : 'cheap';
            const maxLength = post.platform === 'reddit' ? sc.replyStyle.maxLengthReddit : sc.replyStyle.maxLengthX;
            const prompt = buildReplyPrompt({ title: post.title, body: post.snippet, platform: post.platform }, { name: product.name, description: product.description }, { tone: sc.replyStyle.tone, maxLength, rules: sc.replyStyle.rules });
            try {
                const result = await this.router.call(tier, prompt);
                totalCost += result.cost;
                drafts.push({
                    post,
                    text: result.text.trim(),
                    model: result.model,
                    tier,
                    estimatedCost: result.cost,
                });
            }
            catch (err) {
                ctx.log(`Failed to draft reply for ${post.url}: ${err.message}`);
            }
        }
        return {
            data: { drafts, itemCount: drafts.length },
            summary: `${drafts.length} draft replies generated`,
            cost: totalCost,
        };
    }
    /** Step 5: Preview drafts for user review */
    async previewStep(ctx) {
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
                ctx.log(`  ⭐ Lead: ${d.post.leadScore}/10 | Model: ${d.model} | Cost: $${d.estimatedCost.toFixed(4)}`);
                ctx.log(`  Reply: "${d.text.slice(0, 120)}..."`);
            }
        }
        if (medium.length > 0) {
            ctx.log(`\n📋 MEDIUM (${medium.length} posts)`);
            for (const d of medium) {
                ctx.log(`  ${d.post.platform}: "${d.post.title.slice(0, 50)}" | Lead: ${d.post.leadScore}/10`);
            }
        }
        const totalCost = drafts.reduce((sum, d) => sum + d.estimatedCost, 0);
        ctx.log(`\nTotal: ${drafts.length} replies, est. $${totalCost.toFixed(4)}`);
        ctx.log('═'.repeat(50));
        return { summary: `${high.length} high + ${medium.length} medium drafts` };
    }
    /** Step 6: Post replies (skipped in dry-run) */
    async postStep(ctx) {
        const drafts = (ctx.data.drafts ?? []);
        let posted = 0;
        for (const draft of drafts) {
            // Mark as processed (dedup)
            await ctx.track('reply', {
                url: draft.post.url,
                platform: draft.post.platform,
                model: draft.model,
                tier: draft.tier,
                leadScore: draft.post.leadScore,
                replyLength: draft.text.length,
            });
            // TODO: Actually post via browse CLI
            // For now, just log what would be posted
            ctx.log(`✓ Would post to ${draft.post.platform}: ${draft.post.url}`);
            posted++;
        }
        return {
            data: { postedCount: posted },
            summary: `${posted} replies ${ctx.dryRun ? 'drafted' : 'posted'}`,
        };
    }
    /** Step 7: Track results */
    async trackStep(ctx) {
        const drafts = (ctx.data.drafts ?? []);
        const totalCost = drafts.reduce((sum, d) => sum + d.estimatedCost, 0);
        return {
            summary: `${drafts.length} replies tracked, $${totalCost.toFixed(4)} spent`,
            cost: totalCost,
        };
    }
}
