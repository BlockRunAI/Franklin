/**
 * ActivateTool — meta-capability that lets the agent pull on-demand tools
 * into the active toolset per session.
 *
 * Pattern borrowed from OpenBB MCP server's per-session tool visibility:
 * a weak model confronted with 25+ tool definitions starts inventing names
 * or emits role-play "[TOOLCALL]" fragments. Register only the core file/
 * shell tools by default and let the model explicitly opt in to the rest.
 *
 * Contract:
 *   - `ActivateTool()` with no args → lists every inactive tool with a
 *     one-line description so the model knows what's available.
 *   - `ActivateTool({ names: ["ExaSearch", "ExaReadUrls"] })` → adds the
 *     named tools to the session's active set; subsequent turns include
 *     their full schemas. Returns a concise confirmation.
 *
 * The factory captures the shared `activeTools` Set that the loop filters
 * against and the full `allTools` map used for name resolution. Both live
 * in the session — activation is not durable across restarts on purpose,
 * since the model can always re-activate on the next turn if it needs to.
 */

import type { CapabilityHandler, CapabilityResult } from '../agent/types.js';

export interface ActivateToolDeps {
  /** Mutable set of tool names currently visible to the model. */
  activeTools: Set<string>;
  /** Map of every registered capability, keyed by name. */
  allTools: Map<string, CapabilityHandler>;
}

function shortDesc(desc: string): string {
  // First sentence or first 120 chars, whichever is shorter.
  const firstSentence = desc.split(/[.\n]/)[0]?.trim() ?? '';
  if (firstSentence && firstSentence.length <= 120) return firstSentence;
  const trimmed = desc.replace(/\s+/g, ' ').trim();
  return trimmed.length <= 120 ? trimmed : trimmed.slice(0, 117) + '...';
}

export function createActivateToolCapability(deps: ActivateToolDeps): CapabilityHandler {
  const { activeTools, allTools } = deps;

  return {
    spec: {
      name: 'ActivateTool',
      description:
        'Activate additional tools for this session. Most tools are hidden by default to keep your tool inventory small. ' +
        'Call with no arguments to see what is available. Call with { "names": ["ToolA", "ToolB"] } to enable specific tools — ' +
        'they become visible in your tool list on the next turn. Activate only what you need; extra tools crowd the inventory.',
      input_schema: {
        type: 'object',
        properties: {
          names: {
            type: 'array',
            items: { type: 'string' },
            description: 'List of tool names to activate. Omit to list what is available.',
          },
        },
      },
    },
    concurrent: false,
    async execute(input: Record<string, unknown>): Promise<CapabilityResult> {
      const raw = (input as { names?: unknown }).names;
      const names = Array.isArray(raw) ? raw.filter((n): n is string => typeof n === 'string') : undefined;

      // No args → catalog the inactive tools so the model knows what's there.
      if (!names || names.length === 0) {
        const inactive = [...allTools.values()]
          .filter(t => !activeTools.has(t.spec.name))
          .sort((a, b) => a.spec.name.localeCompare(b.spec.name));

        if (inactive.length === 0) {
          return { output: 'All registered tools are already active.' };
        }

        const lines = inactive.map(t => `- ${t.spec.name}: ${shortDesc(t.spec.description)}`);
        return {
          output:
            `Available on-demand tools (${inactive.length}). Activate with ` +
            `ActivateTool({ "names": ["<name>", ...] }):\n` +
            lines.join('\n'),
        };
      }

      // Activate each named tool.
      const activated: string[] = [];
      const alreadyActive: string[] = [];
      const unknown: string[] = [];

      for (const name of names) {
        if (!allTools.has(name)) {
          unknown.push(name);
        } else if (activeTools.has(name)) {
          alreadyActive.push(name);
        } else {
          activeTools.add(name);
          activated.push(name);
        }
      }

      const parts: string[] = [];
      if (activated.length) parts.push(`Activated: ${activated.join(', ')}`);
      if (alreadyActive.length) parts.push(`Already active: ${alreadyActive.join(', ')}`);
      if (unknown.length) parts.push(`Unknown (not registered): ${unknown.join(', ')}`);

      const output = parts.length ? parts.join('. ') + '.' : 'No change.';
      const isError = activated.length === 0 && unknown.length > 0;

      return { output, isError };
    },
  };
}
