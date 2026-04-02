/**
 * Proxy-only mode — runs the BlockRun payment proxy for other tools (e.g. Claude Code).
 * The proxy translates requests and handles x402 payments so Claude Code can use any model.
 */
interface ProxyOptions {
    port?: string;
    model?: string;
    fallback?: boolean;
    debug?: boolean;
    version?: string;
}
export declare function proxyCommand(options: ProxyOptions): Promise<void>;
export {};
