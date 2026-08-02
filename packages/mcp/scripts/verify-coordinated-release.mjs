#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyRebuiltReleaseCandidate } from "./build-release-candidate.mjs";
import {
  reviewedNpmPublishInvocation,
  reviewedReleaseEnvironment,
  reviewedRuntimeIdentity,
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
    fail(`${label} differs from the rebuilt exact tarball`);
  }
}

export function dryRunExactTarball({
  tarball,
  tag,
  toolchain,
  execute = execFileSync,
}) {
  const dryRunRoot = mkdtempSync(resolve(tmpdir(), "opendexter-publish-dry-run-"));
  try {
    const releaseHome = resolve(dryRunRoot, "home");
    mkdirSync(releaseHome);
    const environment = reviewedReleaseEnvironment({
      npmCache: resolve(dryRunRoot, "npm-cache"),
      home: releaseHome,
      nodeBin: dirname(toolchain.command),
    });
    const runtime = reviewedRuntimeIdentity({ toolchain });
    const invocation = reviewedNpmPublishInvocation({
      tarball,
      tag,
      dryRun: true,
      toolchain,
    });
    const raw = execute(invocation.command, invocation.args, {
      cwd: dryRunRoot,
      encoding: "utf8",
      env: environment,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const result = JSON.parse(raw);
    if (!Array.isArray(result?.files) || result.files.length === 0) {
      fail("reviewed npm publish dry-run returned no files");
    }
    return {
      runtime,
      tarball: invocation.tarball,
      artifact: {
        shasum: result.shasum,
        integrity: result.integrity,
      },
      inventory: result.files
        .map((file) => ({ path: file.path, size: file.size }))
        .sort((left, right) => left.path.localeCompare(right.path)),
    };
  } finally {
    rmSync(dryRunRoot, { recursive: true, force: true });
  }
}

export async function verifyCoordinatedRelease({
  attestationPath,
  tarball,
  reviewReceipt,
  noviceEvidence,
  hostedSource,
  apiSource,
  facilitatorSource,
  attestationDigest,
  explicitTag,
  npmTag,
}) {
  const result = await verifyRebuiltReleaseCandidate({
    attestationPath,
    expectedAttestationSha256: attestationDigest,
    candidateTarball: tarball,
    reviewReceipt,
    noviceEvidence,
    hostedSource,
    apiSource,
    facilitatorSource,
    afterRebuild({ attestation, candidateTarball, rebuilt }) {
      verifyPublishPolicy({
        manifest: rebuilt.manifest,
        attestation,
        npmTag,
        explicitTag,
      });
      const dryRun = dryRunExactTarball({
        tarball: candidateTarball,
        tag: explicitTag,
        toolchain: rebuilt.toolchain,
      });
      same(dryRun.runtime, rebuilt.runtime, "dry-run Node/npm identity");
      same(dryRun.artifact, {
        shasum: rebuilt.inspected.artifact.shasum,
        integrity: rebuilt.inspected.artifact.integrity,
      }, "dry-run tarball identity");
      const rebuiltFiles = rebuilt.inspected.inventory
        .map(({ path, size }) => ({ path, size }))
        .sort((left, right) => left.path.localeCompare(right.path));
      same(dryRun.inventory, rebuiltFiles, "dry-run full file inventory");
    },
  });
  return result;
}

export async function main() {
  // Resolve every required input before build, dry-run, or registry contact.
  const result = await verifyCoordinatedRelease({
    attestationPath: absoluteExisting("OPENDXTER_RELEASE_ATTESTATION"),
    tarball: absoluteExisting("OPENDXTER_RELEASE_TARBALL"),
    reviewReceipt: absoluteExisting("OPENDXTER_RELEASE_REVIEW_RECEIPT"),
    noviceEvidence: absoluteExisting("OPENDXTER_RELEASE_NOVICE_EVIDENCE"),
    hostedSource: absoluteExisting("OPENDXTER_RELEASE_HOSTED_SOURCE"),
    apiSource: absoluteExisting("OPENDXTER_RELEASE_API_SOURCE"),
    facilitatorSource: absoluteExisting(
      "OPENDXTER_RELEASE_FACILITATOR_SOURCE",
    ),
    attestationDigest: requiredEnv("OPENDXTER_RELEASE_ATTESTATION_SHA256"),
    explicitTag: requiredEnv("OPENDXTER_RELEASE_DIST_TAG"),
    npmTag: requiredEnv("npm_config_tag"),
  });
  process.stdout.write(
    `Coordinated publish gate passed for ${result.attestation.package.name}`
      + `@${result.attestation.package.version} on `
      + `${result.attestation.package.distTag}.\n`,
  );
  return result;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`OpenDexter publish refused: ${error.message}\n`);
    process.exitCode = 1;
  }
}
