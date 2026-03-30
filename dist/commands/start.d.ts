interface StartOptions {
    port?: string;
    model?: string;
    launch?: boolean;
    fallback?: boolean;
    debug?: boolean;
}
export declare function startCommand(options: StartOptions): Promise<void>;
export {};
