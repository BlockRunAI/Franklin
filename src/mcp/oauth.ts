/**
 * OAuth client provider for remote MCP servers.
 *
 * Implements the MCP SDK's `OAuthClientProvider` interface against Franklin's
 * own on-disk store at `~/.blockrun/mcp/oauth/<server>.json`. Each file holds
 * the registered client information + the current token set (access +
 * refresh + expiry). The SDK handles discovery, registration, PKCE, the
 * exchange, and refresh; we only persist + supply the saved state.
 *
 * Authorization flow (interactive):
 *   1. SDK calls `redirectToAuthorization(url)` — we spin up a localhost
 *      callback listener on the port encoded into `redirectUrl`, then
 *      open the user's browser to the authorization URL.
 *   2. User authorizes in browser. The provider returns `?code=...&state=...`
 *      to our callback. We resolve the code through a one-shot promise.
 *   3. SDK exchanges code → tokens, calls `saveTokens()` → we write to disk.
 *
 * Headless mode is not yet supported — if there is no TTY, the OAuth flow
 * raises a clear error directing the user to configure manually instead.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createServer } from 'node:http';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  OAuthClientProvider,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthTokens,
  OAuthClientMetadata,
  OAuthClientInformation,
  OAuthClientInformationFull,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { BLOCKRUN_DIR } from '../config.js';
import { logger } from '../logger.js';
import type { McpServerConfig } from './client.js';

const execAsync = promisify(exec);

const OAUTH_DIR = join(BLOCKRUN_DIR, 'mcp', 'oauth');

interface StoredOAuthState {
  clientInformation?: OAuthClientInformationFull;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  /** epoch ms when access_token expires (derived from expires_in + grant time). */
  expiresAt?: number;
}

function storePath(serverName: string): string {
  return join(OAUTH_DIR, `${serverName.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`);
}

function loadState(serverName: string): StoredOAuthState {
  const p = storePath(serverName);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as StoredOAuthState;
  } catch (err) {
    logger.warn(`[mcp:oauth:${serverName}] failed to read state — starting fresh: ${(err as Error).message}`);
    return {};
  }
}

function saveState(serverName: string, state: StoredOAuthState): void {
  const p = storePath(serverName);
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  writeFileSync(p, JSON.stringify(state, null, 2), { mode: 0o600 });
}

async function openBrowser(url: string): Promise<void> {
  // Prefer the platform native opener so unusual environments (corporate
  // wrappers, WSL, headless ssh-with-X-forward) still work when they have it.
  const cmd =
    process.platform === 'darwin' ? `open "${url}"` :
    process.platform === 'win32' ? `start "" "${url}"` :
    `xdg-open "${url}"`;
  try {
    await execAsync(cmd);
  } catch (err) {
    logger.warn(`[mcp:oauth] couldn't open browser automatically: ${(err as Error).message}`);
  }
}

/**
 * Bind a one-shot HTTP listener on the redirect URL's port and resolve when
 * the authorization-code callback arrives. Returns the parsed `code`.
 *
 * `expectedState` is the `state` value the SDK embedded in the authorization
 * URL. When present, the callback's `state` must match it — this is the OAuth
 * 2.0 CSRF defense (RFC 6749 §10.12): a forged callback that doesn't echo our
 * one-time state is rejected before the code is ever exchanged.
 */
function waitForCallback(
  redirectUrl: URL,
  expectedState?: string,
  timeoutMs = 5 * 60_000,
): Promise<{ code: string; state?: string }> {
  return new Promise((resolve, reject) => {
    const port = redirectUrl.port ? Number(redirectUrl.port) : 80;
    const expectedPath = redirectUrl.pathname || '/';
    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url || '/', `http://${req.headers.host}`);
        if (url.pathname !== expectedPath) {
          res.statusCode = 404;
          res.end('Not Found');
          return;
        }
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');
        const state = url.searchParams.get('state') || undefined;
        if (error) {
          res.statusCode = 400;
          res.end(`Authorization failed: ${error}`);
          server.close();
          reject(new Error(`OAuth callback returned error=${error}`));
          return;
        }
        if (expectedState !== undefined && state !== expectedState) {
          // CSRF guard: ignore (don't close) so the genuine callback can still
          // arrive; only the real redirect carries our one-time state.
          res.statusCode = 400;
          res.end('State mismatch');
          logger.warn('[mcp:oauth] rejected callback with mismatched state (possible CSRF)');
          return;
        }
        if (!code) {
          res.statusCode = 400;
          res.end('Missing code');
          return;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end('<html><body><h2>Authorization complete — you can close this tab.</h2></body></html>');
        server.close();
        resolve({ code, state });
      } catch (err) {
        res.statusCode = 500;
        res.end('Internal error');
        server.close();
        reject(err as Error);
      }
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1');
    setTimeout(() => {
      try { server.close(); } catch { /* ignore */ }
      reject(new Error(`OAuth callback timeout after ${(timeoutMs / 1000).toFixed(0)}s`));
    }, timeoutMs);
  });
}

