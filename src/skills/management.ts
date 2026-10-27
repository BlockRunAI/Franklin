/** Local skill management. Importing instructions never executes their contents. */
import { lstatSync, mkdirSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BLOCKRUN_DIR } from '../config.js';
import { loadAllSkills } from './bootstrap.js';
import { parseSkill } from './loader.js';
import { matchSkill } from './invoke.js';
import { disabledSkills, setSkillEnabled } from './state.js';
import type { LoadedSkill } from './types.js';

export const MAX_SKILL_BYTES = 256 * 1024;
const root = join(BLOCKRUN_DIR, 'skills');
const reserved = new Set(('learned explain search find refactor scaffold doc moa noplan stash unstash log status diff undo tokens help history transcript bug version mcp context doctor plan ultrathink dump execute sessions cost clear failures compact commit push pr review fix test debug init todo deps optimize security lint migrate clean tasks ultraplan session-search ssearch goal remember flush dream loop market insights learnings brain auto model branch wallet delete resume retry exit').split(' '));

function validName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) throw new Error('Skill name must be lowercase letters, numbers and hyphens (up to 64 characters)');
}

function safeRoot(): void {
  mkdirSync(root, { recursive: true });
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new Error('Skills directory must not be a symlink');
}

function describe(entry: LoadedSkill, disabled: Set<string>) {
  const localBody = entry.skill.body.replace(/https?:\/\/[^\s`"')\]]+/g, '');
  const supportFiles = /(?:\b(?:python3?|node|bash|sh)\s+[^\n`]*\.(?:py|m?js|cjs|sh)\b|(?:scripts|references|assets)\/[^\s`\])]+)/i.test(localBody);
  return {
    name: entry.skill.name, description: entry.skill.description, source: entry.source,
    hidden: !!entry.skill.hidden, modelInvocable: !entry.skill.disableModelInvocation,
    enabled: !disabled.has(entry.skill.name), removable: entry.source === 'user',
    notes: [
      ...(supportFiles ? ['References supporting files. A SKILL.md import does not include those files; provide them separately before use.'] : []),
      ...entry.warnings,
    ],
  };
}

export function listManagedSkills(workDir: string) {
  const loaded = loadAllSkills(workDir, { includeDisabled: true });
  const disabled = disabledSkills();
  return { skills: loaded.registry.list().map((s) => describe(s, disabled)), errors: loaded.errors.map((e) => e.error) };
}

export function importSkill(workDir: string, content: unknown) {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_SKILL_BYTES) throw new Error('Provide a SKILL.md file up to 256 KiB');
  const parsed = parseSkill(content);
  if ('error' in parsed) throw new Error(parsed.error);
  const { name, body, budgetCapUsd } = parsed.skill;
  validName(name);
  if (reserved.has(name)) throw new Error(`/${name} is reserved by Franklin`);
  if (!body.trim()) throw new Error('Skill instructions must not be empty');
  if (budgetCapUsd !== undefined && (!Number.isFinite(budgetCapUsd) || budgetCapUsd < 0)) throw new Error('budget-cap-usd must be a non-negative number');
  if (loadAllSkills(workDir, { includeDisabled: true }).registry.lookup(name)) throw new Error(`/${name} already exists; remove your imported copy before replacing it`);
  safeRoot();
  const dir = join(root, name);
  // mkdir is exclusive, including against dangling symlinks and concurrent imports.
  try { mkdirSync(dir, { mode: 0o700 }); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`/${name} already exists on disk`);
    throw err;
  }
  try {
    writeFileSync(join(dir, 'SKILL.md'), content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    setSkillEnabled(name, true);
  } catch (err) {
    try { unlinkSync(join(dir, 'SKILL.md')); rmdirSync(dir); } catch { /* preserve unexpected files */ }
    throw err;
  }
  return { name };
}

export function toggleSkill(workDir: string, name: unknown, enabled: unknown) {
  validName(name);
  if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean');
  if (!loadAllSkills(workDir, { includeDisabled: true }).registry.lookup(name)) throw new Error('Skill not found');
  setSkillEnabled(name, enabled);
  return { ok: true };
}

export function removeSkill(workDir: string, name: unknown) {
  validName(name);
  const entry = loadAllSkills(workDir, { includeDisabled: true }).registry.lookup(name);
  if (!entry || entry.source !== 'user') throw new Error('Only imported user skills can be removed here');
  safeRoot();
  const dir = join(root, name), file = join(dir, 'SKILL.md');
  if (lstatSync(dir).isSymbolicLink() || lstatSync(file).isSymbolicLink()) throw new Error('Cannot remove a linked skill');
  if (readdirSync(dir).some((f) => f !== 'SKILL.md')) throw new Error('Skill contains supporting files; manage its folder directly');
  unlinkSync(file);
  rmdirSync(dir);
  setSkillEnabled(name, true);
  return { ok: true };
}

/** Same prompt resolver used by slash dispatch; does not call models or tools. */
export function resolveManagedSkill(workDir: string, input: unknown) {
  if (typeof input !== 'string' || input.length > MAX_SKILL_BYTES) throw new Error('Provide a skill command');
  const match = matchSkill(input, loadAllSkills(workDir).registry, {});
  if (!match) throw new Error('Skill not found or disabled');
  return { name: match.skill.name, prompt: match.rewritten };
}
