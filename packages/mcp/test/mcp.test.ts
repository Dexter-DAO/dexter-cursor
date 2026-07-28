import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Wallet Tests ──────────────────────────────────────────────────────────

describe("wallet", () => {
  const testDir = join(tmpdir(), `dexterai-mcp-test-${Date.now()}`);
  const walletFile = join(testDir, "wallet.json");

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch {}
  });

  it("creates a valid wallet file", async () => {
    // Dynamically set env to redirect wallet location
    const origDataDir = process.env.__TEST_DATA_DIR;
    process.env.__TEST_DATA_DIR = testDir;

    // Import and test keypair generation directly
    const { Keypair } = await import("@solana/web3.js");
    const bs58 = await import("bs58");

    const keypair = Keypair.generate();
    const info = {
      solanaPrivateKey: bs58.default.encode(keypair.secretKey),
      solanaAddress: keypair.publicKey.toBase58(),
      createdAt: new Date().toISOString(),
    };

    writeFileSync(walletFile, JSON.stringify(info, null, 2), { mode: 0o600 });

    expect(existsSync(walletFile)).toBe(true);
    const loaded = JSON.parse(readFileSync(walletFile, "utf-8"));
    expect(loaded.solanaAddress).toBe(info.solanaAddress);
    expect(loaded.solanaPrivateKey).toBe(info.solanaPrivateKey);
    expect(loaded.solanaAddress).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);

    process.env.__TEST_DATA_DIR = origDataDir;
  });

  it("rejects invalid private key formats", async () => {
    const { Keypair } = await import("@solana/web3.js");
    const bs58 = await import("bs58");

    expect(() => Keypair.fromSecretKey(bs58.default.decode("invalid"))).toThrow();
    expect(() => Keypair.fromSecretKey(new Uint8Array(32))).toThrow();
  });

  it("loads wallet from base58 key", async () => {
    const { Keypair } = await import("@solana/web3.js");
    const bs58 = await import("bs58");

    const original = Keypair.generate();
    const encoded = bs58.default.encode(original.secretKey);
    const restored = Keypair.fromSecretKey(bs58.default.decode(encoded));

    expect(restored.publicKey.toBase58()).toBe(original.publicKey.toBase58());
  });

  it("loads wallet from JSON array key", async () => {
    const { Keypair } = await import("@solana/web3.js");

    const original = Keypair.generate();
    const jsonArray = JSON.stringify(Array.from(original.secretKey));
    const parsed = JSON.parse(jsonArray);
    const restored = Keypair.fromSecretKey(Uint8Array.from(parsed));

    expect(restored.publicKey.toBase58()).toBe(original.publicKey.toBase58());
  });

  it("detects corrupted wallet files", () => {
    writeFileSync(walletFile, "not json{{{", { mode: 0o600 });
    expect(() => JSON.parse(readFileSync(walletFile, "utf-8"))).toThrow();
  });

  it("labels the MCP wallet as the local payment signer", async () => {
    const { Keypair } = await import("@solana/web3.js");
    const { createNpmWalletAdapter } = await import("../src/wallet/adapter.js");
    const keypair = Keypair.generate();
    const adapter = createNpmWalletAdapter({
      info: {
        solanaAddress: keypair.publicKey.toBase58(),
        createdAt: new Date().toISOString(),
      },
      solanaKeypair: keypair,
      status: "existing",
    });

    expect(adapter.getInfo()).toMatchObject({
      solanaAddress: keypair.publicKey.toBase58(),
      descriptor: "local_file_or_environment_payment_signer",
    });
  });
});

// ── Search Result Formatting Tests ────────────────────────────────────────

describe("search formatting", () => {
  function formatResource(r: any) {
    return {
      name: r.displayName || r.resourceUrl,
      url: r.resourceUrl,
      method: r.method || "GET",
      price: r.priceLabel || (r.priceUsdc != null ? `$${r.priceUsdc.toFixed(2)}` : "free"),
      network: r.priceNetwork || null,
      description: r.description || "",
      category: r.category || "uncategorized",
      qualityScore: r.qualityScore ?? null,
      verified: r.verificationStatus === "pass",
      totalCalls: r.totalSettlements ?? 0,
      seller: r.seller?.displayName || null,
    };
  }

  it("formats a complete resource", () => {
    const result = formatResource({
      resourceUrl: "https://example.com/api",
      displayName: "Test API",
      priceUsdc: 0.05,
      priceNetwork: "solana",
      qualityScore: 92,
      verificationStatus: "pass",
      totalSettlements: 1000,
      category: "AI",
      seller: { displayName: "Test Seller" },
    });

    expect(result.name).toBe("Test API");
    expect(result.price).toBe("$0.05");
    expect(result.verified).toBe(true);
    expect(result.totalCalls).toBe(1000);
    expect(result.seller).toBe("Test Seller");
  });

  it("handles missing fields gracefully", () => {
    const result = formatResource({
      resourceUrl: "https://example.com/api",
    });

    expect(result.name).toBe("https://example.com/api");
    expect(result.price).toBe("free");
    expect(result.network).toBeNull();
    expect(result.verified).toBe(false);
    expect(result.totalCalls).toBe(0);
    expect(result.seller).toBeNull();
    expect(result.category).toBe("uncategorized");
  });

  it("uses priceLabel over priceUsdc when available", () => {
    const result = formatResource({
      resourceUrl: "https://example.com",
      priceLabel: "$0.05/call",
      priceUsdc: 0.05,
    });
    expect(result.price).toBe("$0.05/call");
  });
});

