// src/utils/polymarket/setup.ts
//
// action:"setup" — idempotent state machine that walks the account from "bare
// key" to "ready to trade", reporting done/todo at every step. Safe to re-run
// any time (after funding, after a failed batch, after switching sig types).
//
// POLY_1271 (default): derive → deploy (gasless) → fund (user) → approve
// (gasless WALLET batch, confirm-gated) → derive L2 creds → refresh CLOB cache.
// EOA mode (POLYMARKET_SIG_TYPE=0): the EOA holds pUSD itself and sends its own
// approval transactions (requires POL for gas).
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  fallback,
  formatUnits,
  http,
  maxUint256,
  parseUnits,
  type Hex,
  type PublicClient,
} from "viem";
import { polygon } from "viem/chains";
import { AssetType } from "@polymarket/clob-client-v2";
import { checkGeoblock, getClobClient, getPolymarketAccount } from "./client.js";
import {
  assertContractConfig,
  CONDITIONAL_TOKENS,
  CTF_EXCHANGE_V2,
  ERC1155_ABI,
  ERC20_ABI,
  getBoundedApprovalsUsd,
  getSigType,
  NEG_RISK_ADAPTER,
  NEG_RISK_CTF_EXCHANGE_V2,
  POLYGON_RPC_URLS,
  PUSD_COLLATERAL,
  PUSD_DECIMALS,
} from "./constants.js";
import { loadDepositWalletForSigner, loadState, saveState } from "./creds.js";
import {
  deployDepositWallet,
  deriveDepositWallet,
  deriveDepositWalletNoCreds,
  isDepositWalletDeployed,
  relayerCredsMissing,
  relayerCredsMissingMessage,
  sendWalletBatch,
  type DepositWalletCall,
} from "./relayer.js";

let _publicClient: PublicClient | null = null;

export function getPublicClient(): PublicClient {
  if (!_publicClient) {
    _publicClient = createPublicClient({
      chain: polygon,
      transport: fallback(
        POLYGON_RPC_URLS.map((u) => http(u, { retryCount: 2, timeout: 8_000 })),
        { retryCount: 2 },
      ),
    });
  }
  return _publicClient;
}

/**
 * Retry a Polygon read across transient RPC failures. viem's fallback rotates
 * transports on transport-level errors, but a flaky public RPC can still return
 * a bad/stale body that surfaces as a decode error (which fallback does NOT
 * retry) — enough to fail an entire setup on the approvals/balance reads. Re-
 * running the whole read gives the fallback a fresh shot; a few attempts make
 * setup robust to a single RPC hiccup instead of erroring the whole flow.
 */
async function withRpcRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 350 * (i + 1)));
    }
  }
  throw lastErr;
}

interface ApprovalItem {
  label: string;
  token: Hex;
  spender: Hex;
  kind: "erc20" | "erc1155";
  granted: boolean;
}

/**
 * The pUSD allowance we grant per exchange: the bounded amount if
 * POLYMARKET_BOUNDED_APPROVALS is set, else unlimited. Shared by the approval
 * builder AND the "granted?" check so a bounded value below the old $1000
 * threshold still converges (an allowance exactly meeting the target counts).
 */
function pusdApprovalTarget(): bigint {
  const bounded = getBoundedApprovalsUsd();
  return bounded === null ? maxUint256 : parseUnits(String(bounded), PUSD_DECIMALS);
}

/**
 * The approval set Polymarket V2 trading needs from the funds-holding wallet:
 * pUSD spend for buys (both exchanges), CTF operator for sells (both exchanges)
 * plus the NegRisk adapter (negRisk redeem/convert path).
 */
