/**
 * The in-band tab offer (T2b) — the consent flow comes TO the user inside
 * their agent, mirroring the open MCP's vault_required funnel.
 *
 * Covered here, end to end where money correctness lives:
 *  - dual-rail seller: the call PAYS EXACT (payAndFetch mocked at the
 *    module seam) and the offer rides alongside under `tab_offer`;
 *  - tab-only seller: the offer IS the response (mode, connect_url,
 *    message, instructions, retry echo);
 *  - tab:false: the lane is never consulted, no offer, and NO key is
 *    minted (custody untouched);
 *  - pending: one bounded chain read, then an honest tab_pending;
 *  - post-approval: the SAME retried call finds the grant on chain,
 *    promotes it, and pays by voucher through the REAL seller middleware;
 *  - offer suppression: the relayable invitation shows once per process
 *    for dual-rail sellers, never suppressed for tab-only sellers;
 *  - custody: key persisted 0600 before the link leaves, pubkey-only in
 *    every outcome.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import { tabMiddleware } from "@dexterai/x402/tab/seller";
import { deriveSessionPda } from "@dexterai/vault/session";
import type {
  Request as ExpressRequest,
  Response as ExpressResponse,
  NextFunction,
} from "express";

import { loadTabs, findTab, upsertTab, type TabRecord } from "../src/tabs/store.js";
import { createTabLane, resetTabLaneCacheForTests } from "../src/tabs/lane.js";
import { consentLinkFor } from "../src/tabs/connect.js";
import { x402Fetch, registerFetchTool } from "../../x402-mcp-tools/src/tools/fetch.js";
import type { WalletAdapter } from "../../x402-mcp-tools/src/wallet-adapter.js";

// payAndFetch is the exact path's settlement seam. Mocking it here lets the
// dual-rail test witness "paid exact AND carried the offer" without real
// funds; every other test in this file never reaches the exact path or is
// walletless (the mock stays cold for them).
vi.mock("@dexterai/x402/client", () => ({
  payAndFetch: vi.fn(async () => ({
    ok: true,
    paid: true,
    amountPaid: "10000",
    network: { caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", bare: "solana" },
    txSignature: "EXACT_TX_SIG",
    response: new Response(JSON.stringify({ tick: "exact" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  })),
  createKeypairWallet: vi.fn(async () => ({})),
  createEvmKeypairWallet: vi.fn(async () => ({})),
  getSponsoredRecommendations: vi.fn(() => null),
  fireImpressionBeacon: vi.fn(async () => {}),
}));

// ── Fixtures (shape-identical to tabs.test.ts; trimmed to what this file needs) ──

const SELLER_URL = "https://api.dexter.cash/api/x402/tab-demo/tick";
const COUNTERPARTY = "FKF63wLt122SLDNPBfpDgrMcQzxtdLfLyrUS1KziRR1h";
const FAC = "https://fac.test";
const NOW = Math.floor(Date.now() / 1000);

const TAB_ACCEPT = {
  scheme: "tab",
  network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  amount: "10000",
  maxAmountRequired: "10000",
  asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  payTo: COUNTERPARTY,
  maxTimeoutSeconds: 60,
  extra: {
    feePayer: "DeXterR2kQm8AvRHnNPatWkE46TfAcMeBDjb6FySoAb8",
    decimals: 6,
    voucherHeader: "x-tab-voucher",
  },
};
const EXACT_ACCEPT = {
  scheme: "exact",
  network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  amount: "10000",
  maxAmountRequired: "10000",
  asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  payTo: COUNTERPARTY,
  maxTimeoutSeconds: 60,
  extra: { feePayer: "DeXterR2kQm8AvRHnNPatWkE46TfAcMeBDjb6FySoAb8", decimals: 6 },
};

function body402(accepts: Array<Record<string, unknown>>) {
  return {
    error: "Payment required",
    accepts,
    resource: { url: SELLER_URL, description: "tick", mimeType: "application/json" },
  };
}
const dualRailBody = () => body402([TAB_ACCEPT, EXACT_ACCEPT]);
const tabOnlyBody = () => body402([TAB_ACCEPT]);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Real-layout 162-byte SessionAccount for a pending record the human just approved. */
function sessionAccountFor(record: TabRecord, vault: PublicKey): Buffer {
  const params = {
    maxAmountAtomic: "5000000",
    expiresAtUnix: NOW + 3600,
    nonce: 42,
    maxRevolvingCapacityAtomic: "5000000",
  };
  const buf = Buffer.alloc(162);
  Buffer.from([74, 34, 65, 133, 96, 163, 80, 69]).copy(buf, 0);
  buf.writeUInt8(1, 8);
  buf.writeUInt8(255, 9);
  vault.toBuffer().copy(buf, 10);
  new PublicKey(record.sessionPubkey).toBuffer().copy(buf, 42);
  buf.writeBigUInt64LE(BigInt(params.maxAmountAtomic), 74);
  buf.writeBigInt64LE(BigInt(params.expiresAtUnix), 82);
  new PublicKey(record.counterparty).toBuffer().copy(buf, 90);
  buf.writeUInt32LE(params.nonce, 122);
  buf.writeBigUInt64LE(0n, 126); // spent
  buf.writeBigUInt64LE(0n, 134); // current_outstanding
  buf.writeBigUInt64LE(BigInt(params.maxRevolvingCapacityAtomic), 142);
  buf.writeBigUInt64LE(0n, 150); // crystallized
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

/** Mutable connection double: tests grow `accounts` / `gpaBatches` between calls. */
function mutableConnection() {
  const accounts = new Map<string, Buffer>();
  const gpaBatches: Array<Array<{ pubkey: PublicKey; data: Buffer }>> = [];
  const conn = {
    getAccountInfo: async (pda: PublicKey) => {
      const data = accounts.get(pda.toBase58());
      return data ? { data } : null;
    },
    getProgramAccounts: async () => {
      const batch = gpaBatches.length ? gpaBatches[gpaBatches.length - 1] : [];
      return batch.map((a) => ({ pubkey: a.pubkey, account: { data: a.data } }));
    },
  } as unknown as Connection;
  return { conn, accounts, gpaBatches };
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
 * Fetch router: unvouchered hits on the seller get the given 402 body;
 * vouchered hits run the REAL seller tabMiddleware. Also serves the
 * facilitator endpoints the SDK arms/settles through.
 */
function sellerRouter(
  mw: ReturnType<typeof tabMiddleware> | null,
  body: () => unknown,
) {
  const router = vi.fn(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/tab/open")) return jsonResponse({ success: true, armed: true });
    if (u.endsWith("/tab/lock")) return jsonResponse({ success: true });
    if (u.endsWith("/tab/settle")) return jsonResponse({ settleTx: "SETTLE_TX" });
    if (u.startsWith(SELLER_URL)) {
      const headers = new Headers(init?.headers);
      const voucher = headers.get("x-tab-voucher");
      if (!voucher || !mw) return jsonResponse(body(), 402);
      const req = fakeReq(voucher);
      const res = fakeRes();
      const next = vi.fn();
      await mw(
        req as unknown as ExpressRequest,
        res as unknown as ExpressResponse,
        next as NextFunction,
      );
      res.emit("finish");
      res.emit("close");
      await new Promise((r) => setTimeout(r, 0));
      if (next.mock.calls.length > 0) return jsonResponse({ tick: "on-tab" });
      return jsonResponse(res.body, res.statusCode || 402);
    }
    return jsonResponse({}, 404);
  });
  vi.stubGlobal("fetch", router);
  return router;
}

/** Capture the x402_fetch handler registerFetchTool wires onto the server. */
function registerAndCapture(opts: {
  wallet?: WalletAdapter | null;
  getTabLane: () => unknown;
}) {
  let handler: ((args: Record<string, unknown>) => Promise<any>) | null = null;
  const fakeServer = {
    tool: (name: string, _d: string, _s: unknown, h: (args: any) => Promise<any>) => {
      if (name === "x402_fetch") handler = h;
    },
  };
  registerFetchTool(fakeServer as any, {
    apiBaseUrl: "https://x402.dexter.cash",
    metas: { fetch: {} } as any,
    wallet: opts.wallet ?? null,
    getMaxAmountUsdc: () => 5,
    getTabLane: opts.getTabLane as any,
  });
  if (!handler) throw new Error("x402_fetch handler not registered");
  return handler as (args: Record<string, unknown>) => Promise<any>;
}

const STUB_OFFER = {
  mode: "tab_available" as const,
  connectUrl: consentLinkFor(SELLER_URL, Keypair.generate().publicKey.toBase58()),
  priceUsdcPerCall: 0.01,
};

/** Relay copy must be product language: no protocol words, no em-dash asides. */
function expectCleanCopy(...texts: Array<unknown>) {
  for (const t of texts) {
    expect(String(t)).not.toMatch(/—|scheme|voucher|counterparty/i);
  }
}

// ── Suite ───────────────────────────────────────────────────────────────

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dexterai-tab-offer-test-"));
  resetTabLaneCacheForTests();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
});

