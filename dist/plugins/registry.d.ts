/**
 * Plugin Registry — discovers, loads, and manages plugins.
 *
 * Core stays plugin-agnostic: it knows about the *interface*, not specific plugins.
 * Plugins are discovered from:
 *   1. Bundled: <runcode>/plugins-bundled/* (ships with runcode)
 *   2. User: ~/.blockrun/plugins/* (installed via `runcode plugin install`)
 *   3. Local dev: $RUNCODE_PLUGINS_DIR/* (env var for development)
 */
import type { Plugin, PluginManifest } from '../plugin-sdk/plugin.js';
export declare function getBundledPluginsDir(): string;
export declare function getUserPluginsDir(): string;
interface LoadedPlugin {
    manifest: PluginManifest;
    pluginDir: string;
    plugin: Plugin;
}
/** Find all plugin manifests across discovery paths */
export declare function discoverPluginManifests(): Array<{
    manifest: PluginManifest;
    dir: string;
}>;
/** Load a single plugin from its directory */
export declare function loadPlugin(manifest: PluginManifest, pluginDir: string): Promise<Plugin | null>;
/** Discover and load all plugins. Returns the loaded registry. */
export declare function loadAllPlugins(): Promise<Map<string, LoadedPlugin>>;
export declare function getPlugin(id: string): LoadedPlugin | undefined;
export declare function listPlugins(): LoadedPlugin[];
/** Get all plugins that provide workflows */
export declare function listWorkflowPlugins(): LoadedPlugin[];
/** Get all plugins that provide channels */
export declare function listChannelPlugins(): LoadedPlugin[];
export {};
