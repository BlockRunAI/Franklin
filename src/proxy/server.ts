import http from 'node:http';
import {
  getOrCreateWallet,
  createPaymentPayload,
  parsePaymentRequired,
  extractPaymentDetails,
} from '@blockrun/llm';

export interface ProxyOptions {
  port: number;
  apiUrl: string;
}

export function createProxy(options: ProxyOptions): http.Server {
  const wallet = getOrCreateWallet();
  const privateKey = wallet.privateKey as `0x${string}`;
  const fromAddress = wallet.address;

  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    const path = req.url?.replace(/^\/api/, '') || '';
    const targetUrl = `${options.apiUrl}${path}`;
    let body = '';

    req.on('data', (chunk: Buffer) => {
      body += chunk;
    });

    req.on('end', async () => {
      try {
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
          response = await handlePayment(
            response,
            targetUrl,
            req.method || 'POST',
            headers,
            body,
            privateKey,
            fromAddress
          );
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

async function handlePayment(
  response: Response,
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string,
  privateKey: `0x${string}`,
  fromAddress: string
): Promise<Response> {
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
