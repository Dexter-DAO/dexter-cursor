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
      nonce: 42,
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
      return data ? { data } : null;
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

  it("survives a corrupt file without throwing (returns empty)", () => {
    upsertTab(makeGrant().record, dir);
    const file = join(dir, "tabs.json");
    require("node:fs").writeFileSync(file, "{corrupt", { mode: 0o600 });
    expect(loadTabs(dir)).toEqual([]);
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
          nonce: 7,
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
  const laneDeps = (conn: Connection) => ({
    dataDir: dir,
    connection: conn,
    facilitatorUrl: FAC,
    getMaxAmountUsdc: () => 5,
  });

  it("no tab accept in the 402 → pure fall-through (done:false, no note)", async () => {
    const lane = createTabLane(laneDeps(fakeConnection() as unknown as Connection));
    const out = await lane(
      { url: SELLER_URL, method: "GET" },
      { accepts: [{ scheme: "exact", network: "solana:mainnet", payTo: COUNTERPARTY, amount: "10000" }] },
    );
    expect(out).toEqual({ done: false });
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

  it("ACTIVE grant: pays by voucher through the REAL seller middleware, resumes over the chain frontier, persists the settle receipt", async () => {
    const g = makeGrant();
    upsertTab(g.record, dir);
    const conn = chainFor(g, sessionAccountData(g, { spent: 250000n, crystallized: 100000n }));
    const mw = tabMiddleware({
      connection: conn,
      sellerPubkey: g.record.counterparty,
      perUnit: "0.01",
      network: "solana:mainnet",
      settle: "on-close",
      facilitatorUrl: FAC,
    });
    sellerRouter(mw, () => ({ tick: 1, slot: 12345 }));

    const lane = createTabLane(laneDeps(conn));
    const out = await lane({ url: SELLER_URL, method: "GET" }, live402Body());

    expect(out.done).toBe(true);
    const result = (out as { result: Record<string, any> }).result;
    expect(result.status).toBe(200);
    expect(result.data).toEqual({ tick: 1, slot: 12345 });
    expect(result.payment).toMatchObject({
      rail: "tab",
      counterparty: g.record.counterparty,
      incrementAtomic: "10000",
      // Frontier max(250000, 100000) + 10000: the odometer resumes over the chain.
      cumulativeAtomic: "260000",
    });

    // Settle receipt (the exact accepted voucher header) persisted for `tab close`.
    const rec = findTab(g.record.counterparty, dir)!;
    expect(rec.lastVoucherHeader).toBeTruthy();
    const decoded = JSON.parse(Buffer.from(rec.lastVoucherHeader!, "base64").toString("utf8"));
    expect(decoded.payload.cumulativeAmount).toBe("260000");

    // Second call in the same process: cached tab, next voucher, same channel.
    const out2 = await lane({ url: SELLER_URL, method: "GET" }, live402Body());
    expect(out2.done).toBe(true);
    expect((out2 as { result: Record<string, any> }).result.payment.cumulativeAtomic).toBe("270000");
  });

  it("records witnessed spend through the budget runtime on a tab-paid call", async () => {
    const g = makeGrant();
    upsertTab(g.record, dir);
    const conn = chainFor(g, sessionAccountData(g));
    const mw = tabMiddleware({
      connection: conn, sellerPubkey: g.record.counterparty, perUnit: "0.01",
      network: "solana:mainnet", settle: "on-close", facilitatorUrl: FAC,
    });
    sellerRouter(mw);
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

  it("ITEM 5 — a resume whose first cumulative exceeds the seller's per-voucher bound surfaces cumulative_exceeds_cap as a CLEAR error, never a blind retry or silent exact fallback", async () => {
    // Session lifetime spend $2.00 of a $5.00 cap. A fresh process opens a
    // fresh channel, so its first voucher presents cumulative $2.01 as ONE
    // increment; the seller bounds per-voucher delivery at perUnit×100 =
    // $1.00 (its over-delivery guard) and refuses cumulative_exceeds_cap.
    const g = makeGrant();
    upsertTab(g.record, dir);
    const conn = chainFor(g, sessionAccountData(g, { spent: 2000000n }));
    const mw = tabMiddleware({
      connection: conn, sellerPubkey: g.record.counterparty, perUnit: "0.01",
      network: "solana:mainnet", settle: "on-close", facilitatorUrl: FAC,
    });
    sellerRouter(mw);

    const lane = createTabLane(laneDeps(conn));
    const out = await lane({ url: SELLER_URL, method: "GET" }, live402Body());

    expect(out.done).toBe(true); // final — NOT a fall-through to exact
    const result = (out as { result: Record<string, any> }).result;
    expect(result.status).toBe(402);
    expect(result.error).toMatch(/cumulative_exceeds_cap/);
    expect(result.error).toMatch(/resume/i); // names the resume nuance
    expect(result.error).toMatch(/do not.*retry/i);
    // The remediation command must actually RECOVER: --rekey (or remove +
    // connect), never the old close+connect no-op loop that bricked the tab.
    expect(result.error).toMatch(/--rekey/);
    expect(result.error).not.toMatch(/tab close .* then .*tab connect/);
    expect(result.tab).toMatchObject({ rail: "tab", used: false, refusalReason: "cumulative_exceeds_cap" });
    // The grant is NOT marked dead — its cap has headroom; only the seller's
    // per-voucher resume bound was hit.
    expect(findTab(g.record.counterparty, dir)!.status).toBe("active");
  });

  it("a DEAD on-chain session (revoked/expired) marks the record dead and falls through to exact with a loud note", async () => {
    const g = makeGrant();
    upsertTab(g.record, dir);
    const conn = chainFor(g, sessionAccountData(g, { version: 0 }));
    sellerRouter(tabMiddleware({
      connection: conn, sellerPubkey: g.record.counterparty, perUnit: "0.01",
      network: "solana:mainnet", settle: "on-close", facilitatorUrl: FAC,
    }));

    const lane = createTabLane(laneDeps(conn));
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
    const lane = createTabLane(laneDeps(conn));
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

  it("a lane crash never breaks the paid path — loud note, exact continues", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => live402Response()));
    const result = await x402Fetch(
      { url: SELLER_URL, method: "GET" },
      null,
      {
        maxAmountUsdc: 5,
        tabLane: async () => { throw new Error("lane exploded"); },
      },
    );
    expect(result.status).toBe(402);
    expect(String((result.tab as Record<string, unknown>).error)).toMatch(/lane exploded/);
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
  it("POSTs the persisted voucher to /tab/settle, prints the tx, clears the receipt", async () => {
    const g = makeGrant();
    // A previously accepted voucher header (shape is all the facilitator needs).
    const header = Buffer.from(JSON.stringify({
      payload: { channelId: "ab".repeat(32), cumulativeAmount: "260000", sequenceNumber: 1 },
      sessionPublicKey: Buffer.from(g.kp.publicKey).toString("hex"),
      sessionRegistration: "cd".repeat(188),
      sessionSignature: "ef".repeat(64),
    })).toString("base64");
    upsertTab({ ...g.record, lastVoucherHeader: header }, dir);

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
      cumulativeAmount: "260000",
      sequenceNumber: 1,
      network: "solana:mainnet",
    });
    expect(lines.join("\n")).toContain("SETTLE_TX_123");
    expect(findTab(g.record.counterparty, dir)!.lastVoucherHeader).toBeUndefined();
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
    upsertTab({ ...g.record, lastVoucherHeader: header }, dir);
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse({ error: "non_monotonic_cumulative" }, 409)));

    const lines: string[] = [];
    await cliTabClose(SELLER_URL, { dataDir: dir, facilitatorUrl: FAC, log: (s: string) => lines.push(s) });
    expect(lines.join("\n")).toMatch(/already/i);
    expect(findTab(g.record.counterparty, dir)!.lastVoucherHeader).toBeUndefined();
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
