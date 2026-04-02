interface StartOptions {
    model?: string;
    debug?: boolean;
    trust?: boolean;
    version?: string;
}
export declare function startCommand(options: StartOptions): Promise<void>;
export {};
