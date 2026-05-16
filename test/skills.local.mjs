/**
 * Skills MVP — deterministic local tests (no live model dependency).
 *
 * Phase 1 covers: SKILL.md frontmatter parsing, variable substitution,
 * directory loading, registry conflict resolution, and graceful failure.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseSkill, loadSkillsFromDir } from '../dist/skills/loader.js';
import { substituteVariables, matchSkill } from '../dist/skills/invoke.js';
import { Registry } from '../dist/skills/registry.js';
import { loadBundledSkills, getSkillVars } from '../dist/skills/bootstrap.js';

const DIST = fileURLToPath(new URL('../dist/index.js', import.meta.url));

function runCli(args, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [DIST, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`Timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 0 });
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function makeSkillDir(parent, name, content) {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), content, 'utf8');
  return dir;
}

function frontmatter(name, description, body = 'body content', extra = '') {
  return [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    extra,
    '---',
    body,
    '',
  ].filter((l) => l !== '').join('\n');
}

test('parseSkill parses a minimal valid SKILL.md', () => {
  const md = [
    '---',
    'name: foo',
    'description: A test skill',
    '---',
    'Hello {{wallet_balance}}',
    '',
  ].join('\n');

  const result = parseSkill(md);

  assert.ok('skill' in result, `expected ok result, got: ${JSON.stringify(result)}`);
  assert.equal(result.skill.name, 'foo');
  assert.equal(result.skill.description, 'A test skill');
  assert.equal(result.skill.body, 'Hello {{wallet_balance}}\n');
  assert.deepEqual(result.warnings, []);
});

test('parseSkill captures all Anthropic + Franklin frontmatter fields', () => {
  const md = [
    '---',
    'name: spend-tdd',
    'description: TDD with budget tracking',
    'argument-hint: <feature description>',
    'disable-model-invocation: true',
    'budget-cap-usd: 0.5',
    'cost-receipt: true',
    '---',
    'body content here',
    '',
  ].join('\n');

  const result = parseSkill(md);
  assert.ok('skill' in result, `expected ok, got: ${JSON.stringify(result)}`);
  assert.equal(result.skill.argumentHint, '<feature description>');
  assert.equal(result.skill.disableModelInvocation, true);
  assert.equal(result.skill.budgetCapUsd, 0.5);
  assert.equal(result.skill.costReceipt, true);
});

test('parseSkill rejects content without frontmatter', () => {
  const result = parseSkill('No frontmatter here\nJust body.\n');
  assert.ok('error' in result, `expected error, got: ${JSON.stringify(result)}`);
  assert.match(result.error, /frontmatter/i);
});

test('parseSkill rejects frontmatter missing name field', () => {
  const md = [
    '---',
    'description: missing name',
    '---',
    'body',
  ].join('\n');
  const result = parseSkill(md);
  assert.ok('error' in result, `expected error, got: ${JSON.stringify(result)}`);
  assert.match(result.error, /name/i);
});

test('parseSkill rejects frontmatter missing description field', () => {
  const md = [
    '---',
    'name: nameOnly',
    '---',
    'body',
  ].join('\n');
  const result = parseSkill(md);
  assert.ok('error' in result, `expected error, got: ${JSON.stringify(result)}`);
  assert.match(result.error, /description/i);
});

test('parseSkill rejects frontmatter without closing fence', () => {
  const md = [
    '---',
    'name: foo',
    'description: never closes',
    'body without close',
    '',
  ].join('\n');
  const result = parseSkill(md);
  assert.ok('error' in result, `expected error, got: ${JSON.stringify(result)}`);
});

test('parseSkill ignores unknown frontmatter fields', () => {
  const md = [
    '---',
    'name: foo',
    'description: bar',
    'mystery-future-field: hello',
    '---',
    'body',
  ].join('\n');
  const result = parseSkill(md);
  assert.ok('skill' in result, `expected ok, got: ${JSON.stringify(result)}`);
  assert.equal(result.skill.name, 'foo');
});

// ─── substituteVariables ──────────────────────────────────────────────────

test('substituteVariables replaces a known wallet variable', () => {
  const out = substituteVariables(
    'Balance: {{wallet_balance}} USDC',
    { wallet_balance: '12.50' },
    '',
  );
  assert.equal(out, 'Balance: 12.50 USDC');
});

test('substituteVariables leaves unknown variables intact', () => {
  const out = substituteVariables(
    'Hello {{not_a_known_var}}',
    { wallet_balance: '12.50' },
    '',
  );
  assert.equal(out, 'Hello {{not_a_known_var}}');
});

test('substituteVariables replaces $ARGUMENTS', () => {
  const out = substituteVariables(
    'Plan: $ARGUMENTS',
    {},
    'add a login button',
  );
  assert.equal(out, 'Plan: add a login button');
});

test('substituteVariables collapses $ARGUMENTS when args empty', () => {
  const out = substituteVariables('Plan: $ARGUMENTS done.', {}, '');
  assert.equal(out, 'Plan:  done.');
});

test('substituteVariables handles multiple substitutions in one body', () => {
  const out = substituteVariables(
    'Wallet: {{wallet_balance}} on {{wallet_chain}}; task: $ARGUMENTS',
    {
      wallet_balance: '5.00',
      wallet_chain: 'base',
    },
    'refactor auth',
  );
  assert.equal(
    out,
    'Wallet: 5.00 on base; task: refactor auth',
  );
});

test('substituteVariables preserves variables containing dollar signs in args', () => {
  // A user task description like "find $5 of value" must not be eaten by
  // a literal regex on $ARGUMENTS.
  const out = substituteVariables(
    'Task: $ARGUMENTS',
    {},
    'find $5 of value',
  );
  assert.equal(out, 'Task: find $5 of value');
});

// ─── loadSkillsFromDir ────────────────────────────────────────────────────

test('loadSkillsFromDir returns empty array for nonexistent dir', () => {
  const result = loadSkillsFromDir('/path/that/does/not/exist/skills', 'bundled');
  assert.deepEqual(result.skills, []);
  assert.deepEqual(result.errors, []);
});

test('loadSkillsFromDir reads every SKILL.md in subdirectories', () => {
  const root = mkdtempSync(join(tmpdir(), 'franklin-skills-'));
  try {
    makeSkillDir(root, 'alpha', frontmatter('alpha', 'Alpha skill'));
    makeSkillDir(root, 'beta', frontmatter('beta', 'Beta skill'));

    const result = loadSkillsFromDir(root, 'bundled');
    assert.equal(result.skills.length, 2);
    assert.equal(result.errors.length, 0);
    const names = result.skills.map((s) => s.skill.name).sort();
    assert.deepEqual(names, ['alpha', 'beta']);
    assert.equal(result.skills[0].source, 'bundled');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadSkillsFromDir reports parse errors but continues with valid siblings', () => {
  const root = mkdtempSync(join(tmpdir(), 'franklin-skills-'));
  try {
    makeSkillDir(root, 'good', frontmatter('good', 'Good skill'));
    makeSkillDir(root, 'broken', 'no frontmatter at all\n');

    const result = loadSkillsFromDir(root, 'user');
    assert.equal(result.skills.length, 1);
    assert.equal(result.skills[0].skill.name, 'good');
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].path, /broken[/\\]SKILL\.md$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadSkillsFromDir skips dirs without a SKILL.md', () => {
  const root = mkdtempSync(join(tmpdir(), 'franklin-skills-'));
  try {
    mkdirSync(join(root, 'empty-dir'));
    makeSkillDir(root, 'real', frontmatter('real', 'Real skill'));
    const result = loadSkillsFromDir(root, 'project');
    assert.equal(result.skills.length, 1);
    assert.equal(result.skills[0].skill.name, 'real');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadSkillsFromDir warns when frontmatter name disagrees with directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'franklin-skills-'));
  try {
    makeSkillDir(root, 'dirname-says', frontmatter('frontmatter-says', 'Mismatch'));
    const result = loadSkillsFromDir(root, 'project');
    assert.equal(result.skills.length, 1);
    // We use the directory name as canonical (per design doc) and surface a
    // warning the loader callers can show to the user.
    assert.equal(result.skills[0].skill.name, 'dirname-says');
    const allWarnings = result.skills.flatMap((s) => s.warnings);
    assert.ok(
      allWarnings.some((w) => w.includes('frontmatter-says')),
      `expected warning about name mismatch, got: ${JSON.stringify(allWarnings)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── Registry ─────────────────────────────────────────────────────────────

function loaded(name, source, body = 'body') {
  return {
    skill: { name, description: `${name} skill`, body },
    source,
    path: `/fake/${source}/${name}/SKILL.md`,
    warnings: [],
  };
}

test('Registry stores every uniquely-named skill', () => {
  const reg = Registry.fromLoaded([
    loaded('alpha', 'bundled'),
    loaded('beta', 'user'),
    loaded('gamma', 'project'),
  ]);
  assert.equal(reg.list().length, 3);
  assert.equal(reg.lookup('alpha').source, 'bundled');
  assert.equal(reg.lookup('beta').source, 'user');
  assert.equal(reg.lookup('gamma').source, 'project');
});

test('Registry: project shadows user shadows bundled', () => {
  const bundled = loaded('shared', 'bundled');
  const user = loaded('shared', 'user');
  const project = loaded('shared', 'project');

  const reg = Registry.fromLoaded([bundled, user, project]);
  assert.equal(reg.list().length, 1);
  assert.equal(reg.lookup('shared').source, 'project');

  const shadowed = reg.shadowed();
  assert.equal(shadowed.length, 2);
  const sources = shadowed.map((s) => s.loser.source).sort();
  assert.deepEqual(sources, ['bundled', 'user']);
});

test('Registry: user beats bundled when no project entry', () => {
  const reg = Registry.fromLoaded([
    loaded('shared', 'bundled'),
    loaded('shared', 'user'),
  ]);
  assert.equal(reg.lookup('shared').source, 'user');
});

test('Registry: project beats bundled when no user entry', () => {
  const reg = Registry.fromLoaded([
    loaded('shared', 'bundled'),
    loaded('shared', 'project'),
  ]);
  assert.equal(reg.lookup('shared').source, 'project');
});

test('Registry: two skills at the same precedence — first wins, second shadowed', () => {
  const first = loaded('twin', 'project');
  const second = { ...loaded('twin', 'project'), path: '/fake/project/twin-2/SKILL.md' };
  const reg = Registry.fromLoaded([first, second]);
  assert.equal(reg.list().length, 1);
  assert.equal(reg.lookup('twin').path, first.path);
  const shadowed = reg.shadowed();
  assert.equal(shadowed.length, 1);
  assert.equal(shadowed[0].loser.path, second.path);
});

test('Registry: lookup returns undefined for unknown skill', () => {
  const reg = Registry.fromLoaded([loaded('alpha', 'bundled')]);
  assert.equal(reg.lookup('does-not-exist'), undefined);
});

test('Registry: list ordering is deterministic by name', () => {
  const reg = Registry.fromLoaded([
    loaded('zebra', 'bundled'),
    loaded('alpha', 'bundled'),
    loaded('mango', 'bundled'),
  ]);
  const names = reg.list().map((l) => l.skill.name);
  assert.deepEqual(names, ['alpha', 'mango', 'zebra']);
});

// ─── bootstrap ────────────────────────────────────────────────────────────

test('loadBundledSkills includes budget-grill from src/skills-bundled', () => {
  const result = loadBundledSkills();
  assert.equal(result.errors.length, 0, `unexpected errors: ${JSON.stringify(result.errors)}`);
  const skill = result.registry.lookup('budget-grill');
  assert.ok(skill, 'expected budget-grill to be loaded');
  assert.equal(skill.source, 'bundled');
  assert.equal(skill.skill.costReceipt, true);
  // Pre-substitution body keeps the placeholders intact for the dispatch
  // layer to render against the live runtime context.
  assert.match(skill.skill.body, /\$ARGUMENTS/);
  assert.match(skill.skill.body, /\{\{wallet_chain\}\}/);
});

test('getSkillVars exposes synchronously-known runtime context', () => {
  const vars = getSkillVars({ chain: 'base' });
  assert.equal(vars.wallet_chain, 'base');
  // wallet_balance requires async wallet query — deferred to Phase 2.
  assert.equal(vars.wallet_balance, undefined);
});

test('getSkillVars omits unknown fields when source is empty', () => {
  const vars = getSkillVars({});
  assert.equal(vars.wallet_chain, undefined);
});

// ─── matchSkill ───────────────────────────────────────────────────────────

function makeRegistry(...skills) {
  return Registry.fromLoaded(
    skills.map((s, i) => ({
      skill: s,
      source: 'bundled',
      path: `/fake/${s.name}/SKILL.md`,
      warnings: [],
    })),
  );
}

test('matchSkill resolves a slash command with no args', () => {
  const reg = makeRegistry({ name: 'foo', description: 'd', body: 'pure body' });
  const result = matchSkill('/foo', reg, {});
  assert.ok(result);
  assert.equal(result.rewritten, 'pure body');
});

test('matchSkill resolves a slash command with args', () => {
  const reg = makeRegistry({ name: 'foo', description: 'd', body: 'do: $ARGUMENTS' });
  const result = matchSkill('/foo polish the readme', reg, {});
  assert.ok(result);
  assert.equal(result.rewritten, 'do: polish the readme');
});

test('matchSkill substitutes runtime variables before $ARGUMENTS expansion', () => {
  const reg = makeRegistry({
    name: 'budget-grill',
    description: 'd',
    body: 'on {{wallet_chain}} task=$ARGUMENTS',
  });
  const vars = { wallet_chain: 'base' };
  const result = matchSkill('/budget-grill add login', reg, vars);
  assert.equal(result.rewritten, 'on base task=add login');
});

test('matchSkill returns null for unknown commands', () => {
  const reg = makeRegistry({ name: 'foo', description: 'd', body: 'b' });
  assert.equal(matchSkill('/bar', reg, {}), null);
});

test('matchSkill returns null for non-slash input', () => {
  const reg = makeRegistry({ name: 'foo', description: 'd', body: 'b' });
  assert.equal(matchSkill('not a slash command', reg, {}), null);
});

test('matchSkill returns null for bare slash', () => {
  const reg = makeRegistry({ name: 'foo', description: 'd', body: 'b' });
  assert.equal(matchSkill('/', reg, {}), null);
});

test('matchSkill: trailing whitespace in args is trimmed but interior preserved', () => {
  const reg = makeRegistry({ name: 'foo', description: 'd', body: '$ARGUMENTS' });
  const result = matchSkill('/foo   hello   world   ', reg, {});
  assert.equal(result.rewritten, 'hello   world');
});

// ─── franklin skills CLI ──────────────────────────────────────────────────

test('franklin skills lists the bundled budget-grill skill', { timeout: 15_000 }, async () => {
  const result = await runCli(['skills']);
  assert.equal(result.code, 0, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
  assert.match(result.stdout, /\/budget-grill/);
  assert.match(result.stdout, /Wallet-aware grilling/);
  assert.match(result.stdout, /receipt/, 'cost-receipt flag should appear');
  assert.match(result.stdout, /\(bundled\)/);
});

test('franklin skills --json emits a parseable structure', { timeout: 15_000 }, async () => {
  const result = await runCli(['skills', '--json']);
  assert.equal(result.code, 0);
  const data = JSON.parse(result.stdout);
  assert.ok(Array.isArray(data.skills));
  const grill = data.skills.find((s) => s.name === 'budget-grill');
  assert.ok(grill, 'budget-grill should appear in JSON output');
  assert.equal(grill.source, 'bundled');
  assert.equal(grill.costReceipt, true);
});

test('franklin skills which prints the bundled SKILL.md path', { timeout: 15_000 }, async () => {
  const result = await runCli(['skills', 'which', 'budget-grill']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /skills-bundled[/\\]budget-grill[/\\]SKILL\.md/);
});

test('franklin skills which exits non-zero for unknown skill', { timeout: 15_000 }, async () => {
  const result = await runCli(['skills', 'which', 'nonexistent']);
  assert.notEqual(result.code, 0);
  assert.match(result.stdout, /not found/i);
});

test('substituteVariables wired with bundled skill + getSkillVars produces expected interpolation', () => {
  const result = loadBundledSkills();
  const skill = result.registry.lookup('budget-grill');
  const vars = getSkillVars({ chain: 'solana' });
  const out = substituteVariables(skill.skill.body, vars, 'add a feature');
  assert.match(out, /on solana/);
  assert.match(out, /add a feature\n?$/);
  // Confirm no leftover known-var placeholders in the rendered output.
  assert.doesNotMatch(out, /\{\{wallet_chain\}\}/);
});
