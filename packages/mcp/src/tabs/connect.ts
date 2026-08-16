/**
 * `opendexter tab connect <url>` — the consent handoff (Rail C).
 *
 * The CLI mints an ed25519 session keypair, custodies the secret in
 * ~/.dexterai-mcp/tabs.json (custody mode ii — the designed shape), and
 * hands the human the EXISTING dexter.cash consent deep link:
 *
 *   https://dexter.cash/tabs/connect?url=<seller>&agent=<sessionPubkey>
 *
 * That page resolves the seller's live 402 terms and bridges to /tabs/new,
 * where ONE passkey tap registers the session on chain (Dexter sponsors the
 * tx). Consent is structural: this CLI holds no passkey, so it is
 * cryptographically unable to open the tab itself — the program verifies
 * the passkey ceremony inside the register instruction.
 *
 * CALLBACK CONTRACT (recon'd from the fe source, 2026-07-05): the
 * /tabs/connect blob carries NO callback — ConnectTab.tsx's
 * requestSpendGrant call has no `callback` field, so OpenTabConsent
 * neither redirects nor POSTs after approval. The human may also approve
 * on their PHONE. So the CLI POLLS THE CHAIN: the approval writes a
 * SessionAccount PDA carrying our session pubkey + every consented scope
 * field; getProgramAccounts finds it by (sessionPubkey, counterparty) and
 * the record is promoted pending → active with the CHAIN's params (which
 * tabFromGrant's drift guard then re-verifies on every construction).
 */

