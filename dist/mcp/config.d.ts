/**
 * MCP configuration management for runcode.
 * Loads MCP server configs from:
 * 1. Global: ~/.blockrun/mcp.json
 * 2. Project: .mcp.json in working directory
 */
import type { McpConfig, McpServerConfig } from './client.js';
/**
 * Load MCP server configurations from global + project files.
 * Project config overrides global for same server name.
 */
export declare function loadMcpConfig(workDir: string): McpConfig;
/**
 * Save a server config to the global MCP config.
 */
export declare function saveMcpServer(name: string, config: McpServerConfig): void;
/**
 * Remove a server from the global MCP config.
 */
export declare function removeMcpServer(name: string): boolean;
