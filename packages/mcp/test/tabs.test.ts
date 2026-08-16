/**
 * The tab lane — CLI-custodied session keys, consent handoff, tab-first payment.
 *
 * Verification oracles are REAL where money correctness lives (same discipline
 * as the SDK's own from-grant suite):
 *  - the voucher round trip runs the ACTUAL seller `tabMiddleware` from
 *    @dexterai/x402/tab/seller (base64/hex decode, parseRegistration,
 *    on-chain verify, ed25519, enforceScope, per-voucher increment bound)
 *    against a faked RPC serving a real-layout 162-byte SessionAccount;
 *  - the chain poll test asserts the memcmp offsets agree with the canonical
 *    @dexterai/vault decodeSessionAccount layout by decoding what it finds;
 *  - the 402 fixture for consent tests is the LIVE customer-zero body
 *    (api.dexter.cash/api/x402/tab-demo/tick), captured 2026-07-05.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import { tabMiddleware } from "@dexterai/x402/tab/seller";
import {
  DEXTER_VAULT_PROGRAM_ID,
  tabFromGrant as sdkTabFromGrant,
  voucherToHeader,
  type FinalVoucherV2ReservationInput,
  type FinalVoucherV2ReservationReceipt,
  type SignedVoucher,
  type Tab,
} from "@dexterai/x402/tab";
import { VAULT_ACCOUNT_DISCRIMINATOR } from "@dexterai/vault/constants";
import type {
  Request as ExpressRequest,
  Response as ExpressResponse,
  NextFunction,
} from "express";

import {
  loadTabs,
  saveTabs,
  upsertTab,
  findTab,
  removeTab,
  type TabRecord,
} from "../src/tabs/store.js";
import { findSessionByAgentKey } from "../src/tabs/chain.js";
import { createTabLane, resetTabLaneCacheForTests } from "../src/tabs/lane.js";
import { consentLinkFor, cliTabConnect } from "../src/tabs/connect.js";
import { cliTabClose } from "../src/tabs/cli.js";
import { x402Fetch, registerFetchTool } from "../../x402-mcp-tools/src/tools/fetch.js";
import { readdirSync } from "node:fs";

// ── Fixtures ────────────────────────────────────────────────────────────

const SELLER_URL = "https://api.dexter.cash/api/x402/tab-demo/tick";
const COUNTERPARTY = "FKF63wLt122SLDNPBfpDgrMcQzxtdLfLyrUS1KziRR1h";
const FAC = "https://fac.test";
const NOW = Math.floor(Date.now() / 1000);
const CONTEXT_BOUND_V2_NONCE = 0x8000002a;

/** The LIVE customer-zero 402 body (captured 2026-07-05). */
function live402Body(overrides: { payTo?: string } = {}) {
  const payTo = overrides.payTo ?? COUNTERPARTY;
  return {
    error: "Payment required",
    accepts: [
      {
        scheme: "tab",
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        amount: "10000",
        maxAmountRequired: "10000",
        asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        payTo,
        maxTimeoutSeconds: 60,
        extra: {
          feePayer: "DeXterR2kQm8AvRHnNPatWkE46TfAcMeBDjb6FySoAb8",
          decimals: 6,
          voucherHeader: "x-tab-voucher",
          registrationEncoding: "base64(188-byte sessionRegisterMessage)",
        },
      },
      {
        scheme: "exact",
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        amount: "10000",
        maxAmountRequired: "10000",
        asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        payTo,
        maxTimeoutSeconds: 60,
        extra: { feePayer: "DeXterR2kQm8AvRHnNPatWkE46TfAcMeBDjb6FySoAb8", decimals: 6 },
      },
    ],
    resource: { url: SELLER_URL, description: "tick", mimeType: "application/json" },
  };
}

interface GrantFixture {
  kp: nacl.SignKeyPair;
  record: TabRecord;
  vault: PublicKey;
  counterparty: PublicKey;
}

function makeGrant(over: Partial<TabRecord> = {}, counterparty?: PublicKey): GrantFixture {
  const kp = nacl.sign.keyPair();
  const vault = Keypair.generate().publicKey;
  const cp = counterparty ?? new PublicKey(COUNTERPARTY);
  const record: TabRecord = {
    status: "active",
    sellerUrl: SELLER_URL,
    counterparty: cp.toBase58(),
    sessionPubkey: new PublicKey(kp.publicKey).toBase58(),
    sessionSecretKey: bs58.encode(kp.secretKey),
    vaultPda: vault.toBase58(),
    params: {
      maxAmountAtomic: "5000000", // $5.00 cap
      expiresAtUnix: NOW + 3600,
      nonce: CONTEXT_BOUND_V2_NONCE,
      maxRevolvingCapacityAtomic: "5000000",
    },
    createdAt: new Date().toISOString(),
    ...over,
  };
  return { kp, record, vault, counterparty: cp };
}

/** Real-layout 162-byte SessionAccount (canonical @dexterai/vault decode contract). */
function sessionAccountData(g: GrantFixture, over: {
  version?: number;
  spent?: bigint;
  crystallized?: bigint;
} = {}): Buffer {
  const buf = Buffer.alloc(162);
  Buffer.from([74, 34, 65, 133, 96, 163, 80, 69]).copy(buf, 0); // discriminator
  buf.writeUInt8(over.version ?? 1, 8);
  buf.writeUInt8(255, 9);
  g.vault.toBuffer().copy(buf, 10);
  Buffer.from(g.kp.publicKey).copy(buf, 42);
  buf.writeBigUInt64LE(BigInt(g.record.params!.maxAmountAtomic), 74);
  buf.writeBigInt64LE(BigInt(g.record.params!.expiresAtUnix), 82);
  g.counterparty.toBuffer().copy(buf, 90);
  buf.writeUInt32LE(g.record.params!.nonce, 122);
  buf.writeBigUInt64LE(over.spent ?? 0n, 126);
  buf.writeBigUInt64LE(0n, 134); // current_outstanding
  buf.writeBigUInt64LE(BigInt(g.record.params!.maxRevolvingCapacityAtomic), 142);
  buf.writeBigUInt64LE(over.crystallized ?? 0n, 150);
  buf.writeUInt32LE(0, 158);
  return buf;
}

/** Vault account (readVaultFull contract): version@8, swig_address@43..75. */
function vaultAccountData(swigAddress: string): Buffer {
  const buf = Buffer.alloc(150);
  Buffer.from(VAULT_ACCOUNT_DISCRIMINATOR).copy(buf, 0);
  buf.writeUInt8(6, 8);
  new PublicKey(swigAddress).toBuffer().copy(buf, 43);
  return buf;
}

/** Connection double: getAccountInfo from a map + programmable getProgramAccounts. */
function fakeConnection(
  accounts: Map<string, Buffer> = new Map(),
  programAccounts: Array<Array<{ pubkey: PublicKey; data: Buffer }>> = [],
) {
  const gpaCalls: unknown[] = [];
  let gpaIdx = 0;
  return {
    gpaCalls,
    getAccountInfo: async (pda: PublicKey) => {
      const data = accounts.get(pda.toBase58());
      return data ? { data, owner: DEXTER_VAULT_PROGRAM_ID } : null;
    },
    getProgramAccounts: async (_program: PublicKey, cfg: unknown) => {
      gpaCalls.push(cfg);
      const batch = programAccounts[Math.min(gpaIdx, programAccounts.length - 1)] ?? [];
      gpaIdx += 1;
      return batch.map((a) => ({ pubkey: a.pubkey, account: { data: a.data } }));
    },
  } as unknown as Connection & { gpaCalls: unknown[] };
}

