/**
 * franklin migrate — one-click import from other AI coding agents.
 *
 * Detects installed tools (Claude Code, Cline, Cursor, etc.),
 * shows what can be migrated, and imports with user confirmation.
 */
export declare function migrateCommand(): Promise<void>;
/**
 * Check if other AI tools are installed and suggest migration.
 * Only runs once — writes a marker file after first check.
 * Returns true if the user chose to migrate (caller should re-run start after).
 */
export declare function checkAndSuggestMigration(): Promise<boolean>;
