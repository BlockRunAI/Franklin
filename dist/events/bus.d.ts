import type { FranklinEvent } from './types.js';
type Handler = (event: FranklinEvent) => void | Promise<void>;
export declare class EventBus {
    private handlers;
    private logEnabled;
    private logPath;
    constructor(opts?: {
        log?: boolean;
    });
    on(type: FranklinEvent['type'], handler: Handler): void;
    off(type: FranklinEvent['type'], handler: Handler): void;
    emit(event: FranklinEvent): Promise<void>;
    clear(): void;
    private appendLog;
}
export declare const bus: EventBus;
export {};
