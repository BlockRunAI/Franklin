import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const STORE_DIR = path.join(os.homedir(), '.blockrun');
const STATE_PATH = path.join(STORE_DIR, 'narrative.json');
const MAX_ENTRIES = 50;

export interface SignalRecord {
  asset: string;
  direction: 'bullish' | 'bearish' | 'neutral';
  confidence: number;
  summary: string;
  ts: string;
}

export interface PostRecord {
  platform: string;
  url: string;
  text: string;
  referencesAssets?: string[];
  ts: string;
}

export interface BudgetEnvelope {
  dailyCapUsd: number;
  spentTodayUsd: number;
  date: string;
}

export interface NarrativeState {
  watchlist: string[];
  recentSignals: SignalRecord[];
  recentPosts: PostRecord[];
  budget: BudgetEnvelope;
}

let loaded = false;
let state: NarrativeState;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function defaults(): NarrativeState {
  return {
    watchlist: [],
    recentSignals: [],
    recentPosts: [],
    budget: { dailyCapUsd: 10, spentTodayUsd: 0, date: today() },
  };
}

export function loadNarrative(): NarrativeState {
  if (loaded) return state;
  fs.mkdirSync(STORE_DIR, { recursive: true });
  if (fs.existsSync(STATE_PATH)) {
    try {
      state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) as NarrativeState;
    } catch {
      state = defaults();
    }
  } else {
    state = defaults();
  }
  if (state.budget.date !== today()) {
    state.budget.spentTodayUsd = 0;
    state.budget.date = today();
  }
  loaded = true;
  return state;
}

export function saveNarrative(s: NarrativeState): void {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2) + '\n');
  state = s;
  loaded = true;
}

export function updateNarrative(patch: Partial<NarrativeState>): NarrativeState {
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

export function addSignal(signal: SignalRecord): void {
  const cur = loadNarrative();
  cur.recentSignals = [signal, ...cur.recentSignals].slice(0, MAX_ENTRIES);
  saveNarrative(cur);
}

export function addPost(post: PostRecord): void {
  const cur = loadNarrative();
  cur.recentPosts = [post, ...cur.recentPosts].slice(0, MAX_ENTRIES);
  saveNarrative(cur);
}
