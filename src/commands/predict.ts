/**
 * `franklin predict` — Franklin prediction mode (headless).
 *
 * Runs ONE model as a disciplined forecaster: it researches a single real-world
 * event with a tight, read-only toolset (web search, source fetch, Exa, X, live
 * prediction markets, a little market data) the way a bettor would before
 * putting money down — then commits to a pick with a confidence.
 *
 * Designed for machine callers (e.g. BlockRun Oracle): with --json it emits a
 * single JSON envelope on stdout containing the model's final answer, the full
 * tool-call trace (what it searched and what it found), the terminal reason and
 * token usage. Human-readable streaming otherwise.
 *
 *   franklin predict --model anthropic/claude-opus-4.8 \
 *     --question "Who wins the 2026 FIFA World Cup? Pick one country." --json
 */
import { interactiveSession } from '../agent/loop.js';
import type { AgentConfig, StreamEvent, StreamTurnDone } from '../agent/types.js';
import { predictionCapabilities, resetToolSessionState } from '../tools/index.js';
import { loadChain, API_URLS } from '../config.js';
import { resolveModel } from '../ui/model-picker.js';

export interface PredictOptions {
  model?: string;
  question?: string;
  maxTurns?: string;
  maxToolCalls?: string;
  maxSpend?: string;
  json?: boolean;
  debug?: boolean;
}

const PREDICTION_SYSTEM: string[] = [
  'You are a sharp, disciplined forecasting analyst — think like a professional who is about to put real money on this question.',
  'Your job: predict the outcome of ONE real-world event. Before answering you MUST do research the way a bettor would:',
  "1. Use web_search (and webfetch / exa tools) for the most CURRENT facts and news — today's real-world state matters far more than your training data.",
  '2. Use search_prediction_markets to read the CURRENT market-implied odds (Polymarket, Kalshi, etc.) for this or a closely related question.',
  '3. Weigh it: where is the consensus, where might the market be mispriced, what is your edge.',
  'Budget your research: make AT MOST 4-5 focused tool calls in total. As soon as you have enough to decide, STOP calling tools and output the JSON. Do not keep researching — an answer with light research beats no answer.',
  'Your FINAL message must end with EXACTLY ONE single-line minified JSON object and NOTHING after it:',
  '{"pick": string, "confidence": number, "rationale": string, "analysis": string, "marketOdds": string}',
  '- pick: one option from the question (a short label, e.g. a country, party, bucket, or Yes/No).',
  '- confidence: your probability (0-1) that THIS pick is correct.',
  '- rationale: one sharp sentence (max 22 words).',
  '- analysis: 3-5 sentences citing what your research found, the strongest counter-argument, and why you still land here. No literal newlines inside the string.',
  "- marketOdds: what the prediction market currently implies (e.g. 'Polymarket: France 18%'), or 'n/a' if none found.",
  'Be decisive. Do not hedge with "it depends".',
];

interface TraceEntry {
  tool: string;
  input: string;
  output: string;
  isError?: boolean;
}

export async function predictCommand(options: PredictOptions): Promise<void> {
  const question = options.question?.trim();
  if (!question) {
    process.stderr.write('predict: --question is required\n');
    process.exitCode = 1;
    return;
  }
  if (!options.model) {
    process.stderr.write('predict: --model is required\n');
    process.exitCode = 1;
    return;
  }

  const chain = loadChain();
  const apiUrl = API_URLS[chain];
  const model = resolveModel(options.model);
  const asJson = options.json !== false;

  resetToolSessionState();

  const agentConfig: AgentConfig = {
    model,
    apiUrl,
    chain,
    systemInstructions: PREDICTION_SYSTEM,
    capabilities: predictionCapabilities,
    maxTurns: options.maxTurns != null ? Number(options.maxTurns) : 8,
    permissionMode: 'trust',
    debug: !!options.debug,
    showPrefetchStatus: false,
    // Governance for one-shot forecasting: bound research by tool-call count and
    // force an answer; don't silently switch models or fight a grounding retry.
    // Tool budget (5) is the real research limiter; maxTurns (8) is just slack
    // above it for a thinking turn + the forced-answer turn.
    forceAnswerOnFinalTurn: true,
    maxToolCalls: options.maxToolCalls != null ? Number(options.maxToolCalls) : 6,
    disableModelFallback: true,
    disableGroundingRetry: true,
    ...(options.maxSpend != null ? { maxSpendUsd: Number(options.maxSpend) } : {}),
  };

  let finalText = '';
  let turnReason: StreamTurnDone['reason'] = 'completed';
  let turnError: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  const trace: TraceEntry[] = [];
  const nameById = new Map<string, string>();
  const inputById = new Map<string, string>();
  const previewById = new Map<string, string>();

  let delivered = false;
  const getInput = async (): Promise<string | null> => {
    if (delivered) return null;
    delivered = true;
    return question;
  };

  await interactiveSession(agentConfig, getInput, (event: StreamEvent) => {
    switch (event.kind) {
      case 'text_delta':
        finalText += event.text;
        if (!asJson) process.stdout.write(event.text);
        break;
      case 'capability_start':
        nameById.set(event.id, event.name);
        inputById.set(event.id, '');
        if (event.preview) previewById.set(event.id, event.preview);
        if (!asJson) process.stderr.write(`\n  · ${event.name}${event.preview ? ` ${event.preview}` : ''}\n`);
        break;
      case 'capability_input_delta':
        inputById.set(event.id, (inputById.get(event.id) || '') + event.delta);
        break;
      case 'capability_done': {
        const tool = nameById.get(event.id) || 'tool';
        const input = (inputById.get(event.id) || '').trim() || previewById.get(event.id) || '';
        const output = event.result?.fullOutput || event.result?.output || '';
        trace.push({ tool, input, output: output.slice(0, 1500), isError: event.result?.isError });
        break;
      }
      case 'usage':
        inputTokens = event.inputTokens;
        outputTokens = event.outputTokens;
        break;
      case 'turn_done':
        turnReason = event.reason;
        turnError = event.error;
        break;
    }
  });

  if (asJson) {
    const envelope = {
      model,
      question,
      finalText: finalText.trim(),
      trace,
      turnReason,
      ...(turnError ? { error: turnError } : {}),
      usage: { inputTokens, outputTokens },
    };
    process.stdout.write(JSON.stringify(envelope) + '\n');
  } else if (turnReason !== 'completed' && turnError) {
    process.stderr.write(`\n${turnError}\n`);
  }

  process.exitCode = turnReason === 'completed' ? 0 : 1;
}
