import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));

const expectedRuntime = {
  "@clack/prompts": "1.7.0",
  "@dexterai/dextercard": "0.5.0",
  "@dexterai/mcp-instructions": "2.4.0",
  "@dexterai/vault": "0.43.0",
  "@dexterai/x402": "5.4.2",
  "@dexterai/x402-core": "1.5.1",
  "@dexterai/x402-mcp-tools": "0.8.1",
  "@modelcontextprotocol/ext-apps": "1.7.5",
  "@modelcontextprotocol/sdk": "1.30.0",
  "@solana/spl-token": "0.4.15",
  "@solana/web3.js": "1.98.4",
  "@x402/core": "2.19.0",
  "@x402/extensions": "2.19.0",
  bs58: "6.0.0",
  chalk: "5.6.2",
  ethers: "6.17.0",
  "qrcode-terminal": "0.12.0",
  tweetnacl: "1.0.3",
  viem: "2.55.8",
  yargs: "17.7.3",
  zod: "3.25.76",
};

const expectedBuild = {
  "@types/node": "22.20.1",
  "@types/qrcode-terminal": "0.12.2",
  "@types/yargs": "17.0.35",
  tsup: "8.5.1",
  tsx: "4.23.1",
  typescript: "5.9.3",
  vitest: "4.1.10",
};

describe("published OpenDexter dependency graph", () => {
  it("pins every direct runtime and build dependency to the tested graph", async () => {
    const pkg = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    );
    expect(pkg.dependencies).toEqual(expectedRuntime);
    expect(pkg.devDependencies).toEqual(expectedBuild);
  });

  it("disables every local publish entrypoint", async () => {
    const pkg = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    );
    expect(pkg.scripts.release).toBe("node scripts/refuse-direct-release.mjs");
    const refusal = await readFile(
      new URL("../scripts/refuse-direct-release.mjs", import.meta.url),
      "utf8",
    );
    expect(refusal).toContain("coordinated OpenDexter release");
    expect(pkg.scripts.prepublishOnly).toBe(
      "node scripts/publish-release-candidate.mjs",
    );
    expect(pkg.scripts["release:publish"]).toBeUndefined();
    expect(pkg.scripts["release:candidate"]).toBeUndefined();
    expect(pkg.scripts["release:verify"]).toBeUndefined();
    const publishRefusal = await readFile(
      new URL("../scripts/publish-release-candidate.mjs", import.meta.url),
      "utf8",
    );
    expect(publishRefusal).toContain("Local OpenDexter publishing is disabled");
    expect(publishRefusal).toContain("publish-opendexter.yml");
    expect(pkg.publishConfig).toEqual({
      access: "public",
      tag: "latest",
      provenance: true,
    });
  });

  it("keeps the unpatched bigint-buffer dependency behind fixed-width layouts", async () => {
    const walletSource = await readFile(
      new URL("../src/wallet/index.ts", import.meta.url),
      "utf8",
    );
    expect(walletSource).toMatch(
      /import \{ getAssociatedTokenAddress \} from "@solana\/spl-token";/,
    );
    expect(walletSource).not.toMatch(
      /toBigInt(?:LE|BE)|@solana\/buffer-layout-utils|bigint-buffer/,
    );

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        fileURLToPath(
          new URL(
            "../scripts/verify-bigint-buffer-boundary.mjs",
            import.meta.url,
          ),
        ),
        workspaceRoot,
      ],
      { encoding: "utf8" },
    );
    expect(stdout).toContain(
      "fixed 8/16/24/32-byte layout slices",
    );
  });
});
