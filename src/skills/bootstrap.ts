/**
 * Boot-time helpers that wire the skills library into the running process:
 *
 * - `loadBundledSkills()` discovers `dist/skills-bundled/<name>/SKILL.md`
 *   relative to this module's location and returns a populated Registry.
 *   User-global and project-local discovery are deferred to Phase 2 of the
 *   skills MVP plan; today we only ship the bundled set.
 *
 * - `getSkillVars()` returns the synchronously-known runtime variables
 *   that `substituteVariables` injects into a skill body before
 *   `$ARGUMENTS` expansion. Async values (wallet balance, on-chain reads)
 *   are deferred to a later phase: those vars stay literal in the rendered
 *   prompt and `substituteVariables` leaves unknown vars intact.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadSkillsFromDir } from './loader.js';
import { Registry } from './registry.js';
import type { LoadError } from './types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// Built form lives at dist/skills/bootstrap.js, so dist/skills-bundled/
// is one level up + sibling.
const BUNDLED_DIR = join(HERE, '..', 'skills-bundled');

export interface BundledLoad {
  registry: Registry;
  errors: LoadError[];
}

export function loadBundledSkills(): BundledLoad {
  const result = loadSkillsFromDir(BUNDLED_DIR, 'bundled');
  return { registry: Registry.fromLoaded(result.skills), errors: result.errors };
}

export interface SkillVarSource {
  chain?: 'base' | 'solana';
}

export function getSkillVars(src: SkillVarSource): Record<string, string> {
  const out: Record<string, string> = {};
  if (src.chain) out.wallet_chain = src.chain;
  return out;
}
