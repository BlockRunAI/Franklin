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
  confidence: number;             // 0.0 – 1.0
  source_session: string;
  created_at: number;             // epoch ms
  last_confirmed: number;         // epoch ms
  times_confirmed: number;
}

export type LearningCategory =
  | 'language'
  | 'model_preference'
  | 'tool_pattern'
  | 'coding_style'
  | 'communication'
  | 'domain'
  | 'correction'
  | 'negative'         // "Don't do X" — things the user explicitly rejected
  | 'project_context'  // Project-specific: architecture, key files, tech stack decisions
  | 'workflow'
  | 'other';

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
    steps: string;       // Multi-line procedure
  }>;
}

// ─── Skills (procedural memory) ───────────────────────────────────────────
// Skills are reusable multi-step procedures learned from complex tasks.
// Stored separately from learnings (markdown files) because they're larger.

export interface Skill {
  name: string;
  description: string;
  triggers: string[];
  steps: string;          // Multi-line procedure in markdown
  created: string;        // ISO date
  uses: number;
  source_session: string;
}
