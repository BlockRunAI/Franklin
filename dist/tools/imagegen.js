/**
 * Image Generation capability — generate images via BlockRun API.
 * Uses x402 payment on Solana or Base.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getOrCreateWallet, getOrCreateSolanaWallet, createPaymentPayload, createSolanaPaymentPayload, parsePaymentRequired, extractPaymentDetails, solanaKeyToBytes, SOLANA_NETWORK, } from '@blockrun/llm';
import { loadChain, API_URLS, VERSION } from '../config.js';
async function execute(input, ctx) {
    const { prompt, output_path, size, model } = input;
    if (!prompt) {
        return { output: 'Error: prompt is required', isError: true };
    }
    const chain = loadChain();
    const apiUrl = API_URLS[chain];
    const endpoint = `${apiUrl}/v1/images/generations`;
    const imageModel = model || 'dall-e-3';
    const imageSize = size || '1024x1024';
    // Default output path
    const outPath = output_path
        ? (path.isAbsolute(output_path) ? output_path : path.resolve(ctx.workingDir, output_path))
        : path.resolve(ctx.workingDir, `generated-${Date.now()}.png`);
    const body = JSON.stringify({
        model: imageModel,
        prompt,
        n: 1,
        size: imageSize,
        response_format: 'b64_json',
    });
    const headers = {
        'Content-Type': 'application/json',
        'User-Agent': `runcode/${VERSION}`,
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000); // 60s timeout
    try {
        // First request — will get 402
        let response = await fetch(endpoint, {
            method: 'POST',
            signal: controller.signal,
            headers,
            body,
        });
        // Handle x402 payment
        if (response.status === 402) {
            const paymentHeaders = await signPayment(response, chain, endpoint);
            if (!paymentHeaders) {
                return { output: 'Payment failed. Check wallet balance with: runcode balance', isError: true };
            }
            response = await fetch(endpoint, {
                method: 'POST',
                signal: controller.signal,
                headers: { ...headers, ...paymentHeaders },
                body,
            });
        }
        if (!response.ok) {
            const errText = await response.text().catch(() => '');
            return { output: `Image generation failed (${response.status}): ${errText.slice(0, 200)}`, isError: true };
        }
        const result = await response.json();
        const imageData = result.data?.[0];
        if (!imageData) {
            return { output: 'No image data returned from API', isError: true };
        }
        // Save image
        if (imageData.b64_json) {
            const buffer = Buffer.from(imageData.b64_json, 'base64');
            fs.mkdirSync(path.dirname(outPath), { recursive: true });
            fs.writeFileSync(outPath, buffer);
        }
        else if (imageData.url) {
            // Download from URL
            const imgResp = await fetch(imageData.url);
            const buffer = Buffer.from(await imgResp.arrayBuffer());
            fs.mkdirSync(path.dirname(outPath), { recursive: true });
            fs.writeFileSync(outPath, buffer);
        }
        else {
            return { output: 'No image data (b64_json or url) in response', isError: true };
        }
        const fileSize = fs.statSync(outPath).size;
        const sizeKB = (fileSize / 1024).toFixed(1);
        const revisedPrompt = imageData.revised_prompt ? `\nRevised prompt: ${imageData.revised_prompt}` : '';
        return {
            output: `Image saved to ${outPath} (${sizeKB}KB, ${imageSize})${revisedPrompt}\n\nOpen with: open ${outPath}`,
        };
    }
    catch (err) {
        const msg = err.message || '';
        if (msg.includes('abort')) {
            return { output: 'Image generation timed out (60s limit). Try a simpler prompt.', isError: true };
        }
        return { output: `Error: ${msg}`, isError: true };
    }
    finally {
        clearTimeout(timeout);
    }
}
// ─── Payment ───────────────────────────────────────────────────────────────
async function signPayment(response, chain, endpoint) {
    try {
        const paymentHeader = await extractPaymentReq(response);
        if (!paymentHeader)
            return null;
        if (chain === 'solana') {
            const wallet = await getOrCreateSolanaWallet();
            const paymentRequired = parsePaymentRequired(paymentHeader);
            const details = extractPaymentDetails(paymentRequired, SOLANA_NETWORK);
            const secretBytes = await solanaKeyToBytes(wallet.privateKey);
            const feePayer = details.extra?.feePayer || details.recipient;
            const payload = await createSolanaPaymentPayload(secretBytes, wallet.address, details.recipient, details.amount, feePayer, {
                resourceUrl: details.resource?.url || endpoint,
                resourceDescription: details.resource?.description || 'RunCode image generation',
                maxTimeoutSeconds: details.maxTimeoutSeconds || 300,
                extra: details.extra,
            });
            return { 'PAYMENT-SIGNATURE': payload };
        }
        else {
            const wallet = getOrCreateWallet();
            const paymentRequired = parsePaymentRequired(paymentHeader);
            const details = extractPaymentDetails(paymentRequired);
            const payload = await createPaymentPayload(wallet.privateKey, wallet.address, details.recipient, details.amount, details.network || 'eip155:8453', {
                resourceUrl: details.resource?.url || endpoint,
                resourceDescription: details.resource?.description || 'RunCode image generation',
                maxTimeoutSeconds: details.maxTimeoutSeconds || 300,
                extra: details.extra,
            });
            return { 'PAYMENT-SIGNATURE': payload };
        }
    }
    catch (err) {
        console.error(`[runcode] Image payment error: ${err.message}`);
        return null;
    }
}
async function extractPaymentReq(response) {
    let header = response.headers.get('payment-required');
    if (!header) {
        try {
            const body = (await response.json());
            if (body.x402 || body.accepts) {
                header = btoa(JSON.stringify(body));
            }
        }
        catch { /* ignore */ }
    }
    return header;
}
// ─── Export ────────────────────────────────────────────────────────────────
export const imageGenCapability = {
    spec: {
        name: 'ImageGen',
        description: 'Generate an image from a text prompt using AI (DALL-E, etc). Saves the image to a file.',
        input_schema: {
            type: 'object',
            properties: {
                prompt: { type: 'string', description: 'Text description of the image to generate' },
                output_path: { type: 'string', description: 'Where to save the image. Default: generated-<timestamp>.png in working directory' },
                size: { type: 'string', description: 'Image size: 1024x1024, 1792x1024, or 1024x1792. Default: 1024x1024' },
                model: { type: 'string', description: 'Image model to use. Default: dall-e-3' },
            },
            required: ['prompt'],
        },
    },
    execute,
    concurrent: false,
};
