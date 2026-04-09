/**
 * CLI command: runcode social
 *
 * Social growth workflow — search, filter, draft, post.
 */
interface SocialOptions {
    dryRun?: boolean;
    debug?: boolean;
}
export declare function socialCommand(action: string, options: SocialOptions): Promise<void>;
export {};
