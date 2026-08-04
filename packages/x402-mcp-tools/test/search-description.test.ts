import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildToolMetas } from "../src/widget-meta.js";
import { registerSearchTool } from "../src/tools/search.js";

describe("x402_search direct MCP contract", () => {
  it("keeps discovery separate from checking, approval, and execution", () => {
    const update = vi.fn();
    const tool = vi.fn(() => ({ update }));
    const server = { tool } as unknown as McpServer;

    registerSearchTool(server, {
      apiBaseUrl: "https://dexter.example",
      metas: buildToolMetas({
        search: "ui://search",
        fetch: "ui://fetch",
        pricing: "ui://pricing",
        wallet: "ui://wallet",
      }),
    });

    expect(tool).toHaveBeenCalledOnce();
    const [name, description] = tool.mock.calls[0] as unknown as [
      string,
      string,
    ];

    expect(name).toBe("x402_search");
    expect(description).toContain("read-only discovery");
    expect(description).toContain("never authorization");
    expect(description).toContain("search itself never creates a quote or prepared purchase");
    expect(description).toContain("before `x402_check`");
    expect(description).toContain("provider-mutating check requires explicit confirmation first");
    expect(description).toContain("confirmation never approves a later payment");
    expect(description).toContain("only then use `x402_fetch`");
  });

  it("uses returned execution truth to reject or prepare the next step", () => {
    const tool = vi.fn(() => ({ update: vi.fn() }));
    const server = { tool } as unknown as McpServer;

    registerSearchTool(server, {
      apiBaseUrl: "https://dexter.example",
      metas: buildToolMetas({
        search: "ui://search",
        fetch: "ui://fetch",
        pricing: "ui://pricing",
        wallet: "ui://wallet",
      }),
    });

    const description = tool.mock.calls[0]?.[1] as unknown as string;

    for (const field of [
      "`pricing`",
      "`networkLabel`",
      "`trustBasis`",
      "`trustLabel`",
      "`execution`",
      "`inputSchema`",
      "`pathParams`",
      "`schemaSource`",
    ]) {
      expect(description).toContain(field);
    }

    expect(description).toContain("Catalog-only entries");
    expect(description).toContain("execution is unsupported");
    expect(description).toContain("are not callable");
    expect(description).toContain("Input-dependent pricing");
    expect(description).toContain("POST/PUT/PATCH/DELETE");
    expect(description).toContain("path parameters");
    expect(description).toContain("exact method, resolved URL, and required body values");
  });
});