describe("tab offer — lane side (mint, suppress, pending)", () => {
  const laneDeps = (conn: Connection) => ({
    dataDir: dir,
    connection: conn,
    facilitatorUrl: FAC,
    getMaxAmountUsdc: () => 5,
  });

  it("dual-rail suppression: the relayable offer shows ONCE per process, later calls carry a terse note with the same link", async () => {
    const { conn } = mutableConnection();
    const lane = createTabLane(laneDeps(conn));

    const first = await lane({ url: SELLER_URL, method: "GET" }, dualRailBody());
    expect(first.done).toBe(false);
    const offer = (first as { offer?: Record<string, unknown> }).offer!;
    expect(offer.mode).toBe("tab_available");

    const second = await lane({ url: SELLER_URL, method: "GET" }, dualRailBody());
    expect(second.done).toBe(false);
    expect((second as { offer?: unknown }).offer).toBeUndefined();
    const note = (second as { note?: Record<string, unknown> }).note!;
    expect(note).toMatchObject({ rail: "tab", used: false });
    expect(note.approveUrl).toBe(offer.connectUrl); // machine-visible, never silent
    // Still ONE record, same key — no churn from repeat calls.
    expect(loadTabs(dir)).toHaveLength(1);
  });

  it("tab-only sellers are never suppressed: the offer is the call's only possible answer", async () => {
    const { conn } = mutableConnection();
    const lane = createTabLane(laneDeps(conn));

    const first = await lane({ url: SELLER_URL, method: "GET" }, tabOnlyBody());
    expect((first as { offer?: Record<string, unknown> }).offer!.mode).toBe("tab_available");

    const second = await lane({ url: SELLER_URL, method: "GET" }, tabOnlyBody());
    const offer2 = (second as { offer?: Record<string, unknown> }).offer!;
    expect(offer2.mode).toBe("tab_pending"); // record exists now, approval still absent
  });

  it("a failed chain read while pending stays an honest tab_pending offer (never a crash, never a fake promotion)", async () => {
    const kp = nacl.sign.keyPair();
    upsertTab({
      status: "pending",
      sellerUrl: SELLER_URL,
      counterparty: COUNTERPARTY,
      sessionPubkey: new PublicKey(kp.publicKey).toBase58(),
      sessionSecretKey: bs58.encode(kp.secretKey),
      createdAt: new Date().toISOString(),
    }, dir);
    const conn = {
      getProgramAccounts: async () => { throw new Error("rpc down"); },
      getAccountInfo: async () => null,
    } as unknown as Connection;
    const lane = createTabLane(laneDeps(conn));
    const out = await lane({ url: SELLER_URL, method: "GET" }, tabOnlyBody());
    expect(out.done).toBe(false);
    expect((out as { offer?: Record<string, unknown> }).offer!.mode).toBe("tab_pending");
    expect(findTab(COUNTERPARTY, dir)!.status).toBe("pending"); // unchanged
  });
});

