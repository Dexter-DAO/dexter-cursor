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
