#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

try {
  if (required("OPENDXTER_RELEASE_EXECUTE") !== "PUBLISH_EXACT_REVIEWED_TARBALL") {
    fail("OPENDXTER_RELEASE_EXECUTE does not carry the exact publish authorization phrase");
  }
  const tarball = realpathSync(required("OPENDXTER_RELEASE_TARBALL"));
  const tag = required("OPENDXTER_RELEASE_DIST_TAG");

  // Re-run the complete source/attestation/evidence/current-byte gate before
  // the one consequential command. The command then publishes the already
  // reviewed tarball, not a newly generated artifact.
  execFileSync(process.execPath, [resolve(scriptRoot, "verify-coordinated-release.mjs")], {
    cwd: packageRoot,
    env: { ...process.env, npm_config_tag: tag },
    stdio: "inherit",
  });
  execFileSync(
    "npm",
    ["publish", "--ignore-scripts", "--provenance", "--tag", tag, tarball],
    { cwd: packageRoot, stdio: "inherit" },
  );
} catch (error) {
  process.stderr.write(`OpenDexter exact-artifact publish refused: ${error.message}\n`);
  process.exitCode = 1;
}
