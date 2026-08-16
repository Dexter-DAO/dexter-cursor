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
  registryRequestHeaders,
  validateHostedReleaseConfig,
  registryPublishDecision,
  validateProvenanceStatement,
  validatePublishBundle,
  validateReleaseReceipt,
  validateRegistryIdentity,
  validateReleaseInvocation,
} from "../scripts/github-hosted-release.mjs";
import {
  canonicalJsonDigest,
  digestFile,
  inspectTarball,
  RELEASE_BUILD_RECIPE,
} from "../scripts/package-provenance.mjs";
import { loadReviewedToolchainPin } from "../scripts/reviewed-toolchain.mjs";

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
  const contract = JSON.parse(readFileSync(
    resolve(packageRoot, "release/hosted-public-release.json"),
    "utf8",
  ));
  contract.release = {
    repository: "https://github.com/Dexter-DAO/dexter-mcp",
    commit: "4".repeat(40),
    tree: "5".repeat(40),
    artifactManifestSha256: "6".repeat(64),
    descriptorSha256: "7".repeat(64),
    packageVersion: "0.5.0",
  };
  return contract;
}

function invocation() {
  const releaseConfig = config();
  return {
    config: releaseConfig,
    repository: releaseConfig.repository,
    ref: "refs/tags/opendexter-v1.24.0-rc.1",
    refType: "tag",
    refName: "opendexter-v1.24.0-rc.1",
    sha: "a".repeat(40),
    eventName: "push",
    tagObjectSha: "a".repeat(40),
    tagCommitSha: "a".repeat(40),
    identity: { commit: "a".repeat(40), tree: "b".repeat(40) },
    containerImage: releaseConfig.runner.containerImage,
    packageManifest: {
      name: "@dexterai/opendexter",
      version: "1.24.0-rc.1",
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
    version: "1.24.0-rc.1",
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
  const tarball = resolve(bundle, "dexterai-opendexter-1.24.0-rc.1.tgz");
  execFileSync("tar", ["-czf", tarball, "package"], {
    cwd: resolve(root, "content"),
  });
  const inspected = inspectTarball(tarball);
  const context = validateReleaseInvocation(invocation());
  const receipt = {
    schemaVersion: 3,
    kind: "opendexter-npm-release/v3",
    context,
    sourceContract: {
      schemaVersion: 2,
      kind: "opendexter-hosted-release-pin/v2",
      hostedContractSha256: context.hosted.contractSha256,
      hosted: context.hosted,
    },
    build: {
      recipe: RELEASE_BUILD_RECIPE,
      sourceArchiveSha256: "d".repeat(64),
      rootLockSha256: "e".repeat(64),
      runtime: loadReviewedToolchainPin(),
      validation: [
        "test",
        "typecheck",
        "build",
        "pack-inventory",
        "fresh-install-exact-tarball",
        "opendexter-help",
      ],
      exactTarballInstall: {
        package: "@dexterai/opendexter",
        version: "1.24.0-rc.1",
        ignoredScripts: true,
        cliHelpVerified: true,
      },
    },
    artifact: inspected.artifact,
    inventory: inspected.inventory,
    inventoryDigest: canonicalJsonDigest(inspected.inventory),
    provenance: {
      repository: "https://github.com/Dexter-DAO/opendexter-ide",
      workflowPath: ".github/workflows/publish-opendexter.yml",
      ref: "refs/tags/opendexter-v1.24.0-rc.1",
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
    expect(workflow).not.toContain("OPENDXTER_SOURCE_APP_ID");
    expect(workflow).not.toContain("OPENDXTER_SOURCE_APP_PRIVATE_KEY");
    expect(workflow).not.toContain("actions/create-github-app-token@");
    expect(workflow).not.toContain("Dexter-DAO/dexter-api");
    expect(workflow).not.toContain("Dexter-DAO/dexter-facilitator");
  });

  it("pins the minimal config and refuses obsolete release machinery", () => {
    const policy = config();
    expect(validateHostedReleaseConfig(policy)).toEqual(policy);
    expect(policy).not.toHaveProperty("releaseAudit");
    expect(policy).not.toHaveProperty("evidence");
    expect(policy).not.toHaveProperty("sourceRead");
    expect(policy.publisher.environment).toBe("opendexter-npm-production");
    expect(policy.package.distTag).toBe("next");
    const hostile = structuredClone(policy);
    hostile.publisher.workflowPath = ".github/workflows/other.yml";
    expect(() => validateHostedReleaseConfig(hostile)).toThrow(/publisher policy/);
    const unsupportedChannel = structuredClone(policy);
    unsupportedChannel.package.distTag = "beta";
    expect(() => validateHostedReleaseConfig(unsupportedChannel)).toThrow(
      /dist-tag policy is unsupported/,
    );
  });

  it("binds tag, version, image, and one accepted public hosted release", () => {
    const valid = invocation();
    expect(validateReleaseInvocation(valid)).toMatchObject({
      releaseTag: "opendexter-v1.24.0-rc.1",
      commit: "a".repeat(40),
      package: { version: "1.24.0-rc.1", distTag: "next" },
    });
    for (const mutate of [
      (value: any) => { value.refType = "branch"; },
      (value: any) => { value.refName = "opendexter-v1.23.1"; },
      (value: any) => { value.sha = "c".repeat(40); },
      (value: any) => { value.tagCommitSha = "c".repeat(40); },
      (value: any) => { value.packageManifest.publishConfig.tag = "latest"; },
      (value: any) => { value.hostedContract.release.commit = "short"; },
    ]) {
      const hostile = structuredClone(valid);
      mutate(hostile);
      expect(() => validateReleaseInvocation(hostile)).toThrow();
    }
  });

  it("supports lightweight and annotated tags for push or tagged dispatch", () => {
    const lightweight = invocation();
    expect(validateReleaseInvocation(lightweight)).toMatchObject({
      tag: { objectSha: "a".repeat(40), commitSha: "a".repeat(40) },
      commit: "a".repeat(40),
    });
    const annotatedPush = invocation();
    annotatedPush.sha = "c".repeat(40);
    annotatedPush.tagObjectSha = "c".repeat(40);
    const annotatedDispatch = structuredClone(annotatedPush);
    annotatedDispatch.eventName = "workflow_dispatch";
    annotatedDispatch.sha = annotatedDispatch.tagCommitSha;
    const pushContext = validateReleaseInvocation(annotatedPush);
    const dispatchContext = validateReleaseInvocation(annotatedDispatch);
    expect(pushContext).toEqual(dispatchContext);
    expect(pushContext).toMatchObject({
      tag: { objectSha: "c".repeat(40), commitSha: "a".repeat(40) },
      commit: "a".repeat(40),
    });
    const workflow = readFileSync(
      resolve(repositoryRoot, ".github/workflows/publish-opendexter.yml"),
      "utf8",
    );
    expect(workflow).toContain("push:\n    tags:");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow.match(/ref: \$\{\{ github\.ref \}\}/g)).toHaveLength(2);
  });

  it("accepts only the exact downloaded tarball and receipt hashes", () => {
    const fixture = packageBundle();
    const environment = {
      GITHUB_REPOSITORY: "Dexter-DAO/opendexter-ide",
      GITHUB_REF: "refs/tags/opendexter-v1.24.0-rc.1",
      GITHUB_REF_TYPE: "tag",
      GITHUB_REF_NAME: "opendexter-v1.24.0-rc.1",
      GITHUB_EVENT_NAME: "push",
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
    expect(validatePublishBundle({
      root: fixture.bundle,
      expectedTarballSha256: digestFile(fixture.tarball),
      expectedReleaseSha256: digestFile(fixture.release),
      config: config(),
      environment: {
        ...environment,
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_SHA: fixture.receipt.context.tag.commitSha,
      },
    }).receipt.artifact).toEqual(fixture.receipt.artifact);
    expect(() => validatePublishBundle({
      root: fixture.bundle,
      expectedTarballSha256: "f".repeat(64),
      expectedReleaseSha256: digestFile(fixture.release),
      config: config(),
      environment,
    })).toThrow(/tarball SHA-256 differs/);
  });

  it("independently rejects malformed source, build, and provenance receipts", () => {
    const fixture = packageBundle();
    expect(validateReleaseReceipt(fixture.receipt, config())).toBe(fixture.receipt);
    for (const mutate of [
      (value: any) => { value.sourceContract.hosted.commit = ""; },
      (value: any) => {
        value.sourceContract.hostedContractSha256 = "f".repeat(64);
      },
      (value: any) => { value.build.recipe = "rebuild-something-else"; },
      (value: any) => { value.build.exactTarballInstall.cliHelpVerified = false; },
      (value: any) => { value.provenance.workflowPath = ".github/workflows/other.yml"; },
    ]) {
      const hostile = structuredClone(fixture.receipt);
      mutate(hostile);
      expect(() => validateReleaseReceipt(hostile, config())).toThrow();
    }
  });

  it("binds registry provenance to the exact bytes, workflow, and tag", () => {
    const fixture = packageBundle();
    const integrity = fixture.receipt.artifact.integrity.replace(/^sha512-/, "");
    const statement = {
      _type: "https://in-toto.io/Statement/v1",
      predicateType: "https://slsa.dev/provenance/v1",
      subject: [{
        name: "pkg:npm/%40dexterai/opendexter@1.24.0-rc.1",
        digest: { sha512: Buffer.from(integrity, "base64").toString("hex") },
      }],
      predicate: {
        buildDefinition: {
          externalParameters: {
            workflow: {
              repository: "https://github.com/Dexter-DAO/opendexter-ide",
              path: ".github/workflows/publish-opendexter.yml",
              ref: "refs/tags/opendexter-v1.24.0-rc.1",
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

  it("makes same-version retries idempotent and rejects different bytes", () => {
    const fixture = packageBundle();
    const metadata = {
      name: "@dexterai/opendexter",
      version: "1.24.0-rc.1",
      dist: {
        integrity: fixture.receipt.artifact.integrity,
        shasum: fixture.receipt.artifact.shasum,
      },
    };
    const packument = { "dist-tags": { next: "1.24.0-rc.1" } };
    expect(validateRegistryIdentity({
      receipt: fixture.receipt,
      metadata,
      packument,
      requireDistTag: true,
    })).toEqual({ currentDistTag: "1.24.0-rc.1" });
    expect(registryPublishDecision("same")).toBe(false);
    expect(registryPublishDecision("absent")).toBe(true);
    const hostile = structuredClone(metadata);
    hostile.dist.integrity = "sha512-ZGlmZmVyZW50";
    expect(() => validateRegistryIdentity({
      receipt: fixture.receipt,
      metadata: hostile,
      packument,
      requireDistTag: false,
    })).toThrow(/different immutable bytes/);
  });

  it("requests full JSON for version metadata and compact JSON for the packument", () => {
    expect(registryRequestHeaders("version")).toEqual({
      accept: "application/json",
    });
    expect(registryRequestHeaders("packument")).toEqual({
      accept: "application/vnd.npm.install-v1+json",
    });
    expect(() => registryRequestHeaders("other")).toThrow(
      /unsupported registry request kind/,
    );
  });
});
