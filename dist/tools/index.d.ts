/**
 * Tool registry — exports all available capabilities for the agent.
 */
import type { CapabilityHandler } from '../agent/types.js';
import { readCapability } from './read.js';
import { writeCapability } from './write.js';
import { editCapability } from './edit.js';
import { bashCapability } from './bash.js';
import { globCapability } from './glob.js';
import { grepCapability } from './grep.js';
import { webFetchCapability } from './webfetch.js';
import { webSearchCapability } from './websearch.js';
import { taskCapability } from './task.js';
/** All capabilities available to the 0xcode agent (excluding sub-agent, which needs config). */
export declare const allCapabilities: CapabilityHandler[];
export { readCapability, writeCapability, editCapability, bashCapability, globCapability, grepCapability, webFetchCapability, webSearchCapability, taskCapability, };
export { createSubAgentCapability } from './subagent.js';
