import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BLOCKRUN_DIR } from '../config.js';

const stateFile = join(BLOCKRUN_DIR, 'skills-disabled.json');

export function disabledSkills(): Set<string> {
  if (!existsSync(stateFile)) return new Set();
  if (lstatSync(stateFile).isSymbolicLink()) throw new Error('Skill state must not be a symlink');
  const names: unknown = JSON.parse(readFileSync(stateFile, 'utf8'));
  if (!Array.isArray(names) || !names.every((n) => typeof n === 'string')) throw new Error('Invalid skill state');
  return new Set(names);
}

export function setSkillEnabled(name: string, enabled: boolean): void {
  const names = disabledSkills();
  if (enabled) names.delete(name); else names.add(name);
  mkdirSync(BLOCKRUN_DIR, { recursive: true });
  const temp = `${stateFile}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify([...names]), { mode: 0o600, flag: 'wx' });
  renameSync(temp, stateFile);
}