describe("tab offer — x402Fetch composition", () => {
  it("tab-only seller: the offer IS the response — mode, connect_url, relay copy, retry echo", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(tabOnlyBody(), 402)));
    const result = await x402Fetch(
      { url: SELLER_URL, method: "POST", body: '{"q":"tick"}' },
      null,
      { maxAmountUsdc: 5, tabLane: async () => ({ done: false, offer: STUB_OFFER }) },
    );
    expect(result).toMatchObject({
      status: 402,
      mode: "tab_available",
      connect_url: STUB_OFFER.connectUrl,
      price_per_call_usdc: 0.01,
      retry: { tool: "x402_fetch", url: SELLER_URL, method: "POST", body: '{"q":"tick"}' },
    });
    expect(result.requirements).toBeTruthy();
    expect(String(result.instructions)).toMatch(/re-run this exact call/i);
    expectCleanCopy(result.message, result.instructions);
  });

  it("dual-rail seller: PAYS EXACT and the offer rides alongside under tab_offer (no retry echo, no re-run instruction)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(dualRailBody(), 402)));
    const wallet: WalletAdapter = {
      getInfo: () => ({}),
      getAvailableUsdc: async () => 10,
      getAllBalances: async () => ({ totalUsdc: 10, chains: {} }),
      getPaymentSigners: () => ({
        solanaPrivateKey: bs58.encode(Keypair.generate().secretKey),
      }),
      getSolanaSigner: () => null,
      getEvmSigner: () => null,
    };
    const result = await x402Fetch(
      { url: SELLER_URL, method: "GET" },
      wallet,
      { maxAmountUsdc: 5, tabLane: async () => ({ done: false, offer: STUB_OFFER }) },
    );
    // The user got their answer, paid exact…
    expect(result.status).toBe(200);
    expect(result.data).toEqual({ tick: "exact" });
    expect(result.payment).toMatchObject({
      settled: true,
      details: { transaction: "EXACT_TX_SIG" },
    });
    // …AND the invitation, without any blocking mode at the top level.
    expect(result.mode).toBeUndefined();
    const attached = result.tab_offer as Record<string, unknown>;
    expect(attached).toMatchObject({
      mode: "tab_available",
      connect_url: STUB_OFFER.connectUrl,
    });
    expect("retry" in attached).toBe(false);
    expect(String(attached.instructions)).toMatch(/do not\s+re-run/i);
    expectCleanCopy(attached.message, attached.instructions);
  });

  it("dual-rail seller, walletless: the exact path's own 402 comes back with the offer attached", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(dualRailBody(), 402)));
    const result = await x402Fetch(
      { url: SELLER_URL, method: "GET" },
      null,
      { maxAmountUsdc: 5, tabLane: async () => ({ done: false, offer: STUB_OFFER }) },
    );
    expect(result.status).toBe(402);
    expect(result.mode).toBeUndefined();
    expect(String(result.message)).toMatch(/payment required/i);
    expect((result.tab_offer as Record<string, unknown>).connect_url).toBe(STUB_OFFER.connectUrl);
  });
});

