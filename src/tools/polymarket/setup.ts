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
  CTF_COLLATERAL_ADAPTER,
  CTF_EXCHANGE_V2,
  ERC1155_ABI,
  ERC20_ABI,
  getBoundedApprovalsUsd,
  getSigType,
  NEG_RISK_ADAPTER,
  NEG_RISK_CTF_COLLATERAL_ADAPTER,
  NEG_RISK_CTF_EXCHANGE_V2,
  POLYGON_READ_RPC_URLS,
  POLYGON_WRITE_RPC_URL,
  PUSD_COLLATERAL,
  PUSD_DECIMALS,
} from "./constants.js";
import { loadDepositWalletForSigner, loadState, saveState } from "./creds.js";
import {
  deployDepositWallet,
  deriveDepositWallet,
  isDepositWalletDeployed,
  sendWalletBatch,
  type DepositWalletCall,
} from "./relayer.js";
import { assertTransactionSucceeded } from "./transactions.js";

let _publicClient: PublicClient | null = null;

export function getPublicClient(): PublicClient {
  if (!_publicClient) {
    _publicClient = createPublicClient({
      chain: polygon,
      transport: fallback(
        POLYGON_READ_RPC_URLS.map((u) => http(u, { retryCount: 2, timeout: 8_000 })),
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

export interface ApprovalItem {
  label: string;
  token: Hex;
  spender: Hex;
  kind: "erc20" | "erc1155";
  granted: boolean;
}

/**
 * An approval transaction landing is not the same as the approvals being on
 * the books — re-read the chain (retrying across RPC propagation lag, the same
 * 3×750ms shape as redeem's post-transaction reads) and believe ONLY what it
 * says. An empty read can never count as granted, so a truncated RPC response
 * cannot fake success. Throws if every read attempt fails; the caller decides
 * how to report "chain state unknown". `readFn` is injected so tests can pin
 * the retry/verdict logic without an RPC.
 */
export async function verifyApprovalsLanded(
  readFn: () => Promise<ApprovalItem[]>,
  attempts = 3,
  delayMs = 750,
): Promise<{ approvals: ApprovalItem[]; allGranted: boolean }> {
  let latest: ApprovalItem[] | null = null;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      latest = await readFn();
      if (latest.length > 0 && latest.every((a) => a.granted)) {
        return { approvals: latest, allGranted: true };
      }
    } catch (err) {
      lastErr = err;
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  if (latest === null) throw lastErr;
  return { approvals: latest, allGranted: false };
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
 * Polymarket's own canonical approveTokensForTrading.ts (proxy/safe wallet) —
 * pUSD spend for ALL FOUR collateral spenders (both exchanges, the Conditional
 * Tokens contract for direct split/merge, AND the NegRisk Adapter, whose
 * negRisk order settlement / convert pulls collateral through it) plus the CTF
 * operator for both exchanges and the NegRisk Adapter — PLUS, beyond the
 * canonical script, CTF operator for the two pUSD collateral adapters, which
 * pull the outcome tokens during action:"redeem" (five ERC-1155 operators in
 * total). Removing the adapter operators silently reintroduces the
 * redeem-pays-$0 bug.
 *
 * The NegRisk Adapter pUSD approval is REQUIRED to trade neg-risk markets (e.g.
 * multi-outcome "winner" markets): without it the CLOB accepts the order but
 * settlement through the adapter reverts. It was previously missing while the
 * adapter's CTF (ERC1155) operator approval was granted — an asymmetry that let
 * setup report "ready" yet neg-risk buys fail.
 */
async function readApprovals(owner: Hex): Promise<ApprovalItem[]> {
  const pc = getPublicClient();
  const erc20Spenders: Array<[string, Hex]> = [
    ["pUSD → CTF Exchange V2", CTF_EXCHANGE_V2 as Hex],
    ["pUSD → NegRisk Exchange V2", NEG_RISK_CTF_EXCHANGE_V2 as Hex],
    ["pUSD → NegRisk Adapter", NEG_RISK_ADAPTER as Hex],
    ["pUSD → Conditional Tokens", CONDITIONAL_TOKENS as Hex],
  ];
  // The two collateral adapters are the redeem path (they pull the caller's
  // outcome tokens via safeBatchTransferFrom, so they need operator approval).
  // Wallets set up before 2026-07 lack these; readApprovals runs on-chain
  // every setup, so they self-heal with one action:"setup" confirm:true.
  const erc1155Operators: Array<[string, Hex]> = [
    ["CTF → CTF Exchange V2", CTF_EXCHANGE_V2 as Hex],
    ["CTF → NegRisk Exchange V2", NEG_RISK_CTF_EXCHANGE_V2 as Hex],
    ["CTF → NegRisk Adapter", NEG_RISK_ADAPTER as Hex],
    ["CTF → CtfCollateral Adapter (redeem)", CTF_COLLATERAL_ADAPTER as Hex],
    ["CTF → NegRisk CtfCollateral Adapter (redeem)", NEG_RISK_CTF_COLLATERAL_ADAPTER as Hex],
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
      "Point POLYMARKET_CLOB_HOST + POLYMARKET_RELAYER_URL at a permitted-region relay " +
      "(see deploy/finland-egress) or restore the default. A proxy alone (POLYMARKET_CLOB_PROXY / " +
      "HTTPS_PROXY) only changes how the current egress is reached, not the Polymarket-facing IP.";
  }
  return "ℹ️ Region: could not determine order-placement status (check re-runs on demand)";
}

const KEY_BACKUP_NOTE =
  "🔑 The Polymarket signer is your BlockRun wallet key (~/.blockrun/.session by default; " +
  "a BLOCKRUN_WALLET_KEY env var or an existing agent wallet.json takes precedence). It is " +
  "the ONLY key to these funds — back up the key behind the signer address shown above, " +
  "wherever it lives (key file, or the env-var value itself); never share or print it.";

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
    // The relayer deployed *something*; only contract code at the CREATE2
    // address WE derived proves it deployed THIS wallet. If factory/salt ever
    // diverge between derive and deploy, recording deployed:true here would
    // point approvals and funding at an address that doesn't exist — stranding
    // real money (issue #72 finding 4). Retry the read across RPC lag.
    for (let attempt = 0; attempt < 3 && !deployed; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 750));
      const code = await getPublicClient().getCode({ address: depositWallet }).catch(() => undefined);
      deployed = typeof code === "string" && code !== "0x";
    }
    if (!deployed) {
      throw new Error(
        `Deposit wallet deploy confirmed (tx ${deployTxHash}) but no contract code is visible at the derived ` +
        `address ${depositWallet} after 3 reads. Either the RPCs are lagging (re-run action:"setup" in a minute — ` +
        `it re-checks) or the relayer deployed a different address than we derived, in which case do NOT fund ` +
        `this wallet until that is resolved.`,
      );
    }
  }
  saveState({ deployed: true });

  // 3. Funds + approvals state.
  const balance = await getPusdBalance(depositWallet);
  let approvals = await readApprovals(depositWallet);
  const missing = approvals.filter((a) => !a.granted);

  // 4. Approvals batch — the first real signature; confirm-gated with preview.
  let approvalsTxHash: string | undefined;
  let approvalsPending = missing.length > 0;
  let approvalsUnverified = false;
  if (missing.length > 0 && opts.confirm) {
    const calls = buildApprovalCalls(missing);
    const res = await sendWalletBatch(calls, depositWallet, "Approval batch");
    approvalsTxHash = res.transactionHash;
    // The batch landing proves it was MINED, not that the approvals are on the
    // books. The response used to carry the pre-batch snapshot here, so every
    // item the batch had just granted still read granted:false — and the
    // inverse failure (relayer claims success, chain disagrees) was invisible.
    try {
      const verified = await verifyApprovalsLanded(() => readApprovals(depositWallet));
      if (verified.approvals.length > 0) approvals = verified.approvals;
      approvalsPending = !verified.allGranted;
      approvalsUnverified = !verified.allGranted;
    } catch {
      // Chain state unknown after the tx landed — keep the pre-batch snapshot
      // and report unverified rather than claiming success.
      approvalsPending = true;
      approvalsUnverified = true;
    }
    if (!approvalsPending) saveState({ approvalsDone: true });
  } else if (missing.length === 0) {
    saveState({ approvalsDone: true });
  }

  // 5. L2 creds + CLOB balance-cache refresh (needs deposit wallet on disk,
  //    which is guaranteed above). Non-fatal: report instead of failing setup.
  let credsReady = false;
  let credsNote = "";
  let balanceCacheWarned = "";
  try {
    const clob = await getClobClient();
    credsReady = true;
    // Warm the CLOB's server-side balance cache so the first buy sees the funds.
    // Best-effort — but do NOT swallow silently: if it fails, setup used to still
    // print "ready" while the exchange thought the wallet was empty, so the first
    // buy failed with "not enough balance". Surface it instead; the buy path also
    // refreshes on demand now (see orders.ts), so this is a note, not a blocker.
    try {
      await clob.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    } catch (refreshErr) {
      balanceCacheWarned = refreshErr instanceof Error ? refreshErr.message.split("\n")[0] : String(refreshErr);
    }
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
    ...(approvalsUnverified
      ? [
          ``,
          `   ⚠️ The approval batch landed but the chain does not (yet) show every`,
          `   approval granted — treat them as NOT granted. Re-run action:"setup"`,
          `   to re-check before trading or redeeming.`,
        ]
      : []),
    `${credsReady ? "✅" : "❌"} CLOB API credentials${credsNote}`,
    ...(balanceCacheWarned
      ? [`   ⚠️ Balance cache not pre-warmed (${balanceCacheWarned}) — your first buy refreshes it automatically.`]
      : []),
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
      ...(approvalsTxHash ? { approvalsTxHash } : {}),
      ...(approvalsUnverified ? { approvalsUnverified: true } : {}),
      credsReady,
      ready,
    },
  };
}

async function runSetupEoa(opts: { confirm: boolean }): Promise<{ text: string; structured: Record<string, unknown> }> {
  const account = getPolymarketAccount();
  const pc = getPublicClient();

  const [balance, polWei, initialApprovals] = await Promise.all([
    getPusdBalance(account.address),
    pc.getBalance({ address: account.address }),
    readApprovals(account.address),
  ]);
  let approvals = initialApprovals;
  const pol = Number(formatUnits(polWei, 18));
  const missing = approvals.filter((a) => !a.granted);

  // EOA mode sends its own approval transactions — needs POL for gas.
  let approvalsPending = missing.length > 0;
  let approvalsUnverified = false;
  const approvalTxHashes: string[] = [];
  if (missing.length > 0 && opts.confirm) {
    if (pol <= 0) {
      approvalsPending = true;
    } else {
      const wallet = createWalletClient({ account, chain: polygon, transport: http(POLYGON_WRITE_RPC_URL) });
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
        assertTransactionSucceeded(
          await pc.waitForTransactionReceipt({ hash }),
          `approval transaction (${item.label})`,
          hash,
        );
        approvalTxHashes.push(hash);
      }
      // Same rule as the deposit-wallet batch: report the post-transaction
      // chain state, not the pre-transaction snapshot the report was built on.
      try {
        const verified = await verifyApprovalsLanded(() => readApprovals(account.address));
        if (verified.approvals.length > 0) approvals = verified.approvals;
        approvalsPending = !verified.allGranted;
        approvalsUnverified = !verified.allGranted;
      } catch {
        approvalsPending = true;
        approvalsUnverified = true;
      }
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
    ...(approvalsUnverified
      ? [
          ``,
          `   ⚠️ The approval transactions landed but the chain does not (yet) show every`,
          `   approval granted — treat them as NOT granted. Re-run action:"setup" to re-check.`,
        ]
      : []),
    `${credsReady ? "✅" : "❌"} CLOB API credentials${credsNote}`,
    geo,
    ``,
    ready
      ? `🎯 Ready to trade. Note: the CLOB may reject plain-EOA makers on order placement — ` +
        `the deposit wallet (unset POLYMARKET_SIG_TYPE) is the supported trading path.`
      : `Re-run action:"setup" after completing the ❌ items.`,
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
      ...(approvalTxHashes.length ? { approvalTxHashes } : {}),
      ...(approvalsUnverified ? { approvalsUnverified: true } : {}),
      credsReady,
      ready,
    },
  };
}
