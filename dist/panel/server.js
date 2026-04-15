/**
 * Franklin Panel — local HTTP server.
 * Serves the dashboard HTML + JSON API endpoints + SSE for real-time updates.
 * Zero external dependencies — uses node:http only.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { BLOCKRUN_DIR, loadChain } from '../config.js';
import { getStatsSummary } from '../stats/tracker.js';
import { generateInsights } from '../stats/insights.js';
import { listSessions, loadSessionHistory } from '../session/storage.js';
import { searchSessions } from '../session/search.js';
import { loadLearnings } from '../learnings/store.js';
import { getStats as getSocialStats } from '../social/db.js';
import { getHTML } from './html.js';
const sseClients = new Set();
function json(res, data, status = 200) {
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
function isLoopback(req) {
    const addr = req.socket.remoteAddress || '';
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}
async function readBody(req, maxBytes = 16 * 1024) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > maxBytes) {
                reject(new Error('Request body too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        req.on('error', reject);
    });
}
function broadcast(data) {
    const msg = `data: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
        try {
            client.write(msg);
        }
        catch {
            sseClients.delete(client);
        }
    }
}
export function createPanelServer(port) {
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
                }
                catch {
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
                        }
                        else {
                            const { setupAgentWallet } = await import('@blockrun/llm');
                            const client = setupAgentWallet({ silent: true });
                            address = client.getWalletAddress();
                            balance = await client.getBalance();
                        }
                        json(res, { address, balance, chain });
                    }
                    catch {
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
                    }
                    catch (err) {
                        json(res, { error: err.message }, 500);
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
                        const { loadWallet, loadSolanaWallet, WALLET_FILE_PATH, SOLANA_WALLET_FILE_PATH } = await import('@blockrun/llm');
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
                    }
                    catch (err) {
                        json(res, { error: err.message }, 500);
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
                        const body = JSON.parse(raw);
                        const pk = (body.privateKey || '').trim();
                        if (!pk) {
                            json(res, { error: 'privateKey required' }, 400);
                            return;
                        }
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
                        }
                        else {
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
                    }
                    catch (err) {
                        json(res, { error: err.message }, 500);
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
            }
            catch (err) {
                json(res, { error: err.message }, 500);
            }
        }
        catch (err) {
            // Outer safety net — logs but never crashes the server
            try {
                if (!res.headersSent)
                    json(res, { error: err.message }, 500);
                else
                    res.end();
            }
            catch { /* socket already gone */ }
            console.error('[panel] request error:', err.message);
        }
    });
    // Swallow socket errors (client disconnects, etc.) so they don't crash the process
    server.on('clientError', (err, socket) => {
        try {
            socket.destroy();
        }
        catch { /* already closed */ }
        console.error('[panel] client error:', err.message);
    });
    // Watch stats file for changes → push to SSE clients
    const statsFile = fs.existsSync(path.join(BLOCKRUN_DIR, 'franklin-stats.json'))
        ? path.join(BLOCKRUN_DIR, 'franklin-stats.json')
        : path.join(BLOCKRUN_DIR, 'runcode-stats.json');
    if (fs.existsSync(statsFile)) {
        fs.watchFile(statsFile, { interval: 2000 }, () => {
            try {
                broadcast({ type: 'stats.updated' });
            }
            catch { /* ignore */ }
        });
    }
    return server;
}
