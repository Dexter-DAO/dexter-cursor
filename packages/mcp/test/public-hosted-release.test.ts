import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  preparePublicHostedContract,
  preparePublicHostedPluginContract,
  PUBLIC_HOSTED_HEALTH_URL,
  validatePublicHostedContract,
  validatePublicHostedHealth,
} from "../scripts/public-hosted-release.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function contract() {
  return JSON.parse(readFileSync(
    resolve(packageRoot, "release/hosted-public-release.json"),
    "utf8",
  ));
}

function pluginContract() {
  return JSON.parse(readFileSync(
    resolve(
      repositoryRoot,
      "plugins/opendexter/skills/opendexter/references/hosted-contract.json",
    ),
    "utf8",
  ));
}

function fullDescriptorFromPlugin(pinned: any) {
  return {
    schemaVersion: pinned.schemaVersion,
    kind: "opendexter-hosted-tool-descriptors/v2",
    sourceContracts: pinned.sourceContracts,
    oauth: pinned.oauth,
    anonymousToolNames: pinned.anonymousToolNames,
    oauthPromotedToolNames: pinned.oauthPromotedToolNames,
    connectedToolNames: pinned.connectedToolNames,
    optionalOAuthToolNames: pinned.optionalOAuthToolNames,
    tools: pinned.tools,
  };
}

function healthDocument() {
  const frozen = contract();
  return {
    ok: true,
    service: "dexter-open-mcp",
    release: {
      service: "dexter-open-mcp",
      commit: frozen.release.commit,
      tree: frozen.release.tree,
      artifactManifestSha256: frozen.release.artifactManifestSha256,
      descriptorSha256: frozen.release.descriptorSha256,
      packageVersion: frozen.release.packageVersion,
    },
  };
}

