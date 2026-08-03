import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  validateHostedReleaseConfig,
  validateProvenanceStatement,
  validatePublishBundle,
  validateReleaseInvocation,
} from "../scripts/github-hosted-release.mjs";
import {
  canonicalJsonDigest,
  digestFile,
  inspectTarball,
} from "../scripts/package-provenance.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function config() {
  return JSON.parse(readFileSync(
    resolve(packageRoot, "release/github-hosted-release.json"),
    "utf8",
  ));
}

function hostedContract() {
  return {
    source: {
      repository: "https://github.com/Dexter-DAO/dexter-mcp",
      commit: "4".repeat(40),
      tree: "5".repeat(40),
    },
    sourceContracts: {
      kind: "opendexter-source-contracts/v3",
      integratedApiRelease: {
        repository: "https://github.com/Dexter-DAO/dexter-api",
        commit: "6".repeat(40),
        tree: "7".repeat(40),
      },
      facilitator: {
        repository: "https://github.com/Dexter-DAO/dexter-facilitator",
        commit: "8".repeat(40),
        tree: "9".repeat(40),
      },
    },
  };
}

function invocation() {
  const releaseConfig = config();
  return {
    config: releaseConfig,
    repository: releaseConfig.repository,
    ref: "refs/tags/opendexter-v1.23.0-rc.3",
    refType: "tag",
    refName: "opendexter-v1.23.0-rc.3",
    sha: "a".repeat(40),
    identity: { commit: "a".repeat(40), tree: "b".repeat(40) },
    containerImage: releaseConfig.runner.containerImage,
    packageManifest: {
      name: "@dexterai/opendexter",
      version: "1.23.0-rc.3",
      publishConfig: { tag: "next" },
    },
    hostedContract: hostedContract(),
  };
}

function packageBundle() {
  const root = mkdtempSync(resolve(tmpdir(), "opendexter-release-bundle-"));
  temporaryRoots.push(root);
  const content = resolve(root, "content/package");
  mkdirSync(resolve(content, "dist/widgets"), { recursive: true });
  mkdirSync(resolve(content, "assets/widgets"), { recursive: true });
  writeFileSync(resolve(content, "package.json"), `${JSON.stringify({
    name: "@dexterai/opendexter",
    version: "1.23.0-rc.3",
    files: ["dist", "assets"],
    bin: { opendexter: "dist/index.js" },
  })}\n`);
  writeFileSync(resolve(content, "dist/index.js"), "#!/usr/bin/env node\n");
  chmodSync(resolve(content, "dist/index.js"), 0o755);
  for (const name of [
    "x402-fetch-result.html",
    "x402-marketplace-search.html",
    "x402-pricing.html",
    "x402-wallet.html",
  ]) {
    writeFileSync(resolve(content, "dist/widgets", name), `${name}\n`);
    writeFileSync(resolve(content, "assets/widgets", name), `${name}\n`);
  }
  const bundle = resolve(root, "bundle");
  mkdirSync(bundle);
  const tarball = resolve(bundle, "dexterai-opendexter-1.23.0-rc.3.tgz");
  execFileSync("tar", ["-czf", tarball, "package"], {
    cwd: resolve(root, "content"),
  });
  const inspected = inspectTarball(tarball);
  const context = validateReleaseInvocation(invocation());
  const receipt = {
    schemaVersion: 2,
    kind: "opendexter-npm-release/v2",
    context,
    sourceContract: {},
    build: {},
    artifact: inspected.artifact,
    inventory: inspected.inventory,
    inventoryDigest: canonicalJsonDigest(inspected.inventory),
    provenance: {
      repository: "https://github.com/Dexter-DAO/opendexter-ide",
      workflowPath: ".github/workflows/publish-opendexter.yml",
      ref: "refs/tags/opendexter-v1.23.0-rc.3",
      predicateType: "https://slsa.dev/provenance/v1",
    },
  };
  const release = resolve(bundle, "release.json");
  writeFileSync(release, `${JSON.stringify(receipt, null, 2)}\n`);
  return { bundle, tarball, release, receipt };
}

