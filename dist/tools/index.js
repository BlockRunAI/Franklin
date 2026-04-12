/**
 * Tool registry — exports all available capabilities for the agent.
 */
import { readCapability } from './read.js';
import { writeCapability } from './write.js';
import { editCapability } from './edit.js';
import { bashCapability } from './bash.js';
import { globCapability } from './glob.js';
import { grepCapability } from './grep.js';
import { webFetchCapability } from './webfetch.js';
import { webSearchCapability } from './websearch.js';
import { taskCapability } from './task.js';
import { imageGenCapability } from './imagegen.js';
import { askUserCapability } from './askuser.js';
import { tradingSignalCapability, tradingMarketCapability } from './trading.js';
import { searchXCapability } from './searchx.js';
import { postToXCapability } from './posttox.js';
/** All capabilities available to the runcode agent (excluding sub-agent, which needs config). */
export const allCapabilities = [
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
];
export { readCapability, writeCapability, editCapability, bashCapability, globCapability, grepCapability, webFetchCapability, webSearchCapability, taskCapability, };
export { createSubAgentCapability } from './subagent.js';
