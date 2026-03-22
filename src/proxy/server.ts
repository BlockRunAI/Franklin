import http from 'node:http';
import { Keypair } from '@solana/web3.js';
import { X402Client } from 'x402-solana';
import { createWalletAdapter } from '../wallet/manager.js';
import { SOLANA_RPC_URL } from '../config.js';

export interface ProxyOptions {
  port: number;
  keypair: Keypair;
  apiUrl: string;
}

export function createProxy(options: ProxyOptions): http.Server {
  const wallet = createWalletAdapter(options.keypair);
  const client = new X402Client({
    wallet,
    network: 'solana',
    rpcUrl: SOLANA_RPC_URL,
  });

  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    const targetUrl = `${options.apiUrl}${req.url}`;
    let body = '';

    req.on('data', (chunk: Buffer) => {
      body += chunk;
    });

    req.on('end', async () => {
      try {
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(req.headers)) {
          if (
            key.toLowerCase() !== 'host' &&
            key.toLowerCase() !== 'content-length' &&
            value
          ) {
            headers[key] = Array.isArray(value) ? value[0] : value;
          }
        }

        const response = await client.fetch(targetUrl, {
          method: req.method || 'POST',
          headers,
          body: body || undefined,
        });

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