// ── 402 Response Parsing Tests ────────────────────────────────────────────

describe("402 parsing", () => {
  function parse402(body: unknown) {
    const obj = body as Record<string, unknown> | null;
    if (!obj?.accepts || !Array.isArray(obj.accepts)) return { requirements: null, firstAccept: null };
    return {
      requirements: { accepts: obj.accepts, x402Version: obj.x402Version ?? 2, resource: obj.resource },
      firstAccept: (obj.accepts[0] as Record<string, unknown>) || null,
    };
  }

  it("parses v2 402 response", () => {
    const body = {
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
          amount: "50000",
          asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          payTo: "DevFFyNWxZPtYLpEjzUnN1PFc9Po6PH7eZCi9f3tTkTw",
        },
      ],
      resource: { url: "https://example.com/api" },
    };

    const { requirements, firstAccept } = parse402(body);
    expect(requirements).not.toBeNull();
    expect(requirements!.x402Version).toBe(2);
    expect(firstAccept!.amount).toBe("50000");
    expect(firstAccept!.network).toBe("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
  });

  it("parses v1 402 response (no x402Version)", () => {
    const body = {
      accepts: [{ scheme: "exact", network: "solana", amount: "10000" }],
    };
    const { requirements } = parse402(body);
    expect(requirements!.x402Version).toBe(2); // defaults to 2
  });

  it("returns null for non-402 bodies", () => {
    expect(parse402(null)).toEqual({ requirements: null, firstAccept: null });
    expect(parse402({})).toEqual({ requirements: null, firstAccept: null });
    expect(parse402({ accepts: "not-array" })).toEqual({ requirements: null, firstAccept: null });
  });
});

// ── Check Tool Response Tests ─────────────────────────────────────────────

describe("check tool responses", () => {
  it("classifies 200 as free", () => {
    const status = 200;
    expect(status >= 200 && status < 300).toBe(true);
  });

  it("classifies 500 as server error", () => {
    const status = 500;
    expect(status >= 500).toBe(true);
  });

  it("classifies 404 as client error", () => {
    const status = 404;
    expect(status >= 400 && status < 500).toBe(true);
  });
});

// ── SIWX Access Flow Tests ────────────────────────────────────────────────

describe("siwx access flow", () => {
  it("attaches SIGN-IN-WITH-X and retries successfully for a Solana-gated endpoint", async () => {
    const { Keypair } = await import("@solana/web3.js");
    const { declareSIWxExtension, SOLANA_MAINNET } = await import("@x402/extensions/sign-in-with-x");
    const { encodePaymentRequiredHeader } = await import("@x402/core/http");
    const { accessWithWalletProof } = await import("@dexterai/x402-mcp-tools");
    const { createNpmWalletAdapter } = await import("../src/wallet/adapter.js");

    const keypair = Keypair.generate();
    const loadedWallet = {
      info: {
        solanaPrivateKey: (await import("bs58")).default.encode(keypair.secretKey),
        solanaAddress: keypair.publicKey.toBase58(),
        createdAt: new Date().toISOString(),
      },
      solanaKeypair: keypair,
      status: "created" as const,
    };
    // accessWithWalletProof consumes the WalletAdapter contract, not the
    // raw file-backed LoadedWallet — wrap it the same way the server does.
    const wallet = createNpmWalletAdapter(loadedWallet);

    const declaration = declareSIWxExtension({
      domain: "example.com",
      resourceUri: "https://example.com/protected",
      network: SOLANA_MAINNET,
    });
    const ext = (declaration as any)["sign-in-with-x"];
    const enrichedExtension = {
      "sign-in-with-x": {
        info: {
          ...ext.info,
          nonce: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          issuedAt: "2026-03-14T00:00:00.000Z",
          expirationTime: "2026-03-14T00:05:00.000Z",
        },
        supportedChains: ext.supportedChains,
        schema: ext.schema,
      },
    };

    const paymentRequired = {
      x402Version: 2,
      accepts: [{ network: SOLANA_MAINNET, scheme: "exact" }],
      extensions: enrichedExtension,
    };
    const header = encodePaymentRequiredHeader(paymentRequired as any);

    const calls: Array<{ authHeader: string | null }> = [];
    const originalFetch = global.fetch;
    global.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const authHeader = init?.headers instanceof Headers
        ? init.headers.get("SIGN-IN-WITH-X")
        : (init?.headers as Record<string, string> | undefined)?.["SIGN-IN-WITH-X"] ?? null;
      calls.push({ authHeader });

      if (!authHeader) {
        return new Response("payment required", {
          status: 402,
          headers: { "PAYMENT-REQUIRED": header },
        });
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const result = await accessWithWalletProof(
        { url: "https://example.com/protected", method: "GET" },
        wallet as any,
      );
      expect(result.status).toBe(200);
      expect((result as any).auth.mode).toBe("siwx");
      expect((result as any).data.ok).toBe(true);
      expect(calls).toHaveLength(2);
      expect(calls[0]!.authHeader).toBeNull();
      expect(typeof calls[1]!.authHeader).toBe("string");
    } finally {
      global.fetch = originalFetch;
    }
  });
});

