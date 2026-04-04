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
  });

  const client = new Client(
    { name: `runcode-mcp-${name}`, version: '1.0.0' },
    { capabilities: {} }
  );

  await client.connect(transport);

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
        try {
          const result = await client.callTool({
            name: tool.name,
            arguments: input,
          });

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

      let connected: ConnectedServer;
      if (serverConfig.transport === 'stdio') {
        connected = await connectStdio(name, serverConfig);
      } else {
        // HTTP transport — TODO: implement SSE/HTTP transport
        if (debug) {
          console.error(`[runcode] MCP HTTP transport not yet supported for ${name}`);
        }
        continue;
      }

      allTools.push(...connected.tools);

      if (debug) {
        console.error(`[runcode] MCP ${name}: ${connected.tools.length} tools discovered`);
      }
    } catch (err) {
      // Graceful degradation — log and continue without this server
      console.error(`[runcode] MCP ${name} failed: ${(err as Error).message}`);
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