async function readApprovals(owner: Hex): Promise<ApprovalItem[]> {
  const pc = getPublicClient();
  const erc20Spenders: Array<[string, Hex]> = [
    ["pUSD → CTF Exchange V2", CTF_EXCHANGE_V2 as Hex],
    ["pUSD → NegRisk Exchange V2", NEG_RISK_CTF_EXCHANGE_V2 as Hex],
  ];
  const erc1155Operators: Array<[string, Hex]> = [
    ["CTF → CTF Exchange V2", CTF_EXCHANGE_V2 as Hex],
    ["CTF → NegRisk Exchange V2", NEG_RISK_CTF_EXCHANGE_V2 as Hex],
    ["CTF → NegRisk Adapter", NEG_RISK_ADAPTER as Hex],
  ];

  // "granted" = allowance meets the amount we'd approve (bounded or unlimited),
  // so a configured bound of any size converges instead of re-approving forever.
  const target = pusdApprovalTarget();
  const items: ApprovalItem[] = [];
  for (const [label, spender] of erc20Spenders) {
    const allowance = await withRpcRetry(() => pc.readContract({
      address: PUSD_COLLATERAL as Hex,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [owner, spender],
    }));
    items.push({ label, token: PUSD_COLLATERAL as Hex, spender, kind: "erc20", granted: allowance >= target });
  }
  for (const [label, operator] of erc1155Operators) {
    const approved = await withRpcRetry(() => pc.readContract({
      address: CONDITIONAL_TOKENS as Hex,
      abi: ERC1155_ABI,
      functionName: "isApprovedForAll",
      args: [owner, operator],
    }));
    items.push({ label, token: CONDITIONAL_TOKENS as Hex, spender: operator, kind: "erc1155", granted: approved });
  }
  return items;
}

function buildApprovalCalls(missing: ApprovalItem[]): DepositWalletCall[] {
  const erc20Amount = pusdApprovalTarget();
  return missing.map((item) => ({
    target: item.token,
    value: "0",
    data:
      item.kind === "erc20"
        ? encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [item.spender, erc20Amount] })
        : encodeFunctionData({ abi: ERC1155_ABI, functionName: "setApprovalForAll", args: [item.spender, true] }),
  }));
}

export async function getPusdBalance(owner: Hex): Promise<number> {
  const raw = await withRpcRetry(() => getPublicClient().readContract({
    address: PUSD_COLLATERAL as Hex,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [owner],
  }));
  return Number(formatUnits(raw, PUSD_DECIMALS));
}

function approvalChecklist(items: ApprovalItem[]): string {
  return items.map((i) => `  ${i.granted ? "✅" : "❌"} ${i.label}`).join("\n");
}

async function geoblockLine(): Promise<string> {
  const geo = await checkGeoblock();
  const where = geo.country ? ` (egress country: ${geo.country})` : "";
  if (geo.orderPlacement === "permitted") return `✅ Region: order placement permitted from this egress${where}`;
  if (geo.orderPlacement === "blocked") {
    return `❌ Region: order placement BLOCKED from this egress${where}. ` +
      "Route through an unrestricted egress: set POLYMARKET_CLOB_PROXY / HTTPS_PROXY, or point " +
      "POLYMARKET_CLOB_HOST + POLYMARKET_RELAYER_URL at a Tokyo relay (see deploy/tokyo-egress).";
  }
  return "ℹ️ Region: could not determine order-placement status (check re-runs on demand)";
}

const KEY_BACKUP_NOTE =
  "🔑 The Polymarket signer is your BlockRun wallet key (~/.blockrun/.session). " +
  "It is the ONLY key to these funds — back it up; never share or print it.";

export async function runSetup(opts: { confirm: boolean }): Promise<{ text: string; structured: Record<string, unknown> }> {
  // Verify our exchange/collateral addresses still match the SDK's BEFORE any
  // funds-affecting signature (approval batch / EOA approvals) — otherwise an
  // upstream address rotation could have us approving a dead contract.
  assertContractConfig();
  const sigType = getSigType();
  return sigType === 0 ? runSetupEoa(opts) : runSetupDepositWallet(opts);
}

