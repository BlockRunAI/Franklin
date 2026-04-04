/**
 * MCP configuration management for runcode.
 * Loads MCP server configs from:
 * 1. Global: ~/.blockrun/mcp.json
 * 2. Project: .mcp.json in working directory
 */
import fs from 'node:fs';
import path from 'node:path';
import { BLOCKRUN_DIR } from '../config.js';
const GLOBAL_MCP_FILE = path.join(BLOCKRUN_DIR, 'mcp.json');
/**
 * Load MCP server configurations from global + project files.
 * Project config overrides global for same server name.
 */
export function loadMcpConfig(workDir) {
    const servers = {};
    // 1. Global config
    try {
        if (fs.existsSync(GLOBAL_MCP_FILE)) {
            const raw = JSON.parse(fs.readFileSync(GLOBAL_MCP_FILE, 'utf-8'));
            if (raw.mcpServers && typeof raw.mcpServers === 'object') {
                Object.assign(servers, raw.mcpServers);
            }
        }
    }
    catch {
        // Ignore corrupt global config
    }
    // 2. Project config (.mcp.json in working directory)
    const projectMcpFile = path.join(workDir, '.mcp.json');
    try {
        if (fs.existsSync(projectMcpFile)) {
            const raw = JSON.parse(fs.readFileSync(projectMcpFile, 'utf-8'));
            if (raw.mcpServers && typeof raw.mcpServers === 'object') {
                // Project overrides global for same name
                Object.assign(servers, raw.mcpServers);
            }
        }
    }
    catch {
        // Ignore corrupt project config
    }
    return { mcpServers: servers };
}
/**
 * Save a server config to the global MCP config.
 */
export function saveMcpServer(name, config) {
    const existing = loadGlobalMcpConfig();
    existing.mcpServers[name] = config;
    fs.mkdirSync(BLOCKRUN_DIR, { recursive: true });
    fs.writeFileSync(GLOBAL_MCP_FILE, JSON.stringify(existing, null, 2) + '\n');
}
/**
 * Remove a server from the global MCP config.
 */
export function removeMcpServer(name) {
    const existing = loadGlobalMcpConfig();
    if (!(name in existing.mcpServers))
        return false;
    delete existing.mcpServers[name];
    fs.writeFileSync(GLOBAL_MCP_FILE, JSON.stringify(existing, null, 2) + '\n');
    return true;
}
function loadGlobalMcpConfig() {
    try {
        if (fs.existsSync(GLOBAL_MCP_FILE)) {
            const raw = JSON.parse(fs.readFileSync(GLOBAL_MCP_FILE, 'utf-8'));
            return { mcpServers: raw.mcpServers || {} };
        }
    }
    catch { /* fresh */ }
    return { mcpServers: {} };
}
