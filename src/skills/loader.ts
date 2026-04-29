/**
 * SKILL.md loader — parses Anthropic-spec frontmatter + markdown body.
 *
 * The frontmatter parser is intentionally minimal: flat `key: value` lines
 * with scalar values (string, boolean, number). Quoted strings, nested
 * objects, and arrays are out of scope for MVP — Anthropic's SKILL.md spec
 * never needs them and adding a YAML dependency would be heavier than the
 * spec warrants.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type {
  LoadedSkill,
  LoadResult,
  ParsedSkill,
  ParseResult,
  SkillSource,
} from './types.js';

const FRONTMATTER_FENCE = '---';

export function parseSkill(content: string): ParseResult {
  const fmMatch = extractFrontmatter(content);
  if (!fmMatch) {
    return { error: 'missing frontmatter (file must start with --- fence)' };
  }

  const { frontmatter, body } = fmMatch;
  const parsedFrontmatter = parseFrontmatter(frontmatter);
  if ('error' in parsedFrontmatter) return { error: parsedFrontmatter.error };

  const { fields, warnings } = parsedFrontmatter;

  if (typeof fields.name !== 'string' || fields.name.length === 0) {
    return { error: 'frontmatter missing required field: name' };
  }
  if (typeof fields.description !== 'string' || fields.description.length === 0) {
    return { error: 'frontmatter missing required field: description' };
  }

  const skill: ParsedSkill = {
    name: fields.name,
    description: fields.description,
    body,
  };

  if (typeof fields['argument-hint'] === 'string') {
    skill.argumentHint = fields['argument-hint'];
  }
  if (typeof fields['disable-model-invocation'] === 'boolean') {
    skill.disableModelInvocation = fields['disable-model-invocation'];
  }
  if (typeof fields['budget-cap-usd'] === 'number') {
    skill.budgetCapUsd = fields['budget-cap-usd'];
  }
  if (typeof fields['cost-receipt'] === 'boolean') {
    skill.costReceipt = fields['cost-receipt'];
  }

  return { skill, warnings };
}

interface FrontmatterMatch {
  frontmatter: string;
  body: string;
}

function extractFrontmatter(content: string): FrontmatterMatch | null {
  const normalized = content.replace(/\r\n/g, '\n');
  if (!normalized.startsWith(FRONTMATTER_FENCE + '\n')) return null;

  const rest = normalized.slice(FRONTMATTER_FENCE.length + 1);
  const closeIdx = rest.indexOf('\n' + FRONTMATTER_FENCE + '\n');
  if (closeIdx < 0) return null;

  const frontmatter = rest.slice(0, closeIdx);
  const body = rest.slice(closeIdx + 1 + FRONTMATTER_FENCE.length + 1);
  return { frontmatter, body };
}

type ScalarValue = string | number | boolean;

interface FrontmatterParse {
  fields: Record<string, ScalarValue>;
  warnings: string[];
}

function parseFrontmatter(text: string): FrontmatterParse | { error: string } {
  const fields: Record<string, ScalarValue> = {};
  const warnings: string[] = [];
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) continue;

    const colon = line.indexOf(':');
    if (colon < 0) {
      return { error: `frontmatter line ${i + 1} is not key: value — got "${line}"` };
    }

    const key = line.slice(0, colon).trim();
    const rawValue = line.slice(colon + 1).trim();
    if (key.length === 0) {
      return { error: `frontmatter line ${i + 1} has empty key` };
    }

    fields[key] = parseScalar(rawValue);
  }

  return { fields, warnings };
}

/**
 * Discover and parse every `<dir>/<name>/SKILL.md` under `root`.
 *
 * Missing root → empty result, no error (callers happily union project +
 * user + bundled, and absent dirs are normal).
 *
 * Parse failures on individual skills do not abort the load; they are
 * surfaced via `LoadResult.errors` so the caller can warn the user.
 */
export function loadSkillsFromDir(root: string, source: SkillSource): LoadResult {
  const result: LoadResult = { skills: [], errors: [] };

  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return result;
  }

  for (const entry of entries) {
    const dirPath = join(root, entry);
    let entryStat;
    try {
      entryStat = statSync(dirPath);
    } catch {
      continue;
    }
    if (!entryStat.isDirectory()) continue;

    const skillPath = join(dirPath, 'SKILL.md');
    let content: string;
    try {
      content = readFileSync(skillPath, 'utf8');
    } catch {
      continue;
    }

    const parsed = parseSkill(content);
    if ('error' in parsed) {
      result.errors.push({ path: skillPath, error: parsed.error });
      continue;
    }

    const warnings = [...parsed.warnings];
    let skill = parsed.skill;
    if (skill.name !== entry) {
      warnings.push(
        `frontmatter name "${skill.name}" disagrees with directory "${entry}"; using directory name`,
      );
      skill = { ...skill, name: entry };
    }

    const loaded: LoadedSkill = { skill, source, path: skillPath, warnings };
    result.skills.push(loaded);
  }

  return result;
}

function parseScalar(raw: string): ScalarValue {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+$/.test(raw)) return Number.parseInt(raw, 10);
  if (/^-?\d+\.\d+$/.test(raw)) return Number.parseFloat(raw);

  // Strip surrounding quotes if present.
  if (
    (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) ||
    (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2)
  ) {
    return raw.slice(1, -1);
  }
  return raw;
}