describe("public hosted release boundary", () => {
  it("freezes only the accepted public MCP release and public descriptor", () => {
    const frozen = validatePublicHostedContract(contract());
    expect(frozen.health.url).toBe(PUBLIC_HOSTED_HEALTH_URL);
    expect(frozen.release.repository).toBe(
      "https://github.com/Dexter-DAO/dexter-mcp",
    );
    expect(frozen.publicDescriptor.connectedToolNames).toHaveLength(12);
    const bytes = JSON.stringify(frozen);
    for (const forbidden of [
      "sourceContracts",
      "dexter-api",
      "dexter-facilitator",
      "OPENDXTER_SOURCE_APP_ID",
      "OPENDXTER_SOURCE_APP_PRIVATE_KEY",
      "GH_TOKEN",
    ]) {
      expect(bytes).not.toContain(forbidden);
    }
  });

  it("binds the combined skill contract to the same accepted public bytes", () => {
    const publicReceipt = contract();
    const plugin = pluginContract();
    expect(plugin.source.commit).toBe(publicReceipt.release.commit);
    expect(plugin.source.tree).toBe(publicReceipt.release.tree);
    expect(plugin.materialization.descriptorSha256).toBe(
      publicReceipt.release.descriptorSha256,
    );
    expect(plugin.materialization.packageLockSha256).toBe(
      publicReceipt.materialization.packageLockSha256,
    );
    expect(plugin.materialization.sourceArchiveSha256).toBe(
      publicReceipt.materialization.sourceArchiveSha256,
    );
    expect(plugin.mcp.manifestVersion).toBe(publicReceipt.release.packageVersion);
    const descriptor = fullDescriptorFromPlugin(plugin);
    const descriptorBytes = `${JSON.stringify(descriptor, null, 2)}\n`;
    expect(createHash("sha256").update(descriptorBytes).digest("hex")).toBe(
      publicReceipt.release.descriptorSha256,
    );
    const { sourceContracts: _sourceContracts, ...publicProjection } = descriptor;
    expect(publicProjection).toEqual(publicReceipt.publicDescriptor);
  });

  it("accepts only a complete canonical public health release identity", () => {
    expect(validatePublicHostedHealth(healthDocument())).toMatchObject({
      healthUrl: PUBLIC_HOSTED_HEALTH_URL,
      service: "dexter-open-mcp",
      repository: "https://github.com/Dexter-DAO/dexter-mcp",
    });
    for (const mutate of [
      (value: any) => { value.ok = false; },
      (value: any) => { value.service = "other"; },
      (value: any) => { value.release.commit = "short"; },
      (value: any) => { value.release.tree = "short"; },
      (value: any) => { value.release.artifactManifestSha256 = "short"; },
      (value: any) => { value.release.descriptorSha256 = "short"; },
    ]) {
      const hostile = structuredClone(healthDocument());
      mutate(hostile);
      expect(() => validatePublicHostedHealth(hostile)).toThrow();
    }
  });

  it("resolves live health exactly once during explicit preparation", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "opendexter-public-prep-test-"));
    temporaryRoots.push(root);
    mkdirSync(resolve(root, "source"));
    const expected = contract();
    const healthBytes = Buffer.from(JSON.stringify(healthDocument()));
    let fetches = 0;
    let inspections = 0;
    let writes = 0;
    const result = await preparePublicHostedContract({
      sourceRoot: resolve(root, "source"),
      outputPath: resolve(root, "contract.json"),
      fetchImpl: async () => {
        fetches += 1;
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => healthBytes,
        } as any;
      },
      inspectSource: async ({ release }: any) => {
        inspections += 1;
        expect(release.commit).toBe(expected.release.commit);
        return expected;
      },
      writeOutput: (_path: string, value: any) => {
        writes += 1;
        expect(value).toEqual(expected);
      },
    });
    expect(result.contract).toEqual(expected);
    expect({ fetches, inspections, writes }).toEqual({
      fetches: 1,
      inspections: 1,
      writes: 1,
    });

    const mismatched = structuredClone(expected);
    mismatched.source.commit = "f".repeat(40);
    await expect(preparePublicHostedPluginContract({
      sourceRoot: resolve(root, "source"),
      outputPath: resolve(root, "mismatched-hosted-contract.json"),
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => healthBytes,
      } as any),
      inspectSource: async () => mismatched,
      writeOutput: () => {
        throw new Error("mismatched contract must not be written");
      },
    })).rejects.toThrow("accepted release identity");
  });

  it("prepares the skill contract from the same one-shot accepted release", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "opendexter-plugin-prep-test-"));
    temporaryRoots.push(root);
    mkdirSync(resolve(root, "source"));
    const expected = pluginContract();
    const healthBytes = Buffer.from(JSON.stringify(healthDocument()));
    let fetches = 0;
    let inspections = 0;
    let writes = 0;
    const result = await preparePublicHostedPluginContract({
      sourceRoot: resolve(root, "source"),
      outputPath: resolve(root, "hosted-contract.json"),
      fetchImpl: async () => {
        fetches += 1;
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => healthBytes,
        } as any;
      },
      inspectSource: async ({ release }: any) => {
        inspections += 1;
        expect(release.commit).toBe(contract().release.commit);
        return expected;
      },
      writeOutput: (_path: string, value: any) => {
        writes += 1;
        expect(value).toEqual(expected);
      },
    });
    expect(result.contract).toEqual(expected);
    expect({ fetches, inspections, writes }).toEqual({
      fetches: 1,
      inspections: 1,
      writes: 1,
    });
  });

  it("keeps tagged build and publish retries on frozen evidence only", () => {
    const workflow = readFileSync(
      resolve(repositoryRoot, ".github/workflows/publish-opendexter.yml"),
      "utf8",
    );
    const release = readFileSync(
      resolve(packageRoot, "scripts/github-hosted-release.mjs"),
      "utf8",
    );
    const publicBoundary = readFileSync(
      resolve(packageRoot, "scripts/public-hosted-release.mjs"),
      "utf8",
    );
    expect(workflow).not.toContain(PUBLIC_HOSTED_HEALTH_URL);
    expect(workflow).not.toContain("release:prepare-hosted");
    expect(workflow).not.toContain("public-hosted-release.mjs prepare");
    expect(release).not.toContain("fetchPublicHostedHealth");
    expect(release).not.toContain("verify-hosted-source.mjs");
    expect(publicBoundary).toContain("verifyCanonicalAdvertisement: false");
    expect(publicBoundary).toContain("reconstructDescriptor: false");
    expect(release).toContain("verifyFrozenPublicHostedSource");
    expect(release).toContain("PUBLIC_HOSTED_CONTRACT_PATH");
  });
});
