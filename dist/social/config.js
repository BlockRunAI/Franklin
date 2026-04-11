/**
 * Typed config for Franklin's social subsystem.
 * Stored at ~/.blockrun/social-config.json. Default written on first run.
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
export const CONFIG_PATH = path.join(os.homedir(), '.blockrun', 'social-config.json');
const DEFAULT_CONFIG = {
    version: 1,
    handle: '',
    products: [
        {
            name: 'Your Product',
            description: 'Replace this with a one-paragraph description of what your product does, ' +
                'who it is for, and what pain it solves. Franklin will use this verbatim as ' +
                'the AI persona when replying to relevant posts.',
            trigger_keywords: [],
        },
    ],
    x: {
        search_queries: [],
        daily_target: 20,
        min_delay_seconds: 300,
        max_length: 260,
        login_detection: '',
    },
    reply_style: {
        rules: [
            'Sound like a real human with experience, not a bot',
            'Be specific — reference details from the post you are replying to',
            'Maximum 2-3 sentences, conversational tone',
            'No marketing speak, no emojis, no hashtags',
            'If the product fits naturally, mention it once and only once',
            'If the product does not fit, reply with just: SKIP',
        ],
        model_tier: 'cheap',
    },
};
/**
 * Load config from disk. If missing, write defaults and return them.
 * Returns the parsed config or throws on malformed JSON.
 */
export function loadConfig() {
    const dir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(CONFIG_PATH)) {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
        return { ...DEFAULT_CONFIG };
    }
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.version !== 1) {
        throw new Error(`Unsupported social config version ${parsed.version} (expected 1)`);
    }
    return parsed;
}
/**
 * Persist config back to disk.
 */
export function saveConfig(cfg) {
    const dir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}
/**
 * Whether the config is "ready" to run — has a handle and at least one
 * product with keywords.
 */
export function isConfigReady(cfg) {
    if (!cfg.handle)
        return { ready: false, reason: 'handle not set' };
    if (cfg.products.length === 0)
        return { ready: false, reason: 'no products configured' };
    const hasKeywords = cfg.products.some((p) => p.trigger_keywords.length > 0);
    if (!hasKeywords)
        return { ready: false, reason: 'no trigger keywords on any product' };
    if (cfg.x.search_queries.length === 0)
        return { ready: false, reason: 'no x.search_queries configured' };
    return { ready: true };
}
