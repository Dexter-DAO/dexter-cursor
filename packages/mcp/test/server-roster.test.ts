import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

vi.mock("../src/wallet/index.js", () => ({
  loadOrCreateWallet: vi.fn(async () => null),
}));

import { LOCAL_TOOL_ROSTER, startServer } from "../src/server/index.js";

afterEach(() => {
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
    expect(result.tools.map(({ name }) => name)).toEqual(LOCAL_TOOL_ROSTER);

    await client!.close();
  });
});
