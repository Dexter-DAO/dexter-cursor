import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  buildDoctorReport,
  inspectSignerConfiguration,
} from "../src/cli/doctor.js";

describe("read-only OpenDexter doctor", () => {
  it("classifies registration and signer readiness without changing the wallet file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opendexter-doctor-"));
    try {
      const walletFile = join(directory, "wallet.json");
      const original = JSON.stringify({
        solanaPrivateKey: "configured-but-never-returned",
        createdAt: "2026-08-04T00:00:00.000Z",
      });
      writeFileSync(walletFile, original, { mode: 0o600 });
      const inspect = vi.fn(async () => ({
        state: "present" as const,
        kind: "remote_http" as const,
        disposition: "replace_existing" as const,
        detail: "A remote HTTP MCP registration already uses this name.",
      }));

      const report = await buildDoctorReport(
        { client: "codex", registrationName: "opendexter-local" },
        { inspectRegistration: inspect, walletFile, env: {} },
      );

      expect(report).toMatchObject({
        readOnly: true,
        registrationName: "opendexter-local",
        clients: [{
          id: "codex",
          probe: {
            kind: "remote_http",
            disposition: "replace_existing",
          },
        }],
        discovery: {
          searchAndCheckNeedWallet: false,
          searchAndCheckNeedFunding: false,
        },
        payment: {
          signerConfiguration: "local_file",
          balanceChecked: false,
          configurationIsApproval: false,
        },
      });
      expect(JSON.stringify(report)).not.toContain("configured-but-never-returned");
      expect(readFileSync(walletFile, "utf8")).toBe(original);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not require a signer or funding for search and check", async () => {
    const report = await buildDoctorReport(
      {},
      {
        detectClients: () => [],
        walletFile: "/definitely/missing/opendexter-wallet.json",
        env: {},
      },
    );

    expect(report.payment.signerConfiguration).toBe("not_configured");
    expect(report.nextActions.join(" ")).toContain(
      "does not block search or check",
    );
    expect(report.payment.configurationIsApproval).toBe(false);
  });

  it("reports environment configuration without reading or exposing keys", () => {
    expect(inspectSignerConfiguration("/missing", {
      EVM_PRIVATE_KEY: "0xprivate",
    })).toBe("environment");
  });
});