async function runSetupDepositWallet(opts: { confirm: boolean }): Promise<{ text: string; structured: Record<string, unknown> }> {
  const account = getPolymarketAccount();

  if (relayerCredsMissing()) {
    // Even without relayer creds we can DERIVE (not deploy) the deposit wallet
    // address, so the user can pre-fund it while they get creds.
    let depositWallet: Hex | undefined;
    try {
      depositWallet = (loadDepositWalletForSigner(account.address) as Hex | undefined)
        ?? (await deriveDepositWalletNoCreds());
      saveState({ depositWallet, signer: account.address });
    } catch { /* derivation is best-effort here */ }
    const geo = await geoblockLine();
    const balance = depositWallet ? await getPusdBalance(depositWallet).catch(() => 0) : 0;
    return {
      text: [
        `Polymarket setup — deposit-wallet mode (signer ${account.address})`,
        ...(depositWallet
          ? [
              ``,
              `Your deposit wallet (holds betting funds): ${depositWallet}`,
              `  https://polygonscan.com/address/${depositWallet}`,
              `  ${balance > 0 ? `✅ pUSD balance: $${balance.toFixed(2)}` : "❌ Not funded yet"} — you can fund it NOW`,
              `  (send ~$5 pUSD, or USDC via the Polymarket bridge which auto-wraps) while you get relayer creds.`,
            ]
          : []),
        geo,
        ``,
        relayerCredsMissingMessage(),
      ].join("\n"),
      structured: { mode: "POLY_1271", signer: account.address, depositWallet, ready: false, missing: "relayer_credentials" },
    };
  }

  // 1. Derive (pure CREATE2 math) + persist, keyed to the current signer.
  const depositWallet = (loadDepositWalletForSigner(account.address) as Hex | undefined) ?? (await deriveDepositWallet());
  saveState({ depositWallet, signer: account.address });

  // 2. Deploy if missing — gasless, moves no funds, ownership is baked into
  //    the CREATE2 address, so no confirm gate is needed here.
  let deployed = loadState().deployed === true || (await isDepositWalletDeployed(depositWallet));
  let deployTxHash: string | undefined;
  if (!deployed) {
    const res = await deployDepositWallet();
    deployTxHash = res.transactionHash;
    deployed = true;
  }
  saveState({ deployed: true });

  // 3. Funds + approvals state.
  const balance = await getPusdBalance(depositWallet);
  const approvals = await readApprovals(depositWallet);
  const missing = approvals.filter((a) => !a.granted);

  // 4. Approvals batch — the first real signature; confirm-gated with preview.
  let approvalsTxHash: string | undefined;
  let approvalsPending = missing.length > 0;
  if (missing.length > 0 && opts.confirm) {
    const calls = buildApprovalCalls(missing);
    const res = await sendWalletBatch(calls, depositWallet, "Approval batch");
    approvalsTxHash = res.transactionHash;
    approvalsPending = false;
    saveState({ approvalsDone: true });
  } else if (missing.length === 0) {
    saveState({ approvalsDone: true });
  }

  // 5. L2 creds + CLOB balance-cache refresh (needs deposit wallet on disk,
  //    which is guaranteed above). Non-fatal: report instead of failing setup.
  let credsReady = false;
  let credsNote = "";
  try {
    const clob = await getClobClient();
    credsReady = true;
    await clob.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL }).catch(() => undefined);
  } catch (err) {
    credsNote = ` (${err instanceof Error ? err.message.split("\n")[0] : String(err)})`;
  }

  const geo = await geoblockLine();
  const ready = deployed && balance > 0 && !approvalsPending && credsReady;

  const lines = [
    `Polymarket setup — deposit-wallet mode (POLY_1271)`,
    ``,
    `Signer (BlockRun wallet): ${account.address}`,
    `Deposit wallet (holds betting funds): ${depositWallet}`,
    `  https://polygonscan.com/address/${depositWallet}`,
    ``,
    `${deployed ? "✅" : "❌"} Deposit wallet deployed${deployTxHash ? ` (tx ${deployTxHash})` : ""}`,
    `${balance > 0 ? "✅" : "❌"} pUSD balance: $${balance.toFixed(2)}`,
    ...(balance <= 0
      ? [
          `   Fund it: send pUSD (or USDC via the Polymarket bridge/app, which`,
          `   auto-wraps to pUSD) to the DEPOSIT WALLET address above. Only pUSD`,
          `   held in the deposit wallet counts as buying power. ~$5 is plenty for a demo.`,
        ]
      : []),
    `${approvalsPending ? "❌" : "✅"} Exchange approvals${approvalsTxHash ? ` (batch tx ${approvalsTxHash})` : ""}`,
    approvalChecklist(approvals),
    ...(approvalsPending && !opts.confirm
      ? [
          ``,
          `   ${missing.length} approval(s) needed. This authorizes Polymarket's exchange`,
          `   contracts to settle YOUR signed orders from the deposit wallet (gasless`,
          `   batch via the relayer). Re-run action:"setup" with confirm:true to sign.`,
        ]
      : []),
    `${credsReady ? "✅" : "❌"} CLOB API credentials${credsNote}`,
    geo,
    ``,
    ready ? `🎯 Ready to trade. Discover markets with blockrun_markets, then action:"buy".` : `Re-run action:"setup" after completing the ❌ items.`,
    ``,
    KEY_BACKUP_NOTE,
  ];

  return {
    text: lines.join("\n"),
    structured: {
      mode: "POLY_1271",
      signer: account.address,
      depositWallet,
      deployed,
      pusdBalance: balance,
      approvals: approvals.map((a) => ({ label: a.label, granted: a.granted })),
      approvalsPending,
      credsReady,
      ready,
    },
  };
}

