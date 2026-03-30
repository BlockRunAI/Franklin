export declare function walletExists(): boolean;
export declare function setupWallet(): {
    address: string;
    isNew: boolean;
};
export declare function setupSolanaWallet(): Promise<{
    address: string;
    isNew: boolean;
}>;
export declare function getAddress(): string;
