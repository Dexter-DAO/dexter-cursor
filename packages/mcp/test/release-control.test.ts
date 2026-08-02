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
  canonicalReleaseRemoteRefs,
  EXPECTED_RELEASE_SOURCE_REPOSITORY,
  RELEASE_BUILD_RECIPE,
  repositoryIdentity,
  reviewedNpm,
  reviewedReleaseEnvironment,
  reviewedSourceArchiveDigest,
  validateAttestationShape,
  verifyRegistryMetadata,
  verifyReleaseRepositoryIdentity,
  verifyRootLock,
} from "../scripts/package-provenance.mjs";
import { stageTreePureSource } from "../scripts/build-release-candidate.mjs";
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
      repository: EXPECTED_RELEASE_SOURCE_REPOSITORY,
      commit: "a".repeat(40),
      tree: "b".repeat(40),
      archiveSha256: "3".repeat(64),
      rootLockSha256: "c".repeat(64),
    },
    build: {
      sourceMaterial: "archive",
      recipe: RELEASE_BUILD_RECIPE,
      node: "v22.19.0",
      npm: "10.9.3",
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
    noviceRoutingEvaluation: { status: "passed", evidenceSha256: "2".repeat(64) },
    hostedContract: {
      sourceRepository: "https://github.com/Dexter-DAO/dexter-mcp",
      sourceCommit: "4".repeat(40),
      sourceTree: "5".repeat(40),
      sourceArchiveSha256: "6".repeat(64),
      widgetSourcePath: "public/apps-sdk",
      descriptorPath: "release/open-tool-descriptors.json",
      contractSha256: "7".repeat(64),
    },
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
    const environment = reviewedReleaseEnvironment();
    const npm = reviewedNpm(["--version"]);
    expect(npm.command).toBe(process.execPath);
    expect(execFileSync(npm.command, npm.args, {
      encoding: "utf8",
      env: environment,
    }).trim()).toBe("10.9.3");
    expect(environment.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(environment.npm_config_userconfig).toBe("/dev/null");
    expect(environment.npm_config_ignore_scripts).toBe("true");
    expect(Object.hasOwn(environment, "NODE_OPTIONS")).toBe(false);
  });

  it("revalidates novice evidence with the archived release script", () => {
    const candidate = readFileSync(
      resolve(packageRoot, "scripts/build-release-candidate.mjs"),
      "utf8",
    );
    expect(candidate).toContain(
      'resolve(cleanRoot, "tests/opendexter-novice-routing-evaluation.mjs")',
    );
    expect(candidate).not.toContain(
      'resolve(repositoryRoot, "tests/opendexter-novice-routing-evaluation.mjs")',
    );
  });

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
