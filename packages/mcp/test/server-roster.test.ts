import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

vi.mock("../src/wallet/index.js", () => ({
  loadOrCreateWallet: vi.fn(async () => null),
}));
vi.mock("../src/connect/store.js", () => ({
  loadSession: vi.fn(() => null),
  saveSession: vi.fn(),
}));

import { HOSTED_RUNTIME_TOOL_ROSTER, startServer } from "../src/server/index.js";
import {
  HOSTED_PROXY_INSTRUCTIONS,
  registerHostedProxyTools,
} from "../src/server/hosted-proxy.js";
import { loadOrCreateWallet } from "../src/wallet/index.js";
import { loadSession } from "../src/connect/store.js";

beforeEach(() => {
  vi.mocked(loadSession).mockReturnValue(null);
  vi.mocked(loadOrCreateWallet).mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("local MCP tool registration", () => {
  it("exposes exactly the documented roster through tools/list", async () => {
    const realConnect = McpServer.prototype.connect;
    let client: Client | undefined;

    vi.spyOn(McpServer.prototype, "connect").mockImplementation(
      async function () {
        const [clientTransport, serverTransport] =
          InMemoryTransport.createLinkedPair();

        client = new Client({
          name: "local-roster-test",
          version: "1.0.0",
        });

        await Promise.all([
          realConnect.call(this, serverTransport),
          client.connect(clientTransport),
        ]);
      },
    );

    // startServer owns production signal handlers. Do not add them to Vitest.
    vi.spyOn(process, "on").mockImplementation(
      (() => process) as typeof process.on,
    );

    await startServer({ transport: "stdio", dev: true });

    expect(client).toBeDefined();
    const result = await client!.listTools();
    expect(result.tools.map(({ name }) => name)).toEqual(HOSTED_RUNTIME_TOOL_ROSTER);
    expect(HOSTED_RUNTIME_TOOL_ROSTER).toEqual([
      "x402_search",
      "x402_check",
      "x402_fetch",
      "x402_status",
      "x402_access",
      "x402_wallet",
      "dexter_portfolio",
    ]);
    const fetchSchema = result.tools.find(
      ({ name }) => name === "x402_fetch",
    )!.inputSchema as {
      required?: string[];
      properties?: Record<string, unknown>;
      additionalProperties?: boolean;
    };
    expect(fetchSchema.required).toEqual(["intentId", "maxAmountAtomic"]);
    expect(Object.keys(fetchSchema.properties ?? {})).toEqual([
      "intentId",
      "maxAmountAtomic",
    ]);
    expect(fetchSchema.additionalProperties).toBe(false);
    const statusSchema = result.tools.find(
      ({ name }) => name === "x402_status",
    )!.inputSchema as {
      required?: string[];
      properties?: Record<string, unknown>;
      additionalProperties?: boolean;
    };
    expect(statusSchema.required).toEqual(["intentId"]);
    expect(Object.keys(statusSchema.properties ?? {})).toEqual(["intentId"]);
    expect(statusSchema.additionalProperties).toBe(false);
    const accessSchema = result.tools.find(
      ({ name }) => name === "x402_access",
    )!.inputSchema as {
      properties?: Record<string, unknown>;
      additionalProperties?: boolean;
    };
    expect(Object.keys(accessSchema.properties ?? {})).toEqual([
      "url",
      "method",
      "body",
      "network",
    ]);
    expect(accessSchema.additionalProperties).toBe(false);
    expect(HOSTED_PROXY_INSTRUCTIONS).toContain("x402_status");
    expect(HOSTED_PROXY_INSTRUCTIONS).toContain("never be retried blindly");
    expect(HOSTED_PROXY_INSTRUCTIONS).toContain("OAuth bearer");
    expect(HOSTED_PROXY_INSTRUCTIONS).toContain(
      "A non-GET x402_check can still cause seller-side effects",
    );
    expect(HOSTED_PROXY_INSTRUCTIONS).toContain(
      "that probe authorization is not payment approval",
    );
    expect(HOSTED_PROXY_INSTRUCTIONS).toContain(
      "A non-GET x402_access can cause seller-side effects",
    );
    expect(HOSTED_PROXY_INSTRUCTIONS).not.toContain("preparedPurchase");
    expect(
      result.tools.find(({ name }) => name === "x402_check")!.annotations,
    ).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(
      result.tools.find(({ name }) => name === "x402_access")!.annotations,
    ).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(loadOrCreateWallet).not.toHaveBeenCalled();

    const disconnectedFetch = await client!.callTool({
      name: "x402_fetch",
      arguments: { intentId: "intent_exact", maxAmountAtomic: "1" },
    });
    expect(disconnectedFetch.isError).toBe(true);
    expect(disconnectedFetch.structuredContent).toMatchObject({
      error: "hosted_runtime_call_failed",
      message: "connect_required_for_hosted_x402_fetch",
      automaticLocalFallback: false,
    });
    expect(loadOrCreateWallet).not.toHaveBeenCalled();

    await client!.close();
  });

  it("never mounts the legacy local executor when an environment signer exists", async () => {
    vi.stubEnv("DEXTER_PRIVATE_KEY", "ignored-local-signer");
    vi.spyOn(McpServer.prototype, "connect").mockResolvedValue();
    vi.spyOn(process, "on").mockImplementation((() => process) as typeof process.on);

    await startServer({
      transport: "stdio",
      dev: true,
    });

    expect(loadOrCreateWallet).not.toHaveBeenCalled();
  });

  it("forwards exact hosted requests and retries only read-safe methods", async () => {
    const server = new McpServer({ name: "proxy-test", version: "1.0.0" });
    const callTool = vi.fn(async (toolName: string, args: Record<string, unknown>) => ({
      content: [{ type: "text" as const, text: JSON.stringify({ ok: true, toolName, args }) }],
      structuredContent: { ok: true, toolName, args },
    }));
    registerHostedProxyTools(server, {
      callTool,
      readAuthorityStatus: async () => ({
        namespace: "opendexter-runtime-authority/v1",
        runtimeSource: "hosted_governed_x402",
        status: "unavailable",
        active: null,
        authoritySource: null,
        grantId: null,
        grantRevision: null,
        logicalGrantActive: null,
        principal: null,
        limits: null,
        remaining: null,
        expiresAt: null,
        scopes: null,
        activeRole: null,
        revocation: { revoked: null, manageUrl: "https://dexter.cash/wallet" },
        fallback: {
          available: false,
          enabled: false,
          active: false,
          automatic: false,
        },
        evidenceNamespace: null,
        reason: "governed_authority_status_unavailable",
      }),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "proxy-client", version: "1.0.0" });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    await client.callTool({
      name: "x402_fetch",
      arguments: { intentId: "intent_exact", maxAmountAtomic: "250000" },
    });
    await client.callTool({
      name: "x402_status",
      arguments: { intentId: "intent_exact" },
    });
    await client.callTool({
      name: "x402_check",
      arguments: {
        url: "https://seller.example/check",
        method: "POST",
        body: '{"symbol":"SOL"}',
      },
    });
    await client.callTool({
      name: "x402_access",
      arguments: {
        url: "https://seller.example/access",
        method: "DELETE",
      },
    });
    await client.callTool({
      name: "x402_check",
      arguments: { url: "https://seller.example/read", method: "GET" },
    });
    await client.callTool({
      name: "x402_access",
      arguments: { url: "https://seller.example/read", method: "GET" },
    });

    expect(callTool).toHaveBeenNthCalledWith(
      1,
      "x402_fetch",
      { intentId: "intent_exact", maxAmountAtomic: "250000" },
      false,
    );
    expect(callTool).toHaveBeenNthCalledWith(
      2,
      "x402_status",
      { intentId: "intent_exact" },
      true,
    );
    expect(callTool).toHaveBeenNthCalledWith(
      3,
      "x402_check",
      {
        url: "https://seller.example/check",
        method: "POST",
        body: '{"symbol":"SOL"}',
      },
      false,
    );
    expect(callTool).toHaveBeenNthCalledWith(
      4,
      "x402_access",
      { url: "https://seller.example/access", method: "DELETE" },
      false,
    );
    expect(callTool).toHaveBeenNthCalledWith(
      5,
      "x402_check",
      { url: "https://seller.example/read", method: "GET" },
      true,
    );
    expect(callTool).toHaveBeenNthCalledWith(
      6,
      "x402_access",
      { url: "https://seller.example/read", method: "GET" },
      true,
    );

    await Promise.all([client.close(), server.close()]);
  });
});
