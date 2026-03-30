import http from 'node:http';
import type { Chain } from '../config.js';
export interface ProxyOptions {
    port: number;
    apiUrl: string;
    chain?: Chain;
    modelOverride?: string;
    debug?: boolean;
    fallbackEnabled?: boolean;
}
export declare function createProxy(options: ProxyOptions): http.Server;
type RequestCategory = 'simple' | 'code' | 'default';
interface ClassifiedRequest {
    category: RequestCategory;
    suggestedModel?: string;
}
export declare function classifyRequest(body: string): ClassifiedRequest;
export {};
