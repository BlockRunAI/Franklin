/**
 * Persistence layer for per-user learnings.
 * Stored as JSONL at ~/.blockrun/learnings.jsonl.
 */
import type { Learning, LearningCategory } from './types.js';
export declare function loadLearnings(): Learning[];
export declare function saveLearnings(learnings: Learning[]): void;
export declare function mergeLearning(existing: Learning[], newEntry: {
    learning: string;
    category: LearningCategory;
    confidence: number;
    source_session: string;
}): Learning[];
export declare function decayLearnings(learnings: Learning[]): Learning[];
export declare function formatForPrompt(learnings: Learning[]): string;
