import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
const STORE_DIR = path.join(os.homedir(), '.blockrun');
const STATE_PATH = path.join(STORE_DIR, 'narrative.json');
const MAX_ENTRIES = 50;
let loaded = false;
let state;
function today() {
    return new Date().toISOString().slice(0, 10);
}
function defaults() {
    return {
        watchlist: [],
        recentSignals: [],
        recentPosts: [],
        budget: { dailyCapUsd: 10, spentTodayUsd: 0, date: today() },
    };
}
export function loadNarrative() {
    if (loaded)
        return state;
    fs.mkdirSync(STORE_DIR, { recursive: true });
    if (fs.existsSync(STATE_PATH)) {
        try {
            state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
        }
        catch {
            state = defaults();
        }
    }
    else {
        state = defaults();
    }
    if (state.budget.date !== today()) {
        state.budget.spentTodayUsd = 0;
        state.budget.date = today();
    }
    loaded = true;
    return state;
}
export function saveNarrative(s) {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2) + '\n');
    state = s;
    loaded = true;
}
export function updateNarrative(patch) {
    const cur = loadNarrative();
    const merged = { ...cur, ...patch };
    if (patch.recentSignals) {
        merged.recentSignals = [...patch.recentSignals, ...cur.recentSignals].slice(0, MAX_ENTRIES);
    }
    if (patch.recentPosts) {
        merged.recentPosts = [...patch.recentPosts, ...cur.recentPosts].slice(0, MAX_ENTRIES);
    }
    saveNarrative(merged);
    return merged;
}
export function addSignal(signal) {
    const cur = loadNarrative();
    cur.recentSignals = [signal, ...cur.recentSignals].slice(0, MAX_ENTRIES);
    saveNarrative(cur);
}
export function addPost(post) {
    const cur = loadNarrative();
    cur.recentPosts = [post, ...cur.recentPosts].slice(0, MAX_ENTRIES);
    saveNarrative(cur);
}
