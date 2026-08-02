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
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalJsonDigest,
  createReviewedSourceArchive,
  digestFile,
  EXPECTED_RELEASE_SOURCE_REPOSITORY,
  inspectTarball,
  packageRoot,
  RELEASE_BUILD_RECIPE,
  reviewedReleaseEnvironment,
  reviewedWidgetInventory,
  repositoryIdentity,
  repositoryRoot,
  verifyAttestation,
  verifyRootLock,
} from "./package-provenance.mjs";
import {
  disposeReviewedToolchain,
  loadReviewedToolchainPin,
  reviewedNpm,
  reviewedRuntimeIdentity,
  stageReviewedToolchain,
} from "./reviewed-toolchain.mjs";
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

export function snapshotFileInput(source, destination) {
  const bytes = readFileSync(source);
  writeFileSync(destination, bytes, { flag: "wx", mode: 0o600 });
  return {
    path: destination,
    sha256: digestFile(destination),
    bytes,
  };
}

export function snapshotJsonInput(source, destination) {
  const snapshot = snapshotFileInput(source, destination);
  return {
    ...snapshot,
    value: JSON.parse(snapshot.bytes.toString("utf8")),
  };
}

function runReviewedNpm(toolchain, args, options = {}) {
  const npm = reviewedNpm(args, { toolchain });
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

export function buildReviewedReleaseArtifact(options) {
  const priorUmask = process.umask(0o022);
  try {
    return buildReviewedReleaseArtifactUnderCanonicalUmask(options);
  } finally {
    process.umask(priorUmask);
  }
}

function buildReviewedReleaseArtifactUnderCanonicalUmask({
  sourceRoot,
  identity,
  expectedLockSha256,
  hostedSource,
  hosted,
  stageRoot,
  outputRoot,
}) {
  let toolchain = null;
  try {
    toolchain = stageReviewedToolchain({
      stageRoot: resolve(stageRoot, "reviewed-toolchain"),
    });
    const npmCache = resolve(stageRoot, "npm-cache");
    const releaseHome = resolve(stageRoot, "home");
    mkdirSync(releaseHome);
    const environment = reviewedReleaseEnvironment({
      npmCache,
      home: releaseHome,
      nodeBin: dirname(toolchain.command),
    });
    const runtime = reviewedRuntimeIdentity({ toolchain });
    const sourceStage = stageTreePureSource({
      sourceRoot,
      commit: identity.commit,
      tree: identity.tree,
      stageRoot,
      name: "source",
      environment,
    });
    const hostedStage = stageTreePureSource({
      sourceRoot: hostedSource,
      commit: hosted.commit,
      tree: hosted.tree,
      stageRoot,
      name: "hosted-source",
      environment,
    });
    const verifiedHostedArchiveSha256 =
      hosted.contract?.materialization?.sourceArchiveSha256 ?? null;
    if (
      verifiedHostedArchiveSha256
      && hostedStage.archiveSha256 !== verifiedHostedArchiveSha256
    ) {
      fail("recomputed hosted source archive differs from its verified contract");
    }

    const cleanRoot = sourceStage.extractedRoot;
    const cleanPackageRoot = resolve(cleanRoot, "packages/mcp");
    const immutableWidgetSource = resolve(
      hostedStage.extractedRoot,
      "public/apps-sdk",
    );
    const hostedContractPath = resolve(
      cleanRoot,
      "plugins/opendexter/skills/opendexter/references/hosted-contract.json",
    );
    const cleanManifest = readJson(resolve(cleanPackageRoot, "package.json"));
    const archivedRuntime = loadReviewedToolchainPin(
      resolve(cleanPackageRoot, "release/reviewed-node-npm-toolchain.json"),
    );
    if (canonicalJsonDigest(archivedRuntime) !== canonicalJsonDigest(runtime)) {
      fail("reviewed toolchain differs from the exact archived IDE source pin");
    }
    if (
      canonicalJsonDigest(readJson(hostedContractPath))
      !== canonicalJsonDigest(hosted.contract)
    ) {
      fail("archived IDE hosted contract differs from verified hosted source");
    }
    const archivedLock = verifyRootLock({
      repoRoot: cleanRoot,
      pkgRoot: cleanPackageRoot,
      requireTracked: false,
    });
    if (archivedLock.sha256 !== expectedLockSha256) {
      fail("archived release lock differs from the reviewed source lock");
    }
    const widgets = reviewedWidgetInventory(immutableWidgetSource);

    const npmCiArgs = ["ci", "--ignore-scripts"];
    npmCiArgs.push("--no-audit", "--no-fund");
    runReviewedNpm(toolchain, npmCiArgs, {
      cwd: cleanRoot,
      env: environment,
      stdio: "pipe",
    });
    runReviewedNpm(
      toolchain,
      ["run", "version:check", "--workspace=@dexterai/opendexter"],
      { cwd: cleanRoot, env: environment, stdio: "pipe" },
    );
    runReviewedNpm(
      toolchain,
      ["run", "build", "--workspace=@dexterai/opendexter"],
      {
        cwd: cleanRoot,
        env: {
          ...environment,
          DEXTER_WIDGET_SOURCE: immutableWidgetSource,
        },
        stdio: "pipe",
      },
    );
    for (const widget of widgets.inventory) {
      const copied = resolve(cleanPackageRoot, "dist/widgets", widget.path);
      if (digestFile(copied) !== widget.sha256) {
        fail(`rebuilt package widget differs from immutable hosted source: ${widget.path}`);
      }
    }

    const rawPack = runReviewedNpm(toolchain, [
      "pack",
      "--json",
      "--ignore-scripts",
      `--pack-destination=${outputRoot}`,
    ], {
      cwd: cleanPackageRoot,
      env: environment,
    });
    const [pack] = JSON.parse(rawPack);
    const tarball = resolve(outputRoot, pack.filename);
    const inspected = inspectTarball(tarball, {
      sourcePackageRoot: cleanPackageRoot,
    });
    return {
      tarball,
      inspected,
      identity,
      lock: archivedLock,
      manifest: cleanManifest,
      runtime,
      toolchain,
      noviceSuiteSha256: digestFile(
        resolve(cleanRoot, "tests/opendexter-novice-routing-cases.json"),
      ),
      sourceArchiveSha256: sourceStage.archiveSha256,
      hosted: {
        commit: hosted.commit,
        tree: hosted.tree,
        descriptorPath: hosted.descriptorPath,
        sourceArchiveSha256: hostedStage.archiveSha256,
        contractSha256: digestFile(hostedContractPath),
        widgetSourcePath: "public/apps-sdk",
        widgetSourceDigest: widgets.digest,
        widgetInventory: widgets.inventory,
      },
    };
  } catch (error) {
    disposeReviewedToolchain(toolchain);
    throw error;
  }
}

export async function verifyRebuiltReleaseCandidate({
  attestationPath,
  expectedAttestationSha256,
  candidateTarball,
  reviewReceipt,
  hostedSource,
  apiSource,
  facilitatorSource,
  sourceRoot = repositoryRoot,
  afterRebuild = null,
}) {
  const verificationRoot = mkdtempSync(joinTmp("opendexter-release-verify-"));
  let rebuilt = null;
  try {
    const evidenceRoot = resolve(verificationRoot, "evidence");
    const outputRoot = resolve(verificationRoot, "rebuilt");
    mkdirSync(evidenceRoot);
    mkdirSync(outputRoot);
    const stableAttestation = snapshotJsonInput(
      attestationPath,
      resolve(evidenceRoot, "attestation.json"),
    );
    if (
      expectedAttestationSha256
      && stableAttestation.sha256 !== expectedAttestationSha256
    ) {
      fail("release attestation bytes do not match the required SHA-256");
    }
    const stableReview = snapshotJsonInput(
      reviewReceipt,
      resolve(evidenceRoot, "review.json"),
    );
    const stableCandidate = snapshotFileInput(
      candidateTarball,
      resolve(evidenceRoot, basename(candidateTarball)),
    );

    const identity = repositoryIdentity(sourceRoot, { requireClean: true });
    const lock = verifyRootLock({
      repoRoot: sourceRoot,
      pkgRoot: resolve(sourceRoot, "packages/mcp"),
      requireTracked: true,
    });
    verifyEvidence(stableReview.path, {
      kind: "opendexter-release-review/v1",
      statusField: "decision",
      status: "accepted",
      identity,
    });
    const hosted = await verifyHostedSource({
      sourceRoot: hostedSource,
      apiSourceRoot: apiSource,
      facilitatorSourceRoot: facilitatorSource,
      mode: "check",
    });
    rebuilt = buildReviewedReleaseArtifact({
      sourceRoot,
      identity,
      expectedLockSha256: lock.sha256,
      hostedSource,
      hosted,
      stageRoot: verificationRoot,
      outputRoot,
    });
    const verified = verifyAttestation({
      attestation: stableAttestation.value,
      tarball: stableCandidate.path,
      rebuilt,
      reviewReceipt: stableReview.path,
    });
    if (afterRebuild) {
      await afterRebuild({
        attestation: stableAttestation.value,
        candidateTarball: stableCandidate.path,
        rebuilt,
        verified,
      });
    }
    if (digestFile(stableCandidate.path) !== stableCandidate.sha256) {
      fail("candidate tarball changed during final verification");
    }
    if (digestFile(stableAttestation.path) !== stableAttestation.sha256) {
      fail("release attestation changed during final verification");
    }
    if (digestFile(stableReview.path) !== stableReview.sha256) {
      fail("review receipt changed during final verification");
    }
    return {
      ...verified,
      attestation: stableAttestation.value,
      candidateSha256: stableCandidate.sha256,
    };
  } finally {
    disposeReviewedToolchain(rebuilt?.toolchain);
    rmSync(verificationRoot, { recursive: true, force: true });
  }
}

function installExactArtifact({ tarball, ignoreScripts, toolchain }) {
  const installRoot = mkdtempSync(joinTmp("opendexter-artifact-install-"));
  try {
    const installHome = resolve(installRoot, "home");
    mkdirSync(installHome);
    const environment = reviewedReleaseEnvironment({
      npmCache: resolve(installRoot, "npm-cache"),
      home: installHome,
      nodeBin: dirname(toolchain.command),
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
    runReviewedNpm(toolchain, args, {
      cwd: installRoot,
      env: installEnvironment,
      stdio: "pipe",
    });
    const installedRoot = resolve(installRoot, "node_modules/@dexterai/opendexter");
    const manifest = readJson(resolve(installedRoot, "package.json"));
    run(toolchain.command, [resolve(installedRoot, "dist/index.js"), "--help"], {
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

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const outputParent = requiredAbsolute(args["output-dir"], "--output-dir");
  const hostedSource = requiredAbsolute(args["hosted-source"], "--hosted-source");
  const apiSource = requiredAbsolute(args["api-source"], "--api-source");
  const facilitatorSource = requiredAbsolute(
    args["facilitator-source"],
    "--facilitator-source",
  );
  const reviewPath = requiredAbsolute(args.review, "--review");
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
  const buildStage = mkdtempSync(joinTmp("opendexter-clean-build-"));
  let rebuilt = null;
  try {
    const evidenceRoot = resolve(buildStage, "evidence");
    mkdirSync(evidenceRoot);
    const stableReview = snapshotJsonInput(
      reviewPath,
      resolve(evidenceRoot, "review.json"),
    );
    const review = verifyEvidence(stableReview.path, {
      kind: "opendexter-release-review/v1",
      statusField: "decision",
      status: "accepted",
      identity,
    });
    const hosted = await verifyHostedSource({
      sourceRoot: hostedSource,
      apiSourceRoot: apiSource,
      facilitatorSourceRoot: facilitatorSource,
      mode: "check",
    });
    const candidateRoot = resolve(
      outputParent,
      `${manifest.name.replaceAll("/", "-").replace(/^@/, "")}-${manifest.version}-${identity.commit.slice(0, 12)}`,
    );
    try {
      mkdirSync(candidateRoot, { recursive: false });
    } catch (error) {
      if (error?.code === "EEXIST") {
        fail(`candidate output already exists: ${candidateRoot}`);
      }
      throw error;
    }

    // The candidate is built only from canonically advertised committed trees,
    // the exact root lock and immutable hosted widget bytes. Mutable checkout
    // dist/node_modules never participate.
    rebuilt = buildReviewedReleaseArtifact({
      sourceRoot: repositoryRoot,
      identity,
      expectedLockSha256: lock.sha256,
      hostedSource,
      hosted,
      stageRoot: buildStage,
      outputRoot: candidateRoot,
    });
    if (
      rebuilt.manifest.name !== manifest.name
      || rebuilt.manifest.version !== manifest.version
    ) {
      fail("archived package identity differs from the reviewed checkout");
    }
    const tarball = rebuilt.tarball;

    const normalInstall = installExactArtifact({
      tarball,
      ignoreScripts: false,
      toolchain: rebuilt.toolchain,
    });
    const inertInstall = installExactArtifact({
      tarball,
      ignoreScripts: true,
      toolchain: rebuilt.toolchain,
    });
    if (
      normalInstall.version !== rebuilt.manifest.version
      || inertInstall.version !== rebuilt.manifest.version
    ) {
      fail("exact-artifact install resolved the wrong package version");
    }

    const attestation = {
      schemaVersion: 4,
      kind: "opendexter-coordinated-release/v4",
      package: {
        name: rebuilt.manifest.name,
        version: rebuilt.manifest.version,
        releaseChannel: channel,
        distTag,
      },
      source: {
        repository: EXPECTED_RELEASE_SOURCE_REPOSITORY,
        commit: identity.commit,
        tree: identity.tree,
        archiveSha256: rebuilt.sourceArchiveSha256,
        rootLockSha256: lock.sha256,
      },
      build: {
        sourceMaterial: "archive",
        recipe: RELEASE_BUILD_RECIPE,
        ...rebuilt.runtime,
        exactArtifactInstalls: [normalInstall, inertInstall],
      },
      artifact: rebuilt.inspected.artifact,
      inventory: rebuilt.inspected.inventory,
      hostedContract: {
        sourceRepository: EXPECTED_HOSTED_SOURCE_REPOSITORY,
        sourceCommit: rebuilt.hosted.commit,
        sourceTree: rebuilt.hosted.tree,
        sourceArchiveSha256: rebuilt.hosted.sourceArchiveSha256,
        widgetSourcePath: rebuilt.hosted.widgetSourcePath,
        widgetSourceDigest: rebuilt.hosted.widgetSourceDigest,
        widgetInventory: rebuilt.hosted.widgetInventory,
        descriptorPath: rebuilt.hosted.descriptorPath,
        contractSha256: rebuilt.hosted.contractSha256,
      },
      review: {
        decision: review.decision,
        receiptSha256: stableReview.sha256,
      },
      noviceRoutingEvaluation: {
        status: "pending-post-deploy",
        suiteSha256: rebuilt.noviceSuiteSha256,
        requiredAfter: "package-install-and-hosted-activation",
      },
    };
    const attestationPath = resolve(candidateRoot, "release-attestation.json");
    writeFileSync(attestationPath, `${JSON.stringify(attestation, null, 2)}\n`);
    process.stdout.write(
      `Built one exact candidate tarball: ${tarball}\n`
        + `Attestation: ${attestationPath}\n`
        + `Attestation SHA-256: ${digestFile(attestationPath)}\n`,
    );
    return {
      candidateRoot,
      tarball,
      attestation,
      attestationPath,
      attestationSha256: digestFile(attestationPath),
    };
  } catch (error) {
    // Preserve a failed candidate directory for forensic review; never replace
    // it or silently produce different bytes at the same path.
    throw error;
  } finally {
    disposeReviewedToolchain(rebuilt?.toolchain);
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
