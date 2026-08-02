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
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { snapshotFileInput } from "./build-release-candidate.mjs";
import {
  attestedRuntimeIdentity,
  digestFile,
  RELEASE_REGISTRY,
  reviewedNpmPublishInvocation,
  reviewedReleaseEnvironment,
  reviewedRuntimeIdentity,
} from "./package-provenance.mjs";
import {
  disposeReviewedToolchain,
  stageReviewedToolchain,
} from "./reviewed-toolchain.mjs";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptRoot, "..");

function fail(message) {
  throw new Error(message);
}

function required(name) {
  const value = process.env[name];
  if (!value) fail(`${name} is required`);
  return value;
}

function requiredToken() {
  const token = required("OPENDXTER_RELEASE_NPM_TOKEN");
  if (
    token !== token.trim()
    || token.length < 20
    || /[\0\r\n]/.test(token)
  ) {
    fail("OPENDXTER_RELEASE_NPM_TOKEN is malformed");
  }
  return token;
}

function sameRuntime(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail("publish Node/npm identity differs from the reviewed build identity");
  }
}

export function publishExactReviewedTarball({
  tarball,
  tag,
  environment,
  toolchain,
  execute = execFileSync,
}) {
  const invocation = reviewedNpmPublishInvocation({ tarball, tag, toolchain });
  execute(invocation.command, invocation.args, {
    cwd: dirname(invocation.tarball),
    env: environment,
    stdio: "inherit",
  });
  return invocation;
}

export async function main() {
  if (required("OPENDXTER_RELEASE_EXECUTE") !== "PUBLISH_EXACT_REVIEWED_TARBALL") {
    fail("OPENDXTER_RELEASE_EXECUTE does not carry the exact publish authorization phrase");
  }
  const originalInputs = {
    attestation: realpathSync(required("OPENDXTER_RELEASE_ATTESTATION")),
    tarball: realpathSync(required("OPENDXTER_RELEASE_TARBALL")),
    review: realpathSync(required("OPENDXTER_RELEASE_REVIEW_RECEIPT")),
    novice: realpathSync(required("OPENDXTER_RELEASE_NOVICE_EVIDENCE")),
  };
  const hostedSource = realpathSync(required("OPENDXTER_RELEASE_HOSTED_SOURCE"));
  const expectedAttestationSha256 = required("OPENDXTER_RELEASE_ATTESTATION_SHA256");
  const tag = required("OPENDXTER_RELEASE_DIST_TAG");
  const token = requiredToken();
  const publishRoot = mkdtempSync(resolve(tmpdir(), "opendexter-exact-publish-"));
  let toolchain = null;
  try {
    const inputsRoot = resolve(publishRoot, "inputs");
    mkdirSync(inputsRoot);
    const attestation = snapshotFileInput(
      originalInputs.attestation,
      resolve(inputsRoot, "attestation.json"),
    );
    const tarball = snapshotFileInput(
      originalInputs.tarball,
      resolve(inputsRoot, basename(originalInputs.tarball)),
    );
    const review = snapshotFileInput(
      originalInputs.review,
      resolve(inputsRoot, "review.json"),
    );
    const novice = snapshotFileInput(
      originalInputs.novice,
      resolve(inputsRoot, "novice.json"),
    );
    if (attestation.sha256 !== expectedAttestationSha256) {
      fail("release attestation bytes do not match OPENDXTER_RELEASE_ATTESTATION_SHA256");
    }
    const attestedRuntime = attestedRuntimeIdentity(
      JSON.parse(readFileSync(attestation.path, "utf8")),
    );
    toolchain = stageReviewedToolchain({
      stageRoot: resolve(publishRoot, "reviewed-toolchain"),
    });
    const verifyHome = resolve(publishRoot, "verify-home");
    mkdirSync(verifyHome);
    const verifyEnvironment = {
      ...reviewedReleaseEnvironment({
        npmCache: resolve(publishRoot, "verify-npm-cache"),
        home: verifyHome,
        nodeBin: dirname(toolchain.command),
      }),
      OPENDXTER_RELEASE_ATTESTATION: attestation.path,
      OPENDXTER_RELEASE_TARBALL: tarball.path,
      OPENDXTER_RELEASE_REVIEW_RECEIPT: review.path,
      OPENDXTER_RELEASE_NOVICE_EVIDENCE: novice.path,
      OPENDXTER_RELEASE_HOSTED_SOURCE: hostedSource,
      OPENDXTER_RELEASE_ATTESTATION_SHA256: attestation.sha256,
      OPENDXTER_RELEASE_DIST_TAG: tag,
      npm_config_tag: tag,
    };
    sameRuntime(reviewedRuntimeIdentity({ toolchain }), attestedRuntime);
    execFileSync(
      toolchain.command,
      [resolve(scriptRoot, "verify-coordinated-release.mjs")],
      {
        cwd: packageRoot,
        env: verifyEnvironment,
        stdio: "inherit",
      },
    );
    for (const snapshot of [attestation, tarball, review, novice]) {
      if (digestFile(snapshot.path) !== snapshot.sha256) {
        fail(`${basename(snapshot.path)} changed during final verification`);
      }
    }

    const npmrc = resolve(publishRoot, "npmrc");
    writeFileSync(
      npmrc,
      `registry=${RELEASE_REGISTRY}\n//registry.npmjs.org/:_authToken=${token}\n`,
      { flag: "wx", mode: 0o600 },
    );
    const publishHome = resolve(publishRoot, "publish-home");
    mkdirSync(publishHome);
    const publishEnvironment = {
      ...reviewedReleaseEnvironment({
        npmCache: resolve(publishRoot, "publish-npm-cache"),
        home: publishHome,
        nodeBin: dirname(toolchain.command),
      }),
      npm_config_userconfig: npmrc,
      npm_config_registry: RELEASE_REGISTRY,
      npm_config_tag: tag,
      npm_config_provenance: "true",
    };
    sameRuntime(reviewedRuntimeIdentity({ toolchain }), attestedRuntime);
    const candidateSha256 = digestFile(tarball.path);
    publishExactReviewedTarball({
      tarball: tarball.path,
      tag,
      environment: publishEnvironment,
      toolchain,
    });
    if (digestFile(tarball.path) !== candidateSha256) {
      fail("exact reviewed tarball changed during npm publish");
    }
  } finally {
    disposeReviewedToolchain(toolchain);
    rmSync(publishRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`OpenDexter exact-artifact publish refused: ${error.message}\n`);
    process.exitCode = 1;
  }
}
