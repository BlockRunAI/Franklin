import http from 'node:http';
import {
  getOrCreateWallet,
  getOrCreateSolanaWallet,
  createPaymentPayload,
  createSolanaPaymentPayload,
  parsePaymentRequired,
  extractPaymentDetails,
  solanaKeyToBytes,
  SOLANA_NETWORK,
} from '@blockrun/llm';
import type { Chain } from '../config.js';

export interface ProxyOptions {
  port: number;
  apiUrl: string;
  chain?: Chain;
  modelOverride?: string;
}

export function createProxy(options: ProxyOptions): http.Server {
  const chain = options.chain || 'base';

  let baseWallet: { privateKey: string; address: string } | null = null;
  let solanaWallet: { privateKey: string; address: string } | null = null;

  if (chain === 'base') {
    const w = getOrCreateWallet();
    baseWallet = { privateKey: w.privateKey, address: w.address };
  }

  const initSolana = async () => {
    if (chain === 'solana' && !solanaWallet) {
      const w = await getOrCreateSolanaWallet();
      solanaWallet = { privateKey: w.privateKey, address: w.address };
    }
  };

  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    await initSolana();

    const path = req.url?.replace(/^\/api/, '') || '';
    const targetUrl = `${options.apiUrl}${path}`;
    let body = '';

    req.on('data', (chunk: Buffer) => {
      body += chunk;
    });

    req.on('end', async () => {
      try {
        if (options.modelOverride && body) {
          try {
            const parsed = JSON.parse(body);
            if (parsed.model) {
              parsed.model = options.modelOverride;
              body = JSON.stringify(parsed);
            }
          } catch { /* not JSON, pass through */ }
        }

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        for (const [key, value] of Object.entries(req.headers)) {
          if (
            key.toLowerCase() !== 'host' &&
            key.toLowerCase() !== 'content-length' &&
            value
          ) {
            headers[key] = Array.isArray(value) ? value[0] : value;
          }
        }

        let response = await fetch(targetUrl, {
          method: req.method || 'POST',
          headers,
          body: body || undefined,
        });

        if (response.status === 402) {
          if (chain === 'solana' && solanaWallet) {
            response = await handleSolanaPayment(
              response,
              targetUrl,
              req.method || 'POST',
              headers,
              body,
              solanaWallet.privateKey,
              solanaWallet.address
            );
          } else if (baseWallet) {
            response = await handleBasePayment(
              response,
              targetUrl,
              req.method || 'POST',
              headers,
              body,
              baseWallet.privateKey as `0x${string}`,
              baseWallet.address
            );
          }
        }

        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((v, k) => {
          responseHeaders[k] = v;
        });
        res.writeHead(response.status, responseHeaders);

        if (response.body) {
          const reader = response.body.getReader();
          const pump = async () => {
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                res.end();
                break;
              }
              res.write(value);
            }
          };
          pump().catch(() => res.end());
        } else {
          res.end(await response.text());
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Proxy error';
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            type: 'error',
            error: { type: 'api_error', message: msg },
          })
        );
      }
    });
  });

  return server;
}

// ======================================================================
// Base (EIP-712) payment handler
// ======================================================================

async function handleBasePayment(
  response: Response,
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string,
  privateKey: `0x${string}`,
  fromAddress: string
): Promise<Response> {
  const paymentHeader = await extractPaymentHeader(response);
  if (!paymentHeader) {
    throw new Error('402 response but no payment requirements found');
  }

  const paymentRequired = parsePaymentRequired(paymentHeader);
  const details = extractPaymentDetails(paymentRequired);

  const paymentPayload = await createPaymentPayload(
    privateKey,
    fromAddress,
    details.recipient,
    details.amount,
    details.network || 'eip155:8453',
    {
      resourceUrl: details.resource?.url || url,
      resourceDescription:
        details.resource?.description || 'BlockRun AI API call',
      maxTimeoutSeconds: details.maxTimeoutSeconds || 300,
      extra: details.extra,
    }
  );

  return fetch(url, {
    method,
    headers: {
      ...headers,
      'PAYMENT-SIGNATURE': paymentPayload,
    },
    body: body || undefined,
  });
}

// ======================================================================
// Solana payment handler
// ======================================================================

async function handleSolanaPayment(
  response: Response,
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string,
  privateKey: string,
  fromAddress: string
): Promise<Response> {
  const paymentHeader = await extractPaymentHeader(response);
  if (!paymentHeader) {
    throw new Error('402 response but no payment requirements found');
  }

  const paymentRequired = parsePaymentRequired(paymentHeader);
  const details = extractPaymentDetails(paymentRequired, SOLANA_NETWORK);

  const secretKey = await solanaKeyToBytes(privateKey);

  const feePayer = details.extra?.feePayer || details.recipient;

  const paymentPayload = await createSolanaPaymentPayload(
    secretKey,
    fromAddress,
    details.recipient,
    details.amount,
    feePayer,
    {
      resourceUrl: details.resource?.url || url,
      resourceDescription:
        details.resource?.description || 'BlockRun AI API call',
      maxTimeoutSeconds: details.maxTimeoutSeconds || 300,
      extra: details.extra as Record<string, unknown> | undefined,
    }
  );

  return fetch(url, {
    method,
    headers: {
      ...headers,
      'PAYMENT-SIGNATURE': paymentPayload,
    },
    body: body || undefined,
  });
}

// ======================================================================
// Shared helpers
// ======================================================================

async function extractPaymentHeader(
  response: Response
): Promise<string | null> {
  let paymentHeader = response.headers.get('payment-required');

  if (!paymentHeader) {
    try {
      const respBody = (await response.json()) as Record<string, unknown>;
      if (respBody.x402 || respBody.accepts) {
        paymentHeader = btoa(JSON.stringify(respBody));
      }
    } catch {
      // ignore parse errors
    }
  }

  return paymentHeader;
}
