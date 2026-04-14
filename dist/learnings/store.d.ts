/**
 * Persistence layer for per-user learnings.
 * Stored as JSONL at ~/.blockrun/learnings.jsonl.
 */
import type { Learning, LearningCategory, Skill } from './types.js';
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
/** Load all skills from disk. */
export declare function loadSkills(): Skill[];
/** Save a new skill to disk. */
export declare function saveSkill(skill: Skill): void;
/** Bump use count for a skill. */
export declare function bumpSkillUse(skill: Skill): void;
/** Find skills relevant to a user message, by trigger matching. */
export declare function matchSkills(input: string, skills: Skill[]): Skill[];
/** Format matched skills for system prompt injection. */
export declare function formatSkillsForPrompt(skills: Skill[]): string;
