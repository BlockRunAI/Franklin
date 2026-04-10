/**
 * Plugin contract — what every plugin must export.
 *
 * Plugins are discovered by their manifest file (plugin.json) and loaded
 * dynamically. Core code never references plugins by name.
 */
import type { Workflow } from './workflow.js';
import type { Channel } from './channel.js';
/** Plugin manifest (plugin.json) */
export interface PluginManifest {
    /** Unique plugin id (e.g. "social", "trading") */
    id: string;
    /** Display name */
    name: string;
    /** Short description */
    description: string;
    /** Semantic version */
    version: string;
    /** Plugin type — what surfaces it provides */
    provides: PluginProvides;
    /** Entry point (relative to manifest) */
    entry: string;
    /** Author info */
    author?: string;
    /** Homepage URL */
    homepage?: string;
    /** License */
    license?: string;
    /** Required runcode version (semver range) */
    runcodeVersion?: string;
}
export interface PluginProvides {
    /** This plugin contributes one or more workflows (e.g. "social", "trading") */
    workflows?: string[];
    /** This plugin contributes channels (e.g. "reddit", "x", "telegram") */
    channels?: string[];
    /** This plugin contributes CLI commands */
    commands?: string[];
}
/** Plugin entry point — exported as default from plugin's entry file */
export interface Plugin {
    /** Manifest (loaded from plugin.json — plugin doesn't need to repeat it) */
    manifest: PluginManifest;
    /** Workflows this plugin provides (mapped by workflow id) */
    workflows?: Record<string, () => Workflow>;
    /** Channels this plugin provides (mapped by channel id) */
    channels?: Record<string, () => Channel>;
    /** Custom CLI commands */
    commands?: PluginCommand[];
    /** Called once when plugin is loaded (optional) */
    onLoad?: (ctx: PluginContext) => void | Promise<void>;
    /** Called when plugin is unloaded (optional) */
    onUnload?: () => void | Promise<void>;
}
/** Context passed to plugin lifecycle hooks */
export interface PluginContext {
    /** RunCode version */
    runcodeVersion: string;
    /** Plugin's own data directory (~/.blockrun/plugins/<id>/) */
    dataDir: string;
    /** Path to plugin's installation directory */
    pluginDir: string;
    /** Logger */
    log: (message: string) => void;
}
/** A CLI command contributed by a plugin */
export interface PluginCommand {
    /** Command name (e.g. "init", "run", "stats") */
    name: string;
    /** Description shown in help */
    description: string;
    /** Optional flags */
    options?: Array<{
        flag: string;
        description: string;
    }>;
    /** Handler — receives parsed args and plugin context */
    handler: PluginCommandHandler;
}
export type PluginCommandHandler = (args: {
    /** Positional arguments */
    positional: string[];
    /** Parsed flags */
    flags: Record<string, string | boolean>;
    /** Plugin context */
    ctx: PluginContext;
}) => Promise<void> | void;
