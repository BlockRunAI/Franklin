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

// Patterns in tool descriptions that make LLMs avoid using the tool
const BLOCKER_PATTERNS = [
  /\brequires?\b.*\b(?:config|setup|login|install|key|token|credential)\b/i,
  /\bmust\s+(?:configure|set\s*up|install|login)\b/i,
  /\bneeds?\s+(?:configuration|setup|api\s*key)\b/i,
];

export function validateToolDescriptions(tools: CapabilityHandler[]): ToolValidationIssue[] {
  const issues: ToolValidationIssue[] = [];
  const names = new Set<string>();

  for (const tool of tools) {
    const name = tool.spec.name;
    const desc = tool.spec.description;

    // Duplicate names
    if (names.has(name)) {
      issues.push({ toolName: name, issue: 'Duplicate tool name — LLM will confuse them', severity: 'error' });
    }
    names.add(name);

    // Description length
    if (desc.length < 20) {
      issues.push({ toolName: name, issue: `Description too short (${desc.length} chars) — LLM may not understand when to use this tool`, severity: 'warning' });
    }
    if (desc.length > 500) {
      issues.push({ toolName: name, issue: `Description too long (${desc.length} chars) — wastes context window`, severity: 'warning' });
    }

    // Blocker patterns — phrases that make the LLM think the tool won't work
    for (const pattern of BLOCKER_PATTERNS) {
      if (pattern.test(desc)) {
        issues.push({
          toolName: name,
          issue: `Description contains blocking language: "${desc.match(pattern)?.[0]}" — LLM may avoid using this tool even when it would work`,
          severity: 'warning',
        });
        break; // One warning per tool is enough
      }
    }
  }

  return issues;
}
