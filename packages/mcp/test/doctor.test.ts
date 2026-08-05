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
  inspectLegacyRecoveryMaterial,
} from "../src/cli/doctor.js";

describe("read-only OpenDexter doctor", () => {
  it("classifies registration and legacy recovery material without changing or exposing the wallet file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opendexter-doctor-"));
    try {
      const walletFile = join(directory, "wallet.json");
      const original = JSON.stringify({
        solanaAddress: "11111111111111111111111111111111",
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
        { inspectRegistration: inspect, walletFile, env: {}, connectedSession: false },
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
        legacyRecovery: {
          material: "wallet_file_public_recovery",
          readOnly: true,
          paymentEnabled: false,
          signerLoaded: false,
          privateKeysReturned: false,
        },
        payment: {
          source: "hosted_governed_x402",
          connection: "disconnected",
          authorityStatus: "not_checked",
          balanceChecked: false,
          localSignerExecutor: false,
          configurationIsApproval: false,
        },
      });
      expect(JSON.stringify(report)).not.toContain("configured-but-never-returned");
      expect(readFileSync(walletFile, "utf8")).toBe(original);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not require legacy material or funding for search and check", async () => {
    const report = await buildDoctorReport(
      {},
      {
        detectClients: () => [],
        walletFile: "/definitely/missing/opendexter-wallet.json",
        env: {},
        connectedSession: false,
      },
    );

    expect(report.legacyRecovery.material).toBe("not_present");
    expect(report.nextActions.join(" ")).toContain(
      "opendexter connect",
    );
    expect(report.nextActions.join(" ")).not.toContain("configure one");
    expect(report.payment.source).toBe("hosted_governed_x402");
    expect(report.payment.localSignerExecutor).toBe(false);
    expect(report.payment.configurationIsApproval).toBe(false);
  });

  it("reports only environment variable-name presence without exposing keys", () => {
    expect(inspectLegacyRecoveryMaterial("/missing", {
      EVM_PRIVATE_KEY: "0xprivate",
    })).toBe("environment_material_present");
  });
});
