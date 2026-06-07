/**
 * Cloud sync for desktop chat history — the local agent acts as the bridge.
 *
 * Identity is the local Base wallet (~/.blockrun). We run the SAME SIWE flow a
 * browser does against franklin.run (/api/try/auth/nonce → sign → verify), hold
 * the session, and proxy conversation load/save/delete to the existing
 * /api/try/conversations API (GCS-backed, per-wallet). So the desktop and the
 * web share one history keyed by wallet — and the web server needs no changes.
 *
 * Everything is best-effort: callers fall back to the local file on any failure
 * (offline, not-deployed, auth hiccup), so cloud sync never breaks local use.
 */

import { getOrCreateWallet } from '@blockrun/llm';
import { privateKeyToAccount } from 'viem/accounts';

const CLOUD_BASE = process.env.FRANKLIN_CLOUD_URL || 'https://franklin.run';
const NONCE_COOKIE = 'franklin_try_nonce';
const SESSION_COOKIE = 'franklin_try_session';
const TIMEOUT = 8000;

export interface CloudConversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: unknown[];
}

export function isCloudSyncEnabled(): boolean {
  return process.env.FRANKLIN_CLOUD_SYNC !== 'off';
}

let sessionCookie: string | null = null;
// Track what we've pushed so save only sends changed/removed conversations.
let lastSynced = new Map<string, number>();

function getSetCookie(res: Response, name: string): string | null {
  const list = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  for (const c of list) if (c.startsWith(name + '=')) return c.split(';')[0];
  return null;
}

async function login(): Promise<void> {
  const nonceRes = await fetch(`${CLOUD_BASE}/api/try/auth/nonce`, { signal: AbortSignal.timeout(TIMEOUT) });
  if (!nonceRes.ok) throw new Error(`nonce ${nonceRes.status}`);
  const nonceCookie = getSetCookie(nonceRes, NONCE_COOKIE);
  const { nonce } = (await nonceRes.json()) as { nonce?: string };
  if (!nonce || !nonceCookie) throw new Error('no nonce');

  const { privateKey, address } = getOrCreateWallet();
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const message = `Sign in to Franklin Desktop\n\nNonce: ${nonce}`;
  const signature = await account.signMessage({ message });

  const verifyRes = await fetch(`${CLOUD_BASE}/api/try/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: nonceCookie },
    body: JSON.stringify({ address, message, signature }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!verifyRes.ok) throw new Error(`verify ${verifyRes.status}`);
  const session = getSetCookie(verifyRes, SESSION_COOKIE);
  if (!session) throw new Error('no session cookie');
  sessionCookie = session;
}

async function authed(path: string, init: RequestInit = {}): Promise<Response> {
  if (!sessionCookie) await login();
  const doFetch = () => fetch(`${CLOUD_BASE}${path}`, {
    ...init,
    headers: { ...(init.headers || {}), Cookie: sessionCookie! },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  let res = await doFetch();
  if (res.status === 401) { sessionCookie = null; await login(); res = await doFetch(); }
  return res;
}

export async function cloudList(): Promise<CloudConversation[]> {
  const res = await authed('/api/try/conversations');
  if (!res.ok) throw new Error(`list ${res.status}`);
  const j = (await res.json()) as { conversations?: CloudConversation[] };
  const convos = Array.isArray(j.conversations) ? j.conversations : [];
  lastSynced = new Map(convos.map((c) => [c.id, c.updatedAt]));
  return convos;
}

async function cloudPut(c: CloudConversation): Promise<void> {
  const res = await authed(`/api/try/conversations/${encodeURIComponent(c.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(c),
  });
  if (!res.ok) throw new Error(`put ${res.status}`);
}

async function cloudDelete(id: string): Promise<void> {
  try { await authed(`/api/try/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' }); } catch { /* ignore */ }
}

/** Reconcile cloud to match the given local list: upsert changed, delete removed. */
export async function cloudSync(conversations: CloudConversation[]): Promise<void> {
  const current = new Map(conversations.map((c) => [c.id, c.updatedAt]));
  for (const c of conversations) {
    if (lastSynced.get(c.id) !== c.updatedAt) await cloudPut(c);
  }
  for (const id of [...lastSynced.keys()]) {
    if (!current.has(id)) await cloudDelete(id);
  }
  lastSynced = current;
}
