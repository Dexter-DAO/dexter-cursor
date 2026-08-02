#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createReviewedSourceArchive,
  digestFile,
  EXPECTED_RELEASE_SOURCE_REPOSITORY,
  inspectTarball,
  packageRoot,
  RELEASE_BUILD_RECIPE,
  REVIEWED_RELEASE_NPM_VERSION,
  reviewedNpm,
  reviewedReleaseEnvironment,
  repositoryIdentity,
  repositoryRoot,
  verifyRootLock,
} from "./package-provenance.mjs";
import { releaseChannel } from "./release-policy.mjs";
import {
  EXPECTED_HOSTED_SOURCE_REPOSITORY,
  verifyHostedSource,
} from "./verify-hosted-source.mjs";

function fail(message) {
  throw new Error(message);
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  }).trim();
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function requiredAbsolute(value, label) {
  if (!value) fail(`${label} is required`);
  if (!isAbsolute(value)) fail(`${label} must be an absolute path`);
  return realpathSync(value);
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) fail(`unexpected argument: ${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`${key} requires a value`);
    values[key.slice(2)] = value;
    index += 1;
  }
  return values;
}

function verifyEvidence(path, { kind, statusField, status, identity }) {
  const evidence = readJson(path);
  if (evidence?.kind !== kind) fail(`${basename(path)} has the wrong evidence kind`);
  if (evidence?.[statusField] !== status) fail(`${basename(path)} is not ${status}`);
  if (evidence?.source?.commit !== identity.commit || evidence?.source?.tree !== identity.tree) {
    fail(`${basename(path)} does not accept this exact source commit/tree`);
  }
  return evidence;
}

function runReviewedNpm(args, options = {}) {
  const npm = reviewedNpm(args);
  return run(npm.command, npm.args, options);
}

export function stageTreePureSource({
  sourceRoot,
  commit,
  tree,
  stageRoot,
  name,
  environment = reviewedReleaseEnvironment(),
}) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) fail("invalid source stage name");
  const gitStage = resolve(stageRoot, `${name}-git`);
  const archive = resolve(stageRoot, `${name}.tar`);
  const extractedRoot = resolve(stageRoot, name);
  mkdirSync(gitStage);
  mkdirSync(extractedRoot);
  const archiveSha256 = createReviewedSourceArchive({
    root: sourceRoot,
    commit,
    tree,
    output: archive,
    disposableRoot: gitStage,
    environment,
  });
  run("tar", ["-xf", archive, "-C", extractedRoot], {
    env: environment,
    stdio: "pipe",
  });
  return { archive, archiveSha256, extractedRoot };
}

function installExactArtifact({ tarball, ignoreScripts }) {
  const installRoot = mkdtempSync(joinTmp("opendexter-artifact-install-"));
  try {
    const environment = reviewedReleaseEnvironment({
      npmCache: resolve(installRoot, "npm-cache"),
    });
    const installEnvironment = {
      ...environment,
      npm_config_ignore_scripts: ignoreScripts ? "true" : "false",
    };
    writeFileSync(
      resolve(installRoot, "package.json"),
      `${JSON.stringify({ private: true }, null, 2)}\n`,
    );
    const args = ["install", "--save-exact", "--no-audit", "--no-fund"];
    if (ignoreScripts) args.push("--ignore-scripts");
    args.push(tarball);
    runReviewedNpm(args, {
      cwd: installRoot,
      env: installEnvironment,
      stdio: "pipe",
    });
    const installedRoot = resolve(installRoot, "node_modules/@dexterai/opendexter");
    const manifest = readJson(resolve(installedRoot, "package.json"));
    run(process.execPath, [resolve(installedRoot, "dist/index.js"), "--help"], {
      cwd: installRoot,
      env: installEnvironment,
      stdio: "pipe",
    });
    return { version: manifest.version, ignoredScripts: ignoreScripts };
  } finally {
    rmSync(installRoot, { recursive: true, force: true });
  }
}

function joinTmp(prefix) {
  return resolve(tmpdir(), prefix);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outputParent = requiredAbsolute(args["output-dir"], "--output-dir");
  const hostedSource = requiredAbsolute(args["hosted-source"], "--hosted-source");
  const reviewPath = requiredAbsolute(args.review, "--review");
  const novicePath = requiredAbsolute(args["novice-evidence"], "--novice-evidence");
  const distTag = args["dist-tag"];
  if (!distTag) fail("--dist-tag is required");

  const identity = repositoryIdentity(repositoryRoot, { requireClean: true });
  const lock = verifyRootLock({ requireTracked: true });
  const manifest = readJson(resolve(packageRoot, "package.json"));
  const channel = releaseChannel(manifest.version);
  if (channel === "prerelease" && distTag === "latest") {
    fail("a prerelease candidate cannot target latest");
  }
  if (channel === "stable" && distTag !== "latest") {
    fail("a stable candidate must target latest");
  }
  const review = verifyEvidence(reviewPath, {
    kind: "opendexter-release-review/v1",
    statusField: "decision",
    status: "accepted",
    identity,
  });
  const novice = verifyEvidence(novicePath, {
    kind: "opendexter-novice-routing-evaluation/v1",
    statusField: "status",
    status: "passed",
    identity,
  });
  const hosted = await verifyHostedSource({ sourceRoot: hostedSource, mode: "check" });

  const candidateRoot = resolve(
    outputParent,
    `${manifest.name.replaceAll("/", "-").replace(/^@/, "")}-${manifest.version}-${identity.commit.slice(0, 12)}`,
  );
  try {
    mkdirSync(candidateRoot, { recursive: false });
  } catch (error) {
    if (error?.code === "EEXIST") fail(`candidate output already exists: ${candidateRoot}`);
    throw error;
  }
  const buildStage = mkdtempSync(joinTmp("opendexter-clean-build-"));
  try {
    const npmCache = resolve(buildStage, "npm-cache");
    const environment = reviewedReleaseEnvironment({ npmCache });
    const reviewedVersion = runReviewedNpm(["--version"], { env: environment });
    if (reviewedVersion !== REVIEWED_RELEASE_NPM_VERSION) {
      fail("installed npm differs from the reviewed release npm version");
    }
    const sourceStage = stageTreePureSource({
      sourceRoot: repositoryRoot,
      commit: identity.commit,
      tree: identity.tree,
      stageRoot: buildStage,
      name: "source",
      environment,
    });
    const hostedStage = stageTreePureSource({
      sourceRoot: hostedSource,
      commit: hosted.commit,
      tree: hosted.tree,
      stageRoot: buildStage,
      name: "hosted-source",
      environment,
    });
    const cleanRoot = sourceStage.extractedRoot;
    const immutableWidgetSource = resolve(
      hostedStage.extractedRoot,
      "public/apps-sdk",
    );
    const cleanPackageRoot = resolve(cleanRoot, "packages/mcp");
    const hostedContractPath = resolve(
      cleanRoot,
      "plugins/opendexter/skills/opendexter/references/hosted-contract.json",
    );
    const cleanManifest = readJson(resolve(cleanPackageRoot, "package.json"));
    if (
      JSON.stringify(readJson(hostedContractPath))
      !== JSON.stringify(hosted.contract)
    ) {
      fail("archived IDE hosted contract differs from verified hosted source");
    }
    const archivedLock = verifyRootLock({
      repoRoot: cleanRoot,
      pkgRoot: cleanPackageRoot,
      requireTracked: false,
    });
    if (archivedLock.sha256 !== lock.sha256) {
      fail("archived release lock differs from the reviewed source lock");
    }
    if (
      cleanManifest.name !== manifest.name
      || cleanManifest.version !== manifest.version
    ) {
      fail("archived package identity differs from the reviewed checkout");
    }
    run(
      process.execPath,
      [
        resolve(cleanRoot, "tests/opendexter-novice-routing-evaluation.mjs"),
        "--results",
        novicePath,
      ],
      { cwd: cleanRoot, env: environment, stdio: "pipe" },
    );

    // The candidate is always rebuilt from the committed root lock. No current
    // checkout node_modules, ignored lock, untracked build output, or mutable
    // hosted widget file is reused.
    const npmCiArgs = ["ci", "--ignore-scripts"];
    npmCiArgs.push("--no-audit", "--no-fund");
    runReviewedNpm(npmCiArgs, {
      cwd: cleanRoot,
      env: environment,
      stdio: "pipe",
    });
    runReviewedNpm(["run", "version:check", "--workspace=@dexterai/opendexter"], {
      cwd: cleanRoot,
      env: environment,
      stdio: "pipe",
    });
    runReviewedNpm(["run", "build", "--workspace=@dexterai/opendexter"], {
      cwd: cleanRoot,
      env: {
        ...environment,
        DEXTER_WIDGET_SOURCE: immutableWidgetSource,
      },
      stdio: "pipe",
    });
    const rawPack = runReviewedNpm([
      "pack",
      "--json",
      "--ignore-scripts",
      `--pack-destination=${candidateRoot}`,
    ], {
      cwd: cleanPackageRoot,
      env: environment,
    });
    const [pack] = JSON.parse(rawPack);
    const tarball = resolve(candidateRoot, pack.filename);
    const inspected = inspectTarball(tarball, {
      sourcePackageRoot: cleanPackageRoot,
    });

    const normalInstall = installExactArtifact({ tarball, ignoreScripts: false });
    const inertInstall = installExactArtifact({ tarball, ignoreScripts: true });
    if (
      normalInstall.version !== cleanManifest.version
      || inertInstall.version !== cleanManifest.version
    ) {
      fail("exact-artifact install resolved the wrong package version");
    }

    const attestation = {
      schemaVersion: 1,
      kind: "opendexter-coordinated-release/v1",
      package: {
        name: cleanManifest.name,
        version: cleanManifest.version,
        releaseChannel: channel,
        distTag,
      },
      source: {
        repository: EXPECTED_RELEASE_SOURCE_REPOSITORY,
        commit: identity.commit,
        tree: identity.tree,
        archiveSha256: sourceStage.archiveSha256,
        rootLockSha256: lock.sha256,
      },
      build: {
        sourceMaterial: "archive",
        recipe: RELEASE_BUILD_RECIPE,
        node: process.version,
        npm: reviewedVersion,
        exactArtifactInstalls: [normalInstall, inertInstall],
      },
      artifact: inspected.artifact,
      inventory: inspected.inventory,
      hostedContract: {
        sourceRepository: EXPECTED_HOSTED_SOURCE_REPOSITORY,
        sourceCommit: hosted.commit,
        sourceTree: hosted.tree,
        sourceArchiveSha256: hostedStage.archiveSha256,
        widgetSourcePath: "public/apps-sdk",
        descriptorPath: hosted.descriptorPath,
        contractSha256: digestFile(hostedContractPath),
      },
      review: {
        decision: review.decision,
        receiptSha256: digestFile(reviewPath),
      },
      noviceRoutingEvaluation: {
        status: novice.status,
        evidenceSha256: digestFile(novicePath),
      },
    };
    const attestationPath = resolve(candidateRoot, "release-attestation.json");
    writeFileSync(attestationPath, `${JSON.stringify(attestation, null, 2)}\n`);
    process.stdout.write(
      `Built one exact candidate tarball: ${tarball}\n`
        + `Attestation: ${attestationPath}\n`
        + `Attestation SHA-256: ${digestFile(attestationPath)}\n`,
    );
  } catch (error) {
    // Preserve a failed candidate directory for forensic review; never replace
    // it or silently produce different bytes at the same path.
    throw error;
  } finally {
    rmSync(buildStage, { recursive: true, force: true });
  }
}

if (
  process.argv[1]
  && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`OpenDexter candidate build refused: ${error.message}\n`);
    process.exitCode = 1;
  }
}
