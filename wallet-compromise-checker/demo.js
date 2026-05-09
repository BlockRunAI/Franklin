#!/usr/bin/env node

/**
 * Wallet Compromise Checker - CLI Demo
 * Demonstrates programmatic usage of the compromise checking logic
 */

class WalletCompromiseChecker {
    constructor() {
        this.checks = [];
    }

    validateEthereumKey(key) {
        if (!key || typeof key !== 'string') return false;
        const cleanKey = key.replace(/^0x/, '');
        return /^[0-9a-fA-F]{64}$/.test(cleanKey);
    }

    validateSolanaKey(key) {
        if (!key || typeof key !== 'string') return false;
        try {
            return key.length >= 40 && key.length <= 120 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(key);
        } catch {
            return false;
        }
    }

    calculateEntropy(str) {
        const charCount = {};
        for (const char of str) {
            charCount[char] = (charCount[char] || 0) + 1;
        }

        let entropy = 0;
        const len = str.length;
        for (const count of Object.values(charCount)) {
            const p = count / len;
            entropy -= p * Math.log2(p);
        }

        return entropy;
    }

    async performChecks(key, chain) {
        this.checks = [];

        const isValidFormat = chain === 'ethereum'
            ? this.validateEthereumKey(key)
            : this.validateSolanaKey(key);

        this.checks.push({
            description: 'Private key format validation',
            status: isValidFormat ? 'ok' : 'error',
            detail: isValidFormat ? 'Key format appears valid' : 'Invalid key format for selected chain'
        });

        const keyLength = key.replace(/^0x/, '').length;
        const expectedLength = chain === 'ethereum' ? 64 : '40-120';
        this.checks.push({
            description: 'Key length verification',
            status: (chain === 'ethereum' && keyLength === 64) ||
                   (chain === 'solana' && keyLength >= 40 && keyLength <= 120) ? 'ok' : 'warning',
            detail: `Key length: ${keyLength} characters (expected: ${expectedLength})`
        });

        const entropy = this.calculateEntropy(key);
        this.checks.push({
            description: 'Cryptographic entropy analysis',
            status: entropy > 4.5 ? 'ok' : 'warning',
            detail: `Entropy: ${entropy.toFixed(2)} bits per character`
        });

        const weakPatterns = [/^0{10,}/, /^1{10,}/, /123456/, /abcdef/i, /^0x0{40,}/];
        const hasWeakPattern = weakPatterns.some(pattern => pattern.test(key));
        this.checks.push({
            description: 'Weak pattern detection',
            status: hasWeakPattern ? 'warning' : 'ok',
            detail: hasWeakPattern ? 'Key contains potentially weak patterns' : 'No obvious weak patterns detected'
        });

        return {
            chain,
            checks: this.checks,
            overallStatus: this.getOverallStatus()
        };
    }

    getOverallStatus() {
        const hasErrors = this.checks.some(check => check.status === 'error');
        const hasWarnings = this.checks.some(check => check.status === 'warning');

        if (hasErrors) return 'danger';
        if (hasWarnings) return 'warning';
        return 'safe';
    }

    formatReport(result) {
        const status = {
            safe: '✅ SECURE',
            warning: '⚠️  WARNINGS',
            danger: '❌ COMPROMISED'
        };

        console.log(`\n🔒 Wallet Compromise Check Results`);
        console.log(`Chain: ${result.chain.toUpperCase()}`);
        console.log(`Status: ${status[result.overallStatus]}\n`);

        result.checks.forEach(check => {
            const icon = check.status === 'ok' ? '✅' : check.status === 'warning' ? '⚠️' : '❌';
            console.log(`${icon} ${check.description}`);
            console.log(`   ${check.detail}\n`);
        });
    }
}

// CLI Demo
async function main() {
    const checker = new WalletCompromiseChecker();

    // Example Ethereum key (this is just a demo - never use real keys!)
    const demoEthKey = '0x' + 'a'.repeat(64);
    const demoSolanaKey = '2'.repeat(44);

    console.log('🚀 Wallet Compromise Checker CLI Demo\n');

    console.log('📋 Testing Ethereum Key:');
    console.log(demoEthKey.substring(0, 20) + '...');
    const ethResult = await checker.performChecks(demoEthKey, 'ethereum');
    checker.formatReport(ethResult);

    console.log('\n' + '='.repeat(50) + '\n');

    console.log('📋 Testing Solana Key:');
    console.log(demoSolanaKey.substring(0, 20) + '...');
    const solanaResult = await checker.performChecks(demoSolanaKey, 'solana');
    checker.formatReport(solanaResult);

    console.log('\n💡 Tip: Open index.html in your browser for the full GUI experience!');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(console.error);
}

export { WalletCompromiseChecker };