import { deriveSessionPda } from "@dexterai/vault/session";
function chainFor(g: GrantFixture, data: Buffer, swig?: string): Connection {
  const map = new Map<string, Buffer>();
  map.set(deriveSessionPda(g.vault, g.counterparty)[0].toBase58(), data);
  map.set(g.vault.toBase58(), vaultAccountData(swig ?? Keypair.generate().publicKey.toBase58()));
  return fakeConnection(map) as unknown as Connection;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type TabFromGrant = typeof import("@dexterai/x402/tab").tabFromGrant;
type TabFromGrantOptions = Parameters<TabFromGrant>[0];

function reservationReceipt(
  input: FinalVoucherV2ReservationInput,
): FinalVoucherV2ReservationReceipt {
  return {
    contract: "dexter-native-tab-open-receipt/v2",
    operationId: `lifecycle-${input.idempotencyKey}`,
    callerOperationId: input.idempotencyKey,
    network: input.network,
    transaction: `FINAL_TX_${input.voucher.payload.sequenceNumber}`,
    commitment: "finalized",
    confirmationSlot: 123,
    postStateSlot: 123,
    buyerSwigAddress: input.buyerSwigAddress,
    vaultPda: input.vaultPda,
    sessionPda: input.sessionPda,
    seller: input.seller,
    channelId: input.channelId,
    sessionPublicKey: bs58.encode(input.voucher.sessionPublicKey),
    voucherDigest: input.voucherDigest,
    cumulativeAmountAtomic: input.voucher.payload.cumulativeAmount,
    sequenceNumber: input.voucher.payload.sequenceNumber,
    providerReceiptId: `receipt-${input.idempotencyKey}`,
    reservationAmountAtomic: input.reservationAmountAtomic,
    pendingVoucherCountBefore: input.voucher.payload.sequenceNumber - 1,
    pendingVoucherCountAfter: input.voucher.payload.sequenceNumber,
    currentOutstandingBeforeAtomic: "0",
    currentOutstandingAfterAtomic: input.reservationAmountAtomic,
  };
}

interface FakeTabSpec {
  voucherVersion?: 1 | 2;
  frontierAtomic?: bigint;
  beforeReservationError?: string;
  afterReservationError?: string;
}

function fakeTabFromGrant(spec: FakeTabSpec = {}): {
  implementation: TabFromGrant;
  rollbackVoucher: ReturnType<typeof vi.fn>;
} {
  const rollbackVoucher = vi.fn(() => true);
  const implementation = vi.fn(async (options: TabFromGrantOptions) => {
    const voucherVersion = spec.voucherVersion ?? 2;
    const channelId = "ab".repeat(32);
    let cumulative = spec.frontierAtomic ?? 0n;
    let sequenceNumber = 0;
    const tab = {
      channelId,
      voucherVersion,
      network: "solana:mainnet",
      counterparty: options.params.counterparty,
      state: {
        isOpen: true,
        spent: "0",
        remaining: "5",
        expiresInSec: 3600,
      },
      rollbackVoucher,
      signNextVoucher: vi.fn(async (incrementAtomic: string) => {
        if (spec.beforeReservationError) {
          throw new Error(spec.beforeReservationError);
        }
        const previousCumulative = cumulative;
        cumulative += BigInt(incrementAtomic);
        sequenceNumber += 1;
        const voucher: SignedVoucher = {
          payload: {
            channelId,
            cumulativeAmount: cumulative.toString(),
            sequenceNumber,
          },
          sessionPublicKey: bs58.decode(options.params.sessionPubkey),
          sessionRegistration: new Uint8Array(188).fill(3),
          sessionSignature: new Uint8Array(64).fill(sequenceNumber),
        };
        if (voucherVersion === 2) {
          if (!options.reserveFinalVoucherV2) {
            throw new Error("native_tab_v2_reservation_provider_required");
          }
          await options.reserveFinalVoucherV2({
            network: "solana:mainnet",
            programId: DEXTER_VAULT_PROGRAM_ID.toBase58(),
            buyerSwigAddress: Keypair.generate().publicKey.toBase58(),
            vaultPda: String(options.vaultPda),
            sessionPda: deriveSessionPda(
              new PublicKey(options.vaultPda),
              new PublicKey(options.params.counterparty),
            )[0].toBase58(),
            seller: options.params.counterparty,
            channelId,
            sessionNonce: options.params.nonce,
            reservationAmountAtomic: incrementAtomic,
            previousCumulativeAtomic: previousCumulative.toString(),
            voucherDigest: `digest-${sequenceNumber}`,
            idempotencyKey: `idempotency-${sequenceNumber}`,
            voucher,
          });
          if (spec.afterReservationError) {
            throw new Error(spec.afterReservationError);
          }
        }
        return voucher;
      }),
      stream: vi.fn(),
      close: vi.fn(),
    } as unknown as Tab;
    return tab;
  }) as unknown as TabFromGrant;
  return { implementation, rollbackVoucher };
}

function acceptingSellerRouter(
  body: unknown = { tick: true },
  status = 200,
): ReturnType<typeof vi.fn> {
  const router = vi.fn(async (url: unknown, init?: RequestInit) => {
    if (String(url).startsWith(SELLER_URL)) {
      const voucher = new Headers(init?.headers).get("x-tab-voucher");
      return voucher ? jsonResponse(body, status) : live402Response();
    }
    return jsonResponse({}, 404);
  });
  vi.stubGlobal("fetch", router);
  return router;
}

/** A wire-faithful 402: body AND the PAYMENT-REQUIRED header (base64 of the
 *  same challenge) — the live seller sends both; resolveTabTerms reads the
 *  header, x402Fetch reads the body. */
function live402Response(): Response {
  const body = live402Body();
  const challenge = { x402Version: 2, resource: body.resource, accepts: body.accepts, error: body.error };
  return new Response(JSON.stringify(body), {
    status: 402,
    headers: {
      "content-type": "application/json",
      "payment-required": Buffer.from(JSON.stringify(challenge)).toString("base64"),
    },
  });
}

function fakeReq(voucherHeader: string) {
  return { headers: { "x-tab-voucher": voucherHeader }, tab: undefined as unknown };
}

function fakeRes() {
  const handlers = new Map<string, Array<() => void>>();
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    on(event: string, fn: () => void) {
      const list = handlers.get(event) ?? [];
      list.push(fn);
      handlers.set(event, list);
      return res;
    },
    status(code: number) { res.statusCode = code; return res; },
    json(payload: unknown) { res.body = payload; return res; },
    emit(event: string) { for (const fn of handlers.get(event) ?? []) fn(); },
  };
  return res;
}

/**
 * A fetch router whose resource-URL branch runs the REAL seller middleware.
 * Also serves the facilitator endpoints the SDK + crystallizer hit.
 */
