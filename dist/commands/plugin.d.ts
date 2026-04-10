/**
 * Generic plugin command dispatcher.
 *
 * `runcode <plugin-id> <action>` works for ANY plugin that registers a workflow.
 * Core stays plugin-agnostic — adding a new plugin requires zero changes here.
 */
export interface PluginCommandOptions {
    dryRun?: boolean;
    debug?: boolean;
}
/** Run a plugin command. Plugin id is the first arg. */
export declare function pluginCommand(pluginId: string, action: string | undefined, options: PluginCommandOptions): Promise<void>;
/** List all installed plugins */
export declare function listAvailablePlugins(): void;
