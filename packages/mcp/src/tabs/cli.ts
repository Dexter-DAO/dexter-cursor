/**
 * `opendexter tab list|close|remove` — custody surface for the tab lane.
 *
 * close: hands the last seller-ACCEPTED voucher (the settle receipt the
 * lane persisted) to the facilitator's POST /tab/settle. The facilitator
 * submits the on-chain settle (Ed25519 precompile + settle_tab_voucher +
 * Swig transfer) and pays gas — no CLI key signs anything at close; the
 * voucher is already a bearer claim payable only to the seller. This is
 * the grant tab's SETTLE-ONLY close: the on-chain session stays live until
 * the wallet owner revokes it at dexter.cash/wallet or it expires — the
 * CLI holds no passkey and cannot revoke (custody law).
 */

import { Connection } from "@solana/web3.js";
import { SOLANA_RPC_URL } from "../config.js";
import { readSessionFrontier } from "./chain.js";
import {
  findTabByRef,
  loadTabs,
  removeTab,
  updateTab,
} from "./store.js";

const DEFAULT_FACILITATOR = "https://x402.dexter.cash";
const NETWORK = "solana:mainnet";

function usd(atomic: string | undefined): string | null {
  if (!atomic) return null;
  const n = BigInt(atomic);
  const whole = n / 1_000_000n;
  const cents = ((n % 1_000_000n) / 10_000n).toString().padStart(2, "0");
  // TODO(backlog): 2-decimal display truncates sub-cent amounts ($0.001 →
  // "$0.00"). Fine for customer-zero ($0.01/req) and every display-only use
  // here; revisit with a 6-decimal trimmed formatter if a seller ever prices
  // in sub-cents. Never becomes load-bearing for math — atomic strings are.
  return `${whole}.${cents}`;
}

export interface TabCliOpts {
  dataDir?: string;
  facilitatorUrl?: string;
  connection?: Connection;
  log?: (line: string) => void;
}

export async function cliTabList(opts: TabCliOpts = {}): Promise<void> {
  const log = opts.log ?? console.log;
  const tabs = loadTabs(opts.dataDir);
  if (tabs.length === 0) {
    log(JSON.stringify({ tabs: [], tip: "Open one: opendexter tab connect <url>" }, null, 2));
    return;
  }

  const connection = opts.connection ?? new Connection(SOLANA_RPC_URL, "confirmed");
  const rows = await Promise.all(
    tabs.map(async (t) => {
      const row: Record<string, unknown> = {
        status: t.status,
        seller: t.sellerUrl,
        counterparty: t.counterparty,
        agentKey: t.sessionPubkey,
        ...(t.params
          ? {
              capUsdc: usd(t.params.maxAmountAtomic),
              expiresAt: new Date(t.params.expiresAtUnix * 1000).toISOString(),
            }
          : {}),
        ...(t.deadReason ? { deadReason: t.deadReason } : {}),
        ...(t.lastVoucherHeader ? { unsettledReceiptHeld: true } : {}),
      };
      if (t.status === "active" && t.vaultPda) {
        try {
          const frontier = await readSessionFrontier(connection, t.vaultPda, t.counterparty);
          if (frontier) {
            row.live = frontier.live;
            row.spentUsdc = usd(frontier.spentAtomic);
            row.crystallizedUsdc = usd(frontier.crystallizedAtomic);
          }
        } catch {
          row.chainRead = "unavailable"; // an RPC blip must not hide the record
        }
      }
      return row;
    }),
  );
  log(JSON.stringify({ tabs: rows }, null, 2));
}