import { Connection, PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { SOLANA_RPC_URL } from "../config.js";
import { findSessionByAgentKey } from "./chain.js";
import { findTab, upsertTab, updateTab, type TabRecord } from "./store.js";

/** The consent surface is dexter.cash (the wallet's home), not the API host. */
const CONSENT_BASE = "https://dexter.cash";

export function consentLinkFor(sellerUrl: string, sessionPubkey: string): string {
  return `${CONSENT_BASE}/tabs/connect?url=${encodeURIComponent(sellerUrl)}&agent=${sessionPubkey}`;
}

/**
 * Mint a fresh PENDING grant record for (sellerUrl, counterparty): generate
 * the ed25519 session keypair and persist it — 0700 dir / 0600 file, atomic
 * write — BEFORE any consent link leaves the process. Links, logs, and tool
 * results carry only the public key. Shared by `opendexter tab connect` and
 * the tab lane's in-band offer.
 */
export function mintPendingTab(
  sellerUrl: string,
  counterparty: string,
  dir?: string,
): TabRecord {
  const kp = nacl.sign.keyPair();
  const record: TabRecord = {
    status: "pending",
    sellerUrl,
    counterparty,
    sessionPubkey: new PublicKey(kp.publicKey).toBase58(),
    sessionSecretKey: bs58.encode(kp.secretKey),
    createdAt: new Date().toISOString(),
  };
  upsertTab(record, dir);
  return record;
}

export interface TabConnectOpts {
  /** Poll the chain for the approval (default true). */
  wait?: boolean;
  pollIntervalMs?: number;
  timeoutMs?: number;
  dev?: boolean;
  /**
   * Force a fresh session key even when an ACTIVE tab already exists. This
   * is the recovery path when a long-lived tab has outgrown the seller's
   * per-voucher resume window (cumulative_exceeds_cap): re-approving on
   * dexter.cash atomically replaces the live session in the same transaction
   * — the old scope closes and the fresh tab starts at zero spend, clear of
   * the frontier that tripped the bound. Replaces the local record in place
   * after the human re-approves.
   */
  rekey?: boolean;
  /** Test seams. */
  dataDir?: string;
  connection?: Connection;
  log?: (line: string) => void;
}

// TODO(backlog): see cli.ts::usd — 2-decimal display truncates sub-cent
// amounts. Display-only; atomic strings carry the load-bearing values.
function usd(atomic: string): string {
  const n = BigInt(atomic);
  const whole = n / 1_000_000n;
  const cents = ((n % 1_000_000n) / 10_000n).toString().padStart(2, "0");
  return `${whole}.${cents}`;
}

/**
 * Probe the seller and pull its tab terms off its own 402 — the same
 * wire-truth read the consent page performs (never the CLI's claims).
 */
async function resolveSellerTerms(
  url: string,
): Promise<
  | { kind: "terms"; counterparty: string; perRequestAtomic: string }
  | { kind: "free" }
  | { kind: "no_tab"; schemesOffered: string[] }
  | { kind: "error"; detail: string }
> {
  const { resolveTabTerms } = await import("@dexterai/x402/tab");
  const result = await resolveTabTerms(url);
  if (result.kind === "terms") {
    return {
      kind: "terms",
      counterparty: result.terms.counterparty,
      perRequestAtomic: result.terms.perRequest.atomic,
    };
  }
  if (result.kind === "free") {
    // Consume/cancel the live body we own per the resolveTabTerms contract.
    try {
      await result.response.body?.cancel();
    } catch {
      /* noop */
    }
    return { kind: "free" };
  }
  if (result.kind === "no_tab") return { kind: "no_tab", schemesOffered: result.schemesOffered };
  return { kind: "error", detail: result.detail };
}

export async function cliTabConnect(url: string, opts: TabConnectOpts = {}): Promise<void> {
  const log = opts.log ?? console.log;
  const dir = opts.dataDir;
  const wait = opts.wait !== false;
  const pollIntervalMs = opts.pollIntervalMs ?? 5_000;
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;

  const terms = await resolveSellerTerms(url);
  if (terms.kind === "free") {
    log("This service answered without asking for payment — there is nothing to connect a tab to.");
    return;
  }
  if (terms.kind === "no_tab") {
    log(
      `This service takes payment but doesn't offer tabs ` +
        `(offers: ${terms.schemesOffered.join(", ") || "none"}). Use \`opendexter fetch\` to pay per call.`,
    );
    return;
  }
  if (terms.kind === "error") {
    log(`Couldn't resolve this service: ${terms.detail}`);
    return;
  }

  const counterparty = terms.counterparty;
  const existing = findTab(counterparty, dir);

  let record: TabRecord;
  if (existing?.status === "reconciliation_required") {
    log(
      `This tab has a FINAL voucher that still needs reconciliation. Opening a ` +
        `replacement could hide or strand that obligation, so OpenDexter will ` +
        `not re-key it yet. Run \`opendexter tab close ${url}\` or reconcile the ` +
        `recorded reservation first.`,
    );
    return;
  } else if (existing?.status === "reapproval_required" && !opts.rekey) {
    log(
      `This tab uses the retired voucher format. Settle or revoke it through ` +
        `the wallet/deployment that opened it, then explicitly approve a new ` +
        `V2 grant with:`,
    );
    log(`  opendexter tab connect ${url} --rekey`);
    return;
  } else if (existing && existing.status === "active" && !opts.rekey) {
    log(`A tab with this seller is already open (cap $${usd(existing.params!.maxAmountAtomic)}, `);
    log(`expires ${new Date(existing.params!.expiresAtUnix * 1000).toISOString()}).`);
    log(`Paid calls to it already ride the tab. \`opendexter tab list\` shows its state.`);
    log(`If it keeps refusing vouchers (cumulative_exceeds_cap), open a fresh one:`);
    log(`  opendexter tab connect ${url} --rekey`);
    return;
  } else if (existing && existing.status === "pending" && !opts.rekey) {
    // Re-run while awaiting approval: SAME custodied key, no key churn —
    // the link the human may already have open stays valid.
    record = existing;
  } else {
    // Fresh key. Three arrivals here:
    //  - no record, or a DEAD record (natural re-connect);
    //  - --rekey over an ACTIVE or pending record (the cumulative_exceeds_cap
    //    recovery path: a new grant on a new channel).
    // In every case upsert REPLACES in place. Warn loudly before discarding
    // an unsettled receipt — the same disclosure `tab remove` prints.
    if (existing?.lastVoucherHeader) {
      log(
        `Note: the existing tab holds an UNSETTLED voucher receipt. Re-keying ` +
          `discards it (the new key cannot settle the old channel). Settle it ` +
          `first if you want it on-chain: \`opendexter tab close ${url}\`.`,
      );
    }
    record = mintPendingTab(url, counterparty, dir);
  }

  const link = consentLinkFor(url, record.sessionPubkey);
  log("");
  log("── Open a tab ──────────────────────────────────────────────");
  log(`Seller     ${url}`);
  log(`Price      $${usd(terms.perRequestAtomic)} per request (pays to ${counterparty.slice(0, 4)}…${counterparty.slice(-4)})`);
  log(`Agent key  ${record.sessionPubkey}  (custodied by this CLI, bounded by what you approve)`);
  log("");
  log("Approve it with your passkey — open this link on any device:");
  log("");
  log(`  ${link}`);
  log("");

  if (!wait) {
    log("Not waiting (--no-wait). Re-run this command to resume polling for the approval.");
    return;
  }

  log("Waiting for your approval (polling the chain; Ctrl-C is safe — re-run to resume)…");
  const connection = opts.connection ?? new Connection(SOLANA_RPC_URL, "confirmed");
  const deadline = Date.now() + timeoutMs;

  let warnedRpc = false;
  while (Date.now() < deadline) {
    let found;
    try {
      found = await findSessionByAgentKey(connection, record.sessionPubkey, counterparty);
    } catch (err: unknown) {
      // An RPC blip must not kill the ceremony — the approval may already be
      // on chain. Warn once (loudly, per the no-silent-fallbacks rule) and
      // keep polling until the deadline.
      if (!warnedRpc) {
        warnedRpc = true;
        const msg = err instanceof Error ? err.message.split("\n")[0].slice(0, 120) : String(err);
        log(`(RPC hiccup while polling — still waiting: ${msg})`);
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      continue;
    }
    if (found && found.live) {
      if ((found.params.nonce >>> 31) !== 1) {
        updateTab(
          counterparty,
          {
            status: "reapproval_required",
            vaultPda: found.vaultPda,
            params: found.params,
            sessionPda: found.sessionPda,
            deadReason:
              "native_tab_v1_migration_required: historical low-bit grant must be explicitly reapproved",
          },
          dir,
        );
        log("");
        log(
          `The approval found on chain uses the retired voucher format, so ` +
            `OpenDexter did not activate it. Settle or revoke that historical ` +
            `session, then run \`opendexter tab connect ${url} --rekey\` and ` +
            `approve the new grant.`,
        );
        return;
      }
      updateTab(
        counterparty,
        {
          status: "active",
          vaultPda: found.vaultPda,
          params: found.params,
          sessionPda: found.sessionPda,
          activatedAt: new Date().toISOString(),
        },
        dir,
      );
      log("");
      log("── Tab open ────────────────────────────────────────────────");
      log(`Limit      $${usd(found.params.maxAmountAtomic)} (chain-enforced)`);
      log(`Expires    ${new Date(found.params.expiresAtUnix * 1000).toISOString()}`);
      log(`Vault      ${found.vaultPda}`);
      log(`Session    ${found.sessionPda}`);
      log("");
      log(`Paid calls to this seller now stream on your tab:`);
      log(`  opendexter fetch ${url}`);
      log(`Settle it any time with:`);
      log(`  opendexter tab close ${url}`);
      return;
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  log("");
  const waited =
    timeoutMs >= 60_000
      ? `${Math.round(timeoutMs / 60_000)} minute(s)`
      : `${Math.round(timeoutMs / 1000)} seconds`;
  log(
    `No approval seen after ${waited}. The link stays valid — ` +
      `re-run \`opendexter tab connect ${url}\` to resume polling with the same key.`,
  );
}
