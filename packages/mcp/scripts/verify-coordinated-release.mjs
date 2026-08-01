#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  digestFile,
  packageRoot,
  validateAttestationShape,
  verifyAttestation,
} from "./package-provenance.mjs";
import { verifyPublishPolicy } from "./release-policy.mjs";

function fail(message) {
  throw new Error(message);
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) fail(`${name} is required for a coordinated publish`);
  return value;
}

function absoluteExisting(name) {
  const value = requiredEnv(name);
  if (!isAbsolute(value)) fail(`${name} must be an absolute path`);
  return realpathSync(value);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function same(actual, expected, label) {
  if (JSON.stringify(canonical(actual)) !== JSON.stringify(canonical(expected))) {
    fail(`${label} differs from the attested tarball`);
  }
}

function dryRunInventory() {
  const raw = execFileSync(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    { cwd: packageRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const [result] = JSON.parse(raw);
  if (!Array.isArray(result?.files) || result.files.length === 0) {
    fail("npm pack dry-run returned no files");
  }
  return result.files
    .map((file) => ({ path: file.path, size: file.size }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function main() {
  // Read every required release input before invoking build, pack, npm view,
  // or any other lifecycle. A plain npm publish therefore dies here.
  const attestationPath = absoluteExisting("OPENDXTER_RELEASE_ATTESTATION");
  const tarball = absoluteExisting("OPENDXTER_RELEASE_TARBALL");
  const reviewReceipt = absoluteExisting("OPENDXTER_RELEASE_REVIEW_RECEIPT");
  const noviceEvidence = absoluteExisting("OPENDXTER_RELEASE_NOVICE_EVIDENCE");
  const attestationDigest = requiredEnv("OPENDXTER_RELEASE_ATTESTATION_SHA256");
  const explicitTag = requiredEnv("OPENDXTER_RELEASE_DIST_TAG");

  if (digestFile(attestationPath) !== attestationDigest) {
    fail("release attestation bytes do not match OPENDXTER_RELEASE_ATTESTATION_SHA256");
  }
  const attestation = validateAttestationShape(readJson(attestationPath));
  const review = readJson(reviewReceipt);
  if (
    review?.kind !== "opendexter-release-review/v1"
    || review?.decision !== "accepted"
    || review?.source?.commit !== attestation.source.commit
    || review?.source?.tree !== attestation.source.tree
  ) {
    fail("review receipt does not accept the attested source commit/tree");
  }
  const novice = readJson(noviceEvidence);
  if (
    novice?.kind !== "opendexter-novice-routing-evaluation/v1"
    || novice?.status !== "passed"
    || novice?.source?.commit !== attestation.source.commit
    || novice?.source?.tree !== attestation.source.tree
  ) {
    fail("novice-language evidence does not pass the attested source commit/tree");
  }
  execFileSync(
    process.execPath,
    [
      resolve(packageRoot, "../../tests/opendexter-novice-routing-evaluation.mjs"),
      "--results",
      noviceEvidence,
    ],
    { cwd: resolve(packageRoot, "../.."), stdio: "pipe" },
  );
  const manifest = readJson(resolve(packageRoot, "package.json"));
  verifyPublishPolicy({
    manifest,
    attestation,
    npmTag: process.env.npm_config_tag,
    explicitTag,
  });
  verifyAttestation({
    attestation,
    tarball,
    reviewReceipt,
    noviceEvidence,
  });

  const attestedFiles = attestation.inventory
    .map(({ path, size }) => ({ path, size }))
    .sort((left, right) => left.path.localeCompare(right.path));
  same(dryRunInventory(), attestedFiles, "current npm publish file inventory");
  process.stdout.write(
    `Coordinated publish gate passed for ${manifest.name}@${manifest.version} `
      + `on ${attestation.package.distTag}.\n`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`OpenDexter publish refused: ${error.message}\n`);
  process.exitCode = 1;
}
