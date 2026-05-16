/**
 * Franklin Panel — local HTTP server.
 * Serves the dashboard HTML + JSON API endpoints + SSE for real-time updates.
 * Zero external dependencies — uses node:http only.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { loadChain, saveChain, type Chain } from '../config.js';
import {
  listNumbers as gatewayListNumbers,
  renewNumber as gatewayRenewNumber,
  buyNumber as gatewayBuyNumber,
  releaseNumber as gatewayReleaseNumber,
} from '../phone/client.js';
import {
  readCache as readPhoneCache,
  writeCache as writePhoneCache,
  clearCache as clearPhoneCache,
  isFresh as isPhoneCacheFresh,
} from '../phone/cache.js';
import { loadStats, getStatsSummary, getStatsFilePath } from '../stats/tracker.js';
import { generateInsights } from '../stats/insights.js';
import { listSessions, loadSessionHistory } from '../session/storage.js';
import { searchSessions } from '../session/search.js';
import { loadLearnings } from '../learnings/store.js';
import { readAudit } from '../stats/audit.js';
import { snapshot as marketsSnapshot } from '../trading/providers/telemetry.js';
import { describeWiring } from '../trading/providers/registry.js';
import {
  listTasks,
  readTaskMeta,
  readTaskEvents,
} from '../tasks/store.js';
import { reconcileLostTasks } from '../tasks/lost-detection.js';
import { taskLogPath } from '../tasks/paths.js';
import { isTerminalTaskStatus } from '../tasks/types.js';
import { getHTML } from './html.js';

const sseClients = new Set<http.ServerResponse>();

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

/**
 * Require the request to come from loopback. Wallet secret + import endpoints
 * must never be reachable from another host — defense-in-depth on top of the
 * 127.0.0.1 listen binding in panel.ts.
 */
