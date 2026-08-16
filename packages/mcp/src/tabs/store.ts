/**
 * Tab grant custody — `~/.dexterai-mcp/tabs.json`.
 *
 * This file holds the CLI's custodied SESSION SECRETS (custody mode ii of
 * the /tabs/connect grant ceremony): the CLI generates an ed25519 session
 * keypair per (vault, seller), the human passkey-approves the grant on
 * dexter.cash, and from then on this key signs spend vouchers bounded by
 * the consented cap / expiry / counterparty. It is NOT the wallet key —
 * its blast radius is exactly the scope the human approved, and the session
 * ends on its own expiry or when a new tab with the same seller atomically
 * replaces it on dexter.cash (one session PDA per (vault, counterparty);
 * re-registering closes the old one in the same transaction).
 *
 * Storage follows the wallet.json convention: 0700 dir, 0600 file.
 *
 * WHAT IS DELIBERATELY NOT STORED: the tab's cumulative spend counter.
 * Per the tab-lane design ruling, the on-chain SessionAccount frontier
 * (`max(spent, crystallizedCumulative)`) is the durable counter —
 * `tabFromGrant` reads it at construction. `lastVoucherHeader` below is a
 * settle RECEIPT (the last seller-accepted voucher, a bearer claim payable
 * only to the seller) kept so `opendexter tab close` can hand it to the
 * facilitator's /tab/settle; it is never read back as a counter.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { FinalVoucherV2ReservationReceipt } from "@dexterai/x402/tab";
import { DATA_DIR } from "../config.js";

export const TABS_FILE_NAME = "tabs.json";

export interface TabGrantParams {
  /** Total session cap, atomic USDC (u64 string). */
  maxAmountAtomic: string;
  /** Unix seconds. */
  expiresAtUnix: number;
  nonce: number;
  maxRevolvingCapacityAtomic: string;
}

export interface TabRecord {
  /**
   * pending                 — key minted; human has not approved yet.
   * active                  — context-bound V2 SessionAccount is live.
   * reapproval_required     — historical low-bit V1 grant; never reconstructed
   *                           by x402 v6. The owner must settle/revoke it, then
   *                           explicitly approve a fresh V2 grant.
   * reconciliation_required — V2 reservation/signing/dispatch became
   *                           indeterminate. No other rail may pay until the
   *                           exact voucher obligation is reconciled.
   * dead                    — chain says the session is gone (revoked / expired
   *                           / replaced); kept for visibility.
   */
  status:
    | "pending"
    | "active"
    | "reapproval_required"
    | "reconciliation_required"
    | "dead";
  /** The URL the tab was connected for (display + channel derivation). */
  sellerUrl: string;
  /** Seller settlement pubkey (base58) from the 402's tab accept payTo. */
  counterparty: string;
  /** base58 ed25519 session pubkey — the `agent` in the consent link. */
  sessionPubkey: string;
  /** base58 64-byte nacl secretKey. THE custody artifact. */
  sessionSecretKey: string;
  /** The user's vault PDA — learned from the chain at approval. */
  vaultPda?: string;
  /** The consented scope — read from the chain at approval (chain = truth). */
  params?: TabGrantParams;
  /** The SessionAccount PDA (for status reads). */
  sessionPda?: string;
  createdAt: string;
  activatedAt?: string;
  deadReason?: string;
  /** Last released voucher header (base64). V1 is written after seller
   * acceptance; V2 is written after reservation and before merchant dispatch. */
  lastVoucherHeader?: string;
  lastVoucherAt?: string;
  /** Voucher generation and exact increment needed by current settle/recovery. */
  lastVoucherVersion?: 1 | 2;
  lastVoucherIncrementAtomic?: string;
  /** V2 provider lifecycle evidence plus whether the SDK's independent
   * transaction/post-state verification completed before release. */
  lastFinalV2ReservationReceipt?: FinalVoucherV2ReservationReceipt;
  lastFinalV2ReservationVerified?: boolean;
}

interface TabsFile {
  version: 1;
  tabs: TabRecord[];
}

export class TabCustodyStoreError extends Error {
  constructor(path: string, cause?: unknown) {
    super(
      `tab_custody_store_unreadable: ${path}; refusing to treat unknown ` +
        "voucher obligations as an empty store",
      { cause },
    );
    this.name = "TabCustodyStoreError";
  }
}

function fileFor(dir?: string): string {
  return join(dir ?? DATA_DIR, TABS_FILE_NAME);
}

export function loadTabs(dir?: string): TabRecord[] {
  const file = fileFor(dir);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<TabsFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.tabs)) {
      throw new Error("tab_custody_store_shape_invalid");
    }
    return parsed.tabs as TabRecord[];
  } catch (cause) {
    // An unreadable store can contain a reserved FINAL voucher. Treating it
    // as empty would permit a second rail and could overwrite the only local
    // reconciliation evidence. The shared fetch wrapper turns this failure
    // into a terminal outcome; the original file remains untouched.
    throw new TabCustodyStoreError(file, cause);
  }
}

export function saveTabs(tabs: TabRecord[], dir?: string): void {
  const base = dir ?? DATA_DIR;
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const payload: TabsFile = { version: 1, tabs };
  const file = fileFor(dir);
  // Atomic write: this file holds custodied session SECRETS + unsettled
  // settle receipts. A torn writeFileSync (crash / disk-full mid-write)
  // would leave truncated JSON that a future load must refuse. Write a temp
  // file, then rename:
  // rename is atomic on POSIX, so a reader sees either the whole old file or
  // the whole new one, never a half. 0600 is set at temp creation AND
  // re-asserted after (a pre-existing temp could carry looser perms).
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/** One grant per counterparty: upsert REPLACES any existing record. */
export function upsertTab(record: TabRecord, dir?: string): void {
  const tabs = loadTabs(dir).filter((t) => t.counterparty !== record.counterparty);
  tabs.push(record);
  saveTabs(tabs, dir);
}

export function findTab(counterparty: string, dir?: string): TabRecord | null {
  return loadTabs(dir).find((t) => t.counterparty === counterparty) ?? null;
}

/**
 * Find by a human-friendly reference: exact counterparty, exact seller URL,
 * or same host as the given URL.
 */
export function findTabByRef(ref: string, dir?: string): TabRecord | null {
  const tabs = loadTabs(dir);
  const exact = tabs.find((t) => t.counterparty === ref || t.sellerUrl === ref);
  if (exact) return exact;
  try {
    const host = new URL(ref).host;
    return tabs.find((t) => {
      try {
        return new URL(t.sellerUrl).host === host;
      } catch {
        return false;
      }
    }) ?? null;
  } catch {
    return null;
  }
}

export function removeTab(counterparty: string, dir?: string): boolean {
  const tabs = loadTabs(dir);
  const next = tabs.filter((t) => t.counterparty !== counterparty);
  if (next.length === tabs.length) return false;
  saveTabs(next, dir);
  return true;
}

/** Patch one record in place (by counterparty). No-op if absent. */
export function updateTab(
  counterparty: string,
  patch: Partial<TabRecord>,
  dir?: string,
): void {
  const tabs = loadTabs(dir);
  const idx = tabs.findIndex((t) => t.counterparty === counterparty);
  if (idx === -1) return;
  tabs[idx] = { ...tabs[idx], ...patch };
  saveTabs(tabs, dir);
}
