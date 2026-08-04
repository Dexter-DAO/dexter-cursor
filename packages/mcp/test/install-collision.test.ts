import { describe, expect, it } from "vitest";

import {
  classifyExistingMcpProbe,
  classifyOpenDexterListProbe,
  classifyStaticClaudeDocuments,
  combineOpenDexterProbes,
  existingMcpCommand,
  existingMcpListCommand,
  existingRegistrationMessage,
} from "../src/cli/install/collision.js";

describe("local and hosted OpenDexter registration collision gate", () => {
  it("uses each client's supported read-only MCP lookup", () => {
    expect(existingMcpCommand("claude-code")).toBeNull();
    expect(existingMcpCommand("codex")).toEqual({
      command: "codex",
      args: ["mcp", "get", "opendexter"],
    });
    expect(existingMcpCommand("cursor")).toBeNull();
    expect(existingMcpListCommand("claude-code")).toBeNull();
    expect(existingMcpListCommand("codex")).toEqual({
      command: "codex",
      args: ["mcp", "list", "--json"],
    });
    expect(existingMcpListCommand("cursor")).toBeNull();
  });

  it("treats a successful lookup as an existing registration", () => {
    const probe = classifyExistingMcpProbe(
      0,
      "opendexter\\n  transport: streamable_http\\n  url: https://open.dexter.cash/mcp?secret=redacted",
      "",
    );
    expect(probe).toMatchObject({
      state: "present",
      kind: "remote_http",
      disposition: "replace_existing",
    });
    expect(probe.detail).not.toContain("https://");
    expect(probe.detail).not.toContain("secret");
  });

  it("classifies a release-pinned local stdio registration without exposing its command", () => {
    const probe = classifyExistingMcpProbe(
      0,
      "transport: stdio\\ncommand: npx -y @dexterai/opendexter@1.23.0",
      "",
    );
    expect(probe).toMatchObject({
      kind: "local_stdio",
      disposition: "upgrade_local",
    });
    expect(probe.detail).not.toContain("npx");
  });

  it("recognizes a JSON local dev registration without exposing its path", () => {
    const probe = classifyExistingMcpProbe(
      0,
      JSON.stringify({ command: "node", args: ["/private/dev/dist/index.js"] }),
      "",
    );
    expect(probe).toMatchObject({
      kind: "local_stdio",
      disposition: "upgrade_local",
    });
    expect(probe.detail).not.toContain("/private/dev");
  });

  it("recognizes the clients' explicit not-found response", () => {
    expect(
      classifyExistingMcpProbe(1, "", 'No MCP server named "opendexter".').state,
    ).toBe("absent");
  });

  it("fails closed when the client cannot prove the name is unused", () => {
    expect(classifyExistingMcpProbe(null, "", "command not found").state).toBe("unknown");
    expect(existingRegistrationMessage("Codex", "unknown")).toMatch(
      /left the client unchanged/i,
    );
  });

  it("uses an explicit requested name without treating it as coexistence permission", () => {
    expect(existingMcpCommand("codex", "opendexter-local")).toEqual({
      command: "codex",
      args: ["mcp", "get", "opendexter-local"],
    });
  });

  it("blocks an alias when canonical OpenDexter exists regardless of probe order", () => {
    const aliasAbsent = classifyExistingMcpProbe(
      1,
      "",
      'No MCP server named "opendexter-local".',
      "opendexter-local",
    );
    const canonicalHosted = classifyExistingMcpProbe(
      0,
      "transport: streamable_http\nurl: https://open.dexter.cash/mcp",
      "",
      "opendexter",
    );
    for (const probes of [
      [aliasAbsent, canonicalHosted],
      [canonicalHosted, aliasAbsent],
    ]) {
      const result = combineOpenDexterProbes("opendexter-local", probes);
      expect(result).toMatchObject({
        state: "present",
        kind: "remote_http",
        registrationName: "opendexter",
      });
      expect(
        existingRegistrationMessage("Codex", result, "opendexter-local"),
      ).toMatch(/aliasing does not make two OpenDexter registrations safe/i);
    }
  });

  it("blocks the requested alias itself when canonical OpenDexter is absent", () => {
    const aliasLocal = classifyExistingMcpProbe(
      0,
      "transport: stdio\ncommand: npx -y @dexterai/opendexter@1.23.0",
      "",
      "opendexter-local",
    );
    const canonicalAbsent = classifyExistingMcpProbe(
      1,
      "",
      'No MCP server named "opendexter".',
      "opendexter",
    );
    expect(
      combineOpenDexterProbes("opendexter-local", [canonicalAbsent, aliasLocal]),
    ).toMatchObject({
      state: "present",
      kind: "local_stdio",
      registrationName: "opendexter-local",
    });
  });

  it("blocks canonical installation when a differently named OpenDexter is listed", () => {
    const canonicalAbsent = classifyExistingMcpProbe(
      1,
      "",
      'No MCP server named "opendexter".',
      "opendexter",
    );
    const otherLocal = classifyOpenDexterListProbe(
      0,
      JSON.stringify({
        servers: [{
          name: "opendexter-local",
          command: "npx",
          args: ["-y", "@dexterai/opendexter@1.23.0"],
        }],
      }),
      "",
    );
    for (const probes of [
      [canonicalAbsent, otherLocal],
      [otherLocal, canonicalAbsent],
    ]) {
      expect(combineOpenDexterProbes("opendexter", probes)).toMatchObject({
        state: "present",
        kind: "local_stdio",
        registrationName: "another OpenDexter entry",
      });
    }
  });

  it("fails closed when the client cannot list other registrations", () => {
    expect(classifyOpenDexterListProbe(null, "", "unsupported")).toMatchObject({
      state: "unknown",
      disposition: "inspect_manually",
    });
  });

  it.each([
    [
      "user config",
      { mcpServers: { opendexter: { type: "http", url: "https://open.dexter.cash/mcp" } } },
      "remote_http",
    ],
    [
      "project mcp config",
      { mcpServers: { "opendexter-local": { command: "npx", args: ["-y", "@dexterai/opendexter@1.23.0"] } } },
      "local_stdio",
    ],
    [
      "installed plugin registry",
      { plugins: { "opendexter@opendexter": [{ scope: "user" }] } },
      "remote_http",
    ],
  ] as const)("finds OpenDexter in static Claude %s without running Claude", (_label, document, kind) => {
    expect(
      classifyStaticClaudeDocuments("opendexter", [document]),
    ).toMatchObject({ state: "present", kind });
  });
});