describe("tab offer — the full funnel through the registered tool", () => {
  // The lane resolves `fetch` at creation; tests stub the global per call, so
  // hand it a late-bound impl that always dispatches to the CURRENT stub.
  const lateBoundFetch = ((...args: Parameters<typeof fetch>) =>
    globalThis.fetch(...args)) as typeof fetch;

  it("tab:false pays without the lane, makes no offer, and mints NOTHING", async () => {
    sellerRouter(null, tabOnlyBody);
    const { conn } = mutableConnection();
    const lane = createTabLane({ dataDir: dir, connection: conn, facilitatorUrl: FAC, getMaxAmountUsdc: () => 5, fetchImpl: lateBoundFetch });
    const handler = registerAndCapture({ getTabLane: () => lane });

    const res = await handler({ url: SELLER_URL, method: "GET", tab: false });
    expect(res.structuredContent.status).toBe(402);
    expect("tab_offer" in res.structuredContent).toBe(false);
    expect("mode" in res.structuredContent).toBe(false);
    // Custody untouched: the opt-out must not mint keys.
    expect(existsSync(join(dir, "tabs.json"))).toBe(false);

    // Control: the same call WITHOUT tab:false makes the offer and mints.
    const offered = await handler({ url: SELLER_URL, method: "GET" });
    expect(offered.structuredContent.mode).toBe("tab_available");
    expect(findTab(COUNTERPARTY, dir)!.status).toBe("pending");
  });

  it("offer → human approves → the SAME retried call finds the grant, promotes it, and rides the tab (real seller middleware)", async () => {
    const { conn, accounts, gpaBatches } = mutableConnection();
    const lane = createTabLane({ dataDir: dir, connection: conn, facilitatorUrl: FAC, getMaxAmountUsdc: () => 5, fetchImpl: lateBoundFetch });
    const handler = registerAndCapture({ getTabLane: () => lane });

    // ── Call 1: tab-only seller, no grant → the in-band offer, key custodied.
    sellerRouter(null, tabOnlyBody);
    const first = await handler({ url: SELLER_URL, method: "GET" });
    const offer = first.structuredContent;
    expect(offer.mode).toBe("tab_available");
    const record = findTab(COUNTERPARTY, dir)!;
    expect(record.status).toBe("pending");
    expect(statSync(join(dir, "tabs.json")).mode & 0o777).toBe(0o600);
    expect(offer.connect_url).toBe(consentLinkFor(SELLER_URL, record.sessionPubkey));
    expect(offer.retry).toMatchObject({ tool: "x402_fetch", url: SELLER_URL, method: "GET" });
    // Pubkey-only on the wire.
    expect(JSON.stringify(offer)).not.toContain(record.sessionSecretKey);

    // ── The human taps approve on dexter.cash: the SessionAccount lands.
    const vault = Keypair.generate().publicKey;
    const sessionData = sessionAccountFor(record, vault);
    const sessionPda = deriveSessionPda(vault, new PublicKey(COUNTERPARTY))[0];
    accounts.set(sessionPda.toBase58(), sessionData);
    accounts.set(vault.toBase58(), vaultAccountData(Keypair.generate().publicKey.toBase58()));
    gpaBatches.push([{ pubkey: sessionPda, data: sessionData }]);

    // ── Call 2 (the retry the instructions promised): rides the tab.
    const mw = tabMiddleware({
      connection: conn,
      sellerPubkey: COUNTERPARTY,
      perUnit: "0.01",
      network: "solana:mainnet",
      settle: "on-close",
      facilitatorUrl: FAC,
    });
    sellerRouter(mw, tabOnlyBody);
    const second = await handler({ url: SELLER_URL, method: "GET" });
    const paid = second.structuredContent;
    expect(paid.status).toBe(200);
    expect(paid.data).toEqual({ tick: "on-tab" });
    expect(paid.payment).toMatchObject({
      rail: "tab",
      settled: "accrued_to_tab",
      incrementAtomic: "10000",
    });
    // The grant was promoted with the CHAIN's params.
    const promoted = findTab(COUNTERPARTY, dir)!;
    expect(promoted.status).toBe("active");
    expect(promoted.vaultPda).toBe(vault.toBase58());
    expect(promoted.sessionPubkey).toBe(record.sessionPubkey); // same custodied key
  });
});
