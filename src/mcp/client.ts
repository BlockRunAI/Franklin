/**
 * MCP Client for runcode.
 * Connects to MCP servers, discovers tools, and wraps them as CapabilityHandlers.
 * Supports stdio and HTTP (SSE) transports.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CapabilityHandler, CapabilityResult, ExecutionScope } from '../agent/types.js';

// ─── Types ────────────────────────────────────────────────────────────────

export interface McpServerConfig {
  /** Transport type */
  transport: 'stdio' | 'http';
  /** For stdio: command to run */
  command?: string;
  /** For stdio: arguments */
  args?: string[];
  /** For stdio: environment variables */
  env?: Record<string, string>;
  /** For http: server URL */
  url?: string;
  /** For http: headers */
  headers?: Record<string, string>;
  /** Human-readable label */
  label?: string;
  /** Disable this server */
  disabled?: boolean;
}

export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

interface ConnectedServer {
  name: string;
  client: Client;
  transport: StdioClientTransport;
  tools: CapabilityHandler[];
}

// ─── Connection Management ────────────────────────────────────────────────

const connections = new Map<string, ConnectedServer>();

/**
 * Connect to an MCP server via stdio transport.
 * Discovers tools and returns them as CapabilityHandlers.
 */
async function connectStdio(
  name: string,
  config: McpServerConfig
): Promise<ConnectedServer> {
  if (!config.command) {
    throw new Error(`MCP server "${name}" missing command`);
  }

  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args || [],
    env: { ...process.env, ...(config.env || {}) } as Record<string, string>,
    // 'ignore' discards subprocess stderr completely so a misconfigured MCP
    // server (e.g. missing OAuth keys) can't dump multi-line stack traces
    // into the user's terminal. 'pipe' didn't fully work because some SDK
    // versions read piped stderr and re-emit it.
    stderr: 'ignore',
  });

  const client = new Client(
    { name: `runcode-mcp-${name}`, version: '1.0.0' },
    { capabilities: {} }
  );

  try {
    await client.connect(transport);
  } catch (err) {
    // Clean up transport if connect fails to prevent resource leak
    try { await transport.close(); } catch { /* ignore */ }
    throw err;
  }

  // Discover tools
  const { tools: mcpTools } = await client.listTools();
  const capabilities: CapabilityHandler[] = [];

  for (const tool of mcpTools) {
    const toolName = `mcp__${name}__${tool.name}`;
    const toolDescription = (tool.description || '').slice(0, 2048);

    capabilities.push({
      spec: {
        name: toolName,
        description: toolDescription || `MCP tool from ${name}`,
        input_schema: (tool.inputSchema as { type: 'object'; properties: Record<string, unknown>; required?: string[] }) || {
          type: 'object',
          properties: {},
        },
      },
      execute: async (input: Record<string, unknown>, _ctx: ExecutionScope): Promise<CapabilityResult> => {
        const MCP_TOOL_TIMEOUT = 30_000;
        try {
          // Timeout protection: if tool hangs, don't block the agent forever
          const callPromise = client.callTool({ name: tool.name, arguments: input });
          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`MCP tool timeout after ${MCP_TOOL_TIMEOUT / 1000}s`)), MCP_TOOL_TIMEOUT)
          );
          const result = await Promise.race([callPromise, timeoutPromise]);

          // Extract text content from MCP response
          const output = (result.content as Array<{ type: string; text?: string }>)
            ?.filter(c => c.type === 'text')
            ?.map(c => c.text)
            ?.join('\n') || JSON.stringify(result.content);

          return {
            output,
            isError: result.isError === true,
          };
        } catch (err) {
          return {
            output: `MCP tool error (${name}/${tool.name}): ${(err as Error).message}`,
            isError: true,
          };
        }
      },
      concurrent: true, // MCP tools are safe to run concurrently
    });
  }

  const connected: ConnectedServer = { name, client, transport, tools: capabilities };
  connections.set(name, connected);
  return connected;
}

/**
 * Connect to all configured MCP servers and return discovered tools.
 */
const MCP_CONNECT_TIMEOUT = 5_000; // 5s per server connection

/**
 * Connect to all configured MCP servers and return discovered tools.
 * Each connection has a 5s timeout to avoid blocking startup.
 */
export async function connectMcpServers(
  config: McpConfig,
  debug?: boolean
): Promise<CapabilityHandler[]> {
  const allTools: CapabilityHandler[] = [];

  for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
    if (serverConfig.disabled) continue;

    try {
      if (debug) {
        console.error(`[runcode] Connecting to MCP server: ${name}...`);
      }

      if (serverConfig.transport !== 'stdio') {
        if (debug) {
          console.error(`[runcode] MCP HTTP transport not yet supported for ${name}`);
        }
        continue;
      }

      // Timeout: don't let a slow server block startup
      const connectPromise = connectStdio(name, serverConfig);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('connection timeout (5s)')), MCP_CONNECT_TIMEOUT)
      );
      const connected = await Promise.race([connectPromise, timeoutPromise]);
      allTools.push(...connected.tools);

      if (debug) {
        console.error(`[runcode] MCP ${name}: ${connected.tools.length} tools discovered`);
      }
    } catch (err) {
      // Graceful degradation — one-line warning, continue without this server.
      // Always visible (not debug-only) so the user knows why tools are missing.
      const shortMsg = (err as Error).message?.split('\n')[0]?.slice(0, 100) || 'unknown error';
      console.error(`  ${name}: ${shortMsg} ${debug ? '' : '(--debug for details)'}`);
    }
  }

  return allTools;
}

/**
 * Disconnect all MCP servers.
 */
export async function disconnectMcpServers(): Promise<void> {
  for (const [name, conn] of connections) {
    try {
      await conn.client.close();
    } catch {
      // Ignore cleanup errors
    }
    connections.delete(name);
  }
}

/**
 * List connected MCP servers and their tools.
 */
export function listMcpServers(): Array<{ name: string; toolCount: number; tools: string[] }> {
  const result: Array<{ name: string; toolCount: number; tools: string[] }> = [];
  for (const [name, conn] of connections) {
    result.push({
      name,
      toolCount: conn.tools.length,
      tools: conn.tools.map(t => t.spec.name),
    });
  }
  return result;
}
