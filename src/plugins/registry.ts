/**
 * Plugin Registry — discovers, loads, and manages plugins.
 *
 * Core stays plugin-agnostic: it knows about the *interface*, not specific plugins.
 * Plugins are discovered from:
 *   1. Bundled: <runcode>/plugins-bundled/* (ships with runcode)
 *   2. User: ~/.blockrun/plugins/* (installed via `runcode plugin install`)
 *   3. Local dev: $RUNCODE_PLUGINS_DIR/* (env var for development)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import type { Plugin, PluginManifest } from '../plugin-sdk/plugin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Plugin Discovery Paths ───────────────────────────────────────────────

export function getBundledPluginsDir(): string {
  // From dist/plugins/registry.js, plugins-bundled is at ../plugins-bundled
  // (built from src/plugins-bundled by tsc + copy-plugin-assets)
  return path.resolve(__dirname, '..', 'plugins-bundled');
}

export function getUserPluginsDir(): string {
  return path.join(os.homedir(), '.blockrun', 'plugins');
}

function getDevPluginsDir(): string | null {
  return process.env.RUNCODE_PLUGINS_DIR || null;
}

// ─── Loaded Plugin State ──────────────────────────────────────────────────

interface LoadedPlugin {
  manifest: PluginManifest;
  pluginDir: string;
  plugin: Plugin;
}

const loaded = new Map<string, LoadedPlugin>();

// ─── Discovery ────────────────────────────────────────────────────────────

/** Find all plugin manifests across discovery paths */
export function discoverPluginManifests(): Array<{ manifest: PluginManifest; dir: string }> {
  const found: Array<{ manifest: PluginManifest; dir: string }> = [];
  const seen = new Set<string>();

  const searchPaths: string[] = [];
  const dev = getDevPluginsDir();
  if (dev && fs.existsSync(dev)) searchPaths.push(dev);
  const user = getUserPluginsDir();
  if (fs.existsSync(user)) searchPaths.push(user);
  const bundled = getBundledPluginsDir();
  if (fs.existsSync(bundled)) searchPaths.push(bundled);

  for (const base of searchPaths) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(base);
    } catch { continue; }

    for (const entry of entries) {
      const pluginDir = path.join(base, entry);
      const manifestPath = path.join(pluginDir, 'plugin.json');
      if (!fs.existsSync(manifestPath)) continue;

      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as PluginManifest;
        if (!manifest.id || seen.has(manifest.id)) continue;
        seen.add(manifest.id);
        found.push({ manifest, dir: pluginDir });
      } catch {
        // Invalid manifest — skip
      }
    }
  }

  return found;
}

// ─── Loading ──────────────────────────────────────────────────────────────

/** Load a single plugin from its directory */
export async function loadPlugin(manifest: PluginManifest, pluginDir: string): Promise<Plugin | null> {
  // Resolve entry path. Plugin's entry should point to a built JS file.
  // For bundled plugins, entry might be "dist/index.js" but we ship from src/.
  // Check both — prefer dist if present.
  let entryPath = path.join(pluginDir, manifest.entry);
  if (!fs.existsSync(entryPath)) {
    // Try .js extension swap (TS source vs built)
    const jsEntry = entryPath.replace(/\.ts$/, '.js');
    if (fs.existsSync(jsEntry)) entryPath = jsEntry;
  }

  if (!fs.existsSync(entryPath)) {
    process.stderr.write(`[plugin:${manifest.id}] entry not found: ${manifest.entry}\n`);
    return null;
  }

  try {
    // Dynamic import — works for both ESM and CJS
    const mod = await import(entryPath);
    const plugin: Plugin = mod.default ?? mod.plugin ?? mod;
    if (!plugin || typeof plugin !== 'object') {
      process.stderr.write(`[plugin:${manifest.id}] invalid plugin export\n`);
      return null;
    }
    // Inject manifest if plugin didn't include it
    plugin.manifest = manifest;
    return plugin;
  } catch (err) {
    process.stderr.write(`[plugin:${manifest.id}] load failed: ${(err as Error).message}\n`);
    return null;
  }
}

/** Discover and load all plugins. Returns the loaded registry. */
export async function loadAllPlugins(): Promise<Map<string, LoadedPlugin>> {
  if (loaded.size > 0) return loaded;

  const manifests = discoverPluginManifests();
  for (const { manifest, dir } of manifests) {
    const plugin = await loadPlugin(manifest, dir);
    if (plugin) {
      loaded.set(manifest.id, { manifest, pluginDir: dir, plugin });
      // Lifecycle hook
      if (plugin.onLoad) {
        try {
          await plugin.onLoad({
            runcodeVersion: getRuncodeVersion(),
            dataDir: path.join(os.homedir(), '.blockrun', 'plugins', manifest.id),
            pluginDir: dir,
            log: (msg) => process.stderr.write(`[${manifest.id}] ${msg}\n`),
          });
        } catch (err) {
          process.stderr.write(`[plugin:${manifest.id}] onLoad failed: ${(err as Error).message}\n`);
        }
      }
    }
  }

  return loaded;
}

// ─── Query API ────────────────────────────────────────────────────────────

export function getPlugin(id: string): LoadedPlugin | undefined {
  return loaded.get(id);
}

export function listPlugins(): LoadedPlugin[] {
  return Array.from(loaded.values());
}

/** Get all plugins that provide workflows */
export function listWorkflowPlugins(): LoadedPlugin[] {
  return listPlugins().filter(p => p.plugin.workflows && Object.keys(p.plugin.workflows).length > 0);
}

/** Get all plugins that provide channels */
export function listChannelPlugins(): LoadedPlugin[] {
  return listPlugins().filter(p => p.plugin.channels && Object.keys(p.plugin.channels).length > 0);
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function getRuncodeVersion(): string {
  try {
    const pkgPath = path.resolve(__dirname, '..', '..', 'package.json');
    return JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}
