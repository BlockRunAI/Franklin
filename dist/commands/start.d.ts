interface StartOptions {
    model?: string;
    debug?: boolean;
    trust?: boolean;
    version?: string;
    /** Resume: explicit session ID, or true for "most recent in cwd", or 'picker' to prompt */
    resume?: string | boolean | 'picker';
    /** Continue: resume most recent session matching the current working directory */
    continue?: boolean;
}
export declare function startCommand(options: StartOptions): Promise<void>;
export {};
