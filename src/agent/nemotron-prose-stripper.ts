/**
 * Strip leaked reasoning prose from Nemotron-family models.
 *
 * NVIDIA's Nemotron Omni reasoning model emits its chain of thought as plain
 * text — without `<think>` tags or a separate reasoning_content channel — so
 * the think-tag stripper can't catch it. The reasoning prose is then concatenated
 * directly with the answer (often without even a separator), e.g.:
 *
 *   "The user asks: ... According to instructions, we must obey. Just output
 *    the tokenOMNI_E2E_OK"
 *
 * This module detects the reasoning preamble (heuristic: leading sentence
 * matches a known meta-reasoning opener) and strips everything up to and
 * including the last "answer-introducer" phrase ("just output the token",
 * "the answer is:", "output:", etc.). The stripped portion is returned as
 * `thinking` so it can be routed to the thinking display channel; the
 * remainder is the user-facing `answer`.
 */

import { isFreeModelId } from '../free-models.js';

const REASONING_OPENERS = [
  /^the user (asks|wants|says|requested|is asking|wants me|wrote|just|said)/i,
  // Observed live on 2026-08-30 from the rotated free pool (nemotron-3-nano-30b
  // and nemotron-3.5-lightning, which every free id can be served by). These
  // openers were not covered, so the leak reached users verbatim.
  /^here'?s\s+(?:a|my|the)\s+thinking process/i,
  /^hmm,?\s/i,
  /^user (asks|says|wants|requested|wrote)/i,
  /^we need to/i,
  /^looking at (this|the)/i,
  /^based on (the|this)/i,
  /^according to/i,
  /^we (must|should|need)/i,
  /^i (need|should|must|will|'ll|am going to|have to)\s/i,
  /^let me/i,
  /^there'?s? no need/i,
  /^okay,?\s+(the user|so|let|i)/i,
  /^alright,?\s+(the user|so|let|i)/i,
  /^so,?\s+the user/i,
  /^the question (is|asks)/i,
  /^the prompt (is|says|asks)/i,
];

const ANSWER_INTRODUCERS: RegExp[] = [
  /\bjust\s+(?:output|respond|say|reply|return|emit|write|give|print)\s+(?:the|a|with|out|to|exactly|back|only)?\s*(?:token|word|answer|response|string|text|output|message)?\s*:?\s*/gi,
  /\b(?:the|my)\s+(?:answer|response|token|output|reply)\s+is\s*:?\s*/gi,
  /\bhere'?s?\s+(?:the|my)?\s*(?:response|answer|output|token|reply):?\s*/gi,
  /(?:^|[\s.])(?:output|response|answer|reply|token)\s*:\s*/gi,
  /\bi(?:'ll| will| shall)\s+(?:output|respond|say|reply|return|emit|write|give|print)\s+(?:the|a|with|out|to|exactly|back|only)?\s*(?:token|word|answer|response|string|text|output|message)?\s*:?\s*/gi,
];

/**
 * Which models leak chain-of-thought into `content`?
 *
 * This used to name one id (nemotron-3-nano-omni). The 2026-08-30 probe
 * showed the leak is a property of the free POOL, not of that id: on
 * /api/v1/chat/completions a request for any free id can be served by
 * nemotron-3-nano-30b or nemotron-3.5-lightning, and both emit their full
 * trace as plain text. The requested id is what the stripper sees, so
 * matching on it missed every substituted response — Franklin's own free
 * default leaked to users unstripped for exactly that reason.
 *
 * On /api/v1/messages (the agent loop's endpoint) the substitution does not
 * happen and only nemotron-3.5-lightning leaks. Franklin also talks to
 * chat/completions through the proxy, so the whole free tier is treated as
 * leak-prone rather than tracking which endpoint a call came from.
 *
 * Stripping is safe on clean output: the opener patterns reject anything that
 * doesn't start with a meta-reasoning sentence.
 */
export function isNemotronProseModel(model: string): boolean {
  if (/^nvidia\/nemotron/i.test(model)) return true;
  return isFreeModelId(model);
}

export function stripNemotronProse(text: string): { thinking: string; answer: string } {
  if (!text) return { thinking: '', answer: '' };

  const leadingWhitespaceMatch = text.match(/^\s*/);
  const leadingWhitespace = leadingWhitespaceMatch ? leadingWhitespaceMatch[0] : '';
  const trimmed = text.slice(leadingWhitespace.length);

  if (!trimmed) return { thinking: '', answer: text };

  // Reject early: if no reasoning opener at the start, this isn't leaked prose.
  if (!REASONING_OPENERS.some((p) => p.test(trimmed))) {
    return { thinking: '', answer: text };
  }

  let lastEnd = -1;
  for (const re of ANSWER_INTRODUCERS) {
    const matches = [...trimmed.matchAll(re)];
    for (const m of matches) {
      const end = (m.index ?? 0) + m[0].length;
      if (end > lastEnd) lastEnd = end;
    }
  }

  if (lastEnd === -1) {
    // Reasoning detected but no transition phrase found. Conservative: leave
    // the text intact rather than swallow what might be a legitimate answer.
    return { thinking: '', answer: text };
  }

  const thinking = leadingWhitespace + trimmed.slice(0, lastEnd);
  const answer = trimmed.slice(lastEnd).replace(/^[\s.,:;\-—]+/, '');

  // Don't return an empty answer — fall back to the original text so the user
  // gets *something* even if our heuristic over-stripped.
  if (!answer) return { thinking: '', answer: text };

  return { thinking, answer };
}