function sellerRouter(mw: ReturnType<typeof tabMiddleware>, onTick?: () => unknown) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const router = vi.fn(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (u.endsWith("/tab/open")) return jsonResponse({ success: true, armed: true });
    if (u.endsWith("/tab/lock")) return jsonResponse({ success: true });
    if (u.endsWith("/tab/settle")) return jsonResponse({ settleTx: "SETTLE_TX" });
    if (u.startsWith(SELLER_URL)) {
      const headers = new Headers(init?.headers);
      const voucher = headers.get("x-tab-voucher") ?? headers.get("X-Tab-Voucher");
      if (!voucher) return jsonResponse(live402Body(), 402);
      const req = fakeReq(voucher);
      const res = fakeRes();
      const next = vi.fn();
      await mw(
        req as unknown as ExpressRequest,
        res as unknown as ExpressResponse,
        next as NextFunction,
      );
      // Release the single-stream lease the way express does.
      res.emit("finish");
      res.emit("close");
      await new Promise((r) => setTimeout(r, 0));
      if (next.mock.calls.length > 0) {
        return jsonResponse(onTick ? onTick() : { tick: true });
      }
      return jsonResponse(res.body, res.statusCode || 402);
    }
    return jsonResponse({}, 404);
  });
  vi.stubGlobal("fetch", router);
  return { router, calls };
}

// ── Suite ───────────────────────────────────────────────────────────────

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dexterai-tabs-test-"));
  resetTabLaneCacheForTests();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
});

describe("tabs/store — custody file", () => {
  it("persists tabs.json with 0600 perms and round-trips records", () => {
    const { record } = makeGrant();
    upsertTab(record, dir);
    const file = join(dir, "tabs.json");
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const loaded = findTab(record.counterparty, dir);
    expect(loaded).toMatchObject({
      counterparty: record.counterparty,
      sessionSecretKey: record.sessionSecretKey,
      status: "active",
    });
  });

  it("upsert replaces by counterparty (one grant per seller), remove deletes", () => {
    const g1 = makeGrant();
    upsertTab(g1.record, dir);
    const g2 = makeGrant(); // fresh key, same counterparty
    upsertTab(g2.record, dir);
    expect(loadTabs(dir)).toHaveLength(1);
    expect(findTab(COUNTERPARTY, dir)!.sessionPubkey).toBe(g2.record.sessionPubkey);
    expect(removeTab(COUNTERPARTY, dir)).toBe(true);
    expect(loadTabs(dir)).toHaveLength(0);
  });

  it("fails closed on a corrupt store instead of treating unknown obligations as empty", () => {
    upsertTab(makeGrant().record, dir);
    const file = join(dir, "tabs.json");
    require("node:fs").writeFileSync(file, "{corrupt", { mode: 0o600 });
    expect(() => loadTabs(dir)).toThrow(/tab_custody_store_unreadable/);
    expect(readFileSync(file, "utf8")).toBe("{corrupt");
  });

  it("writes atomically: 0600, no lingering temp file, whole-file replace", () => {
    saveTabs([makeGrant().record], dir);
    saveTabs([makeGrant().record, makeGrant({ counterparty: "So11111111111111111111111111111111111111112" }).record], dir);
    // No .tmp-* residue from the rename, and perms held on the final file.
    const entries = readdirSync(dir);
    expect(entries.filter((f) => f.includes(".tmp"))).toEqual([]);
    expect(statSync(join(dir, "tabs.json")).mode & 0o777).toBe(0o600);
    expect(loadTabs(dir)).toHaveLength(2);
  });
});

describe("tabs/chain — poll by (sessionPubkey, counterparty)", () => {
  it("filters at the canonical offsets and decodes via the vault SDK decoder", async () => {
    const g = makeGrant();
    const pda = deriveSessionPda(g.vault, g.counterparty)[0];
    const conn = fakeConnection(new Map(), [
      [{ pubkey: pda, data: sessionAccountData(g, { spent: 250000n, crystallized: 100000n }) }],
    ]);

    const found = await findSessionByAgentKey(
      conn as unknown as Connection,
      g.record.sessionPubkey,
      g.record.counterparty,
    );

    expect(found).not.toBeNull();
    expect(found!.vaultPda).toBe(g.vault.toBase58());
    expect(found!.live).toBe(true);
    expect(found!.params).toEqual(g.record.params);
    expect(found!.spentAtomic).toBe("250000");
    expect(found!.crystallizedAtomic).toBe("100000");

    // The wire filters: dataSize 162 + memcmp(42)=sessionPubkey + memcmp(90)=counterparty.
    const cfg = (conn as unknown as { gpaCalls: Array<{ filters: Array<Record<string, any>> }> }).gpaCalls[0];
    expect(cfg.filters).toContainEqual({ dataSize: 162 });
    expect(cfg.filters).toContainEqual({ memcmp: { offset: 42, bytes: g.record.sessionPubkey } });
    expect(cfg.filters).toContainEqual({ memcmp: { offset: 90, bytes: g.record.counterparty } });
  });

  it("returns null when nothing matches", async () => {
    const conn = fakeConnection(new Map(), [[]]);
    expect(await findSessionByAgentKey(conn as unknown as Connection, makeGrant().record.sessionPubkey, COUNTERPARTY)).toBeNull();
  });
});