export interface FranklinOAuthProvider {
  provider: OAuthClientProvider;
  /** Cheap signal for `/mcp` to show "authorized" without re-validating tokens. */
  isAuthorized(): boolean;
  /** Pending callback promise — populated when the SDK requests a redirect,
   *  awaited to get the code back. The caller (connectRemoteWithOAuth in
   *  client.ts) then calls `transport.finishAuth(code)` to complete the flow. */
  pendingCallback?: Promise<{ code: string; state?: string }>;
}

export async function createOAuthProvider(
  serverName: string,
  serverUrl: URL,
  config: McpServerConfig,
): Promise<FranklinOAuthProvider> {
  let state = loadState(serverName);
  const callbackPort = 33761; // Fixed local port for Franklin's MCP OAuth callback.
  const redirectUrl = `http://127.0.0.1:${callbackPort}/oauth/callback`;

  const oauthOpts = typeof config.oauth === 'object' ? config.oauth : {};

  const handle: FranklinOAuthProvider = {
    isAuthorized: () => !!state.tokens?.access_token,
    provider: {} as OAuthClientProvider,
  };

  const provider: OAuthClientProvider = {
    get redirectUrl() { return redirectUrl; },
    get clientMetadata(): OAuthClientMetadata {
      return {
        client_name: oauthOpts.clientName || `Franklin (${serverName})`,
        redirect_uris: [redirectUrl],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: oauthOpts.scopes?.join(' '),
      };
    },
    clientInformation(): OAuthClientInformation | undefined {
      return state.clientInformation;
    },
    saveClientInformation(info: OAuthClientInformationFull): void {
      state = { ...state, clientInformation: info };
      saveState(serverName, state);
    },
    tokens(): OAuthTokens | undefined {
      return state.tokens;
    },
    saveTokens(tokens: OAuthTokens): void {
      const expiresAt =
        typeof tokens.expires_in === 'number' && tokens.expires_in > 0
          ? Date.now() + tokens.expires_in * 1000
          : undefined;
      state = { ...state, tokens, expiresAt };
      saveState(serverName, state);
      logger.debug(`[mcp:oauth:${serverName}] tokens saved (expires in ${tokens.expires_in ?? 'n/a'}s)`);
    },
    saveCodeVerifier(codeVerifier: string): void {
      state = { ...state, codeVerifier };
      saveState(serverName, state);
    },
    codeVerifier(): string {
      if (!state.codeVerifier) {
        throw new Error('OAuth code verifier missing — authorization not yet started');
      }
      return state.codeVerifier;
    },
    redirectToAuthorization(authorizationUrl: URL): void {
      // Best-effort: start the callback listener, log + open browser. The SDK
      // expects this to be fire-and-forget; the caller awaits `finishAuth`
      // (which we expose via `handle.pendingCallback`) to actually finish.
      logger.info(`[mcp:oauth:${serverName}] authorization required — opening browser to ${authorizationUrl.host}`);
      console.error(`\n[Franklin MCP] '${serverName}' needs authorization. Opening browser to:\n  ${authorizationUrl.toString()}\nIf the browser does not open, copy the URL manually.\n`);
      const expectedState = authorizationUrl.searchParams.get('state') ?? undefined;
      handle.pendingCallback = waitForCallback(new URL(redirectUrl), expectedState);
      void openBrowser(authorizationUrl.toString());
    },
  };

  handle.provider = provider;
  void serverUrl; // silence unused (kept for future per-server policy)
  return handle;
}

/**
 * Standalone helper to drive an OAuth login outside the transport's normal
 * flow — used by `franklin mcp login <name>` to refresh tokens before any
 * connect attempt. Not wired by default; provided for the command layer.
 */
export async function loginToMcpServer(_serverName: string, _config: McpServerConfig): Promise<void> {
  // Implementation deferred to a follow-up — the transport's lazy OAuth flow
  // already covers the first-time login path when the user runs `franklin
  // start`. This stub exists so the CLI command surface is stable.
  throw new Error('`franklin mcp login` not implemented — start a session and trigger the OAuth flow there for now.');
}
