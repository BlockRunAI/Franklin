/**
 * Franklin Panel — local HTTP server.
 * Serves the dashboard HTML + JSON API endpoints + SSE for real-time updates.
 * Zero external dependencies — uses node:http only.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { BLOCKRUN_DIR, loadChain } from '../config.js';
import { loadStats, getStatsSummary } from '../stats/tracker.js';
import { generateInsights } from '../stats/insights.js';
import { listSessions, loadSessionHistory } from '../session/storage.js';
import { searchSessions } from '../session/search.js';
import { loadLearnings } from '../learnings/store.js';
import { getStats as getSocialStats } from '../social/db.js';
import { getHTML } from './html.js';

const sseClients = new Set<http.ServerResponse>();

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

function broadcast(data: unknown): void {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(msg); } catch { sseClients.delete(client); }
  }
}

export function createPanelServer(port: number): http.Server {
  const html = getHTML();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`);
    const p = url.pathname;

    // ─── HTML ──
    if (p === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
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

      if (p === '/api/social') {
        const stats = getSocialStats();
        json(res, stats);
        return;
      }

      if (p === '/api/learnings') {
        const learnings = loadLearnings();
        json(res, learnings);
        return;
      }

      // 404
      res.writeHead(404);
      res.end('Not found');
    } catch (err) {
      json(res, { error: (err as Error).message }, 500);
    }
  });

  // Watch stats file for changes → push to SSE clients
  const statsFile = path.join(BLOCKRUN_DIR, 'runcode-stats.json');
  if (fs.existsSync(statsFile)) {
    fs.watchFile(statsFile, { interval: 2000 }, () => {
      try {
        broadcast({ type: 'stats.updated' });
      } catch { /* ignore */ }
    });
  }

  return server;
}
