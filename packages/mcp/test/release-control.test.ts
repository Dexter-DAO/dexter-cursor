import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalJsonDigest,
  attestedRuntimeIdentity,
  inspectTarball,
  canonicalReleaseRemoteRefs,
  EXPECTED_RELEASE_SOURCE_REPOSITORY,
  RELEASE_BUILD_RECIPE,
  RELEASE_WIDGET_FILES,
  repositoryIdentity,
  reviewedNpm,
  reviewedReleaseEnvironment,
  reviewedSourceArchiveDigest,
  validateAttestationShape,
  verifyAttestation,
  verifyRegistryMetadata,
  verifyReleaseRepositoryIdentity,
  verifyRootLock,
} from "../scripts/package-provenance.mjs";
import {
  disposeReviewedToolchain,
  inspectReviewedToolchainSource,
  loadReviewedToolchainPin,
  stageReviewedToolchain,
} from "../scripts/reviewed-toolchain.mjs";
import {
  installExactArtifact,
  stageTreePureSource,
} from "../scripts/build-release-candidate.mjs";
import { dryRunExactTarball } from "../scripts/verify-coordinated-release.mjs";
import { listCanonicalRemoteRefs } from "../scripts/verify-hosted-source.mjs";
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

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
  }).trim();
}

function committedRepository(files: Record<string, string>) {
  const root = mkdtempSync(resolve(tmpdir(), "opendexter-source-fixture-"));
  temporaryRoots.push(root);
  for (const [relativePath, contents] of Object.entries(files)) {
    const path = resolve(root, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  execFileSync("git", ["init", "-q", root]);
  git(root, ["config", "user.name", "OpenDexter Test"]);
  git(root, ["config", "user.email", "test@invalid.example"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "fixture"]);
  git(root, [
    "remote",
    "add",
    "origin",
    "https://github.com/Dexter-DAO/opendexter-ide.git",
  ]);
  return {
    root,
    commit: git(root, ["rev-parse", "HEAD^{commit}"]),
    tree: git(root, ["rev-parse", "HEAD^{tree}"]),
  };
}

function attestation() {
  const runtime = loadReviewedToolchainPin();
  const widgetInventory = RELEASE_WIDGET_FILES.map((path, index) => ({
    path,
    size: index + 1,
    sha256: ["7", "8", "9", "a"][index].repeat(64),
  }));
  return {
    schemaVersion: 4,
    kind: "opendexter-coordinated-release/v4",
    package: {
      name: "@dexterai/opendexter",
      version: "1.23.0-rc.3",
      releaseChannel: "prerelease",
      distTag: "next",
    },
    source: {
      repository: EXPECTED_RELEASE_SOURCE_REPOSITORY,
      commit: "a".repeat(40),
      tree: "b".repeat(40),
      archiveSha256: "3".repeat(64),
      rootLockSha256: "c".repeat(64),
    },
    build: {
      sourceMaterial: "archive",
      recipe: RELEASE_BUILD_RECIPE,
      ...runtime,
      exactArtifactInstalls: [],
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
    noviceRoutingEvaluation: {
      status: "pending-post-deploy",
      suiteSha256: "2".repeat(64),
      requiredAfter: "package-install-and-hosted-activation",
    },
    hostedContract: {
      sourceRepository: "https://github.com/Dexter-DAO/dexter-mcp",
      sourceCommit: "4".repeat(40),
      sourceTree: "5".repeat(40),
      sourceArchiveSha256: "6".repeat(64),
      widgetSourcePath: "public/apps-sdk",
      widgetSourceDigest: canonicalJsonDigest(widgetInventory),
      widgetInventory,
      descriptorPath: "release/open-tool-descriptors.json",
      contractSha256: "7".repeat(64),
    },
  };
}

function stagedReviewedToolchain() {
  const root = mkdtempSync(resolve(tmpdir(), "opendexter-toolchain-stage-"));
  temporaryRoots.push(root);
  return stageReviewedToolchain({ stageRoot: resolve(root, "toolchain") });
}

function toolchainFixture() {
  const root = mkdtempSync(resolve(tmpdir(), "opendexter-toolchain-fixture-"));
  temporaryRoots.push(root);
  const nodePath = resolve(root, "source/bin/node");
  const npmRoot = resolve(root, "source/lib/node_modules/npm");
  mkdirSync(dirname(nodePath), { recursive: true });
  mkdirSync(resolve(npmRoot, "bin"), { recursive: true });
  mkdirSync(resolve(npmRoot, "lib"), { recursive: true });
  writeFileSync(nodePath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(resolve(npmRoot, "package.json"), `${JSON.stringify({
    name: "npm",
    version: "10.9.3",
  })}\n`);
  writeFileSync(
    resolve(npmRoot, "bin/npm-cli.js"),
    "#!/usr/bin/env node\nrequire('../lib/cli.js')\n",
    { mode: 0o755 },
  );
  writeFileSync(resolve(npmRoot, "lib/cli.js"), "module.exports = {}\n");
  const runtime = inspectReviewedToolchainSource({
    nodePath,
    npmRoot,
    nodeVersion: "v22.19.0",
  });
  return { root, nodePath, npmRoot, runtime };
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

  it("allows the current prerelease candidate only on the explicit next tag", () => {
    const candidateAttestation = attestation();
    candidateAttestation.package = {
      ...candidateAttestation.package,
      version: "1.24.0-rc.1",
      releaseChannel: "prerelease",
      distTag: "next",
    };
    expect(verifyPublishPolicy({
      manifest: {
        name: "@dexterai/opendexter",
        version: "1.24.0-rc.1",
        publishConfig: { tag: "next" },
      },
      attestation: candidateAttestation,
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
    const env = {
      ...process.env,
      // The reviewed release builder intentionally disables lifecycle scripts
      // globally. This assertion is specifically proving that an ordinary
      // user-run npm publish invokes and is refused by prepublishOnly.
      npm_config_ignore_scripts: "false",
    };
    for (const name of Object.keys(env)) {
      if (name.startsWith("OPENDXTER_RELEASE_")) delete env[name];
    }
    const result = spawnSync(
      "npm",
      ["publish", "--dry-run", "--tag", "next"],
      { cwd: packageRoot, env, encoding: "utf8", timeout: 30_000 },
    );
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(
      /Local OpenDexter publishing is disabled/,
    );
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("Widget source:");
  });
});

describe("exact tarball install smoke", () => {
  it("fresh-installs the packed artifact once and runs its CLI help", () => {
    const fixture = fixtureRoot();
    writeFileSync(
      resolve(fixture.packageDir, "package.json"),
      `${JSON.stringify({
        name: "@dexterai/opendexter",
        version: "1.23.0-rc.3",
        files: ["dist"],
        bin: { opendexter: "dist/index.js" },
      })}\n`,
    );
    const tarball = pack(fixture.root);
    const toolchain = stagedReviewedToolchain();
    try {
      expect(installExactArtifact({
        tarball,
        ignoreScripts: true,
        toolchain,
      })).toEqual({
        package: "@dexterai/opendexter",
        version: "1.23.0-rc.3",
        ignoredScripts: true,
        cliHelpVerified: true,
      });
    } finally {
      disposeReviewedToolchain(toolchain);
    }
  }, 30_000);
});

describe("exact package provenance", () => {
  it("refuses legacy release attestations instead of reinterpreting v1", () => {
    const legacy = {
      ...attestation(),
      schemaVersion: 1,
      kind: "opendexter-coordinated-release/v1",
    };
    expect(() => validateAttestationShape(legacy)).toThrow(/unsupported release attestation schema/);
  });

  it("cannot misstate prepublication novice proof as completed", () => {
    for (const mutate of [
      (value: any) => { value.noviceRoutingEvaluation.status = "passed"; },
      (value: any) => { value.noviceRoutingEvaluation.evidenceSha256 = "9".repeat(64); },
      (value: any) => { delete value.noviceRoutingEvaluation.suiteSha256; },
      (value: any) => { value.noviceRoutingEvaluation.requiredAfter = "source-review"; },
    ]) {
      const value = attestation();
      mutate(value);
      expect(() => validateAttestationShape(value)).toThrow(
        /novice evaluation|novice evaluation boundary/,
      );
    }
  });

  it("rejects a self-consistent rehashed npm library inventory that differs from the source pin", () => {
    const forged = attestation();
    const npmLibrary = forged.build.toolchainInventory.find(
      ({ path }: { path: string }) => path === "lib/node_modules/npm/lib/cli.js",
    );
    npmLibrary.sha256 = "a".repeat(64);
    forged.build.toolchainInventorySha256 = canonicalJsonDigest(
      forged.build.toolchainInventory,
    );
    expect(() => validateAttestationShape(forged)).toThrow(
      /attested Node\/npm toolchain source pin does not match/,
    );
  });

  it("accepts only the canonical IDE origin and an advertised exact HEAD", () => {
    for (const origin of [
      "https://github.com/Dexter-DAO/opendexter-ide.git",
      "git@github.com:Dexter-DAO/opendexter-ide.git",
      "ssh://git@github.com/Dexter-DAO/opendexter-ide.git",
    ]) {
      expect(verifyReleaseRepositoryIdentity(origin))
        .toBe(EXPECTED_RELEASE_SOURCE_REPOSITORY);
    }
    expect(() => verifyReleaseRepositoryIdentity(
      "https://github.com/example/opendexter-ide.git",
    )).toThrow(/expected https:\/\/github\.com\/Dexter-DAO\/opendexter-ide/);

    const repository = committedRepository({ "tracked.txt": "reviewed\n" });
    expect(() => repositoryIdentity(repository.root, {
      advertisedRefs: `${"f".repeat(40)}\trefs/heads/lookalike`,
    })).toThrow(/canonical release source does not advertise HEAD/);
    expect(repositoryIdentity(repository.root, {
      advertisedRefs: `${repository.commit}\trefs/heads/release`,
    })).toMatchObject({
      repository: EXPECTED_RELEASE_SOURCE_REPOSITORY,
      commit: repository.commit,
      tree: repository.tree,
      clean: true,
    });
  });

  it("ignores caller Git URL rewrites for canonical remote advertisement", () => {
    const root = mkdtempSync(resolve(tmpdir(), "opendexter-release-redirect-"));
    temporaryRoots.push(root);
    const attacker = resolve(root, "attacker.git");
    const runner = resolve(root, "runner");
    mkdirSync(runner);
    execFileSync("git", ["init", "--bare", "-q", attacker]);
    execFileSync("git", ["init", "-q", runner]);
    writeFileSync(resolve(runner, "attacker.txt"), "attacker\n");
    git(runner, ["config", "user.name", "OpenDexter Test"]);
    git(runner, ["config", "user.email", "test@invalid.example"]);
    git(runner, ["add", "attacker.txt"]);
    git(runner, ["commit", "-qm", "attacker"]);
    git(runner, ["push", `file://${attacker}`, "HEAD:refs/heads/attacker"]);
    git(runner, [
      "config",
      `url.file://${attacker}.insteadOf`,
      "test://canonical-release/repository.git",
    ]);
    expect(git(runner, ["ls-remote", "test://canonical-release/repository.git"]))
      .toMatch(/refs\/heads\/attacker/);
    expect(() => listCanonicalRemoteRefs(
      "test://canonical-release/repository.git",
      { cwd: runner, environment: reviewedReleaseEnvironment() },
    )).toThrow(/remote-test|not a git command|unable to find remote helper/i);

    let queriedRemote: string | null = null;
    let queriedEnvironment: NodeJS.ProcessEnv | null = null;
    const refs = canonicalReleaseRemoteRefs({
      environment: reviewedReleaseEnvironment(),
      listRefs(
        remote: string,
        options: { environment: NodeJS.ProcessEnv },
      ) {
        queriedRemote = remote;
        queriedEnvironment = options.environment;
        return `${"a".repeat(40)}\trefs/heads/release`;
      },
    });
    expect(refs).toContain("refs/heads/release");
    expect(queriedRemote).toBe(`${EXPECTED_RELEASE_SOURCE_REPOSITORY}.git`);
    expect(queriedEnvironment?.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(queriedEnvironment?.GIT_CONFIG_NOSYSTEM).toBe("1");
  });

  it("refuses hidden index flags and replace refs before release", () => {
    for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
      const repository = committedRepository({ "tracked.txt": "reviewed\n" });
      git(repository.root, ["update-index", flag, "tracked.txt"]);
      expect(() => repositoryIdentity(repository.root, {
        advertisedRefs: `${repository.commit}\trefs/heads/release`,
      })).toThrow(/assume-unchanged or skip-worktree/);
    }

    const repository = committedRepository({ "tracked.txt": "one\n" });
    writeFileSync(resolve(repository.root, "tracked.txt"), "two\n");
    git(repository.root, ["add", "tracked.txt"]);
    git(repository.root, ["commit", "-qm", "second"]);
    const head = git(repository.root, ["rev-parse", "HEAD"]);
    git(repository.root, ["replace", head, `${head}^`]);
    expect(() => repositoryIdentity(repository.root, {
      advertisedRefs: `${head}\trefs/heads/release`,
    })).toThrow(/Git replace refs/);
  });

  it("stages tree-pure source and ignores attributes plus later hosted mutations", () => {
    const repository = committedRepository({
      "public/apps-sdk/widget.html": "reviewed widget\n",
      "public/apps-sdk/kept.txt": "$Format:%H$\n",
    });
    const attributes = resolve(repository.root, ".git/local-attributes");
    writeFileSync(
      attributes,
      "public/apps-sdk/widget.html export-ignore\n"
        + "public/apps-sdk/kept.txt export-subst\n",
    );
    git(repository.root, ["config", "core.attributesFile", attributes]);
    writeFileSync(
      resolve(repository.root, ".git/info/attributes"),
      "public/apps-sdk/widget.html export-ignore\n"
        + "public/apps-sdk/kept.txt export-subst\n",
    );
    const stageRoot = mkdtempSync(resolve(tmpdir(), "opendexter-tree-pure-stage-"));
    temporaryRoots.push(stageRoot);
    const environment = reviewedReleaseEnvironment();
    const staged = stageTreePureSource({
      sourceRoot: repository.root,
      commit: repository.commit,
      tree: repository.tree,
      stageRoot,
      name: "hosted-source",
      environment,
    });
    expect(readFileSync(
      resolve(staged.extractedRoot, "public/apps-sdk/widget.html"),
      "utf8",
    )).toBe("reviewed widget\n");
    expect(readFileSync(
      resolve(staged.extractedRoot, "public/apps-sdk/kept.txt"),
      "utf8",
    )).toBe("$Format:%H$\n");

    writeFileSync(
      resolve(repository.root, "public/apps-sdk/widget.html"),
      "mutated working file\n",
    );
    expect(readFileSync(
      resolve(staged.extractedRoot, "public/apps-sdk/widget.html"),
      "utf8",
    )).toBe("reviewed widget\n");
    expect(reviewedSourceArchiveDigest({
      root: repository.root,
      commit: repository.commit,
      tree: repository.tree,
      environment,
    })).toBe(staged.archiveSha256);
  });

  it("uses the protected exact npm CLI and scrubbed release environment", () => {
    const toolchain = stagedReviewedToolchain();
    try {
      const environment = reviewedReleaseEnvironment({
        nodeBin: dirname(toolchain.command),
      });
      const npm = reviewedNpm(["--version"], { toolchain });
      expect(npm.command).toBe(toolchain.command);
      expect(npm.command).not.toBe(process.execPath);
      expect(execFileSync(npm.command, npm.args, {
        encoding: "utf8",
        env: environment,
      }).trim()).toBe("10.9.3");
      expect(environment.PATH?.split(":")[0]).toBe(dirname(toolchain.command));
      expect(environment.GIT_CONFIG_GLOBAL).toBe("/dev/null");
      expect(environment.npm_config_userconfig).toBe("/dev/null");
      expect(environment.npm_config_ignore_scripts).toBe("true");
      expect(Object.hasOwn(environment, "NODE_OPTIONS")).toBe(false);
    } finally {
      disposeReviewedToolchain(toolchain);
    }
  });

  it("ignores nondeterministic Python bytecode caches in reviewed npm source", () => {
    const fixture = toolchainFixture();
    const cacheRoot = resolve(
      fixture.npmRoot,
      "node_modules/node-gyp/gyp/pylib/gyp/__pycache__",
    );
    mkdirSync(cacheRoot, { recursive: true });
    writeFileSync(resolve(cacheRoot, "input.cpython-312.pyc"), "cache bytes\n");
    writeFileSync(
      resolve(fixture.npmRoot, "standalone.cpython-312.pyc"),
      "cache bytes\n",
    );

    const inspected = inspectReviewedToolchainSource({
      nodePath: fixture.nodePath,
      npmRoot: fixture.npmRoot,
      nodeVersion: "v22.19.0",
    });
    expect(inspected).toEqual(fixture.runtime);
    expect(inspected.toolchainInventory.some(
      ({ path }) => path.includes("/__pycache__/") || path.endsWith(".pyc"),
    )).toBe(false);

    const staged = stageReviewedToolchain({
      stageRoot: resolve(fixture.root, "cache-free-stage"),
      sourceNode: fixture.nodePath,
      sourceNpmRoot: fixture.npmRoot,
      sourceNodeVersion: "v22.19.0",
      expectedRuntime: fixture.runtime,
    });
    try {
      expect(staged.runtime).toEqual(fixture.runtime);
    } finally {
      disposeReviewedToolchain(staged);
    }

    writeFileSync(
      resolve(fixture.npmRoot, "lib/cli.js"),
      "module.exports = { compromised: true }\n",
    );
    expect(() => stageReviewedToolchain({
      stageRoot: resolve(fixture.root, "mutated-stage"),
      sourceNode: fixture.nodePath,
      sourceNpmRoot: fixture.npmRoot,
      sourceNodeVersion: "v22.19.0",
      expectedRuntime: fixture.runtime,
    })).toThrow(/toolchain source differs from the reviewed source pin/);
  });

  it.each([
    ["hard-linked .pyc", (fixture: ReturnType<typeof toolchainFixture>) => {
      linkSync(
        resolve(fixture.npmRoot, "lib/cli.js"),
        resolve(fixture.npmRoot, "cache.pyc"),
      );
    }],
    ["symlinked .pyc", (fixture: ReturnType<typeof toolchainFixture>) => {
      symlinkSync("lib/cli.js", resolve(fixture.npmRoot, "cache.pyc"));
    }],
    ["special .pyc", (fixture: ReturnType<typeof toolchainFixture>) => {
      execFileSync("mkfifo", [resolve(fixture.npmRoot, "cache.pyc")]);
    }],
    ["symlinked __pycache__", (fixture: ReturnType<typeof toolchainFixture>) => {
      symlinkSync("lib", resolve(fixture.npmRoot, "__pycache__"));
    }],
    ["hard link inside __pycache__", (fixture: ReturnType<typeof toolchainFixture>) => {
      const cacheRoot = resolve(fixture.npmRoot, "__pycache__");
      mkdirSync(cacheRoot);
      linkSync(
        resolve(fixture.npmRoot, "lib/cli.js"),
        resolve(cacheRoot, "cache.pyc"),
      );
    }],
    ["symlink inside __pycache__", (fixture: ReturnType<typeof toolchainFixture>) => {
      const cacheRoot = resolve(fixture.npmRoot, "__pycache__");
      mkdirSync(cacheRoot);
      symlinkSync("../lib/cli.js", resolve(cacheRoot, "cache.pyc"));
    }],
    ["special file inside __pycache__", (fixture: ReturnType<typeof toolchainFixture>) => {
      const cacheRoot = resolve(fixture.npmRoot, "__pycache__");
      mkdirSync(cacheRoot);
      execFileSync("mkfifo", [resolve(cacheRoot, "cache.pyc")]);
    }],
  ])("rejects a %s cache lookalike", (_label, mutate) => {
    const fixture = toolchainFixture();
    mutate(fixture);
    expect(() => inspectReviewedToolchainSource({
      nodePath: fixture.nodePath,
      npmRoot: fixture.npmRoot,
      nodeVersion: "v22.19.0",
    })).toThrow(/hard-linked file|link or special file/);
  });

  it("refuses a source npm lib/cli.js mutation before candidate build staging", () => {
    const fixture = toolchainFixture();
    writeFileSync(
      resolve(fixture.npmRoot, "lib/cli.js"),
      "module.exports = { compromised: true }\n",
    );
    expect(() => stageReviewedToolchain({
      stageRoot: resolve(fixture.root, "staged"),
      sourceNode: fixture.nodePath,
      sourceNpmRoot: fixture.npmRoot,
      sourceNodeVersion: "v22.19.0",
      expectedRuntime: fixture.runtime,
    })).toThrow(/toolchain source differs from the reviewed source pin/);
  });

  it("refuses a staged npm lib/cli.js mutation before build, dry-run, or publish contact", () => {
    const fixture = toolchainFixture();
    const toolchain = stageReviewedToolchain({
      stageRoot: resolve(fixture.root, "staged"),
      sourceNode: fixture.nodePath,
      sourceNpmRoot: fixture.npmRoot,
      sourceNodeVersion: "v22.19.0",
      expectedRuntime: fixture.runtime,
    });
    const tarballFixture = fixtureRoot();
    const tarball = pack(tarballFixture.root);
    try {
      const npmLibrary = resolve(toolchain.root, "lib/node_modules/npm/lib/cli.js");
      chmodSync(npmLibrary, 0o600);
      writeFileSync(npmLibrary, "module.exports = { compromised: true }\n");

      let buildContact = false;
      expect(() => {
        reviewedNpm(["ci", "--ignore-scripts"], { toolchain });
        buildContact = true;
      }).toThrow(/snapshot file is writable|snapshot differs from the reviewed source pin/);
      expect(buildContact).toBe(false);

      let dryRunContact = false;
      expect(() => dryRunExactTarball({
        tarball,
        tag: "next",
        toolchain,
        execute() {
          dryRunContact = true;
          return "{}";
        },
      })).toThrow(/snapshot file is writable|snapshot differs from the reviewed source pin/);
      expect(dryRunContact).toBe(false);

    } finally {
      disposeReviewedToolchain(toolchain);
    }
  });

  it("keeps novice proof pending until the exact package is installed and hosted", () => {
    const candidate = readFileSync(
      resolve(packageRoot, "scripts/build-release-candidate.mjs"),
      "utf8",
    );
    expect(candidate).toContain('status: "pending-post-deploy"');
    expect(candidate).toContain(
      'requiredAfter: "package-install-and-hosted-activation"',
    );
    expect(candidate).not.toContain("--novice-evidence");
    expect(candidate).not.toContain("--results");
  });

  it("uses one canonical root lock for the exact stable dependency train", () => {
    const candidate = JSON.parse(
      readFileSync(resolve(packageRoot, "package.json"), "utf8"),
    );
    const rootLock = JSON.parse(
      readFileSync(resolve(repositoryRoot, "package-lock.json"), "utf8"),
    );
    const locked = rootLock.packages?.["packages/mcp"];

    const exactTrain = {
      version: "1.24.0-rc.1",
      instructions: "2.4.1",
      core: "1.5.2",
      tools: "0.9.0-rc.0",
    };
    expect({
      version: candidate.version,
      instructions: candidate.dependencies["@dexterai/mcp-instructions"],
      core: candidate.dependencies["@dexterai/x402-core"],
      tools: candidate.dependencies["@dexterai/x402-mcp-tools"],
    }).toEqual(exactTrain);
    expect({
      version: locked?.version,
      instructions: locked?.dependencies?.["@dexterai/mcp-instructions"],
      core: locked?.dependencies?.["@dexterai/x402-core"],
      tools: locked?.dependencies?.["@dexterai/x402-mcp-tools"],
    }).toEqual(exactTrain);

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

  it("rejects an arbitrary ignored build plus a matching forged attestation", () => {
    const { root, packageDir } = fixtureRoot();
    const reviewedTarball = pack(root, "reviewed.tgz");
    const reviewed = inspectTarball(reviewedTarball);
    const release = attestation();
    release.artifact = reviewed.artifact;
    release.inventory = reviewed.inventory;
    const rebuilt = {
      inspected: reviewed,
      identity: {
        commit: release.source.commit,
        tree: release.source.tree,
      },
      lock: { sha256: release.source.rootLockSha256 },
      manifest: {
        name: release.package.name,
        version: release.package.version,
      },
      runtime: {
        ...attestedRuntimeIdentity(release),
      },
      sourceArchiveSha256: release.source.archiveSha256,
      noviceSuiteSha256: release.noviceRoutingEvaluation.suiteSha256,
      hosted: {
        commit: release.hostedContract.sourceCommit,
        tree: release.hostedContract.sourceTree,
        descriptorPath: release.hostedContract.descriptorPath,
        sourceArchiveSha256: release.hostedContract.sourceArchiveSha256,
        contractSha256: release.hostedContract.contractSha256,
        widgetSourceDigest: release.hostedContract.widgetSourceDigest,
        widgetInventory: release.hostedContract.widgetInventory,
      },
    };
    expect(() => verifyAttestation({
      attestation: release,
      tarball: reviewedTarball,
      rebuilt,
    })).not.toThrow();

    // Model an attacker rewriting ignored live dist and then forging the
    // attestation around those same bytes. Final verification compares only
    // with the independent sterile rebuild, so the paired forgery is refused.
    writeFileSync(
      resolve(packageDir, "dist/index.js"),
      "#!/usr/bin/env node\nconsole.log('forged ignored dist');\n",
    );
    const forgedTarball = pack(root, "forged.tgz");
    const forged = inspectTarball(forgedTarball);
    const forgedAttestation = structuredClone(release);
    forgedAttestation.artifact = forged.artifact;
    forgedAttestation.inventory = forged.inventory;
    expect(() => verifyAttestation({
      attestation: forgedAttestation,
      tarball: forgedTarball,
      rebuilt,
    })).toThrow(/candidate and rebuilt tarball identity|candidate and rebuilt full inventory/);
  });

  it("uses protected npm for exact-tarball dry-run despite ambient PATH", () => {
    const { root } = fixtureRoot();
    const tarball = pack(root);
    const inspected = inspectTarball(tarball);
    const fakeBin = resolve(root, "fake-bin");
    mkdirSync(fakeBin);
    writeFileSync(resolve(fakeBin, "npm"), "#!/bin/sh\nexit 91\n", { mode: 0o755 });
    const priorPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${priorPath ?? ""}`;
    const toolchain = stagedReviewedToolchain();
    try {
      let dryRunCalled = false;
      const dryRun = dryRunExactTarball({
        tarball,
        tag: "next",
        toolchain,
        execute(command: string, args: string[], options: { env: NodeJS.ProcessEnv }) {
          dryRunCalled = true;
          expect(command).toBe(toolchain.command);
          expect(args[0]).toBe(toolchain.cli);
          expect(args).toContain("--dry-run");
          expect(args).toEqual(expect.arrayContaining([
            "--access",
            "public",
            "--registry",
            "https://registry.npmjs.org/",
          ]));
          expect(args.at(-1)).toBe(realpathSync(tarball));
          expect(options.env.PATH?.startsWith(fakeBin)).toBe(false);
          return JSON.stringify({
            shasum: inspected.artifact.shasum,
            integrity: inspected.artifact.integrity,
            files: inspected.inventory.map(({ path, size }) => ({ path, size })),
          });
        },
      });
      expect(dryRunCalled).toBe(true);
      expect(dryRun.tarball).toBe(realpathSync(tarball));
    } finally {
      disposeReviewedToolchain(toolchain);
      process.env.PATH = priorPath;
    }
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