describe("repeatable GitHub npm release", () => {
  it("has one workflow, two jobs, and only one protected environment", () => {
    const workflow = readFileSync(
      resolve(repositoryRoot, ".github/workflows/publish-opendexter.yml"),
      "utf8",
    );
    expect(existsSync(
      resolve(repositoryRoot, ".github/workflows/review-opendexter-release.yml"),
    )).toBe(false);
    expect(workflow.match(/^  [a-z][a-z-]*:\n    name:/gm)).toHaveLength(2);
    expect(workflow).toContain("  build:\n");
    expect(workflow).toContain("  publish:\n");
    expect(workflow.match(/^    environment:/gm)).toEqual([
      "    environment:",
    ]);
    expect(workflow).toContain("environment: opendexter-npm-production");
    expect(workflow.match(/npm-cli\.js|npm publish|node \"\$OPENDXTER_NPM_CLI\" publish/g))
      .toHaveLength(1);
    for (const obsolete of [
      "release-audit",
      "RELEASE_AUDIT",
      "release-review",
      "evidence_artifact",
      "artifact-ids",
      "Independently rebuild",
    ]) {
      expect(workflow).not.toContain(obsolete);
    }
    expect(workflow).toContain("OPENDXTER_SOURCE_APP_ID");
    expect(workflow.match(/actions\/create-github-app-token@/g)).toHaveLength(1);
  });

  it("pins the minimal config and refuses obsolete release machinery", () => {
    const policy = config();
    expect(validateHostedReleaseConfig(policy)).toEqual(policy);
    expect(policy).not.toHaveProperty("releaseAudit");
    expect(policy).not.toHaveProperty("evidence");
    expect(policy.sourceRead).not.toHaveProperty("environment");
    expect(policy.publisher.environment).toBe("opendexter-npm-production");
    const hostile = structuredClone(policy);
    hostile.publisher.workflowPath = ".github/workflows/other.yml";
    expect(() => validateHostedReleaseConfig(hostile)).toThrow(/publisher policy/);
  });

  it("binds tag, version, source commit, image, and paired contracts", () => {
    const valid = invocation();
    expect(validateReleaseInvocation(valid)).toMatchObject({
      releaseTag: "opendexter-v1.23.0-rc.3",
      commit: "a".repeat(40),
      package: { version: "1.23.0-rc.3", distTag: "next" },
    });
    for (const mutate of [
      (value: any) => { value.refType = "branch"; },
      (value: any) => { value.refName = "opendexter-v1.23.0-rc.2"; },
      (value: any) => { value.sha = "c".repeat(40); },
      (value: any) => { value.packageManifest.publishConfig.tag = "latest"; },
      (value: any) => { value.hostedContract.source.commit = "short"; },
    ]) {
      const hostile = structuredClone(valid);
      mutate(hostile);
      expect(() => validateReleaseInvocation(hostile)).toThrow();
    }
  });

  it("accepts only the exact downloaded tarball and receipt hashes", () => {
    const fixture = packageBundle();
    const environment = {
      GITHUB_REPOSITORY: "Dexter-DAO/opendexter-ide",
      GITHUB_REF_TYPE: "tag",
      GITHUB_REF_NAME: "opendexter-v1.23.0-rc.3",
      GITHUB_SHA: "a".repeat(40),
      OPENDXTER_RELEASE_CONTAINER_IMAGE: config().runner.containerImage,
    };
    expect(validatePublishBundle({
      root: fixture.bundle,
      expectedTarballSha256: digestFile(fixture.tarball),
      expectedReleaseSha256: digestFile(fixture.release),
      config: config(),
      environment,
    }).receipt.artifact).toEqual(fixture.receipt.artifact);
    expect(() => validatePublishBundle({
      root: fixture.bundle,
      expectedTarballSha256: "f".repeat(64),
      expectedReleaseSha256: digestFile(fixture.release),
      config: config(),
      environment,
    })).toThrow(/tarball SHA-256 differs/);
  });

  it("binds registry provenance to the exact bytes, workflow, and tag", () => {
    const fixture = packageBundle();
    const integrity = fixture.receipt.artifact.integrity.replace(/^sha512-/, "");
    const statement = {
      _type: "https://in-toto.io/Statement/v1",
      predicateType: "https://slsa.dev/provenance/v1",
      subject: [{
        name: "pkg:npm/%40dexterai/opendexter@1.23.0-rc.3",
        digest: { sha512: Buffer.from(integrity, "base64").toString("hex") },
      }],
      predicate: {
        buildDefinition: {
          externalParameters: {
            workflow: {
              repository: "https://github.com/Dexter-DAO/opendexter-ide",
              path: ".github/workflows/publish-opendexter.yml",
              ref: "refs/tags/opendexter-v1.23.0-rc.3",
            },
          },
        },
        runDetails: {
          builder: { id: "https://github.com/actions/runner/github-hosted" },
        },
      },
    };
    expect(validateProvenanceStatement({
      statement,
      receipt: fixture.receipt,
    })).toBe(true);
    const hostile = structuredClone(statement);
    hostile.predicate.buildDefinition.externalParameters.workflow.path =
      ".github/workflows/other.yml";
    expect(() => validateProvenanceStatement({
      statement: hostile,
      receipt: fixture.receipt,
    })).toThrow(/workflow identity differs/);
  });
});
