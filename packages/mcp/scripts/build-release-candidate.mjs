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
import {
  digestFile,
  inspectTarball,
  packageRoot,
  repositoryIdentity,
  repositoryRoot,
  verifyRootLock,
} from "./package-provenance.mjs";
import { releaseChannel } from "./release-policy.mjs";
import { verifyHostedSource } from "./verify-hosted-source.mjs";

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

function installExactArtifact({ tarball, ignoreScripts }) {
  const installRoot = mkdtempSync(joinTmp("opendexter-artifact-install-"));
  try {
    writeFileSync(
      resolve(installRoot, "package.json"),
      `${JSON.stringify({ private: true }, null, 2)}\n`,
    );
    const args = ["install", "--save-exact", "--no-audit", "--no-fund"];
    if (ignoreScripts) args.push("--ignore-scripts");
    args.push(tarball);
    run("npm", args, { cwd: installRoot, stdio: "pipe" });
    const installedRoot = resolve(installRoot, "node_modules/@dexterai/opendexter");
    const manifest = readJson(resolve(installedRoot, "package.json"));
    run(process.execPath, [resolve(installedRoot, "dist/index.js"), "--help"], {
      cwd: installRoot,
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
  run(
    process.execPath,
    [resolve(repositoryRoot, "tests/opendexter-novice-routing-evaluation.mjs"), "--results", novicePath],
    { cwd: repositoryRoot, stdio: "pipe" },
  );
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
    const archive = resolve(buildStage, "source.tar");
    run("git", ["-C", repositoryRoot, "archive", "--format=tar", `--output=${archive}`, identity.commit]);
    const cleanRoot = resolve(buildStage, "source");
    mkdirSync(cleanRoot);
    run("tar", ["-xf", archive, "-C", cleanRoot]);

    // The candidate is always rebuilt from the committed root lock. No current
    // checkout node_modules, ignored lock, or untracked build output is reused.
    run("npm", ["ci", "--ignore-scripts"], { cwd: cleanRoot, stdio: "pipe" });
    run("npm", ["run", "version:check", "--workspace=@dexterai/opendexter"], {
      cwd: cleanRoot,
      stdio: "pipe",
    });
    run("npm", ["run", "build", "--workspace=@dexterai/opendexter"], {
      cwd: cleanRoot,
      env: {
        ...process.env,
        DEXTER_WIDGET_SOURCE: resolve(hostedSource, "public/apps-sdk"),
      },
      stdio: "pipe",
    });
    const rawPack = run(
      "npm",
      [
        "pack",
        "--json",
        "--ignore-scripts",
        `--pack-destination=${candidateRoot}`,
      ],
      { cwd: resolve(cleanRoot, "packages/mcp") },
    );
    const [pack] = JSON.parse(rawPack);
    const tarball = resolve(candidateRoot, pack.filename);
    const inspected = inspectTarball(tarball, {
      sourcePackageRoot: resolve(cleanRoot, "packages/mcp"),
    });

    const normalInstall = installExactArtifact({ tarball, ignoreScripts: false });
    const inertInstall = installExactArtifact({ tarball, ignoreScripts: true });
    if (normalInstall.version !== manifest.version || inertInstall.version !== manifest.version) {
      fail("exact-artifact install resolved the wrong package version");
    }

    const hostedContractPath = resolve(
      repositoryRoot,
      "plugins/opendexter/skills/opendexter/references/hosted-contract.json",
    );
    const attestation = {
      schemaVersion: 1,
      kind: "opendexter-coordinated-release/v1",
      package: {
        name: manifest.name,
        version: manifest.version,
        releaseChannel: channel,
        distTag,
      },
      source: {
        repository: manifest.repository?.url,
        commit: identity.commit,
        tree: identity.tree,
        rootLockSha256: lock.sha256,
      },
      build: {
        recipe: "git-archive+npm-ci-ignore-scripts+workspace-build+npm-pack-once/v1",
        node: process.version,
        npm: run("npm", ["--version"]),
        exactArtifactInstalls: [normalInstall, inertInstall],
      },
      artifact: inspected.artifact,
      inventory: inspected.inventory,
      hostedContract: {
        sourceCommit: hosted.commit,
        sourceTree: hosted.tree,
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

try {
  await main();
} catch (error) {
  process.stderr.write(`OpenDexter candidate build refused: ${error.message}\n`);
  process.exitCode = 1;
}
