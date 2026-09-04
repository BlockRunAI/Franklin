/** Shared account authentication for Franklin's direct gateway requests. */
export const ACCOUNT_PORTAL = 'https://user.blockrun.ai';
export function accountMode(): boolean { return process.env.BLOCKRUN_API_KEY !== undefined; }
export function accountBaseURL(): string {
  const raw = (process.env.BLOCKRUN_API_BASE_URL || 'https://api.blockrun.ai').replace(/\/+$/, '').replace(/\/v1$/, '');
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('BLOCKRUN_API_BASE_URL requires HTTPS (except localhost) and no credentials, query or fragment.');
  }
  return raw;
}
export function accountStatus() {
  return { authMode: 'api-key', address: '', chain: 'account', balance: null, balanceUsd: undefined, portalUrl: ACCOUNT_PORTAL, creditsUrl: `${ACCOUNT_PORTAL}/dashboard/credits` };
}

function key(): string {
  const value = process.env.BLOCKRUN_API_KEY?.trim() || '';
  if (!/^brk_[A-Za-z0-9_-]+$/.test(value)) throw new Error(`Invalid BLOCKRUN_API_KEY. Create a key at ${ACCOUNT_PORTAL}/dashboard/keys.`);
  return value;
}
export function validateAccountConfig(): void { if (accountMode()) { key(); accountBaseURL(); } }

function accountRequestURL(input: string | URL | Request): URL {
  const base = new URL(accountBaseURL());
  const source = new URL(input instanceof Request ? input.url : String(input), `${base}/`);
  const gateways = new Set(['https://blockrun.ai', 'https://sol.blockrun.ai', 'https://api.blockrun.ai', base.origin]);
  if (!gateways.has(source.origin) || source.username || source.password) throw new Error('Refusing to forward an account key to an unknown gateway or polling origin.');
  source.protocol = base.protocol; source.host = base.host;
  source.pathname = source.pathname.replace(/^\/api\/v1\//, '/v1/');
  return source;
}

// Caller receives the actual HTTP status, so existing stream parsers and proxy
// clients keep their error semantics. No x402 branch may run in account mode.
export async function gatewayFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  if (!accountMode()) return globalThis.fetch(input, init);
  const credential = key();
  const url = accountRequestURL(input);
  const request = input instanceof Request ? input : undefined;
  const headers = new Headers(init?.headers ?? request?.headers);
  for (const name of [...headers.keys()]) if (/payment/i.test(name) || /^(x-api-key|authorization)$/i.test(name)) headers.delete(name);
  headers.set('authorization', `Bearer ${credential}`);
  const response = await globalThis.fetch(request ? new Request(url, request) : url, { ...init, headers, redirect: 'error' });
  if (response.ok) return response;
  let body: unknown;
  try { body = await response.json(); } catch { body = {}; }
  const outer = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const detail = outer.error && typeof outer.error === 'object' ? outer.error as Record<string, unknown> : outer;
  const safe = Object.fromEntries(['message', 'code', 'type', 'param'].flatMap(name => typeof detail[name] === 'string' ? [[name, (detail[name] as string).split(credential).join('[REDACTED]')]] : []));
  if (response.status === 402) safe.message = `BlockRun account credits exhausted (402). Top up at ${ACCOUNT_PORTAL}/dashboard/credits.`;
  if (response.status === 401) safe.message = `BlockRun account authentication failed (401). Check your key at ${ACCOUNT_PORTAL}/dashboard/keys.`;
  const safeHeaders = new Headers({ 'content-type': 'application/json' });
  const retryAfter = response.headers.get('retry-after'); if (retryAfter) safeHeaders.set('retry-after', retryAfter);
  return new Response(JSON.stringify({ error: safe }), { status: response.status, headers: safeHeaders });
}

/** Poll direct API jobs with an abortable deadline; never resubmit a job. */
export async function pollAccountJob(response: Response, signal?: AbortSignal, intervalMs = 2000): Promise<Response> {
  if (!accountMode() || response.status !== 202) return response;
  const initial = await response.clone().json() as { poll_url?: string };
  if (!initial.poll_url) throw new Error('Account async response missing poll_url');
  const endpoint = accountRequestURL(initial.poll_url);
  const deadline = AbortSignal.timeout(15 * 60_000);
  const abort = signal ? AbortSignal.any([signal, deadline]) : deadline;
  while (!abort.aborted) {
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => { clearTimeout(timer); reject(abort.reason); };
      const timer = setTimeout(() => { abort.removeEventListener('abort', onAbort); resolve(); }, intervalMs);
      abort.addEventListener('abort', onAbort, { once: true });
      if (abort.aborted) onAbort();
    });
    const polled = await gatewayFetch(endpoint, { signal: abort });
    if (!polled.ok) return polled;
    const data = await polled.clone().json() as { status?: string };
    if (data.status === 'completed') return polled;
    if (['failed', 'cancelled', 'canceled'].includes(data.status || '')) throw new Error('Account job failed or was cancelled');
  }
  throw new Error('Account job polling stopped; check job before resubmitting');
}