// ── Install Config Tests ──────────────────────────────────────────────────

describe("install config", () => {
  it("generates correct Cursor config", async () => {
    const { getClientConfig } = await import("../src/cli/install/clients.js");
    const { VERSION } = await import("../src/config.js");
    const config = getClientConfig("cursor", false);

    expect(config.configPath).toContain(".cursor");
    expect(config.configPath).toContain("mcp.json");
    expect(config.sectionKey).toBe("mcpServers");
    expect(config.entry).toEqual({
      command: "npx",
      args: ["-y", `@dexterai/opendexter@${VERSION}`],
    });
    expect((config.entry as { args: string[] }).args).not.toContain(
      "@dexterai/opendexter@latest",
    );
    expect(config.manual).toBeUndefined();
  });

  it("generates correct Claude Code config", async () => {
    const { getClientConfig } = await import("../src/cli/install/clients.js");
    const config = getClientConfig("claude-code", false);

    expect(config.configPath).toContain(".claude.json");
    expect(config.sectionKey).toBe("mcpServers");
  });

  it("pins every generated non-Claude release config to this candidate version", async () => {
    const { getClientConfig } = await import("../src/cli/install/clients.js");
    const { VERSION } = await import("../src/config.js");
    for (const client of [
      "cursor",
      "codex",
      "vscode",
      "windsurf",
      "gemini-cli",
    ] as const) {
      expect(getClientConfig(client, false).entry).toEqual({
        command: "npx",
        args: ["-y", `@dexterai/opendexter@${VERSION}`],
      });
    }
  });

  it("marks Codex as manual (TOML)", async () => {
    const { getClientConfig } = await import("../src/cli/install/clients.js");
    const config = getClientConfig("codex", false);

    expect(config.manual).toBe(true);
    expect(config.sectionKey).toBe("mcp_servers");
  });

  it("generates dev mode config with local path", async () => {
    const { getClientConfig } = await import("../src/cli/install/clients.js");
    const config = getClientConfig("cursor", true);

    expect(config.entry).toHaveProperty("command", "node");
    const args = (config.entry as any).args as string[];
    expect(args[0]).toContain("dist/index.js");
    expect(args).toContain("--dev");
  });

  it("lists all 6 supported clients", async () => {
    const { CLIENTS } = await import("../src/cli/install/clients.js");
    const ids = Object.keys(CLIENTS);
    expect(ids).toHaveLength(6);
    expect(ids).toContain("cursor");
    expect(ids).toContain("claude-code");
    expect(ids).toContain("codex");
    expect(ids).toContain("vscode");
    expect(ids).toContain("windsurf");
    expect(ids).toContain("gemini-cli");
  });
});

// ── Payment Policy Gate Tests ─────────────────────────────────────────────
//
// evaluatePaymentRequirements is the spend-safety filter on the paid path:
// given a 402 `accepts` array, the wallet, and the per-call USDC cap, it
// decides whether any option is within policy (price <= cap) AND funded
// (balance >= price). These tests exercise the real exported function with
// a fake WalletAdapter, not a re-implementation.

