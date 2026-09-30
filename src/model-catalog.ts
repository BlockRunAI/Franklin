/** Shared model facts and policy; payment credentials stay in Franklin. */
import { createCatalogClient, type CatalogState, type Network } from '@blockrun/model-catalog';
import { API_URLS, loadChain } from './config.js';
import { gatewayHeaders, resolvePayMode } from './payments/auth-mode.js';

const clients = new Map<string, ReturnType<typeof createCatalogClient>>();
const bundled = new Map<Network, CatalogState>();
function bundledState(): CatalogState {
  const network = sessionNetwork ?? loadChain();
  let state = bundled.get(network);
  if (!state) { state = createCatalogClient({ network }).current(); bundled.set(network, state); }
  return state;
}
const listeners = new Set<(state: CatalogState) => void>();
let sessionNetwork: Network | undefined;
function activeClient() {
  const mode = resolvePayMode();
  const network = sessionNetwork ?? loadChain();
  const gatewayUrl = `${mode.kind === 'key' ? mode.apiBase : API_URLS[network]}/v1/models?format=json`;
  const catalogUrl = process.env.BLOCKRUN_MODEL_CATALOG_URL;
  // Separate caches for each chain, endpoint and API account; keys never leave memory.
  const identity = JSON.stringify([network, gatewayUrl, catalogUrl, mode.kind === 'key' ? mode.key : '']);
  let client = clients.get(identity);
  if (!client) {
    const headers = gatewayHeaders(mode);
    client = createCatalogClient({
      network, gatewayUrl, catalogUrl,
      fetch: (url, init) => globalThis.fetch(url, {
        ...init,
        // A separately hosted public snapshot must never receive the API key.
        headers: String(url) === gatewayUrl ? { ...init?.headers, ...headers } : init?.headers,
      }),
    });
    clients.set(identity, client);
  }
  return { identity, client };
}
export function getModelCatalogIdentity(): string {
  try { return activeClient().identity; } catch { return `unconfigured:${sessionNetwork ?? loadChain()}`; }
}
export function getModelCatalog(): CatalogState {
  // Metadata imports precede CLI flag parsing. An invalid saved key must not
  // prevent --help or --wallet from running; request-time refresh still validates auth.
  try { return activeClient().client.current(); } catch { return bundledState(); }
}
export function onModelCatalogChange(listener: (state: CatalogState) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export async function refreshModelCatalog(options: { network?: Network; force?: boolean } = {}): Promise<CatalogState> {
  if (options.network) sessionNetwork = options.network;
  const { identity, client } = activeClient();
  const state = process.env.FRANKLIN_CATALOG_OFFLINE === '1'
    ? client.current() : await client.refresh({ force: options.force });
  if (identity === activeClient().identity) for (const listener of listeners) listener(state);
  return state;
}
export function clearModelCatalogCache(): void {
  clients.clear();
  sessionNetwork = undefined;
}
