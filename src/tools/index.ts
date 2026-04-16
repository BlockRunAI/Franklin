/**
 * Tool registry — exports all available capabilities for the agent.
 */

import type { CapabilityHandler } from '../agent/types.js';

import { readCapability, clearSessionState as clearReadSessionState } from './read.js';
import { writeCapability } from './write.js';
import { editCapability } from './edit.js';
import { bashCapability, clearSessionState as clearBashSessionState } from './bash.js';
import { globCapability } from './glob.js';
import { grepCapability } from './grep.js';
import { webFetchCapability, clearSessionState as clearWebFetchSessionState } from './webfetch.js';
import { webSearchCapability } from './websearch.js';
import { taskCapability } from './task.js';
import { imageGenCapability } from './imagegen.js';
import { askUserCapability } from './askuser.js';
import { tradingSignalCapability, tradingMarketCapability } from './trading.js';
import { searchXCapability } from './searchx.js';
import { postToXCapability } from './posttox.js';
import { moaCapability } from './moa.js';

/**
 * Reset module-level tool state that would otherwise leak between sessions
 * when the same process runs `interactiveSession()` more than once (library
 * callers, tests, planned daemon mode). Safe to call before every session.
 */
export function resetToolSessionState(): void {
  clearReadSessionState();
  clearWebFetchSessionState();
  clearBashSessionState();
}

/** All capabilities available to the Franklin agent (excluding sub-agent, which needs config). */
export const allCapabilities: CapabilityHandler[] = [
  readCapability,
  writeCapability,
  editCapability,
  bashCapability,
  globCapability,
  grepCapability,
  webFetchCapability,
  webSearchCapability,
  taskCapability,
  imageGenCapability,
  askUserCapability,
  tradingSignalCapability,
  tradingMarketCapability,
  searchXCapability,
  postToXCapability,
  moaCapability,
];

export {
  readCapability,
  writeCapability,
  editCapability,
  bashCapability,
  globCapability,
  grepCapability,
  webFetchCapability,
  webSearchCapability,
  taskCapability,
};

export { createSubAgentCapability } from './subagent.js';
