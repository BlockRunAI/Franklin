interface StartOptions {
    port?: string;
    model?: string;
    launch?: boolean;
    fallback?: boolean;
    debug?: boolean;
    version?: string;
}
export declare function startCommand(options: StartOptions): Promise<void>;
export {};
