// Run with: npm test  (node --test over the compiled dist)
//
// Locks down the ERC-7739 TypedDataSign wrapping in tools/polymarket/l1-auth-1271
// — the byte-exact workaround for @polymarket/clob-client-v2 issue #65 that was
// ported verbatim from blockrun-mcp. Two layers of defense:
//   1. a pinned golden vector (any byte-level drift in the envelope fails),
//   2. an independent signature recovery via viem, proving the inner signature
//      really is the EOA signing the TypedDataSign struct that embeds the
//      deposit wallet's domain.
// If this test fails after a dependency bump, the ported signing code has drifted
// from the pinned @polymarket/clob-client-v2@1.0.8 internals — do not ship.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const { buildWrapped1271Headers } = await import('../dist/tools/polymarket/l1-auth-1271.js');

// Well-known anvil/hardhat test key #0 — public knowledge, NOT a real wallet.
const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const EOA = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const DEPOSIT = '0x1111111111111111111111111111111111111111';
const TS = 1750000000;

// Generated once from the implementation and pinned. Deterministic: RFC-6979
// ECDSA + fixed key/wallet/timestamp.
const GOLDEN_ENVELOPE =
  '0x800be3f91dff8b8258f7c11c202e0fb1fac364efbc95ed0adaa9bec2b9bca58a404f563d83b55d93943459fd0991e9b829ed7f5b40580acd4ea13d106507ff2b1ccfc66be2a3b30464cb3b588324101f660c9a205fa76e8e5f83ee16a528e1c4cb98550d479dd28abd705cf7f292d37bf03c44d2143e43c1715e09e5c396ed41df436c6f6241757468286164647265737320616464726573732c737472696e672074696d657374616d702c75696e74323536206e6f6e63652c737472696e67206d657373616765290047';

test('polymarket l1-auth: wrapped headers match the pinned golden vector', async () => {
  const account = privateKeyToAccount(TEST_KEY);
  const h = await buildWrapped1271Headers(account, DEPOSIT, TS);

  assert.equal(h.POLY_ADDRESS, DEPOSIT, 'POLY_ADDRESS must be the deposit wallet, not the EOA');
  assert.notEqual(h.POLY_ADDRESS.toLowerCase(), EOA.toLowerCase());
  assert.equal(h.POLY_TIMESTAMP, String(TS));
  assert.equal(h.POLY_NONCE, '0');
  assert.equal(h.POLY_SIGNATURE, GOLDEN_ENVELOPE);
});

test('polymarket l1-auth: envelope layout sig ‖ domainSep ‖ contentsHash ‖ typeString ‖ uint16', async () => {
  const account = privateKeyToAccount(TEST_KEY);
  const h = await buildWrapped1271Headers(account, DEPOSIT, TS);
  const hex = h.POLY_SIGNATURE.slice(2);

  const typeString = 'ClobAuth(address address,string timestamp,uint256 nonce,string message)';
  // 65B sig + 32B domain sep + 32B contents hash + typeString + 2B length.
  assert.equal(hex.length, (65 + 32 + 32 + typeString.length + 2) * 2);
  // Trailing uint16 = byte length of the type descriptor (0x47 = 71).
  assert.equal(hex.slice(-4), typeString.length.toString(16).padStart(4, '0'));
  // The type descriptor rides along in plain ASCII.
  assert.equal(Buffer.from(hex.slice(258, 258 + typeString.length * 2), 'hex').toString(), typeString);
});

test('polymarket l1-auth: inner signature recovers to the EOA over TypedDataSign', async () => {
  const account = privateKeyToAccount(TEST_KEY);
  const h = await buildWrapped1271Headers(account, DEPOSIT, TS);
  const innerSig = `0x${h.POLY_SIGNATURE.slice(2, 2 + 130)}`;

  // Independently reconstruct the exact struct the module is supposed to sign;
  // if the implementation drifts (field order, domain, salt), recovery fails.
  const recovered = await recoverTypedDataAddress({
    domain: { name: 'ClobAuthDomain', version: '1', chainId: 137 },
    types: {
      TypedDataSign: [
        { name: 'contents', type: 'ClobAuth' },
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
        { name: 'salt', type: 'bytes32' },
      ],
      ClobAuth: [
        { name: 'address', type: 'address' },
        { name: 'timestamp', type: 'string' },
        { name: 'nonce', type: 'uint256' },
        { name: 'message', type: 'string' },
      ],
    },
    primaryType: 'TypedDataSign',
    message: {
      contents: {
        address: DEPOSIT,
        timestamp: String(TS),
        nonce: 0n,
        message: 'This message attests that I control the given wallet',
      },
      name: 'DepositWallet',
      version: '1',
      chainId: 137n,
      verifyingContract: DEPOSIT,
      salt: `0x${'00'.repeat(32)}`,
    },
    signature: innerSig,
  });
  assert.equal(recovered.toLowerCase(), EOA.toLowerCase());
});
