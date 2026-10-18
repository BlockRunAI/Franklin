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

// ─── Experience (outcome-verified lessons) ────────────────────────────────
//
// A learning records what the USER said. An experience records what a GOAL
// OUTCOME showed: it is written only when a /goal was refuted by the verifier
// panel and then verified on a later round, so a behavioral contrast between
// two attempts at the same objective backs it. Adoption alone (a goal that
// passes on round 1) never produces one. See src/learnings/experience.ts.

export type ExperienceComponent = 'playbook' | 'guardrail' | 'tool_guidance' | 'skill' | 'memory';
export type ExperienceVerdict = 'helped' | 'hurt' | 'confounded';
export type ExperienceConfidence = 'high' | 'medium' | 'low';

/** Exactly one of wallet / workspace is set. Experiences are never global. */
export interface ExperienceScope {
  wallet?: string;     // `<chain>-<addr8>`, trading goals
  workspace?: string;  // `<slug>-<hash8>`, everything else (same key as src/memory)
}

export interface ExperienceEvidence {
  goalId: string;
  kind: 'trading' | 'research' | 'general';
  /** Rounds the verifier panel refuted before the goal was verified (or capped). */
  roundsRefuted: number;
  /** Gaps the last refuted round raised that the verified round no longer did. */
  closedGaps: string[];
  /** Skills whose trigger hints were active while the goal ran (for scoring later). */
  skillsHinted: string[];
}

export interface Experience {
  id: string;
  /** Shape of situation the lesson applies to — the pattern, never this goal's facts. */
  cue: string;
  /** The operation to perform, naming the component it concerns. <= 240 chars. */
  lesson: string;
  component: ExperienceComponent;
  verdict: ExperienceVerdict;
  confidence: ExperienceConfidence;
  evidence: ExperienceEvidence;
  scope: ExperienceScope;
  source_session: string;
  created_at: number;
  last_confirmed: number;
  times_confirmed: number;
  /** Set when the lesson was rendered into a system prompt; lets a later
   *  refutation in the same scope count against it. */
  last_rendered_at?: number;
  /** Goals in this scope refuted on round 1 while the lesson was rendered. */
  refutations_seen?: number;
}