async function runSetupEoa(opts: { confirm: boolean }): Promise<{ text: string; structured: Record<string, unknown> }> {
  const account = getPolymarketAccount();
  const pc = getPublicClient();

  const [balance, polWei, approvals] = await Promise.all([
    getPusdBalance(account.address),
    pc.getBalance({ address: account.address }),
    readApprovals(account.address),
  ]);
  const pol = Number(formatUnits(polWei, 18));
  const missing = approvals.filter((a) => !a.granted);

  // EOA mode sends its own approval transactions — needs POL for gas.
  let approvalsPending = missing.length > 0;
  const approvalTxHashes: string[] = [];
  if (missing.length > 0 && opts.confirm) {
    if (pol <= 0) {
      approvalsPending = true;
    } else {
      const wallet = createWalletClient({ account, chain: polygon, transport: http(POLYGON_RPC_URLS[0]) });
      const erc20Amount = pusdApprovalTarget(); // honor POLYMARKET_BOUNDED_APPROVALS in EOA mode too
      for (const item of missing) {
        const hash =
          item.kind === "erc20"
            ? await wallet.writeContract({
                address: item.token,
                abi: ERC20_ABI,
                functionName: "approve",
                args: [item.spender, erc20Amount],
                chain: polygon,
                account,
              })
            : await wallet.writeContract({
                address: item.token,
                abi: ERC1155_ABI,
                functionName: "setApprovalForAll",
                args: [item.spender, true],
                chain: polygon,
                account,
              });
        await pc.waitForTransactionReceipt({ hash });
        approvalTxHashes.push(hash);
      }
      approvalsPending = false;
    }
  }

  let credsReady = false;
  let credsNote = "";
  try {
    const clob = await getClobClient();
    credsReady = true;
    await clob.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL }).catch(() => undefined);
  } catch (err) {
    credsNote = ` (${err instanceof Error ? err.message.split("\n")[0] : String(err)})`;
  }

  const geo = await geoblockLine();
  const ready = balance > 0 && !approvalsPending && credsReady;

  const lines = [
    `Polymarket setup — plain EOA mode (POLYMARKET_SIG_TYPE=0)`,
    ``,
    `Trading wallet (BlockRun key, holds funds directly): ${account.address}`,
    `  https://polygonscan.com/address/${account.address}`,
    ``,
    `${balance > 0 ? "✅" : "❌"} pUSD balance: $${balance.toFixed(2)}`,
    `${pol > 0 ? "✅" : "❌"} POL for gas: ${pol.toFixed(4)} POL`,
    `${approvalsPending ? "❌" : "✅"} Exchange approvals${approvalTxHashes.length ? ` (${approvalTxHashes.length} tx sent)` : ""}`,
    approvalChecklist(approvals),
    ...(approvalsPending && !opts.confirm
      ? [``, `   Re-run action:"setup" with confirm:true to send the approval transactions.`]
      : approvalsPending && pol <= 0
        ? [``, `   Cannot send approvals: the EOA has no POL for gas. Send a little POL first.`]
        : []),
    `${credsReady ? "✅" : "❌"} CLOB API credentials${credsNote}`,
    geo,
    ``,
    ready ? `🎯 Ready to trade.` : `Re-run action:"setup" after completing the ❌ items.`,
    ``,
    KEY_BACKUP_NOTE,
  ];

  return {
    text: lines.join("\n"),
    structured: {
      mode: "EOA",
      signer: account.address,
      pusdBalance: balance,
      polBalance: pol,
      approvals: approvals.map((a) => ({ label: a.label, granted: a.granted })),
      approvalsPending,
      credsReady,
      ready,
    },
  };
}
