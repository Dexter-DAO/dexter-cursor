#!/usr/bin/env node

const EXACT_VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

function fail(message) {
  throw new Error(message);
}

export function releaseChannel(version) {
  const match = String(version ?? "").match(EXACT_VERSION);
  if (!match) fail(`package version is not exact semver: ${version ?? "missing"}`);
  return match[4] ? "prerelease" : "stable";
}

export function verifyPublishPolicy({
  manifest,
  attestation,
  npmTag,
  explicitTag,
}) {
  if (!npmTag) fail("npm publish must receive an explicit --tag");
  if (!explicitTag) {
    fail("OPENDXTER_RELEASE_DIST_TAG must explicitly repeat the reviewed npm tag");
  }
  if (npmTag !== explicitTag) fail("npm --tag and OPENDXTER_RELEASE_DIST_TAG differ");
  if (attestation?.package?.name !== manifest?.name) fail("attested package name drifted");
  if (attestation?.package?.version !== manifest?.version) fail("attested package version drifted");
  if (attestation?.package?.distTag !== npmTag) fail("attested npm tag drifted");

  const actualChannel = releaseChannel(manifest.version);
  if (attestation?.package?.releaseChannel !== actualChannel) {
    fail("attested release channel does not match the version");
  }
  if (actualChannel === "prerelease" && npmTag === "latest") {
    fail("a prerelease may never publish to the stable latest tag");
  }
  if (actualChannel === "stable" && npmTag !== "latest") {
    fail("a stable release requires an explicit reviewed latest tag");
  }
  if (manifest.publishConfig?.tag && manifest.publishConfig.tag !== npmTag) {
    fail("package publishConfig tag differs from the reviewed publish tag");
  }
  return { releaseChannel: actualChannel, distTag: npmTag };
}
