export interface AppConfig {
    'default-model'?: string;
    'sonnet-model'?: string;
    'opus-model'?: string;
    'haiku-model'?: string;
    'smart-routing'?: string;
    'permission-mode'?: string;
    'max-turns'?: string;
    'auto-compact'?: string;
    'session-save'?: string;
    'debug'?: string;
}
export declare function loadConfig(): AppConfig;
export declare function configCommand(action: string, keyOrUndefined?: string, value?: string): void;
