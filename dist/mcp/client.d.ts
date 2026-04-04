/**
 * MCP Client for runcode.
 * Connects to MCP servers, discovers tools, and wraps them as CapabilityHandlers.
 * Supports stdio and HTTP (SSE) transports.
 */
import type { CapabilityHandler } from '../agent/types.js';
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
/**
 * Connect to all configured MCP servers and return discovered tools.
 */
export declare function connectMcpServers(config: McpConfig, debug?: boolean): Promise<CapabilityHandler[]>;
/**
 * Disconnect all MCP servers.
 */
export declare function disconnectMcpServers(): Promise<void>;
/**
 * List connected MCP servers and their tools.
 */
export declare function listMcpServers(): Array<{
    name: string;
    toolCount: number;
    tools: string[];
}>;
