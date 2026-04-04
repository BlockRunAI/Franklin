/**
 * MCP Client for runcode.
 * Connects to MCP servers, discovers tools, and wraps them as CapabilityHandlers.
 * Supports stdio and HTTP (SSE) transports.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
// ─── Connection Management ────────────────────────────────────────────────
const connections = new Map();
/**
 * Connect to an MCP server via stdio transport.
 * Discovers tools and returns them as CapabilityHandlers.
 */
async function connectStdio(name, config) {
    if (!config.command) {
        throw new Error(`MCP server "${name}" missing command`);
    }
    const transport = new StdioClientTransport({
        command: config.command,
        args: config.args || [],
        env: { ...process.env, ...(config.env || {}) },
    });
    const client = new Client({ name: `runcode-mcp-${name}`, version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
    // Discover tools
    const { tools: mcpTools } = await client.listTools();
    const capabilities = [];
    for (const tool of mcpTools) {
        const toolName = `mcp__${name}__${tool.name}`;
        const toolDescription = (tool.description || '').slice(0, 2048);
        capabilities.push({
            spec: {
                name: toolName,
                description: toolDescription || `MCP tool from ${name}`,
                input_schema: tool.inputSchema || {
                    type: 'object',
                    properties: {},
                },
            },
            execute: async (input, _ctx) => {
                try {
                    const result = await client.callTool({
                        name: tool.name,
                        arguments: input,
                    });
                    // Extract text content from MCP response
                    const output = result.content
                        ?.filter(c => c.type === 'text')
                        ?.map(c => c.text)
                        ?.join('\n') || JSON.stringify(result.content);
                    return {
                        output,
                        isError: result.isError === true,
                    };
                }
                catch (err) {
                    return {
                        output: `MCP tool error (${name}/${tool.name}): ${err.message}`,
                        isError: true,
                    };
                }
            },
            concurrent: true, // MCP tools are safe to run concurrently
        });
    }
    const connected = { name, client, transport, tools: capabilities };
    connections.set(name, connected);
    return connected;
}
/**
 * Connect to all configured MCP servers and return discovered tools.
 */
export async function connectMcpServers(config, debug) {
    const allTools = [];
    for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
        if (serverConfig.disabled)
            continue;
        try {
            if (debug) {
                console.error(`[runcode] Connecting to MCP server: ${name}...`);
            }
            let connected;
            if (serverConfig.transport === 'stdio') {
                connected = await connectStdio(name, serverConfig);
            }
            else {
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
        }
        catch (err) {
            // Graceful degradation — log and continue without this server
            console.error(`[runcode] MCP ${name} failed: ${err.message}`);
        }
    }
    return allTools;
}
/**
 * Disconnect all MCP servers.
 */
export async function disconnectMcpServers() {
    for (const [name, conn] of connections) {
        try {
            await conn.client.close();
        }
        catch {
            // Ignore cleanup errors
        }
        connections.delete(name);
    }
}
/**
 * List connected MCP servers and their tools.
 */
export function listMcpServers() {
    const result = [];
    for (const [name, conn] of connections) {
        result.push({
            name,
            toolCount: conn.tools.length,
            tools: conn.tools.map(t => t.spec.name),
        });
    }
    return result;
}