describe("tabs/connect — consent handoff", () => {
  it("mints the EXACT /tabs/connect deep link", () => {
    const pk = new PublicKey(nacl.sign.keyPair().publicKey).toBase58();
    expect(consentLinkFor(SELLER_URL, pk)).toBe(
      `https://dexter.cash/tabs/connect?url=${encodeURIComponent(SELLER_URL)}&agent=${pk}`,
    );
  });

  it("probes the 402, persists a pending record (0600), prints the link — and reuses the key on re-run", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => live402Response()));
    const lines: string[] = [];
    const conn = fakeConnection(new Map(), [[]]);

    await cliTabConnect(SELLER_URL, {
      wait: false, dataDir: dir, connection: conn as unknown as Connection,
      log: (s: string) => lines.push(s),
    });

    const rec = findTab(COUNTERPARTY, dir);
    expect(rec).not.toBeNull();
    expect(rec!.status).toBe("pending");
    expect(bs58.decode(rec!.sessionSecretKey)).toHaveLength(64);
    expect(statSync(join(dir, "tabs.json")).mode & 0o777).toBe(0o600);
    const link = consentLinkFor(SELLER_URL, rec!.sessionPubkey);
    expect(lines.join("\n")).toContain(link);

    // Re-run: SAME agent key (no key churn while approval is pending).
    await cliTabConnect(SELLER_URL, {
      wait: false, dataDir: dir, connection: conn as unknown as Connection,
      log: (s: string) => lines.push(s),
    });
    expect(loadTabs(dir)).toHaveLength(1);
    expect(findTab(COUNTERPARTY, dir)!.sessionPubkey).toBe(rec!.sessionPubkey);
  });

  it("polls the chain and promotes pending → active with the CHAIN's params + vaultPda", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => live402Response()));
    const lines: string[] = [];

    // First pass: mint the pending record.
    await cliTabConnect(SELLER_URL, {
      wait: false, dataDir: dir,
      connection: fakeConnection(new Map(), [[]]) as unknown as Connection,
      log: (s: string) => lines.push(s),
    });
    const pending = findTab(COUNTERPARTY, dir)!;

    // Build the on-chain account the human's approval would have registered.
    const g: GrantFixture = {
      kp: {
        publicKey: bs58.decode(pending.sessionPubkey),
        secretKey: bs58.decode(pending.sessionSecretKey),
      } as nacl.SignKeyPair,
      record: {
        ...pending,
        params: {
          maxAmountAtomic: "1000000",
          expiresAtUnix: NOW + 7 * 86400,
          nonce: CONTEXT_BOUND_V2_NONCE,
          maxRevolvingCapacityAtomic: "1000000",
        },
      },
      vault: Keypair.generate().publicKey,
      counterparty: new PublicKey(COUNTERPARTY),
    };
    const pda = deriveSessionPda(g.vault, g.counterparty)[0];
    // Poll returns empty once, then the registered account.
    const conn = fakeConnection(new Map(), [
      [],
      [{ pubkey: pda, data: sessionAccountData(g) }],
    ]);

    await cliTabConnect(SELLER_URL, {
      wait: true, pollIntervalMs: 1, timeoutMs: 5000, dataDir: dir,
      connection: conn as unknown as Connection,
      log: (s: string) => lines.push(s),
    });

    const active = findTab(COUNTERPARTY, dir)!;
    expect(active.status).toBe("active");
    expect(active.vaultPda).toBe(g.vault.toBase58());
    expect(active.params).toEqual(g.record.params);
    expect(active.sessionPubkey).toBe(pending.sessionPubkey); // same custodied key
  });

  it("does not activate a historical low-bit grant and requires an explicit V2 reapproval", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => live402Response()));
    const lines: string[] = [];
    await cliTabConnect(SELLER_URL, {
      wait: false,
      dataDir: dir,
      connection: fakeConnection(new Map(), [[]]) as unknown as Connection,
      log: (s: string) => lines.push(s),
    });
    const pending = findTab(COUNTERPARTY, dir)!;
    const grant: GrantFixture = {
      kp: {
        publicKey: bs58.decode(pending.sessionPubkey),
        secretKey: bs58.decode(pending.sessionSecretKey),
      } as nacl.SignKeyPair,
      record: {
        ...pending,
        params: {
          maxAmountAtomic: "1000000",
          expiresAtUnix: NOW + 3600,
          nonce: 42,
          maxRevolvingCapacityAtomic: "1000000",
        },
      },
      vault: Keypair.generate().publicKey,
      counterparty: new PublicKey(COUNTERPARTY),
    };
    const pda = deriveSessionPda(grant.vault, grant.counterparty)[0];
    const conn = fakeConnection(new Map(), [
      [{ pubkey: pda, data: sessionAccountData(grant) }],
    ]);

    await cliTabConnect(SELLER_URL, {
      wait: true,
      pollIntervalMs: 1,
      timeoutMs: 100,
      dataDir: dir,
      connection: conn as unknown as Connection,
      log: (s: string) => lines.push(s),
    });

    expect(findTab(COUNTERPARTY, dir)!.status).toBe("reapproval_required");
    expect(lines.join("\n")).toMatch(/retired voucher format/i);
    expect(lines.join("\n")).toContain(`opendexter tab connect ${SELLER_URL} --rekey`);
  });

  it("an ACTIVE tab is left untouched on a plain re-run, and the recovery hint names --rekey", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => live402Response()));
    const g = makeGrant();
    upsertTab(g.record, dir);
    const lines: string[] = [];
    await cliTabConnect(SELLER_URL, {
      wait: false, dataDir: dir,
      connection: fakeConnection(new Map(), [[]]) as unknown as Connection,
      log: (s: string) => lines.push(s),
    });
    // Unchanged: no new key minted, no status churn.
    expect(findTab(COUNTERPARTY, dir)!.sessionPubkey).toBe(g.record.sessionPubkey);
    expect(lines.join("\n")).toContain(`opendexter tab connect ${SELLER_URL} --rekey`);
  });

  it("--rekey over an ACTIVE tab mints a FRESH key and re-issues consent (the cumulative_exceeds_cap recovery)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => live402Response()));
    const g = makeGrant();
    upsertTab(g.record, dir);
    const lines: string[] = [];
    await cliTabConnect(SELLER_URL, {
      wait: false, rekey: true, dataDir: dir,
      connection: fakeConnection(new Map(), [[]]) as unknown as Connection,
      log: (s: string) => lines.push(s),
    });
    const rec = findTab(COUNTERPARTY, dir)!;
    expect(rec.status).toBe("pending"); // back to awaiting the human tap
    expect(rec.sessionPubkey).not.toBe(g.record.sessionPubkey); // FRESH key
    expect(loadTabs(dir)).toHaveLength(1); // replaced in place
    expect(lines.join("\n")).toContain(consentLinkFor(SELLER_URL, rec.sessionPubkey));
  });

  it("--rekey warns before discarding an unsettled voucher receipt (mirrors `tab remove`)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => live402Response()));
    const g = makeGrant();
    upsertTab({ ...g.record, lastVoucherHeader: "aGVsZG9uLXJlY2VpcHQ=" }, dir);
    const lines: string[] = [];
    await cliTabConnect(SELLER_URL, {
      wait: false, rekey: true, dataDir: dir,
      connection: fakeConnection(new Map(), [[]]) as unknown as Connection,
      log: (s: string) => lines.push(s),
    });
    const out = lines.join("\n");
    expect(out).toMatch(/UNSETTLED voucher receipt/i);
    expect(out).toContain(`opendexter tab close ${SELLER_URL}`);
    // The new key was still minted (the warning informs, it doesn't block).
    expect(findTab(COUNTERPARTY, dir)!.sessionPubkey).not.toBe(g.record.sessionPubkey);
  });

  it("re-connecting over a DEAD record warns before discarding a held receipt", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => live402Response()));
    const g = makeGrant({ status: "dead", deadReason: "tab_session_not_live" });
    upsertTab({ ...g.record, lastVoucherHeader: "aGVsZG9uLXJlY2VpcHQ=" }, dir);
    const lines: string[] = [];
    await cliTabConnect(SELLER_URL, {
      wait: false, dataDir: dir,
      connection: fakeConnection(new Map(), [[]]) as unknown as Connection,
      log: (s: string) => lines.push(s),
    });
    expect(lines.join("\n")).toMatch(/UNSETTLED voucher receipt/i);
    expect(findTab(COUNTERPARTY, dir)!.status).toBe("pending"); // fresh grant minted
  });
});

