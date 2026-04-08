/**
 * MCP configuration management for runcode.
 * Loads MCP server configs from:
 * 1. Global: ~/.blockrun/mcp.json
 * 2. Project: .mcp.json in working directory
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { BLOCKRUN_DIR } from '../config.js';
const GLOBAL_MCP_FILE = path.join(BLOCKRUN_DIR, 'mcp.json');
/**
 * Load MCP server configurations from global + project files.
 * Project config overrides global for same server name.
 */
// Built-in MCP server: @blockrun/mcp available when globally installed
// Uses `blockrun-mcp` binary instead of `npx` for fast startup
const BUILTIN_MCP_SERVERS = {
    blockrun: {
        transport: 'stdio',
        command: 'blockrun-mcp',
        args: [],
        label: 'BlockRun (built-in)',
    },
    unbrowse: {
        transport: 'stdio',
        command: 'unbrowse',
        args: ['mcp'],
        label: 'Unbrowse (built-in)',
    },
};
function isCommandAvailable(cmd) {
    try {
        execSync(`which ${cmd}`, { stdio: 'pipe' });
        return true;
    }
    catch {
        return false;
    }
}
export function loadMcpConfig(workDir) {
    // Start with built-in servers (only if their binary is available)
    const servers = {};
    for (const [name, config] of Object.entries(BUILTIN_MCP_SERVERS)) {
        if (config.command && isCommandAvailable(config.command)) {
            servers[name] = config;
        }
    }
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
    // Security: project configs can execute arbitrary commands via stdio transport.
    // Only load if a trust marker exists (user has explicitly opted in).
    const projectMcpFile = path.join(workDir, '.mcp.json');
    const trustMarker = path.join(BLOCKRUN_DIR, 'trusted-projects.json');
    try {
        if (fs.existsSync(projectMcpFile)) {
            // Check if this project directory is trusted
            let trusted = false;
            try {
                if (fs.existsSync(trustMarker)) {
                    const trustedDirs = JSON.parse(fs.readFileSync(trustMarker, 'utf-8'));
                    trusted = Array.isArray(trustedDirs) && trustedDirs.includes(workDir);
                }
            }
            catch { /* not trusted */ }
            if (trusted) {
                const raw = JSON.parse(fs.readFileSync(projectMcpFile, 'utf-8'));
                if (raw.mcpServers && typeof raw.mcpServers === 'object') {
                    Object.assign(servers, raw.mcpServers);
                }
            }
            // If not trusted, silently skip project config (user must run /mcp trust)
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
/**
 * Trust a project directory to load its .mcp.json.
 */
export function trustProjectDir(workDir) {
    const trustMarker = path.join(BLOCKRUN_DIR, 'trusted-projects.json');
    let trusted = [];
    try {
        if (fs.existsSync(trustMarker)) {
            trusted = JSON.parse(fs.readFileSync(trustMarker, 'utf-8'));
        }
    }
    catch { /* fresh */ }
    if (!trusted.includes(workDir)) {
        trusted.push(workDir);
        fs.mkdirSync(BLOCKRUN_DIR, { recursive: true });
        fs.writeFileSync(trustMarker, JSON.stringify(trusted, null, 2));
    }
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