export async function cliTabClose(ref: string, opts: TabCliOpts = {}): Promise<void> {
  const log = opts.log ?? console.log;
  const record = findTabByRef(ref, opts.dataDir);
  if (!record) {
    log(`No tab found for "${ref}". \`opendexter tab list\` shows what this CLI custodies.`);
    return;
  }

  if (!record.lastVoucherHeader) {
    log(
      `Nothing to settle: no unsettled voucher receipt is held for ${record.sellerUrl}. ` +
        `(The seller's own crystallization lane secures anything already streamed; ` +
        `the on-chain session stays live until it expires or you revoke it at dexter.cash/wallet.)`,
    );
    return;
  }

  // The persisted header is base64(JSON) with hex byte fields — exactly the
  // fields /tab/settle takes, flattened (same wire shape as the SDK's
  // postSettle, recon'd from tab.ts + the facilitator contract).
  let decoded: {
    payload: { channelId: string; cumulativeAmount: string; sequenceNumber: number };
    sessionPublicKey: string;
    sessionRegistration: string;
    sessionSignature: string;
  };
  try {
    decoded = JSON.parse(Buffer.from(record.lastVoucherHeader, "base64").toString("utf8"));
  } catch {
    log(`The held voucher receipt is unreadable — clearing it. Nothing was settled.`);
    updateTab(record.counterparty, { lastVoucherHeader: undefined, lastVoucherAt: undefined }, opts.dataDir);
    return;
  }

  const facilitator = opts.facilitatorUrl ?? DEFAULT_FACILITATOR;
  const res = await fetch(`${facilitator}/tab/settle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      channelId: decoded.payload.channelId,
      cumulativeAmount: decoded.payload.cumulativeAmount,
      sequenceNumber: decoded.payload.sequenceNumber,
      sessionPublicKey: decoded.sessionPublicKey,
      sessionRegistration: decoded.sessionRegistration,
      sessionSignature: decoded.sessionSignature,
      network: NETWORK,
    }),
  });

  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    /* non-JSON error body */
  }

  if (res.ok) {
    const settleTx = String(body.settleTx ?? "");
    updateTab(record.counterparty, { lastVoucherHeader: undefined, lastVoucherAt: undefined }, opts.dataDir);
    log(`Tab settled on-chain.`);
    log(`  cumulative  $${usd(decoded.payload.cumulativeAmount)} (session lifetime)`);
    if (body.grossAmount != null) log(`  gross       $${usd(String(body.grossAmount))}`);
    if (body.netAmount != null) log(`  net→seller  $${usd(String(body.netAmount))}`);
    log(`  tx          ${settleTx}`);
    log(`  https://solscan.io/tx/${settleTx}`);
    log(
      `The on-chain session stays live until it expires or you revoke it at ` +
        `https://dexter.cash/wallet (revoking is the wallet owner's passkey surface — this CLI cannot).`,
    );
    return;
  }

  const errText = String(body.error ?? body.detail ?? res.status);
  if (errText.includes("non_monotonic")) {
    // The chain frontier already covers this voucher — the seller's
    // crystallize lane (or an earlier settle) beat us to it. There is
    // nothing left this receipt can move; clearing it is honest.
    updateTab(record.counterparty, { lastVoucherHeader: undefined, lastVoucherAt: undefined }, opts.dataDir);
    log(
      `Nothing left to settle: the chain has already crystallized or settled at or beyond ` +
        `this receipt (facilitator said: ${errText}). The seller is paid; receipt cleared.`,
    );
    return;
  }

  log(`Settle failed (${res.status}): ${errText}. The receipt is kept — retry later.`);
}

export async function cliTabRemove(ref: string, opts: TabCliOpts = {}): Promise<void> {
  const log = opts.log ?? console.log;
  const record = findTabByRef(ref, opts.dataDir);
  if (!record) {
    log(`No tab found for "${ref}".`);
    return;
  }
  if (record.status === "active") {
    log(
      `Note: removing this record only deletes the LOCAL session key. The on-chain session ` +
        `stays live until it expires (${record.params ? new Date(record.params.expiresAtUnix * 1000).toISOString() : "unknown"}) ` +
        `or you revoke it at https://dexter.cash/wallet.`,
    );
  }
  if (record.lastVoucherHeader) {
    log(`Note: an unsettled voucher receipt was held — settle first with \`opendexter tab close ${record.sellerUrl}\` if you want it on-chain now.`);
  }
  removeTab(record.counterparty, opts.dataDir);
  log(`Removed the tab record for ${record.sellerUrl}.`);
}