describe("payment policy gate", () => {
  // Minimal WalletAdapter: only getAvailableUsdc is exercised by
  // evaluatePaymentRequirements. The rest satisfy the type with stubs.
  function fakeWallet(balances: Record<string, number>) {
    return {
      getInfo: () => ({}),
      getAvailableUsdc: async (network: string) => balances[network] ?? 0,
      getAllBalances: async () => ({ totalUsdc: 0, chains: {} }),
      getPaymentSigners: () => ({}),
      getSolanaSigner: () => null,
      getEvmSigner: () => null,
    };
  }

  // Build a 402 requirements object. amount is in base units; with the
  // default 6 decimals, "100000" => $0.10.
  function accept(network: string, amountBaseUnits: string) {
    return { scheme: "exact", network, amount: amountBaseUnits };
  }

  it("rejects when every option's price exceeds the per-call cap", async () => {
    const { evaluatePaymentRequirements } = await import("@dexterai/x402-mcp-tools");
    const wallet = fakeWallet({ "solana": 100 }); // funded plenty
    const requirements = { accepts: [accept("solana", "500000")] }; // $0.50

    const result = await evaluatePaymentRequirements(wallet as any, requirements, 0.1);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Payment policy blocked");
      // fmtUsd intentionally trims trailing zeros so sub-cent prices
      // ($0.001, $0.005) render honestly. $0.10 thus renders as "$0.1".
      expect(result.error).toContain("$0.1");
    }
  });

  it("rejects when the option is within cap but the wallet is underfunded", async () => {
    const { evaluatePaymentRequirements } = await import("@dexterai/x402-mcp-tools");
    const wallet = fakeWallet({ "solana": 0.02 }); // only $0.02 on chain
    const requirements = { accepts: [accept("solana", "100000")] }; // $0.10, under cap

    const result = await evaluatePaymentRequirements(wallet as any, requirements, 1.0);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Insufficient balance");
    }
  });

  it("accepts when at least one chain is both within cap and funded", async () => {
    const { evaluatePaymentRequirements } = await import("@dexterai/x402-mcp-tools");
    // Base is broke, Solana is funded — the gate should pick Solana.
    const wallet = fakeWallet({ "eip155:8453": 0, "solana": 5 });
    const requirements = {
      accepts: [
        accept("eip155:8453", "100000"), // $0.10, unfunded
        accept("solana", "100000"), // $0.10, funded
      ],
    };

    const result = await evaluatePaymentRequirements(wallet as any, requirements, 1.0);

    expect(result.ok).toBe(true);
  });

  it("treats an empty accepts array as a free call (ok)", async () => {
    const { evaluatePaymentRequirements } = await import("@dexterai/x402-mcp-tools");
    const wallet = fakeWallet({});

    const result = await evaluatePaymentRequirements(wallet as any, { accepts: [] }, 0.1);

    expect(result.ok).toBe(true);
  });
});

// ── Integration Tests (require network) ───────────────────────────────────

const describeLive =
  process.env.OPENDEXTER_RUN_LIVE_TESTS === "1" ? describe : describe.skip;

describeLive("integration", () => {
  it("searches the live capability endpoint", async () => {
    const res = await fetch(
      "https://api.dexter.cash/api/x402gle/capability?q=token%20price&limit=3",
      { signal: AbortSignal.timeout(20_000) },
    );
    expect(res.ok).toBe(true);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    // Either strong or related results should exist for a common query like "token price"
    const total = (data.strongResults?.length ?? 0) + (data.relatedResults?.length ?? 0);
    expect(total).toBeGreaterThan(0);
    // Tiered response shape sanity check
    expect(typeof data.strongCount).toBe("number");
    expect(typeof data.relatedCount).toBe("number");
    expect(data.rerank).toBeDefined();
  }, 25_000);

  it("gets 402 from v2-test endpoint", async () => {
    const res = await fetch("https://api.dexter.cash/api/v2-test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    expect(res.status).toBe(402);
    const body = await res.json() as any;
    expect(body.accepts).toBeDefined();
    expect(Array.isArray(body.accepts)).toBe(true);
    expect(body.accepts.length).toBeGreaterThan(0);
  }, 15_000);

  it("creates a QR pay session", async () => {
    const res = await fetch("https://api.dexter.cash/v2/pay/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        payTo: "DevFFyNWxZPtYLpEjzUnN1PFc9Po6PH7eZCi9f3tTkTw",
        amount: "10000",
        asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      }),
      signal: AbortSignal.timeout(10_000),
    });
    expect(res.ok).toBe(true);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.nonce).toBeDefined();
    expect(data.solanaPayUrl).toContain("solana:");
    expect(data.txUrl).toContain("/v2/pay/tx");
  }, 15_000);
});
