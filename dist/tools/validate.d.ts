/**
 * Tool description validation — catches descriptions that discourage the LLM
 * from using tools that actually work (like SearchX's old "Requires social config").
 */
import type { CapabilityHandler } from '../agent/types.js';
export interface ToolValidationIssue {
    toolName: string;
    issue: string;
    severity: 'warning' | 'error';
}
export declare function validateToolDescriptions(tools: CapabilityHandler[]): ToolValidationIssue[];
