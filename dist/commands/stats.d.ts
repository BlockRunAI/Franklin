/**
 * 0xcode stats command
 * Display usage statistics and cost savings
 */
interface StatsOptions {
    clear?: boolean;
    json?: boolean;
}
export declare function statsCommand(options: StatsOptions): void;
export {};