describe("tabs/lane — tab-first payment", () => {
  const laneDeps = (conn: Connection, spec: FakeTabSpec = {}) => {
    const runtime = fakeTabFromGrant(spec);
    return {
      dataDir: dir,
      connection: conn,
      facilitatorUrl: FAC,
      getMaxAmountUsdc: () => 5,
      tabFromGrant: runtime.implementation,
      reserveFinalVoucherV2: vi.fn(async (input: FinalVoucherV2ReservationInput) =>
        reservationReceipt(input)),
    };
  };

  it("no tab accept in the 402 → pure fall-through (done:false, no note)", async () => {
    const lane = createTabLane(laneDeps(fakeConnection() as unknown as Connection));
    const out = await lane(
      { url: SELLER_URL, method: "GET" },
      { accepts: [{ scheme: "exact", network: "solana:mainnet", payTo: COUNTERPARTY, amount: "10000" }] },
    );
    expect(out).toEqual({ done: false });
  });

  it("the pinned V6 SDK rejects a low-bit grant before any chain or provider I/O", async () => {
    const g = makeGrant({
      params: {
        maxAmountAtomic: "5000000",
        expiresAtUnix: NOW + 3600,
        nonce: 42,
        maxRevolvingCapacityAtomic: "5000000",
      },
    });
    const connection = {
      getAccountInfo: vi.fn(async () => {
        throw new Error("unexpected chain read");
      }),
    } as unknown as Connection;
    const reserveFinalVoucherV2 = vi.fn();

    await expect(sdkTabFromGrant({
      sessionSecretKey: bs58.decode(g.record.sessionSecretKey),
      params: {
        counterparty: g.record.counterparty,
        sessionPubkey: g.record.sessionPubkey,
        ...g.record.params!,
      },
      vaultPda: g.record.vaultPda!,
      connection,
      perUnitCapAtomic: "10000",
      reserveFinalVoucherV2,
    })).rejects.toThrow(/native_tab_v1_migration_required/);
    expect(connection.getAccountInfo).not.toHaveBeenCalled();
    expect(reserveFinalVoucherV2).not.toHaveBeenCalled();
  });

  it("tab accept + no stored grant → mints a pending key (custody 0600 FIRST) and returns the in-band offer", async () => {
    const lane = createTabLane(laneDeps(fakeConnection() as unknown as Connection));
    const out = await lane({ url: SELLER_URL, method: "GET" }, live402Body());
    expect(out.done).toBe(false);
    // The key was custodied before the offer left the lane.
    const rec = findTab(COUNTERPARTY, dir)!;
    expect(rec.status).toBe("pending");
    expect(bs58.decode(rec.sessionSecretKey)).toHaveLength(64);
    expect(statSync(join(dir, "tabs.json")).mode & 0o777).toBe(0o600);
    const offer = (out as { offer?: Record<string, unknown> }).offer!;
    expect(offer).toMatchObject({
      mode: "tab_available",
      connectUrl: consentLinkFor(SELLER_URL, rec.sessionPubkey),
      priceUsdcPerCall: 0.01,
    });
    // Pubkey-only in the outcome — the secret never leaves the file.
    expect(JSON.stringify(out)).not.toContain(rec.sessionSecretKey);
  });

  it("tab accept + PENDING grant (approval not on chain yet) → tab_pending offer with the SAME key's link", async () => {
    const g = makeGrant({ status: "pending", vaultPda: undefined, params: undefined });
    upsertTab(g.record, dir);
    const lane = createTabLane(laneDeps(fakeConnection() as unknown as Connection));
    const out = await lane({ url: SELLER_URL, method: "GET" }, live402Body());
    expect(out.done).toBe(false);
    expect((out as { offer?: Record<string, unknown> }).offer).toMatchObject({
      mode: "tab_pending",
      connectUrl: consentLinkFor(SELLER_URL, g.record.sessionPubkey),
    });
    // No key churn while awaiting approval.
    expect(findTab(COUNTERPARTY, dir)!.sessionPubkey).toBe(g.record.sessionPubkey);
  });

  it("ACTIVE V2 grant reserves the exact final claim before dispatch and persists independently-verified evidence", async () => {
    const g = makeGrant();
    upsertTab(g.record, dir);
    const conn = chainFor(g, sessionAccountData(g, { spent: 250000n, crystallized: 100000n }));
    acceptingSellerRouter({ tick: 1, slot: 12345 });

    const lane = createTabLane(laneDeps(conn, { frontierAtomic: 250000n }));
    const out = await lane({ url: SELLER_URL, method: "GET" }, live402Body());

    expect(out.done).toBe(true);
    const result = (out as { result: Record<string, any> }).result;
    expect(result.status).toBe(200);
    expect(result.data).toEqual({ tick: 1, slot: 12345 });
    expect(result.payment).toMatchObject({
      rail: "tab",
      counterparty: g.record.counterparty,
      incrementAtomic: "10000",
      voucherVersion: 2,
      reservationCommitment: "finalized",
      // Frontier max(250000, 100000) + 10000: the odometer resumes over the chain.
      cumulativeAtomic: "260000",
    });

    // Settle receipt (the exact accepted voucher header) persisted for `tab close`.
    const rec = findTab(g.record.counterparty, dir)!;
    expect(rec.lastVoucherHeader).toBeTruthy();
    expect(rec.status).toBe("active");
    const decoded = JSON.parse(Buffer.from(rec.lastVoucherHeader!, "base64").toString("utf8"));
    expect(decoded.payload.cumulativeAmount).toBe("260000");
    expect(rec.lastVoucherVersion).toBe(2);
    expect(rec.lastVoucherIncrementAtomic).toBe("10000");
    expect(rec.lastFinalV2ReservationReceipt).toMatchObject({
      commitment: "finalized",
      cumulativeAmountAtomic: "260000",
    });
    expect(rec.lastFinalV2ReservationVerified).toBe(true);

    // Second call in the same process: cached tab, next voucher, same channel.
    const out2 = await lane({ url: SELLER_URL, method: "GET" }, live402Body());
    expect(out2.done).toBe(true);
    expect((out2 as { result: Record<string, any> }).result.payment.cumulativeAtomic).toBe("270000");
  });

  it("uses the facilitator's canonical DEXTER_INTERNAL_TOKEN for the managed reservation boundary", async () => {
    vi.stubEnv("TAB_OPEN_INTERNAL_TOKEN", "");
    vi.stubEnv("DEXTER_INTERNAL_TOKEN", "canonical-internal-token");
    const g = makeGrant();
    upsertTab(g.record, dir);
    const reservationFetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) =>
      jsonResponse({
        receipt: {
          commitment: "finalized",
          transaction: "FINAL_TX",
          providerReceiptId: "provider-receipt",
        },
      })) as typeof fetch;
    const runtime = fakeTabFromGrant();
    acceptingSellerRouter();
    const lane = createTabLane({
      dataDir: dir,
      connection: chainFor(g, sessionAccountData(g)),
      facilitatorUrl: FAC,
      getMaxAmountUsdc: () => 5,
      tabFromGrant: runtime.implementation,
      reservationFetchImpl,
    });

    const out = await lane({ url: SELLER_URL, method: "GET" }, live402Body());

    expect(out.done).toBe(true);
    expect(reservationFetchImpl).toHaveBeenCalledOnce();
    const init = reservationFetchImpl.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("x-internal-token"))
      .toBe("canonical-internal-token");
    expect(init?.redirect).toBe("error");
  });

  it("records witnessed spend through the budget runtime on a tab-paid call", async () => {
    const g = makeGrant();
    upsertTab(g.record, dir);
    const conn = chainFor(g, sessionAccountData(g));
    acceptingSellerRouter();
    const spends: Array<[number, string]> = [];
    const lane = createTabLane({
      ...laneDeps(conn),
      getBudgetRuntime: () => ({
        dailyBudgetUsdc: 0,
        spentLast24hUsdc: 0,
        recordSpend: (usdc: number, url: string) => spends.push([usdc, url]),
      }),
    });
    const out = await lane({ url: SELLER_URL, method: "GET" }, live402Body());
    expect(out.done).toBe(true);
    expect(spends).toEqual([[0.01, SELLER_URL]]);
  });

  it("a seller 402 after a V2 reservation is terminal, retains the claim, and never rolls it back", async () => {
    const g = makeGrant();
    upsertTab(g.record, dir);
    const conn = chainFor(g, sessionAccountData(g));
    acceptingSellerRouter({ reason: "seller_policy_refused", detail: "not delivered" }, 402);
    const runtime = fakeTabFromGrant();

    const lane = createTabLane({
      ...laneDeps(conn),
      tabFromGrant: runtime.implementation,
    });
    const out = await lane({ url: SELLER_URL, method: "GET" }, live402Body());

    expect(out.done).toBe(true); // final — NOT a fall-through to exact
    const result = (out as { result: Record<string, any> }).result;
    expect(result.status).toBe(402);
    expect(result.error).toMatch(/FINAL tab voucher/i);
    expect(result.error).toMatch(/reservation already finalized/i);
    expect(result.tab).toMatchObject({
      rail: "tab",
      used: true,
      refused: true,
      voucherVersion: 2,
      state: "reconciliation_required",
      retrySafe: false,
      reservationCommitment: "finalized",
    });
    expect(runtime.rollbackVoucher).not.toHaveBeenCalled();
    const persisted = findTab(g.record.counterparty, dir)!;
    expect(persisted.status).toBe("reconciliation_required");
    expect(persisted.lastFinalV2ReservationVerified).toBe(true);
  });

  it("a V2 response loss blocks the next payment and directs reconciliation instead of retry", async () => {
    const g = makeGrant();
    upsertTab(g.record, dir);
    const conn = chainFor(g, sessionAccountData(g));
    const runtime = fakeTabFromGrant();
    const lane = createTabLane({
      ...laneDeps(conn),
      tabFromGrant: runtime.implementation,
    });

    const out = await lane({
      url: SELLER_URL,
      method: "GET",
      externalFetch: vi.fn(async () => {
        throw new Error("merchant response lost");
      }) as typeof fetch,
    }, live402Body());

    expect(out.done).toBe(true);
    const result = (out as { result: Record<string, any> }).result;
    expect(result.status).toBe(0);
    expect(result.error).toMatch(/reconcile the recorded FINAL reservation/i);
    expect(result.error).not.toMatch(/call again/i);
    expect(result.tab).toMatchObject({
      state: "reconciliation_required",
      retrySafe: false,
      reservationCommitment: "finalized",
    });
    expect(runtime.rollbackVoucher).not.toHaveBeenCalled();
    expect(findTab(g.record.counterparty, dir)).toMatchObject({
      status: "reconciliation_required",
      lastFinalV2ReservationVerified: true,
    });
  });

  it("an after-reservation V2 signing error is terminal and preserves the exact obligation for reconciliation", async () => {
    const g = makeGrant();
    upsertTab(g.record, dir);
    const conn = chainFor(g, sessionAccountData(g));
    const merchant = acceptingSellerRouter();
    const runtime = fakeTabFromGrant({
      afterReservationError: "independent finalized readback timed out",
    });
    const lane = createTabLane({
      ...laneDeps(conn),
      tabFromGrant: runtime.implementation,
    });

    const out = await lane({ url: SELLER_URL, method: "GET" }, live402Body());

    expect(out.done).toBe(true);
    expect((out as { result: Record<string, any> }).result).toMatchObject({
      status: 409,
      tab: {
        state: "reconciliation_required",
        retrySafe: false,
        reservationCommitment: "finalized",
      },
    });
    expect(merchant).not.toHaveBeenCalled();
    const persisted = findTab(g.record.counterparty, dir)!;
    expect(persisted.status).toBe("reconciliation_required");
    expect(persisted.lastVoucherVersion).toBe(2);
    expect(persisted.lastVoucherIncrementAtomic).toBe("10000");
    expect(persisted.lastFinalV2ReservationVerified).toBe(false);
  });

  it("a provider timeout replaces stale receipt identity with the current voucher and an unverified marker", async () => {
    const g = makeGrant();
    upsertTab({
      ...g.record,
      lastFinalV2ReservationReceipt: {
        providerReceiptId: "stale-receipt",
        transaction: "STALE_TX",
      } as FinalVoucherV2ReservationReceipt,
      lastFinalV2ReservationVerified: true,
    }, dir);
    const conn = chainFor(g, sessionAccountData(g));
    const merchant = acceptingSellerRouter();
    const deps = laneDeps(conn);
    const lane = createTabLane({
      ...deps,
      reserveFinalVoucherV2: vi.fn(async () => {
        throw new Error("provider response lost after dispatch");
      }),
    });

    const out = await lane({ url: SELLER_URL, method: "GET" }, live402Body());

    expect(out.done).toBe(true);
    expect(merchant).not.toHaveBeenCalled();
    const persisted = findTab(g.record.counterparty, dir)!;
    expect(persisted.status).toBe("reconciliation_required");
    expect(persisted.lastVoucherHeader).toBeTruthy();
    expect(persisted.lastFinalV2ReservationReceipt).toBeUndefined();
    expect(persisted.lastFinalV2ReservationVerified).toBe(false);
  });

  it("an outstanding V2 reservation recovered at construction is terminal and never permits Exact fallback", async () => {
    const g = makeGrant();
    upsertTab({
      ...g.record,
      lastVoucherHeader: "persisted-final-v2-voucher",
      lastVoucherVersion: 2,
      lastVoucherIncrementAtomic: "10000",
    }, dir);
    const tabFromGrant = vi.fn(async () => {
      throw new Error(
        "native_tab_v2_reservation_pending: the session already has an exact outstanding reservation of 10000",
      );
    }) as unknown as TabFromGrant;
    const lane = createTabLane({
      ...laneDeps(chainFor(g, sessionAccountData(g))),
      tabFromGrant,
    });

    const out = await lane({ url: SELLER_URL, method: "GET" }, live402Body());

    expect(out.done).toBe(true);
    expect((out as { result: Record<string, any> }).result).toMatchObject({
      status: 409,
      tab: {
        state: "reconciliation_required",
        retrySafe: false,
      },
    });
    expect(findTab(g.record.counterparty, dir)).toMatchObject({
      status: "reconciliation_required",
      lastVoucherHeader: "persisted-final-v2-voucher",
      lastVoucherVersion: 2,
    });
  });

  it("persisted V2 evidence blocks Exact even when this process has no reservation provider", async () => {
    const g = makeGrant();
    upsertTab({
      ...g.record,
      lastVoucherHeader: "persisted-final-v2-voucher",
      lastVoucherVersion: 2,
      lastVoucherIncrementAtomic: "10000",
    }, dir);
    const tabFromGrant = vi.fn() as unknown as TabFromGrant;
    const lane = createTabLane({
      dataDir: dir,
      connection: chainFor(g, sessionAccountData(g)),
      facilitatorUrl: FAC,
      getMaxAmountUsdc: () => 5,
      tabFromGrant,
      tabOpenInternalToken: "",
    });

    const out = await lane({ url: SELLER_URL, method: "GET" }, live402Body());

    expect(out.done).toBe(true);
    expect((out as { result: Record<string, any> }).result).toMatchObject({
      status: 409,
      tab: { state: "reconciliation_required", retrySafe: false },
    });
    expect(tabFromGrant).not.toHaveBeenCalled();
    expect(findTab(g.record.counterparty, dir)).toMatchObject({
      status: "reconciliation_required",
      lastVoucherHeader: "persisted-final-v2-voucher",
      lastVoucherVersion: 2,
    });
  });

  it("an unidentified runtime voucher contract fails closed before signing", async () => {
    const g = makeGrant();
    upsertTab(g.record, dir);
    const conn = chainFor(g, sessionAccountData(g));
    const runtime = fakeTabFromGrant();
    const invalidTabFromGrant = vi.fn(async (options: TabFromGrantOptions) => {
      const tab = await runtime.implementation(options);
      return Object.assign(tab, { voucherVersion: undefined }) as unknown as Tab;
    }) as unknown as TabFromGrant;
    const merchant = acceptingSellerRouter();
    const lane = createTabLane({
      ...laneDeps(conn),
      tabFromGrant: invalidTabFromGrant,
    });

    const out = await lane({ url: SELLER_URL, method: "GET" }, live402Body());

    expect(out.done).toBe(true);
    expect((out as { result: Record<string, any> }).result).toMatchObject({
      status: 500,
      tab: { state: "runtime_contract_invalid", retrySafe: false },
    });
    expect(merchant).not.toHaveBeenCalled();
  });

  it("a historical V1 active record blocks automatic payment and demands explicit reapproval", async () => {
    const g = makeGrant({
      params: {
        maxAmountAtomic: "5000000",
        expiresAtUnix: NOW + 3600,
        nonce: 42,
        maxRevolvingCapacityAtomic: "5000000",
      },
    });
    upsertTab(g.record, dir);
    const lane = createTabLane(laneDeps(chainFor(g, sessionAccountData(g))));

    const out = await lane({ url: SELLER_URL, method: "GET" }, live402Body());

    expect(out.done).toBe(true);
    expect((out as { result: Record<string, any> }).result).toMatchObject({
      status: 409,
      tab: { state: "reapproval_required", used: false },
    });
    expect(String((out as { result: Record<string, any> }).result.error)).toContain("--rekey");
    expect(findTab(g.record.counterparty, dir)!.status).toBe("reapproval_required");
  });

  it("a pre-reservation V1 signing refusal remains eligible for the exact one-shot path", async () => {
    const g = makeGrant();
    upsertTab(g.record, dir);
    const runtime = fakeTabFromGrant({
      voucherVersion: 1,
      beforeReservationError: "historical_v1_local_refusal",
    });
    const lane = createTabLane({
      ...laneDeps(chainFor(g, sessionAccountData(g))),
      tabFromGrant: runtime.implementation,
    });

    const out = await lane({ url: SELLER_URL, method: "GET" }, live402Body());

    expect(out.done).toBe(false);
    expect(String((out as { note: Record<string, unknown> }).note.reason)).toMatch(/paid exact instead/i);
  });

  it("a DEAD on-chain session (revoked/expired) marks the record dead and falls through to exact with a loud note", async () => {
    const g = makeGrant();
    upsertTab(g.record, dir);
    const conn = chainFor(g, sessionAccountData(g, { version: 0 }));
    const tabFromGrant = vi.fn(async () => {
      throw new Error("tab_session_not_live");
    }) as unknown as TabFromGrant;
    const lane = createTabLane({ ...laneDeps(conn), tabFromGrant });
    const out = await lane({ url: SELLER_URL, method: "GET" }, live402Body());

    expect(out.done).toBe(false);
    expect((out as { note?: Record<string, unknown> }).note).toMatchObject({ rail: "tab", used: false });
    expect(String((out as { note?: Record<string, any> }).note!.reason)).toMatch(/tab_session_not_live/);
    const rec = findTab(g.record.counterparty, dir)!;
    expect(rec.status).toBe("dead");
    expect(rec.deadReason).toMatch(/tab_session_not_live/);
  });

  it("a wrong-key record (tab_session_key_mismatch) is marked dead, not retried every call", async () => {
    // A corrupted record: the stored secret does not sign for its pubkey.
    // tabFromGrant throws tab_session_key_mismatch BEFORE any I/O — the lane
    // must mark it dead so the next call skips construction entirely.
    const g = makeGrant();
    const other = makeGrant();
    upsertTab({ ...g.record, sessionSecretKey: other.record.sessionSecretKey }, dir);
    const conn = chainFor(g, sessionAccountData(g));
    const tabFromGrant = vi.fn(async () => {
      throw new Error("tab_session_key_mismatch");
    }) as unknown as TabFromGrant;
    const lane = createTabLane({ ...laneDeps(conn), tabFromGrant });
    const out = await lane({ url: SELLER_URL, method: "GET" }, live402Body());
    expect(out.done).toBe(false);
    const rec = findTab(g.record.counterparty, dir)!;
    expect(rec.status).toBe("dead");
    expect(rec.deadReason).toMatch(/tab_session_key_mismatch/);
  });

  it("skips the lane when the per-call policy cap is below the seller's price (falls through; exact path enforces the same cap)", async () => {
    const g = makeGrant();
    upsertTab(g.record, dir);
    const conn = chainFor(g, sessionAccountData(g));
    const lane = createTabLane({ ...laneDeps(conn), getMaxAmountUsdc: () => 0.005 });
    const out = await lane({ url: SELLER_URL, method: "GET" }, live402Body());
    expect(out.done).toBe(false);
    expect(String((out as { note?: Record<string, any> }).note!.reason)).toMatch(/cap/i);
  });
});