function isLoopback(req: http.IncomingMessage): boolean {
  const addr = req.socket.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

async function readBody(req: http.IncomingMessage, maxBytes = 16 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) { reject(new Error('Request body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function broadcast(data: unknown): void {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(msg); } catch { sseClients.delete(client); }
  }
}

/**
 * Resolve the current active wallet address (Base or Solana, depending on
 * the active chain). Used by phone endpoints that key the cache by wallet,
 * and that must sign x402 payments out of the wallet the user owns.
 *
 * Throws if no wallet exists yet — the UI handles this by showing an
 * empty state with a "Create wallet" CTA before any phone calls can be made.
 */
async function currentWalletAddress(): Promise<string> {
  const chain = loadChain();
  if (chain === 'solana') {
    const { setupAgentSolanaWallet } = await import('@blockrun/llm');
    const client = await setupAgentSolanaWallet({ silent: true });
    return await client.getWalletAddress();
  }
  const { setupAgentWallet } = await import('@blockrun/llm');
  const client = setupAgentWallet({ silent: true });
  return client.getWalletAddress();
}

export function createPanelServer(port: number): http.Server {
  const html = getHTML();

  const server = http.createServer(async (req, res) => {
    try {
    const url = new URL(req.url || '/', `http://localhost:${port}`);
    const p = url.pathname;

    // ─── HTML ──
    if (p === '/') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
      });
      res.end(html);
      return;
    }

    // ─── Static assets ──
    if (p.startsWith('/assets/') && p.endsWith('.jpg')) {
      const filename = path.basename(p);
      const assetsDir = path.join(path.dirname(path.dirname(new URL(import.meta.url).pathname)), '..', 'assets');
      const imgPath = path.join(assetsDir, filename);
      try {
        const img = fs.readFileSync(imgPath);
        res.writeHead(200, {
          'Content-Type': 'image/jpeg',
          'Cache-Control': 'public, max-age=86400',
        });
        res.end(img);
      } catch {
        res.writeHead(404);
        res.end('Not found');
      }
      return;
    }

    // ─── SSE ──
    if (p === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write('data: {"type":"connected"}\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    // ─── API ──
    try {
      if (p === '/api/stats') {
        const summary = getStatsSummary();
        json(res, {
          totalRequests: summary.stats.totalRequests,
          totalCostUsd: summary.stats.totalCostUsd,
          opusCost: summary.opusCost,
          saved: summary.saved,
          savedPct: summary.savedPct,
          avgCostPerRequest: summary.avgCostPerRequest,
          period: summary.period,
          byModel: summary.stats.byModel,
        });
        return;
      }

      if (p === '/api/insights') {
        const days = parseInt(url.searchParams.get('days') || '30', 10);
        const report = generateInsights(days);
        json(res, report);
        return;
      }

      if (p === '/api/audit') {
        // Per-call LLM audit log — prompt, model, tokens, cost per call.
        // Supports ?limit=N&paidOnly=1&since=<ms>&session=<prefix>&model=<substr>
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '200', 10), 2000);
        const paidOnly = url.searchParams.get('paidOnly') === '1';
        const since = parseInt(url.searchParams.get('since') || '0', 10);
        const sessionFilter = url.searchParams.get('session') || '';
        const modelFilter = url.searchParams.get('model') || '';
        let entries = readAudit();
        if (since > 0) entries = entries.filter(e => e.ts >= since);
        if (paidOnly) entries = entries.filter(e => e.costUsd > 0);
        if (sessionFilter) entries = entries.filter(e => e.sessionId?.startsWith(sessionFilter));
        if (modelFilter) entries = entries.filter(e => e.model.includes(modelFilter));
        const recent = entries.slice(-limit).reverse(); // newest first
        const totalCost = entries.reduce((s, e) => s + e.costUsd, 0);
        const totalIn = entries.reduce((s, e) => s + e.inputTokens, 0);
        const totalOut = entries.reduce((s, e) => s + e.outputTokens, 0);
        json(res, {
          total: entries.length,
          returned: recent.length,
          totalCostUsd: totalCost,
          totalInputTokens: totalIn,
          totalOutputTokens: totalOut,
          entries: recent,
        });
        return;
      }

      if (p === '/api/sessions') {
        const sessions = listSessions();
        json(res, sessions);
        return;
      }

      if (p.startsWith('/api/sessions/search')) {
        const q = url.searchParams.get('q') || '';
        const limit = parseInt(url.searchParams.get('limit') || '20', 10);
        const results = searchSessions(q, { limit });
        json(res, results);
        return;
      }

      if (p.startsWith('/api/sessions/')) {
        const id = decodeURIComponent(p.slice('/api/sessions/'.length));
        const history = loadSessionHistory(id);
        json(res, history);
        return;
      }

      if (p === '/api/wallet') {
        try {
          const chain = loadChain();
          let address = '', balance = 0;
          if (chain === 'solana') {
            const { setupAgentSolanaWallet } = await import('@blockrun/llm');
            const client = await setupAgentSolanaWallet({ silent: true });
            address = await client.getWalletAddress();
            balance = await client.getBalance();
          } else {
            const { setupAgentWallet } = await import('@blockrun/llm');
            const client = setupAgentWallet({ silent: true });
            address = client.getWalletAddress();
            balance = await client.getBalance();
          }
          json(res, { address, balance, chain });
        } catch {
          json(res, { address: 'not set', balance: 0, chain: loadChain() });
        }
        return;
      }

      // ─── Wallet QR (SVG) ────────────────────────────────────────────────
      // Returns an SVG QR code for a given payload (?data=...). Generated
      // server-side so the browser never ships the wallet address to a
      // third-party QR service. Size-bounded.
      if (p === '/api/wallet/qr') {
        const data = url.searchParams.get('data') || '';
        if (!data || data.length > 256) {
          json(res, { error: 'missing or oversized data param' }, 400);
          return;
        }
        try {
          const QRCode = (await import('qrcode')).default;
          const svg = await QRCode.toString(data, {
            type: 'svg',
            errorCorrectionLevel: 'M',
            margin: 1,
            color: { dark: '#000000', light: '#ffffff' },
          });
          res.writeHead(200, {
            'Content-Type': 'image/svg+xml; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end(svg);
        } catch (err) {
          json(res, { error: (err as Error).message }, 500);
        }
        return;
      }

      // ─── Wallet secret (loopback only) ──────────────────────────────────
      // Returns the private key so the user can back it up / move it.
      // Hardened: loopback-only (belt-and-suspenders on the 127.0.0.1 bind),
      // no-store cache header, JSON only.
      if (p === '/api/wallet/secret') {
        if (!isLoopback(req)) {
          json(res, { error: 'forbidden' }, 403);
          return;
        }
        try {
          const chain = loadChain();
          const { loadWallet, loadSolanaWallet, WALLET_FILE_PATH, SOLANA_WALLET_FILE_PATH } =
            await import('@blockrun/llm');
          const privateKey = chain === 'solana' ? loadSolanaWallet() : loadWallet();
          if (!privateKey) {
            json(res, { error: 'wallet not set' }, 404);
            return;
          }
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify({
            chain,
            privateKey,
            walletFile: chain === 'solana' ? SOLANA_WALLET_FILE_PATH : WALLET_FILE_PATH,
          }));
        } catch (err) {
          json(res, { error: (err as Error).message }, 500);
        }
        return;
      }

      // ─── Wallet import (loopback only) ──────────────────────────────────
      // Overwrites the local wallet with a user-supplied private key.
      // Destructive — overwrites the existing wallet file without backup,
      // so the UI warns the user. Loopback-only.
      if (p === '/api/wallet/import' && req.method === 'POST') {
        if (!isLoopback(req)) {
          json(res, { error: 'forbidden' }, 403);
          return;
        }
        try {
          const raw = await readBody(req);
          const body = JSON.parse(raw) as { privateKey?: string };
          const pk = (body.privateKey || '').trim();
          if (!pk) { json(res, { error: 'privateKey required' }, 400); return; }

          const chain = loadChain();
          if (chain === 'solana') {
            const { saveSolanaWallet, setupAgentSolanaWallet } = await import('@blockrun/llm');
            // Basic shape check: base58 chars, reasonable length. Library validates too.
            if (!/^[1-9A-HJ-NP-Za-km-z]{40,120}$/.test(pk)) {
              json(res, { error: 'invalid Solana private key format' }, 400);
              return;
            }
            saveSolanaWallet(pk);
            const client = await setupAgentSolanaWallet({ silent: true });
            const address = await client.getWalletAddress();
            json(res, { ok: true, chain, address });
          } else {
            const { saveWallet, setupAgentWallet } = await import('@blockrun/llm');
            // Base: 0x + 64 hex chars
            const normalized = pk.startsWith('0x') ? pk : `0x${pk}`;
            if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
              json(res, { error: 'invalid Base private key — expected 0x + 64 hex chars' }, 400);
              return;
            }
            saveWallet(normalized);
            const client = setupAgentWallet({ silent: true });
            const address = client.getWalletAddress();
            json(res, { ok: true, chain, address });
          }
        } catch (err) {
          json(res, { error: (err as Error).message }, 500);
        }
        return;
      }

      // ─── Chain switch (loopback only) ───────────────────────────────
      // Switches the active payment chain (base ↔ solana) for subsequent
      // Franklin runs. Writes ~/.blockrun/payment-chain, then ensures a
      // wallet exists on the target chain (creates if missing). Returns
      // the new wallet address + balance so the UI can re-render without
      // a follow-up round trip.
      //
      // NOTE: a currently-running `franklin` agent reads the chain once
      // at startup. The Panel switch takes effect immediately for Panel
      // reads and for the *next* agent invocation, but won't flip chain
      // mid-session for an already-running agent. UI copy makes this clear.
      if (p === '/api/chain' && req.method === 'POST') {
        if (!isLoopback(req)) {
          json(res, { error: 'forbidden' }, 403);
          return;
        }
        try {
          const raw = await readBody(req);
          const body = JSON.parse(raw) as { chain?: string };
          const target = body.chain;
          if (target !== 'base' && target !== 'solana') {
            json(res, { error: 'chain must be "base" or "solana"' }, 400);
            return;
          }
          saveChain(target as Chain);
          // Creates-or-loads the wallet on the target chain.
          let address = '';
          let balance = 0;
          if (target === 'solana') {
            const { setupAgentSolanaWallet } = await import('@blockrun/llm');
            const client = await setupAgentSolanaWallet({ silent: true });
            address = await client.getWalletAddress();
            balance = await client.getBalance();
          } else {
            const { setupAgentWallet } = await import('@blockrun/llm');
            const client = setupAgentWallet({ silent: true });
            address = client.getWalletAddress();
            balance = await client.getBalance();
          }
          json(res, { ok: true, chain: target, address, balance });
        } catch (err) {
          json(res, { error: (err as Error).message }, 500);
        }
        return;
      }

      // ─── Phone & Voice ──────────────────────────────────────────────────
      // GET  /api/phone/numbers           — list wallet-owned numbers (cached)
      // POST /api/phone/numbers/refresh   — force-refresh from BlockRun ($0.001)
      // POST /api/phone/numbers/renew     — extend lease 30d ($5)
      // POST /api/phone/numbers/buy       — provision new number ($5)
      // POST /api/phone/numbers/release   — release (free)
      //
      // Renewals are explicit user clicks. No silent auto-renew: a wallet
      // that runs dry between charges would fail the renewal and surprise
      // the user. Notifications at T-7/3/1 days keep them in the loop.
      //
      // All mutating endpoints are loopback-only because they spend money
      // out of the user's wallet — same posture as /api/wallet/secret.

      if (p === '/api/phone/numbers' && (!req.method || req.method === 'GET')) {
        try {
          const wallet = await currentWalletAddress();
          const chain = loadChain();
          const cache = readPhoneCache();
          if (cache && isPhoneCacheFresh(cache, wallet, chain)) {
            json(res, {
              wallet,
              chain,
              fetchedAt: cache.fetchedAt,
              fromCache: true,
              numbers: cache.numbers,
            });
            return;
          }
          // Cache stale or missing — fetch fresh (costs $0.001).
          // We pay through the panel's wallet, which is the same wallet
          // that owns the numbers, so the gateway returns this user's list.
          const fresh = await gatewayListNumbers({ walletAddress: wallet });
          json(res, {
            wallet,
            chain,
            fetchedAt: Date.now(),
            fromCache: false,
            paid: fresh.paid,
            numbers: fresh.numbers,
          });
        } catch (err) {
          json(res, { error: (err as Error).message, numbers: [] }, 500);
        }
        return;
      }

      if (p === '/api/phone/numbers/refresh' && req.method === 'POST') {
        if (!isLoopback(req)) { json(res, { error: 'forbidden' }, 403); return; }
        try {
          const wallet = await currentWalletAddress();
          clearPhoneCache();
          const fresh = await gatewayListNumbers({ walletAddress: wallet });
          broadcast({ type: 'phone.refreshed' });
          json(res, {
            wallet,
            chain: loadChain(),
            paid: fresh.paid,
            numbers: fresh.numbers,
          });
        } catch (err) {
          json(res, { error: (err as Error).message }, 500);
        }
        return;
      }

      if (p === '/api/phone/numbers/renew' && req.method === 'POST') {
        if (!isLoopback(req)) { json(res, { error: 'forbidden' }, 403); return; }
        try {
          const raw = await readBody(req);
          const body = JSON.parse(raw) as { phoneNumber?: string };
          const target = (body.phoneNumber || '').trim();
          if (!target) { json(res, { error: 'phoneNumber required' }, 400); return; }
          const result = await gatewayRenewNumber(target);
          // Patch the cache in place so the panel UI gets the new expiry
          // without a follow-up $0.001 list call.
          const cache = readPhoneCache();
          if (cache) {
            const idx = cache.numbers.findIndex(n => n.phone_number === target);
            if (idx >= 0) {
              cache.numbers[idx] = {
                ...cache.numbers[idx],
                expires_at: result.expires_at,
                active: true,
              };
              writePhoneCache({ wallet: cache.wallet, chain: cache.chain, numbers: cache.numbers });
            }
          }
          broadcast({ type: 'phone.renewed', phoneNumber: target, expires_at: result.expires_at });
          json(res, { ok: true, ...result });
        } catch (err) {
          json(res, { error: (err as Error).message }, 500);
        }
        return;
      }

      if (p === '/api/phone/numbers/buy' && req.method === 'POST') {
        if (!isLoopback(req)) { json(res, { error: 'forbidden' }, 403); return; }
        try {
          const raw = await readBody(req);
          const body = JSON.parse(raw) as { country?: string; areaCode?: string };
          const result = await gatewayBuyNumber({
            country: body.country,
            areaCode: body.areaCode,
          });
          clearPhoneCache(); // forces next /api/phone/numbers to re-list
          broadcast({ type: 'phone.bought', phoneNumber: result.phone_number });
          json(res, { ok: true, ...result });
        } catch (err) {
          json(res, { error: (err as Error).message }, 500);
        }
        return;
      }

      if (p === '/api/phone/numbers/release' && req.method === 'POST') {
        if (!isLoopback(req)) { json(res, { error: 'forbidden' }, 403); return; }
        try {
          const raw = await readBody(req);
          const body = JSON.parse(raw) as { phoneNumber?: string };
          const target = (body.phoneNumber || '').trim();
          if (!target) { json(res, { error: 'phoneNumber required' }, 400); return; }
          const result = await gatewayReleaseNumber(target);
          const cache = readPhoneCache();
          if (cache) {
            const next = cache.numbers.filter(n => n.phone_number !== target);
            writePhoneCache({ wallet: cache.wallet, chain: cache.chain, numbers: next });
          }
          broadcast({ type: 'phone.released', phoneNumber: target });
          json(res, { ok: true, ...result });
        } catch (err) {
          json(res, { error: (err as Error).message }, 500);
        }
        return;
      }

      if (p === '/api/markets') {
        // Snapshot of every active data provider for the Markets panel:
        // pipeline wiring (which endpoint serves which asset class), live
        // health + latency per provider, and today's paid-call ledger.
        const snap = marketsSnapshot();
        const wiring = describeWiring();
        json(res, {
          chain: loadChain(),
          wiring,
          providers: snap.providers,
          totals: snap.totals,
          recentPaidCalls: snap.recentPaidCalls,
        });
        return;
      }

      if (p === '/api/learnings') {
        const learnings = loadLearnings();
        json(res, learnings);
        return;
      }

      // ─── Tasks ─────────────────────────────────────────────────────────
      // Background tasks dispatched via the Detach tool / `franklin task`.
      // The list endpoint reconciles lost tasks (dead pids) before snapshot
      // so the UI never displays a zombie as "running". Detail / log /
      // events endpoints power the per-task drawer in the Tasks tab.
      if (p === '/api/tasks') {
        try { reconcileLostTasks(); } catch { /* best-effort */ }
        json(res, { tasks: listTasks() });
        return;
      }

      if (p.startsWith('/api/tasks/')) {
        const rest = p.slice('/api/tasks/'.length);
        const segments = rest.split('/');
        const runId = decodeURIComponent(segments[0] || '');
        const sub = segments[1];

        if (!runId) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }

        // GET /api/tasks/:runId
        if (!sub) {
          const meta = readTaskMeta(runId);
          if (!meta) {
            res.writeHead(404);
            res.end('Not found');
            return;
          }
          json(res, meta);
          return;
        }

        // GET /api/tasks/:runId/log — supports Range: bytes=N- for tail polling.
        // Brand-new tasks may not have created log.txt yet — return empty 200
        // rather than 404 so the panel UI's tail loop doesn't surface noise.
        if (sub === 'log') {
          const logPath = taskLogPath(runId);
          let content: Buffer;
          try {
            content = fs.readFileSync(logPath);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
              res.writeHead(200, {
                'Content-Type': 'text/plain; charset=utf-8',
                'Cache-Control': 'no-store',
              });
              res.end('');
              return;
            }
            throw err;
          }
          const total = content.length;
          const range = req.headers['range'];
          if (typeof range === 'string') {
            const m = range.match(/^bytes=(\d+)-$/);
            if (m) {
              const start = Math.min(parseInt(m[1], 10), total);
              const slice = content.subarray(start);
              res.writeHead(206, {
                'Content-Type': 'text/plain; charset=utf-8',
                'Cache-Control': 'no-store',
                'Content-Range': `bytes ${start}-${Math.max(total - 1, start)}/${total}`,
              });
              res.end(slice);
              return;
            }
          }
          res.writeHead(200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end(content);
          return;
        }

        // GET /api/tasks/:runId/events
        if (sub === 'events') {
          json(res, { events: readTaskEvents(runId) });
          return;
        }

        // POST /api/tasks/:runId/cancel — loopback only.
        // Sends SIGTERM to the recorded pid; the runner then writes a
        // `cancelled` event itself. This endpoint never mutates meta
        // directly to avoid racing the runner (see store.ts contract).
        if (sub === 'cancel' && req.method === 'POST') {
          if (!isLoopback(req)) {
            json(res, { error: 'forbidden' }, 403);
            return;
          }
          try {
            const meta = readTaskMeta(runId);
            if (!meta) {
              res.writeHead(404);
              res.end('Not found');
              return;
            }
            if (isTerminalTaskStatus(meta.status)) {
              json(res, { ok: false, reason: `already ${meta.status}` });
              return;
            }
            if (typeof meta.pid !== 'number') {
              json(res, { ok: false, reason: 'no pid recorded' });
              return;
            }
            try {
              process.kill(meta.pid, 'SIGTERM');
              json(res, { ok: true });
            } catch (err) {
              json(res, { ok: false, reason: (err as Error).message });
            }
          } catch (err) {
            json(res, { ok: false, reason: (err as Error).message });
          }
          return;
        }

        res.writeHead(404);
        res.end('Not found');
        return;
      }

      // 404
      res.writeHead(404);
      res.end('Not found');
    } catch (err) {
      json(res, { error: (err as Error).message }, 500);
    }
    } catch (err) {
      // Outer safety net — logs but never crashes the server
      try {
        if (!res.headersSent) json(res, { error: (err as Error).message }, 500);
        else res.end();
      } catch { /* socket already gone */ }
      console.error('[panel] request error:', (err as Error).message);
    }
  });

  // Swallow socket errors (client disconnects, etc.) so they don't crash the process.
  // ECONNRESET / EPIPE happen every time a browser tab closes an SSE stream — pure noise.
  server.on('clientError', (err: NodeJS.ErrnoException, socket) => {
    try { socket.destroy(); } catch { /* already closed */ }
    if (err.code === 'ECONNRESET' || err.code === 'EPIPE') return;
    if (process.env.FRANKLIN_PANEL_DEBUG) {
      console.error('[panel] client error:', err.message);
    }
  });

  // Watch stats file for changes → push to SSE clients.
  // getStatsFilePath() also handles the runcode-stats.json → franklin-stats.json
  // migration on first call, so users coming from the old binary keep their
  // history without an extra cleanup step.
  const statsFile = getStatsFilePath();
  if (fs.existsSync(statsFile)) {
    fs.watchFile(statsFile, { interval: 2000 }, () => {
      try {
        broadcast({ type: 'stats.updated' });
      } catch { /* ignore */ }
    });
  }

  return server;
}
