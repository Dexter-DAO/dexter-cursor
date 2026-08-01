import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectTarball,
  validateAttestationShape,
  verifyRegistryMetadata,
  verifyRootLock,
} from "../scripts/package-provenance.mjs";
import { verifyPublishPolicy } from "../scripts/release-policy.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixtureRoot() {
  const root = mkdtempSync(resolve(tmpdir(), "opendexter-release-fixture-"));
  temporaryRoots.push(root);
  const packageDir = resolve(root, "package");
  mkdirSync(resolve(packageDir, "dist"), { recursive: true });
  writeFileSync(
    resolve(packageDir, "package.json"),
    `${JSON.stringify({
      name: "@dexterai/opendexter",
      version: "1.23.0-rc.3",
      files: ["dist", "README.md"],
      bin: { opendexter: "dist/index.js" },
      dependencies: { zod: "3.25.76" },
    })}\n`,
  );
  writeFileSync(resolve(packageDir, "README.md"), "fixture\n");
  writeFileSync(resolve(packageDir, "dist/index.js"), "#!/usr/bin/env node\n");
  chmodSync(resolve(packageDir, "dist/index.js"), 0o755);
  return { root, packageDir };
}

function pack(root: string, name = "candidate.tgz") {
  const tarball = resolve(root, name);
  execFileSync("tar", ["-czf", tarball, "package"], { cwd: root });
  return tarball;
}

function attestation() {
  return {
    schemaVersion: 1,
    kind: "opendexter-coordinated-release/v1",
    package: {
      name: "@dexterai/opendexter",
      version: "1.23.0-rc.3",
      releaseChannel: "prerelease",
      distTag: "next",
    },
    source: {
      commit: "a".repeat(40),
      tree: "b".repeat(40),
      rootLockSha256: "c".repeat(64),
    },
    artifact: {
      fileName: "candidate.tgz",
      size: 10,
      sha256: "d".repeat(64),
      shasum: "e".repeat(40),
      integrity: "sha512-Zml4dHVyZQ==",
    },
    inventory: [{
      path: "package.json",
      size: 1,
      mode: "644",
      sha256: "f".repeat(64),
      executable: false,
    }],
    review: { decision: "accepted", receiptSha256: "1".repeat(64) },
    noviceRoutingEvaluation: { status: "passed", evidenceSha256: "2".repeat(64) },
    hostedContract: { contractSha256: "3".repeat(64) },
  };
}

describe("coordinated publish policy", () => {
  it("allows the immutable prerelease only on its explicit reviewed tag", () => {
    expect(verifyPublishPolicy({
      manifest: {
        name: "@dexterai/opendexter",
        version: "1.23.0-rc.3",
        publishConfig: { tag: "next" },
      },
      attestation: attestation(),
      npmTag: "next",
      explicitTag: "next",
    })).toEqual({ releaseChannel: "prerelease", distTag: "next" });
  });

  it("protects latest and refuses implicit or conflicting tags", () => {
    const manifest = {
      name: "@dexterai/opendexter",
      version: "1.23.0-rc.3",
      publishConfig: { tag: "next" },
    };
    expect(() => verifyPublishPolicy({
      manifest,
      attestation: attestation(),
      npmTag: "latest",
      explicitTag: "latest",
    })).toThrow(/attested npm tag drifted|prerelease may never publish/);
    expect(() => verifyPublishPolicy({
      manifest,
      attestation: attestation(),
      npmTag: "next",
      explicitTag: undefined,
    })).toThrow(/must explicitly repeat/);
  });

  it("makes a plain npm publish lifecycle fail before build or registry work", () => {
    const env = { ...process.env };
    for (const name of Object.keys(env)) {
      if (name.startsWith("OPENDXTER_RELEASE_")) delete env[name];
    }
    const result = spawnSync(
      "npm",
      ["publish", "--dry-run", "--tag", "next"],
      { cwd: packageRoot, env, encoding: "utf8", timeout: 20_000 },
    );
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(
      /OPENDXTER_RELEASE_ATTESTATION is required/,
    );
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("Widget source:");
  });
});

describe("exact package provenance", () => {
  it("uses one canonical root lock and rejects a nested package lock", () => {
    const lock = verifyRootLock({ requireTracked: false });
    expect(lock.path).toBe("package-lock.json");
    expect(lock.lockfileVersion).toBe(3);
    expect(readFileSync(resolve(repositoryRoot, ".gitignore"), "utf8"))
      .toContain("/packages/*/package-lock.json");
  });

  it("records every regular file hash and only the declared executable", () => {
    const { root } = fixtureRoot();
    const result = inspectTarball(pack(root));
    expect(result.inventory.map(({ path }) => path)).toEqual([
      "dist/index.js",
      "package.json",
      "README.md",
    ]);
    expect(result.inventory.filter(({ executable }) => executable).map(({ path }) => path))
      .toEqual(["dist/index.js"]);
    expect(result.inventory.every(({ sha256 }) => /^[0-9a-f]{64}$/.test(sha256))).toBe(true);
  });

  it.each([
    ["symlink", (dir: string) => symlinkSync("index.js", resolve(dir, "dist/link.js"))],
    ["hardlink", (dir: string) => linkSync(resolve(dir, "dist/index.js"), resolve(dir, "dist/hard.js"))],
    ["fifo", (dir: string) => execFileSync("mkfifo", [resolve(dir, "dist/pipe")])],
  ])("rejects %s archive entries", (_label, mutate) => {
    const { root, packageDir } = fixtureRoot();
    mutate(packageDir);
    expect(() => inspectTarball(pack(root))).toThrow(/link or special file|symlink|hard-linked|special/);
  });

  it.each([
    ["environment file", ".env.production", "secret"],
    ["source map", "dist/index.js.map", "{}"],
    ["credential file", "credentials.json", "{}"],
    ["undeclared extra", "surprise.txt", "extra"],
  ])("rejects a published %s", (_label, relative, contents) => {
    const { root, packageDir } = fixtureRoot();
    const path = resolve(packageDir, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
    expect(() => inspectTarball(pack(root))).toThrow(/forbidden publish artifact|undeclared publish artifact/);
  });

  it("rejects an undeclared executable and packed-byte drift", () => {
    const { root, packageDir } = fixtureRoot();
    chmodSync(resolve(packageDir, "README.md"), 0o755);
    expect(() => inspectTarball(pack(root))).toThrow(/undeclared executable/);

    chmodSync(resolve(packageDir, "README.md"), 0o644);
    const tarball = pack(root, "clean.tgz");
    writeFileSync(resolve(packageDir, "README.md"), "changed after pack\n");
    expect(() => inspectTarball(tarball, { sourcePackageRoot: packageDir }))
      .toThrow(/packed bytes differ/);
  });

  it("fails closed when registry integrity or shasum differs", () => {
    const reviewed = validateAttestationShape(attestation());
    expect(() => verifyRegistryMetadata(reviewed, {
      name: reviewed.package.name,
      version: reviewed.package.version,
      dist: { integrity: "sha512-wrong", shasum: reviewed.artifact.shasum },
    })).toThrow(/dist\.integrity/);
    expect(() => verifyRegistryMetadata(reviewed, {
      name: reviewed.package.name,
      version: reviewed.package.version,
      dist: { integrity: reviewed.artifact.integrity, shasum: "wrong" },
    })).toThrow(/dist\.shasum/);
  });
});
