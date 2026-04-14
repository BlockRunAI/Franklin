/**
 * Types for Franklin's per-user self-evolution system.
 *
 * Each user's Franklin learns preferences from session traces and
 * injects them into the system prompt on next startup.
 */
export interface Learning {
    id: string;
    learning: string;
    category: LearningCategory;
    confidence: number;
    source_session: string;
    created_at: number;
    last_confirmed: number;
    times_confirmed: number;
}
export type LearningCategory = 'language' | 'model_preference' | 'tool_pattern' | 'coding_style' | 'communication' | 'domain' | 'correction' | 'negative' | 'project_context' | 'workflow' | 'other';
export interface ExtractionResult {
    learnings: Array<{
        learning: string;
        category: LearningCategory;
        confidence: number;
    }>;
    /** Procedural skills extracted from complex task patterns. */
    skills?: Array<{
        name: string;
        description: string;
        triggers: string[];
        steps: string;
    }>;
}
export interface Skill {
    name: string;
    description: string;
    triggers: string[];
    steps: string;
    created: string;
    uses: number;
    source_session: string;
}