describe("x402Fetch seam — tab lane hook", () => {
  it("a done:true lane outcome IS the result (wallet never consulted)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => live402Response()));
    const result = await x402Fetch(
      { url: SELLER_URL, method: "GET" },
      null,
      {
        maxAmountUsdc: 5,
        tabLane: async () => ({ done: true, result: { status: 200, data: { via: "tab" } } }),
      },
    );
    expect(result).toEqual({ status: 200, data: { via: "tab" } });
  });

  it("a done:false note rides the ordinary 402 result under `tab`", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => live402Response()));
    const result = await x402Fetch(
      { url: SELLER_URL, method: "GET" },
      null,
      {
        maxAmountUsdc: 5,
        tabLane: async () => ({ done: false, note: { rail: "tab", used: false, connect: "opendexter tab connect …" } }),
      },
    );
    expect(result.status).toBe(402);
    expect(result.tab).toMatchObject({ rail: "tab", used: false });
  });

  it("an untyped lane crash is terminal because a V2 FINAL reservation may already exist", async () => {
    const probe = vi.fn(async () => live402Response());
    vi.stubGlobal("fetch", probe);
    const result = await x402Fetch(
      { url: SELLER_URL, method: "GET" },
      null,
      {
        maxAmountUsdc: 5,
        tabLane: async () => { throw new Error("lane exploded"); },
      },
    );
    expect(result).toMatchObject({
      status: 502,
      mode: "tab_error",
      phase: "dispatch_unknown",
      retryable: false,
      error: "tab_lane_failed",
      payment: {
        dispatched: "unknown",
        settled: "unknown",
        retrySafe: false,
      },
    });
    expect(String(result.message)).toMatch(/reconcile.*do not retry.*Exact/i);
    expect(String(result.message)).toMatch(/lane exploded/i);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("a corrupt custody store fails the paid path closed and is never overwritten", async () => {
    upsertTab(makeGrant().record, dir);
    const file = join(dir, "tabs.json");
    require("node:fs").writeFileSync(file, "{corrupt", { mode: 0o600 });
    const probe = vi.fn(async () => live402Response());
    vi.stubGlobal("fetch", probe);

    const result = await x402Fetch(
      { url: SELLER_URL, method: "GET" },
      null,
      {
        maxAmountUsdc: 5,
        tabLane: createTabLane({ dataDir: dir }),
      },
    );

    expect(result).toMatchObject({
      status: 502,
      mode: "tab_error",
      phase: "dispatch_unknown",
      retryable: false,
      error: "tab_lane_failed",
    });
    expect(String(result.message)).toMatch(/tab_custody_store_unreadable/);
    expect(readFileSync(file, "utf8")).toBe("{corrupt");
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("without a lane the behavior is byte-identical to before (no tab key)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => live402Response()));
    const result = await x402Fetch({ url: SELLER_URL, method: "GET" }, null, { maxAmountUsdc: 5 });
    expect(result.status).toBe(402);
    expect("tab" in result).toBe(false);
  });
});

describe("x402_fetch tool — per-call tab opt-out (the real escape hatch)", () => {
  /** Capture the handler registerFetchTool wires onto the MCP server. */
  function registerAndCapture(getTabLane: () => any) {
    let handler: ((args: any) => Promise<any>) | null = null;
    const fakeServer = {
      tool: (name: string, _d: string, _s: unknown, h: (args: any) => Promise<any>) => {
        if (name === "x402_fetch") handler = h;
      },
    };
    registerFetchTool(fakeServer as any, {
      apiBaseUrl: "https://x402.dexter.cash",
      metas: { fetch: {} } as any,
      wallet: null,
      getMaxAmountUsdc: () => 5,
      getTabLane,
    });
    if (!handler) throw new Error("x402_fetch handler not registered");
    return handler as (args: any) => Promise<any>;
  }

  it("tab:false makes the tool NOT consult the lane (exact escape hatch)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => live402Response()));
    const laneSpy = vi.fn(async () => ({ done: true, result: { status: 200, data: { via: "tab" } } }));
    const handler = registerAndCapture(() => laneSpy);
    const res = await handler({ url: SELLER_URL, method: "GET", tab: false });
    expect(laneSpy).not.toHaveBeenCalled();
    // Walletless + no lane → canonical 402 requirements, no tab result.
    expect(res.structuredContent.status).toBe(402);
    expect("tab" in res.structuredContent).toBe(false);
  });

  it("tab omitted (default) DOES consult the lane", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => live402Response()));
    const laneSpy = vi.fn(async () => ({ done: true, result: { status: 200, data: { via: "tab" } } }));
    const handler = registerAndCapture(() => laneSpy);
    const res = await handler({ url: SELLER_URL, method: "GET" });
    expect(laneSpy).toHaveBeenCalledOnce();
    expect(res.structuredContent).toEqual({ status: 200, data: { via: "tab" } });
  });
});

