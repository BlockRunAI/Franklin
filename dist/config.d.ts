export type Chain = 'base' | 'solana';
export declare const BLOCKRUN_DIR: string;
export declare const CHAIN_FILE: string;
export declare const API_URLS: Record<Chain, string>;
export declare const DEFAULT_PROXY_PORT = 8402;
export declare function saveChain(chain: Chain): void;
export declare function loadChain(): Chain;
