import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PermissionManager } from '../dist/agent/permissions.js';
import {
  createDesktopWorkspacePermissionPolicy,
  fileTokenOk,
  isOriginAllowed,
  localFileUrl,
  resolveServedMediaPath,
  tokenOk,
} from '../dist/serve/server.js';

test('serve token gates WebSocket and file URLs', () => {
  const previous = process.env.FRANKLIN_SERVE_TOKEN;
  const previousFileToken = process.env.FRANKLIN_SERVE_FILE_TOKEN;
  process.env.FRANKLIN_SERVE_TOKEN = 'test-token-with-enough-entropy';
  process.env.FRANKLIN_SERVE_FILE_TOKEN = 'separate-file-signing-key';
  try {
    assert.equal(tokenOk(new URL('http://127.0.0.1/agent')), false);
    assert.equal(tokenOk(new URL('http://127.0.0.1/agent?token=wrong')), false);
    assert.equal(tokenOk(new URL('http://127.0.0.1/agent?token=test-token-with-enough-entropy')), true);

    const fileUrl = new URL(localFileUrl(3737, '/tmp/demo audio.mp3'));
    assert.equal(fileUrl.searchParams.get('path'), '/tmp/demo audio.mp3');
    assert.equal(fileUrl.searchParams.has('token'), false);
    assert.equal(fileTokenOk(fileUrl), true);
    const tampered = new URL(fileUrl);
    tampered.searchParams.set('path', '/tmp/different.mp3');
    assert.equal(fileTokenOk(tampered), false);
  } finally {
    if (previous === undefined) delete process.env.FRANKLIN_SERVE_TOKEN;
    else process.env.FRANKLIN_SERVE_TOKEN = previous;
    if (previousFileToken === undefined) delete process.env.FRANKLIN_SERVE_FILE_TOKEN;
    else process.env.FRANKLIN_SERVE_FILE_TOKEN = previousFileToken;
  }
});

test('serve origin policy rejects hostile and opaque browser origins by default', () => {
  const previous = process.env.FRANKLIN_SERVE_ALLOW_NULL_ORIGIN;
  delete process.env.FRANKLIN_SERVE_ALLOW_NULL_ORIGIN;
  try {
    assert.equal(isOriginAllowed('https://attacker.example'), false);
    assert.equal(isOriginAllowed('null'), false);
    assert.equal(isOriginAllowed('http://127.0.0.1:5174'), true);
    assert.equal(isOriginAllowed('https://franklin.run'), true);
  } finally {
    if (previous === undefined) delete process.env.FRANKLIN_SERVE_ALLOW_NULL_ORIGIN;
    else process.env.FRANKLIN_SERVE_ALLOW_NULL_ORIGIN = previous;
  }
});

test('served media stays inside approved roots and rejects symlink escapes', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'franklin-serve-security-'));
  const root = path.join(temp, 'workspace');
  const outside = path.join(temp, 'private');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  const allowed = path.join(root, 'result.mp3');
  const secret = path.join(outside, 'secret.png');
  const nonMedia = path.join(root, 'wallet.key');
  const escape = path.join(root, 'escape.png');
  fs.writeFileSync(allowed, 'audio');
  fs.writeFileSync(secret, 'private image');
  fs.writeFileSync(nonMedia, 'secret');
  fs.symlinkSync(secret, escape);

  try {
    assert.deepEqual(resolveServedMediaPath(allowed, [fs.realpathSync(root)]), {
      realPath: fs.realpathSync(allowed),
      mediaType: 'audio/mpeg',
    });
    assert.equal(resolveServedMediaPath(secret, [fs.realpathSync(root)]), null);
    assert.equal(resolveServedMediaPath(nonMedia, [fs.realpathSync(root)]), null);
    assert.equal(resolveServedMediaPath(escape, [fs.realpathSync(root)]), null);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('Desktop workspace policy prompts for direct path and symlink escapes', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'franklin-desktop-boundary-'));
  const root = path.join(temp, 'workspace');
  const outside = path.join(temp, 'private');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, 'inside.txt'), 'ok');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  fs.symlinkSync(outside, path.join(root, 'escape'));

  try {
    const policy = createDesktopWorkspacePermissionPolicy(root);
    assert.equal(await policy('Read', { file_path: path.join(root, 'inside.txt') }), undefined);
    assert.equal((await policy('Read', { file_path: path.join(outside, 'secret.txt') }))?.behavior, 'ask');
    assert.equal((await policy('Write', { file_path: path.join(root, '..', 'private', 'new.txt') }))?.behavior, 'ask');
    assert.equal((await policy('Write', { file_path: path.join(root, 'escape', 'new.txt') }))?.behavior, 'ask');
    assert.equal((await policy('Glob', { path: outside, pattern: '**/*' }))?.behavior, 'ask');
    assert.equal((await policy('Grep', { path: path.join(root, 'inside.txt'), pattern: 'ok' })), undefined);
    assert.equal((await policy('Bash', { command: `cat ${path.join(root, 'inside.txt')}` }))?.behavior, 'ask');
    assert.equal((await policy('BrowserX', { action: 'screenshot' }))?.behavior, 'ask');
    assert.equal((await policy('BrowserX', { action: 'screenshot', path: path.join(root, 'shot.png') })), undefined);
    assert.equal((await policy('BrowserX', { action: 'open', url: 'file:///tmp/private.html' }))?.behavior, 'ask');
    assert.equal((await policy('BrowserX', { action: 'open', url: 'fi\tle:///tmp/private.html' }))?.behavior, 'ask');
    assert.equal((await policy('ImageGen', {
      prompt: 'edit',
      image_url: path.join(outside, 'secret.txt'),
      output_path: path.join(root, 'result.png'),
    }))?.behavior, 'ask');
    assert.equal((await policy('ImageGen', { prompt: 'draw', image_url: 'https://example.com/source.png' })), undefined);
    assert.equal((await policy('VideoGen', { prompt: 'animate', image_url: path.join(root, 'inside.txt') })), undefined);
    assert.equal((await policy('MusicGen', { prompt: 'song', output_path: path.join(outside, 'song.mp3') }))?.behavior, 'ask');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('driver policy cannot be bypassed by trust mode or normal allow rules', async () => {
  const policy = async (toolName) => toolName === 'Read'
    ? { behavior: 'ask', reason: 'test boundary' }
    : undefined;
  const manager = new PermissionManager('trust', undefined, policy);
  assert.deepEqual(await manager.check('Read', { file_path: '/tmp/secret' }), {
    behavior: 'ask',
    reason: 'test boundary',
  });
});