describe("tabs/cli — close (settle the held receipt)", () => {
  it("POSTs the exact V2 increment and provider identity to /tab/settle, then clears the evidence", async () => {
    const g = makeGrant();
    const voucher: SignedVoucher = {
      payload: {
        channelId: "ab".repeat(32),
        cumulativeAmount: "260000",
        sequenceNumber: 1,
      },
      sessionPublicKey: g.kp.publicKey,
      sessionRegistration: new Uint8Array(188).fill(0xcd),
      sessionSignature: new Uint8Array(64).fill(0xef),
    };
    const receipt = reservationReceipt({
      network: "solana:mainnet",
      programId: DEXTER_VAULT_PROGRAM_ID.toBase58(),
      buyerSwigAddress: Keypair.generate().publicKey.toBase58(),
      vaultPda: g.vault.toBase58(),
      sessionPda: deriveSessionPda(g.vault, g.counterparty)[0].toBase58(),
      seller: g.counterparty.toBase58(),
      channelId: voucher.payload.channelId,
      sessionNonce: CONTEXT_BOUND_V2_NONCE,
      reservationAmountAtomic: "10000",
      previousCumulativeAtomic: "250000",
      voucherDigest: "close-digest",
      idempotencyKey: "close-idempotency",
      voucher,
    });
    upsertTab({
      ...g.record,
      lastVoucherHeader: voucherToHeader(voucher),
      lastVoucherVersion: 2,
      lastVoucherIncrementAtomic: "10000",
      lastFinalV2ReservationReceipt: receipt,
      lastFinalV2ReservationVerified: true,
    }, dir);

    const calls: Array<{ url: string; body: any }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return jsonResponse({ settleTx: "SETTLE_TX_123" });
    }));

    const lines: string[] = [];
    await cliTabClose(SELLER_URL, { dataDir: dir, facilitatorUrl: FAC, log: (s: string) => lines.push(s) });

    const settle = calls.find((c) => c.url === `${FAC}/tab/settle`);
    expect(settle).toBeDefined();
    expect(settle!.body).toMatchObject({
      channelId: "ab".repeat(32),
      attemptedAmount: "10000",
      cumulativeAmount: "260000",
      sequenceNumber: 1,
      providerReceiptId: receipt.providerReceiptId,
      network: "solana:mainnet",
    });
    expect(settle!.body.lifecycleOperationId).toBeUndefined();
    expect(lines.join("\n")).toContain("SETTLE_TX_123");
    expect(findTab(g.record.counterparty, dir)!.lastVoucherHeader).toBeUndefined();
    expect(findTab(g.record.counterparty, dir)!.lastFinalV2ReservationReceipt).toBeUndefined();
    // K-T4 atomic-replace copy: settle does not end the session, and the model
    // is atomic-replace — never the old "go manually revoke it" abandonment step.
    const out = lines.join("\n");
    expect(out).toMatch(/atomically replaces/i);
    expect(out).not.toMatch(/revoke/i);
    expect(out).not.toContain("dexter.cash/wallet");
  });

  it("explains an already-crystallized voucher (facilitator non_monotonic) honestly and clears it", async () => {
    const g = makeGrant();
    const header = Buffer.from(JSON.stringify({
      payload: { channelId: "ab".repeat(32), cumulativeAmount: "260000", sequenceNumber: 1 },
      sessionPublicKey: Buffer.from(g.kp.publicKey).toString("hex"),
      sessionRegistration: "cd".repeat(188),
      sessionSignature: "ef".repeat(64),
    })).toString("base64");
    upsertTab({
      ...g.record,
      lastVoucherHeader: header,
      lastVoucherVersion: 1,
      lastVoucherIncrementAtomic: "10000",
    }, dir);
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse({ error: "non_monotonic_cumulative" }, 409)));

    const lines: string[] = [];
    await cliTabClose(SELLER_URL, { dataDir: dir, facilitatorUrl: FAC, log: (s: string) => lines.push(s) });
    expect(lines.join("\n")).toMatch(/already/i);
    expect(findTab(g.record.counterparty, dir)!.lastVoucherHeader).toBeUndefined();
  });

  it("keeps a historical receipt when its exact increment is unknown instead of guessing from chain state", async () => {
    const g = makeGrant();
    const header = Buffer.from(JSON.stringify({
      payload: { channelId: "ab".repeat(32), cumulativeAmount: "260000", sequenceNumber: 1 },
      sessionPublicKey: Buffer.from(g.kp.publicKey).toString("hex"),
      sessionRegistration: "cd".repeat(188),
      sessionSignature: "ef".repeat(64),
    })).toString("base64");
    upsertTab({ ...g.record, lastVoucherHeader: header }, dir);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const lines: string[] = [];
    await cliTabClose(SELLER_URL, {
      dataDir: dir,
      facilitatorUrl: FAC,
      log: (s: string) => lines.push(s),
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(lines.join("\n")).toMatch(/will not guess/i);
    expect(findTab(g.record.counterparty, dir)!.lastVoucherHeader).toBe(header);
  });

  it("with no held voucher there is nothing to settle — says so, changes nothing", async () => {
    const g = makeGrant();
    upsertTab(g.record, dir);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const lines: string[] = [];
    await cliTabClose(SELLER_URL, { dataDir: dir, facilitatorUrl: FAC, log: (s: string) => lines.push(s) });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(lines.join("\n")).toMatch(/nothing/i);
  });
});
