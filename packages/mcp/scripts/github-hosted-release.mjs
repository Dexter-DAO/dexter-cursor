#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  main as buildReviewedReleaseCandidate,
} from "./build-release-candidate.mjs";
import {
  canonicalJsonDigest,
  digestFile,
  inspectTarball,
  packageRoot,
  repositoryIdentity,
  repositoryRoot,
  sha512Integrity,
} from "./package-provenance.mjs";
import { verifyCoordinatedRelease } from "./verify-coordinated-release.mjs";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const defaultConfigPath = resolve(
  packageRoot,
  "release/github-hosted-release.json",
);
const hostedContractPath = resolve(
  repositoryRoot,
  "plugins/opendexter/skills/opendexter/references/hosted-contract.json",
);
const producerWorkflowPath =
  ".github/workflows/review-opendexter-release.yml";

function fail(message) {
  throw new Error(message);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
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
    fail(`${label} differs`);
  }
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  same(Object.keys(value).sort(), [...keys].sort(), `${label} fields`);
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${label} is required`);
  }
  return value;
}

function requireInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail(`${label} is invalid`);
  }
  return value;
}

function requireSha(value, length, label) {
  if (
    typeof value !== "string"
    || !new RegExp(`^[0-9a-f]{${length}}$`).test(value)
  ) {
    fail(`${label} is invalid`);
  }
  return value;
}

function requireDigest(value, label) {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    fail(`${label} is invalid`);
  }
  return value;
}

function requireDecimalId(value, label) {
  const text = String(value);
  if (!/^[1-9][0-9]{0,19}$/.test(text)) fail(`${label} is invalid`);
  return text;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

function git(root, args) {
  return run("/usr/bin/git", ["--no-replace-objects", "-C", root, ...args], {
    env: {
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      HOME: process.env.HOME,
      LANG: "C",
      LC_ALL: "C",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
    },
  });
}

function canonicalGithubRepository(value) {
  const text = requireString(value, "GitHub repository").trim();
  const match =
    /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(text)
    ?? /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(text)
    ?? /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(text);
  if (!match) fail("source origin is not one canonical GitHub repository");
  return `https://github.com/${match[1]}/${match[2]}`;
}

export function validateCredentialFreeGitConfigKeys(keys) {
  if (!Array.isArray(keys)) fail("local Git configuration keys are invalid");
  const forbidden = keys.find((rawKey) => {
    const key = String(rawKey).trim().toLowerCase();
    return key.startsWith("credential.")
      || key.startsWith("http.")
      || key.startsWith("url.")
      || key.startsWith("include.")
      || key.startsWith("includeif.")
      || key === "core.sshcommand"
      || /^remote\..*\.pushurl$/.test(key);
  });
  if (forbidden !== undefined) {
    fail(`source checkout retains a credential-capable Git setting: ${forbidden}`);
  }
  return keys;
}

function exactSourceIdentity(root, expectedRepository) {
  const exactRoot = realpathSync(root);
  const top = realpathSync(git(exactRoot, ["rev-parse", "--show-toplevel"]));
  if (top !== exactRoot) fail(`${expectedRepository} source is not one repository root`);
  const expectedOrigin = `https://github.com/${expectedRepository}`;
  if (
    canonicalGithubRepository(git(exactRoot, ["remote", "get-url", "origin"]))
      .toLowerCase() !== expectedOrigin.toLowerCase()
  ) {
    fail(`${expectedRepository} source origin differs`);
  }
  const status = git(exactRoot, [
    "status",
    "--porcelain=v2",
    "--untracked-files=all",
  ]);
  if (status) fail(`${expectedRepository} source is not clean`);
  const hidden = git(exactRoot, ["ls-files", "-v"])
    .split("\n")
    .filter((entry) => /^[a-zS] /.test(entry));
  if (hidden.length > 0) {
    fail(`${expectedRepository} source contains hidden index state`);
  }
  if (git(exactRoot, ["for-each-ref", "--format=%(refname)", "refs/replace"])) {
    fail(`${expectedRepository} source contains replace refs`);
  }
  validateCredentialFreeGitConfigKeys(
    git(exactRoot, ["config", "--local", "--name-only", "--list"])
      .split("\n")
      .filter(Boolean),
  );
  return {
    repository: expectedOrigin,
    commit: git(exactRoot, ["rev-parse", "HEAD^{commit}"]),
    tree: git(exactRoot, ["rev-parse", "HEAD^{tree}"]),
  };
}

function npmEnvironment(extra = {}) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: "C",
    LC_ALL: "C",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_ignore_scripts: "true",
    npm_config_userconfig: "/dev/null",
    npm_config_globalconfig: "/dev/null.opendexter-github-release",
    ...extra,
  };
}

export function validateHostedReleaseConfig(config) {
  exactKeys(config, [
    "schemaVersion",
    "kind",
    "repository",
    "package",
    "runner",
    "publisher",
    "sourceRead",
    "releaseAudit",
    "actions",
    "evidence",
  ], "hosted release config");
  if (
    config.schemaVersion !== 1
    || config.kind !== "opendexter-github-hosted-release/v1"
  ) {
    fail("hosted release config schema is unsupported");
  }
  if (config.repository !== "Dexter-DAO/opendexter-ide") {
    fail("hosted release repository is not canonical");
  }
  same(config.package, {
    name: "@dexterai/opendexter",
    root: "packages/mcp",
    distTag: "next",
    tagPrefix: "opendexter-v",
  }, "hosted package policy");
  if (config.runner.label !== "ubuntu-24.04") fail("runner label is not frozen");
  if (config.runner.containerImage !== "node:22.19.0-bookworm@sha256:"
    + "f2bf1588ef7e8dd183d9e4cb4330a0d952204b7348ead42afb1aab11f9c4911b") {
    fail("runner container is not one exact image digest");
  }
  if (config.runner.node !== "v22.19.0" || config.runner.npm !== "10.9.3") {
    fail("builder Node/npm identity is not frozen");
  }
  if (config.publisher.environment !== "opendexter-npm-production") {
    fail("publish environment is not frozen");
  }
  if (config.publisher.npm !== "11.5.1") fail("OIDC npm version is not frozen");
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(config.publisher.npmPackageIntegrity)) {
    fail("OIDC npm package integrity is invalid");
  }
  requireSha(config.publisher.npmPackageShasum, 40, "OIDC npm package shasum");
  if (config.publisher.registry !== "https://registry.npmjs.org/") {
    fail("npm registry is not canonical");
  }
  same(config.sourceRead, {
    environment: "opendexter-source-read",
    owner: "Dexter-DAO",
    repositories: ["dexter-api", "dexter-facilitator"],
    permission: "contents:read",
  }, "private source-read policy");
  same(config.releaseAudit, {
    owner: "Dexter-DAO",
    repositories: ["opendexter-ide"],
    permissions: ["actions:read", "administration:read"],
  }, "release audit policy");
  same(config.evidence, {
    environment: "opendexter-release-review",
    workflowPath: producerWorkflowPath,
    proposalArtifactNamePrefix: "opendexter-release-proposal-",
    artifactNamePrefix: "opendexter-release-evidence-",
    reviewKind: "opendexter-release-review/v1",
    requiredReviewer: { login: "dexter-skill-bot", id: 284909648 },
    reviewerMustDifferFromDispatcher: true,
  }, "evidence producer policy");
  same(config.actions, {
    checkout: "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803",
    uploadArtifact:
      "actions/upload-artifact@330a01c490aca151604b8cf639adc76d48f6c5d4",
    downloadArtifact:
      "actions/download-artifact@634f93cb2916e3fdff6788551b99b062d0335ce0",
    createGithubAppToken:
      "actions/create-github-app-token@fee1f7d63c2ff003460e3d139729b119787bc349",
  }, "GitHub action pins");
  return config;
}

function loadConfig(path = defaultConfigPath) {
  return validateHostedReleaseConfig(readJson(realpathSync(path)));
}

export function validateProtectedTagRulesets({
  config,
  repository,
  releaseTag,
  rulesets,
}) {
  if (repository !== config.repository) fail("protected-tag repository differs");
  if (!releaseTag.startsWith(config.package.tagPrefix)) {
    fail("release tag does not use the frozen package prefix");
  }
  const frozenInclude = [`refs/tags/${config.package.tagPrefix}*`];
  const accepted = [];
  for (const ruleset of rulesets ?? []) {
    if (ruleset?.target !== "tag" || ruleset?.enforcement !== "active") continue;
    const names = ruleset?.conditions?.ref_name;
    if (
      JSON.stringify(names?.include) !== JSON.stringify(frozenInclude)
      || JSON.stringify(names?.exclude) !== "[]"
      || JSON.stringify(ruleset?.bypass_actors) !== "[]"
    ) continue;
    const types = new Set((ruleset.rules ?? []).map((rule) => rule?.type));
    if (types.has("update") && types.has("deletion")) {
      accepted.push({
        id: requireInteger(ruleset.id, "tag ruleset id"),
        name: requireString(ruleset.name, "tag ruleset name"),
      });
    }
  }
  if (accepted.length === 0) {
    fail("release tag is not protected against update and deletion");
  }
  return accepted.sort((left, right) => left.id - right.id);
}

async function githubJson(path, token = process.env.GITHUB_TOKEN) {
  requireString(token, "GITHUB_TOKEN");
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "opendexter-reviewed-release",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) fail(`GitHub API returned HTTP ${response.status} for ${path}`);
  return response.json();
}

async function protectedTagRulesets(config, releaseTag) {
  const listed = await githubJson(
    `/repos/${config.repository}/rulesets?includes_parents=true&targets=tag`,
  );
  const detailed = [];
  for (const ruleset of listed) {
    if (ruleset?.target === "tag" && ruleset?.enforcement === "active") {
      detailed.push(await githubJson(
        `/repos/${config.repository}/rulesets/${ruleset.id}?includes_parents=true`,
      ));
    }
  }
  return validateProtectedTagRulesets({
    config,
    repository: config.repository,
    releaseTag,
    rulesets: detailed,
  });
}

function validateReviewEvidence(review, {
  config,
  repository,
  releaseTag,
  commit,
  tree,
  approval,
  dispatcher,
  proposalArtifact,
}) {
  exactKeys(review, [
    "schemaVersion",
    "kind",
    "decision",
    "source",
    "approval",
    "dispatcher",
    "proposalArtifact",
  ], "source review evidence");
  if (review?.kind !== config.evidence.reviewKind || review?.decision !== "accepted") {
    fail("source review evidence is not accepted");
  }
  if (review.schemaVersion !== 1) fail("source review schema is unsupported");
  same(review.source, {
    repository: `https://github.com/${repository}`,
    releaseTag,
    commit,
    tree,
  }, "source review subject");
  same(review.approval, approval, "source review approval");
  same(review.dispatcher, dispatcher, "source review dispatcher");
  same(review.proposalArtifact, proposalArtifact, "source review proposal artifact");
  return review;
}

function approvedEnvironmentReview(
  approvals,
  environment,
  dispatchers = [],
  requiredReviewer = null,
) {
  const accepted = (approvals ?? []).filter((review) =>
    String(review?.state).toLowerCase() === "approved"
    && Array.isArray(review?.environments)
    && review.environments.some((candidate) => candidate?.name === environment)
    && typeof review?.user?.login === "string"
    && review.user.login.length > 0
    && Number.isSafeInteger(review?.user?.id)
  ).map((review) => ({
    environment,
    state: "approved",
    reviewer: { login: review.user.login, id: review.user.id },
  })).filter(({ reviewer }) =>
    !dispatchers.some((dispatcher) => reviewerIsDispatcher(reviewer, dispatcher))
    && (!requiredReviewer || (
      reviewer.id === requiredReviewer.id
      && reviewer.login.toLowerCase() === requiredReviewer.login.toLowerCase()
    ))
  );
  if (accepted.length === 0) {
    fail(`workflow run lacks an independent approved ${environment} environment review`);
  }
  accepted.sort((left, right) =>
    left.reviewer.id - right.reviewer.id
      || left.reviewer.login.localeCompare(right.reviewer.login)
  );
  return accepted[0];
}

function exactActor(actor, label) {
  return {
    login: requireString(actor?.login, `${label} login`),
    id: requireInteger(actor?.id, `${label} id`),
  };
}

function reviewerIsDispatcher(reviewer, dispatcher) {
  return reviewer.id === dispatcher.id
    || reviewer.login.toLowerCase() === dispatcher.login.toLowerCase();
}

export function validateReviewEnvironmentProtection(
  environment,
  expectedName,
  expectedReviewer,
) {
  if (
    environment?.name !== expectedName
    || !Array.isArray(environment?.protection_rules)
  ) {
    fail("review environment metadata is invalid");
  }
  const required = environment.protection_rules.filter(
    (rule) => rule?.type === "required_reviewers",
  );
  if (
    required.length !== 1
    || required[0]?.prevent_self_review !== true
    || !Array.isArray(required[0]?.reviewers)
    || required[0].reviewers.length !== 1
    || required[0].reviewers[0]?.type !== "User"
    || required[0].reviewers[0]?.reviewer?.id !== expectedReviewer?.id
    || String(required[0].reviewers[0]?.reviewer?.login).toLowerCase()
      !== String(expectedReviewer?.login).toLowerCase()
  ) {
    fail("review environment does not enforce independent reviewers");
  }
  return {
    environment: expectedName,
    independentApprovalHistoryRequired: true,
    requiredReviewers: {
      id: requireInteger(required[0].id, "required-reviewers rule id"),
      preventSelfReview: true,
      reviewer: { ...expectedReviewer },
    },
  };
}

function validateReviewProposal(proposal, {
  config,
  repository,
  releaseTag,
  commit,
  tree,
  run,
  protectedRulesets,
}) {
  exactKeys(proposal, [
    "schemaVersion",
    "kind",
    "subject",
    "producer",
    "protectedRulesets",
  ], "release review proposal");
  if (
    proposal.schemaVersion !== 1
    || proposal.kind !== "opendexter-release-review-proposal/v1"
  ) {
    fail("release review proposal schema is unsupported");
  }
  same(proposal.subject, {
    repository,
    releaseTag,
    ref: `refs/tags/${releaseTag}`,
    commit,
    tree,
  }, "release review proposal subject");
  same(proposal.producer, {
    workflowPath: config.evidence.workflowPath,
    runId: String(run.id),
    runAttempt: run.run_attempt,
    event: "workflow_dispatch",
    actor: exactActor(run.actor, "workflow actor"),
    triggeringActor: exactActor(run.triggering_actor, "workflow triggering actor"),
  }, "release review proposal producer");
  same(proposal.protectedRulesets, protectedRulesets, "release review tag rulesets");
  return proposal;
}

export function validateEvidenceProducerBinding({
  config,
  repository,
  releaseTag,
  sha,
  tree,
  runId,
  artifactId,
  artifactDigest,
  run,
  artifact,
  proposalArtifact,
  approvals,
  environment,
  protectedRulesets,
  producerReceipt,
  reviewEvidence,
  proposal,
}) {
  validateHostedReleaseConfig(config);
  requireSha(sha, 40, "evidence subject commit");
  requireSha(tree, 40, "evidence subject tree");
  const exactRunId = requireDecimalId(runId, "evidence run id");
  const exactArtifactId = requireDecimalId(artifactId, "evidence artifact id");
  requireDigest(artifactDigest, "evidence artifact digest");
  if (repository !== config.repository) fail("evidence repository differs");
  const ref = `refs/tags/${releaseTag}`;
  if (
    String(run?.id) !== exactRunId
    || run?.event !== "workflow_dispatch"
    || run?.status !== "completed"
    || run?.conclusion !== "success"
    || run?.head_sha !== sha
    || run?.head_branch !== releaseTag
    || run?.repository?.full_name !== repository
    || String(run?.path ?? "").split("@")[0] !== config.evidence.workflowPath
    || !Number.isSafeInteger(run?.run_attempt)
    || run.run_attempt <= 0
  ) {
    fail("evidence producer workflow run differs");
  }
  const expectedArtifactName = `${config.evidence.artifactNamePrefix}${sha}`;
  if (
    String(artifact?.id) !== exactArtifactId
    || artifact?.name !== expectedArtifactName
    || artifact?.digest !== artifactDigest
    || artifact?.expired !== false
    || String(artifact?.workflow_run?.id) !== exactRunId
    || artifact?.workflow_run?.head_sha !== sha
  ) {
    fail("evidence artifact service metadata differs");
  }
  const dispatcher = {
    actor: exactActor(run.actor, "workflow actor"),
    triggeringActor: exactActor(run.triggering_actor, "workflow triggering actor"),
  };
  const approval = approvedEnvironmentReview(
    approvals,
    config.evidence.environment,
    [dispatcher.actor, dispatcher.triggeringActor],
    config.evidence.requiredReviewer,
  );
  const environmentProtection = validateReviewEnvironmentProtection(
    environment,
    config.evidence.environment,
    config.evidence.requiredReviewer,
  );
  exactKeys(producerReceipt, [
    "schemaVersion",
    "kind",
    "subject",
    "producer",
    "approval",
    "environmentProtection",
    "proposalArtifact",
    "files",
  ], "evidence producer receipt");
  if (
    producerReceipt.schemaVersion !== 1
    || producerReceipt.kind !== "opendexter-github-evidence-producer/v1"
  ) {
    fail("evidence producer receipt schema is unsupported");
  }
  exactKeys(producerReceipt.subject, [
    "repository", "releaseTag", "ref", "commit", "tree",
  ], "evidence producer subject");
  exactKeys(producerReceipt.producer, [
    "workflowPath",
    "runId",
    "runAttempt",
    "event",
    "actor",
    "triggeringActor",
  ], "evidence producer identity");
  exactKeys(producerReceipt.files, ["reviewSha256"], "evidence producer files");
  exactKeys(producerReceipt.proposalArtifact, [
    "id", "name", "digest", "proposalSha256",
  ], "evidence proposal artifact binding");
  same(producerReceipt.subject, {
    repository,
    releaseTag,
    ref,
    commit: sha,
    tree,
  }, "evidence producer subject");
  same(producerReceipt.producer, {
    workflowPath: config.evidence.workflowPath,
    runId: exactRunId,
    runAttempt: run.run_attempt,
    event: "workflow_dispatch",
    ...dispatcher,
  }, "evidence producer identity");
  same(producerReceipt.approval, approval, "evidence protected approval");
  same(
    producerReceipt.environmentProtection,
    environmentProtection,
    "evidence environment protection",
  );
  const expectedProposalName = `${config.evidence.proposalArtifactNamePrefix}${sha}`;
  const proposalBinding = producerReceipt.proposalArtifact;
  const proposalId = requireDecimalId(
    proposalBinding?.id,
    "proposal artifact id",
  );
  const proposalDigest = requireDigest(
    proposalBinding?.digest,
    "proposal artifact digest",
  );
  requireSha(proposalBinding?.proposalSha256, 64, "proposal evidence digest");
  if (
    proposalBinding?.name !== expectedProposalName
    || String(proposalArtifact?.id) !== proposalId
    || proposalArtifact?.name !== expectedProposalName
    || proposalArtifact?.digest !== proposalDigest
    || proposalArtifact?.expired !== false
    || String(proposalArtifact?.workflow_run?.id) !== exactRunId
    || proposalArtifact?.workflow_run?.head_sha !== sha
    || canonicalJsonDigest(proposal) !== proposalBinding.proposalSha256
  ) {
    fail("proposal artifact service metadata differs");
  }
  validateReviewProposal(proposal, {
    config,
    repository,
    releaseTag,
    commit: sha,
    tree,
    run,
    protectedRulesets,
  });
  requireSha(producerReceipt?.files?.reviewSha256, 64, "review evidence digest");
  if (producerReceipt.files.reviewSha256 !== canonicalJsonDigest(reviewEvidence)) {
    fail("producer receipt review evidence digest differs");
  }
  validateReviewEvidence(reviewEvidence, {
    config,
    repository,
    releaseTag,
    commit: sha,
    tree,
    approval,
    dispatcher,
    proposalArtifact: proposalBinding,
  });
  return {
    schemaVersion: 1,
    kind: "opendexter-github-evidence-binding/v1",
    producer: {
      repository,
      workflowPath: config.evidence.workflowPath,
      runId: exactRunId,
      runAttempt: run.run_attempt,
      headSha: sha,
      tree,
      releaseTag,
    },
    artifact: {
      id: exactArtifactId,
      name: expectedArtifactName,
      digest: artifactDigest,
    },
    approval,
    environmentProtection,
    proposalArtifact: { ...proposalBinding },
    files: { ...producerReceipt.files },
  };
}

function validateReleaseSubject({
  config,
  repository,
  ref,
  refType,
  refName,
  releaseTag,
  sha,
  commit,
  tree,
  containerImage,
  packageManifest,
}) {
  validateHostedReleaseConfig(config);
  if (repository !== config.repository) fail("workflow repository is not canonical");
  if (refType !== "tag") fail("release workflow was not dispatched from a tag");
  const expectedTag = `${config.package.tagPrefix}${packageManifest?.version ?? ""}`;
  if (releaseTag !== expectedTag || refName !== expectedTag) {
    fail("release tag does not exactly match the package version");
  }
  if (ref !== `refs/tags/${expectedTag}`) fail("workflow ref is not the exact release tag");
  requireSha(sha, 40, "GITHUB_SHA");
  if (sha !== commit) fail("checked-out commit differs from GITHUB_SHA");
  requireSha(tree, 40, "checked-out tree");
  if (containerImage !== config.runner.containerImage) {
    fail("workflow container image differs from the reviewed digest");
  }
  if (packageManifest?.name !== config.package.name) fail("package name drifted");
  if (packageManifest?.publishConfig?.tag !== config.package.distTag) {
    fail("package dist-tag drifted");
  }
  return {
    repository,
    ref,
    refType,
    refName,
    releaseTag,
    commit,
    tree,
    containerImage,
    package: {
      name: packageManifest.name,
      version: packageManifest.version,
      distTag: config.package.distTag,
    },
  };
}

export function validateReleaseInvocation(input) {
  const subject = validateReleaseSubject(input);
  const { evidenceBinding } = input;
  if (
    evidenceBinding?.kind !== "opendexter-github-evidence-binding/v1"
    || evidenceBinding?.producer?.repository !== subject.repository
    || evidenceBinding?.producer?.headSha !== subject.commit
    || evidenceBinding?.producer?.tree !== subject.tree
    || evidenceBinding?.producer?.releaseTag !== subject.releaseTag
  ) {
    fail("immutable evidence binding differs from the tagged source");
  }
  return {
    schemaVersion: 1,
    kind: "opendexter-github-release-context/v1",
    ...subject,
    evidence: evidenceBinding,
  };
}

function sourceContractDescriptor(mcpRoot) {
  const descriptorPath = resolve(mcpRoot, "release/open-tool-descriptors.json");
  const descriptor = readJson(descriptorPath);
  if (
    descriptor?.sourceContracts?.schemaVersion !== 3
    || descriptor?.sourceContracts?.kind !== "opendexter-source-contracts/v3"
  ) {
    fail("hosted descriptor lacks a supported complete source contract");
  }
  return { descriptor, descriptorPath, contracts: descriptor.sourceContracts };
}

function verifyFixture(root, path, expectedSha256, label) {
  const exactRoot = realpathSync(root);
  const exactPath = realpathSync(resolve(exactRoot, path));
  if (!exactPath.startsWith(`${exactRoot}/`)) fail(`${label} path escapes source`);
  if (digestFile(exactPath) !== expectedSha256) fail(`${label} bytes differ`);
  return exactPath;
}

function verifyCanonicalJsonFixture(root, fixture, label) {
  const path = verifyFixture(root, fixture.path, fixture.sha256, label);
  if (canonicalJsonDigest(readJson(path)) !== fixture.canonicalDigest) {
    fail(`${label} canonical digest differs`);
  }
}

export function validateSourceReceipt({ receipt, context }) {
  if (
    receipt?.schemaVersion !== 1
    || receipt?.kind !== "opendexter-hosted-source-receipt/v1"
  ) {
    fail("hosted source receipt schema is unsupported");
  }
  same(receipt.subject, {
    commit: context.commit,
    tree: context.tree,
  }, "hosted source receipt subject");
  for (const [label, source] of [
    ["MCP", receipt.mcp],
    ["API", receipt.api],
    ["facilitator", receipt.facilitator],
  ]) {
    requireString(source?.repository, `${label} source repository`);
    requireSha(source?.commit, 40, `${label} source commit`);
    requireSha(source?.tree, 40, `${label} source tree`);
  }
  requireSha(receipt?.governedApi?.commit, 40, "governed API commit");
  requireSha(receipt?.governedApi?.tree, 40, "governed API tree");
  requireSha(receipt?.descriptorSha256, 64, "descriptor SHA-256");
  requireSha(receipt?.descriptorDigest, 64, "descriptor digest");
  requireSha(receipt?.contractsDigest, 64, "source contracts digest");
  return receipt;
}

export function validateSourceContracts({
  context,
  mcpRoot,
  apiRoot,
  facilitatorRoot,
}) {
  const mcp = exactSourceIdentity(mcpRoot, "Dexter-DAO/dexter-mcp");
  const api = exactSourceIdentity(apiRoot, "Dexter-DAO/dexter-api");
  const facilitator = exactSourceIdentity(
    facilitatorRoot,
    "Dexter-DAO/dexter-facilitator",
  );
  const { descriptor, descriptorPath, contracts } = sourceContractDescriptor(mcpRoot);
  if (
    contracts.mcp.repository !== mcp.repository
    || contracts.mcp.toolContractPath !== "lib/open-tool-contracts.mjs"
    || contracts.mcp.authContractPath !== "lib/open-tool-auth.mjs"
  ) {
    fail("MCP contract source identity differs from its descriptor");
  }
  const mcpContractCommit = requireSha(
    contracts.mcp.commit,
    40,
    "MCP contract commit",
  );
  git(mcpRoot, ["cat-file", "-e", `${mcpContractCommit}^{commit}`]);
  if (git(mcpRoot, ["rev-parse", `${mcpContractCommit}^{tree}`]) !== contracts.mcp.tree) {
    fail("MCP contract source tree differs");
  }
  try {
    git(mcpRoot, ["merge-base", "--is-ancestor", mcpContractCommit, mcp.commit]);
  } catch {
    fail("final MCP source does not contain the accepted contract source");
  }
  const mcpContractDrift = git(mcpRoot, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--name-only",
    mcpContractCommit,
    mcp.commit,
    "--",
    contracts.mcp.toolContractPath,
    contracts.mcp.authContractPath,
  ]);
  if (mcpContractDrift) {
    fail("final MCP source changes the accepted tool/auth contract bytes");
  }
  if (
    contracts.integratedApiRelease.repository !== api.repository
    || contracts.integratedApiRelease.commit !== api.commit
    || contracts.integratedApiRelease.tree !== api.tree
  ) {
    fail("API release identity differs from its descriptor");
  }
  if (
    contracts.facilitator.repository !== facilitator.repository
    || contracts.facilitator.commit !== facilitator.commit
    || contracts.facilitator.tree !== facilitator.tree
  ) {
    fail("facilitator identity differs from its descriptor");
  }
  const governedCommit = requireSha(
    contracts.api.commit,
    40,
    "governed API source commit",
  );
  git(apiRoot, ["cat-file", "-e", `${governedCommit}^{commit}`]);
  const governedTree = git(apiRoot, ["rev-parse", `${governedCommit}^{tree}`]);
  if (governedTree !== contracts.api.tree) fail("governed API source tree differs");
  try {
    git(apiRoot, ["merge-base", "--is-ancestor", governedCommit, api.commit]);
  } catch {
    fail("integrated API release does not contain the accepted governed source");
  }
  const governedConsumerFixturePath = verifyFixture(
    mcpRoot,
    contracts.api.consumerFixture.path,
    contracts.api.consumerFixture.sha256,
    "MCP governed API consumer fixture",
  );
  const governedConsumerFixture = readJson(governedConsumerFixturePath);
  const {
    digest: governedConsumerDeclaredDigest,
    ...governedConsumerUnsignedBody
  } = governedConsumerFixture.body ?? {};
  if (
    governedConsumerFixture.sourceRepository !== "Dexter-DAO/dexter-api"
    || governedConsumerFixture.sourceCommit !== governedCommit
    || canonicalJsonDigest(governedConsumerUnsignedBody)
      !== contracts.api.consumerFixture.canonicalBodyDigest
    || governedConsumerDeclaredDigest
      !== contracts.api.consumerFixture.canonicalBodyDigest
  ) {
    fail("MCP governed API consumer fixture source/body binding differs");
  }
  verifyFixture(
    mcpRoot,
    contracts.facilitator.bindingFixture.consumerPath,
    contracts.facilitator.bindingFixture.sha256,
    "MCP facilitator fixture",
  );
  verifyFixture(
    apiRoot,
    contracts.facilitator.bindingFixture.apiPath,
    contracts.facilitator.bindingFixture.sha256,
    "API facilitator fixture",
  );
  verifyFixture(
    facilitatorRoot,
    contracts.facilitator.bindingFixture.facilitatorPath,
    contracts.facilitator.bindingFixture.sha256,
    "facilitator binding fixture",
  );
  if (contracts.schemaVersion === 3) {
    const projection = contracts.portfolioProjection;
    if (
      projection?.repository !== api.repository
      || projection?.commit !== api.commit
      || projection?.tree !== api.tree
      || projection?.fixture?.consumerPath
        !== "tests/fixtures/opendexter-portfolio-v1-zero-holding-approved-action-targets.json"
      || projection?.fixture?.apiPath
        !== "tests/fixtures/opendexter-portfolio-v1-zero-holding-approved-action-targets.json"
    ) {
      fail("portfolio projection source contract differs");
    }
    same(projection.sourcePaths, [
      "src/portfolio/approvedActionTargets.ts",
      "src/routes/passkeyMcpBinding.ts",
      "src/routes/defaultGovernedDelegatedAssetActions.ts",
    ], "portfolio projection source paths");
    for (const relativePath of projection.sourcePaths) {
      const sourcePath = realpathSync(resolve(apiRoot, relativePath));
      if (!sourcePath.startsWith(`${realpathSync(apiRoot)}/`)) {
        fail("portfolio projection source path escapes API source");
      }
    }
    verifyCanonicalJsonFixture(
      mcpRoot,
      {
        path: projection.fixture.consumerPath,
        sha256: projection.fixture.sha256,
        canonicalDigest: projection.fixture.canonicalDigest,
      },
      "MCP portfolio projection fixture",
    );
    verifyCanonicalJsonFixture(
      apiRoot,
      {
        path: projection.fixture.apiPath,
        sha256: projection.fixture.sha256,
        canonicalDigest: projection.fixture.canonicalDigest,
      },
      "API portfolio projection fixture",
    );
  }
  const hostedContract = readJson(hostedContractPath);
  if (
    hostedContract?.source?.commit !== mcp.commit
    || hostedContract?.source?.tree !== mcp.tree
  ) {
    fail("IDE hosted contract does not bind the exact MCP source");
  }
  return validateSourceReceipt({
    context,
    receipt: {
      schemaVersion: 1,
      kind: "opendexter-hosted-source-receipt/v1",
      subject: { commit: context.commit, tree: context.tree },
      descriptorSha256: digestFile(descriptorPath),
      descriptorDigest: canonicalJsonDigest(descriptor),
      mcp,
      api,
      facilitator,
      governedApi: { commit: governedCommit, tree: governedTree },
      contractsDigest: canonicalJsonDigest(contracts),
    },
  });
}

export function createArtifactHandoff({
  repository,
  runId,
  artifactId,
  artifactDigest,
  artifactName,
  headSha,
  receiptSha256,
}) {
  requireString(repository, "artifact handoff repository");
  requireSha(headSha, 40, "artifact handoff head SHA");
  requireSha(receiptSha256, 64, "artifact handoff receipt digest");
  return {
    schemaVersion: 1,
    kind: "opendexter-github-artifact-handoff/v1",
    repository,
    runId: requireDecimalId(runId, "artifact handoff run id"),
    artifactId: requireDecimalId(artifactId, "artifact handoff artifact id"),
    artifactDigest: requireDigest(
      artifactDigest,
      "artifact handoff service digest",
    ),
    artifactName: requireString(artifactName, "artifact handoff name"),
    headSha,
    receiptSha256,
  };
}

export function createArtifactReceipt({
  phase,
  context,
  sourceReceipt,
  runtime,
  lockSha256,
  inspected,
}) {
  if (!['candidate', 'rebuild'].includes(phase)) fail("artifact phase is invalid");
  validateSourceReceipt({ receipt: sourceReceipt, context });
  if (runtime?.node !== "v22.19.0" || runtime?.npm !== "10.9.3") {
    fail("artifact runtime differs from the reviewed builder");
  }
  return {
    schemaVersion: 1,
    kind: "opendexter-github-artifact-receipt/v1",
    phase,
    context,
    sourceReceipt,
    runtime,
    rootLockSha256: requireSha(lockSha256, 64, "root lock digest"),
    artifact: inspected.artifact,
    inventory: inspected.inventory,
    inventoryDigest: canonicalJsonDigest(inspected.inventory),
  };
}

function validateGenericArtifactReceipt(receipt, phase, context, artifactPath) {
  if (
    receipt?.schemaVersion !== 1
    || receipt?.kind !== "opendexter-github-artifact-receipt/v1"
    || receipt?.phase !== phase
  ) {
    fail("artifact receipt is unsupported");
  }
  same(receipt.context, context, "artifact context");
  validateSourceReceipt({ receipt: receipt.sourceReceipt, context });
  requireSha(receipt.rootLockSha256, 64, "artifact root lock digest");
  if (canonicalJsonDigest(receipt.inventory) !== receipt.inventoryDigest) {
    fail("artifact inventory digest is inconsistent");
  }
  if (artifactPath) {
    const inspected = inspectTarball(artifactPath);
    same(inspected.artifact, receipt.artifact, "artifact identity");
    same(inspected.inventory, receipt.inventory, "artifact inventory");
  }
  return receipt;
}

export function validateArtifactHandoff(input, expected) {
  if (input?.receipt) {
    validateGenericArtifactReceipt(
      input.receipt,
      input.phase,
      input.context,
      input.artifactPath,
    );
    const handoff = {
      runId: requireDecimalId(input?.handoff?.runId, "artifact handoff run id"),
      artifactId: requireDecimalId(
        input?.handoff?.artifactId,
        "artifact handoff artifact id",
      ),
      artifactDigest: requireDigest(
        input?.handoff?.artifactDigest,
        "artifact handoff digest",
      ),
    };
    same(handoff, input.expectedHandoff, "artifact handoff");
    return { receipt: input.receipt, handoff };
  }
  const handoff = input;
  if (
    handoff?.schemaVersion !== 1
    || handoff?.kind !== "opendexter-github-artifact-handoff/v1"
  ) {
    fail("artifact handoff schema is unsupported");
  }
  same(handoff, createArtifactHandoff(expected), "artifact handoff");
  return handoff;
}

export function verifyIndependentRebuild({ candidate, rebuild }) {
  validateGenericArtifactReceipt(
    candidate,
    "candidate",
    candidate?.context,
    null,
  );
  validateGenericArtifactReceipt(
    rebuild,
    "rebuild",
    candidate.context,
    null,
  );
  same(candidate.sourceReceipt, rebuild.sourceReceipt, "candidate/rebuild sources");
  same(candidate.runtime, rebuild.runtime, "candidate/rebuild runtime");
  if (candidate.rootLockSha256 !== rebuild.rootLockSha256) {
    fail("candidate/rebuild root lock differs");
  }
  same(candidate.artifact, rebuild.artifact, "candidate/rebuild artifact");
  same(candidate.inventory, rebuild.inventory, "candidate/rebuild inventory");
  if (candidate.inventoryDigest !== rebuild.inventoryDigest) {
    fail("candidate/rebuild inventory digest differs");
  }
  return {
    schemaVersion: 1,
    kind: "opendexter-github-rebuild-acceptance/v1",
    context: candidate.context,
    sourceReceipt: candidate.sourceReceipt,
    runtime: candidate.runtime,
    rootLockSha256: candidate.rootLockSha256,
    artifact: candidate.artifact,
    inventory: candidate.inventory,
    inventoryDigest: candidate.inventoryDigest,
    candidateReceiptSha256: canonicalJsonDigest(candidate),
    rebuildReceiptSha256: canonicalJsonDigest(rebuild),
  };
}

function validateCandidateReceipt({
  receipt,
  context,
  sourceReceipt,
  artifactPath,
  attestationPath,
}) {
  if (
    receipt?.schemaVersion !== 1
    || receipt?.kind !== "opendexter-github-candidate-receipt/v1"
  ) {
    fail("candidate receipt schema is unsupported");
  }
  same(receipt.context, context, "candidate context");
  same(receipt.sourceReceipt, sourceReceipt, "candidate source receipt");
  validateSourceReceipt({ receipt: receipt.sourceReceipt, context });
  const inspected = inspectTarball(artifactPath);
  const attestation = readJson(attestationPath);
  same(inspected.artifact, receipt.artifact, "candidate artifact identity");
  same(inspected.inventory, attestation.inventory, "candidate inventory");
  same(inspected.artifact, attestation.artifact, "candidate attested artifact");
  if (digestFile(attestationPath) !== receipt.attestationSha256) {
    fail("candidate attestation bytes differ");
  }
  if (canonicalJsonDigest(inspected.inventory) !== receipt.inventoryDigest) {
    fail("candidate inventory digest differs");
  }
  return { receipt, inspected, attestation };
}

export function verifyRegistryReconciliation({ acceptance, metadata, packument }) {
  if (metadata?.name !== acceptance?.context?.package?.name) {
    fail("registry package name differs");
  }
  if (metadata?.version !== acceptance?.context?.package?.version) {
    fail("registry package version differs");
  }
  if (metadata?.dist?.integrity !== acceptance?.artifact?.integrity) {
    fail("registry integrity differs from the accepted artifact");
  }
  if (metadata?.dist?.shasum !== acceptance?.artifact?.shasum) {
    fail("registry shasum differs from the accepted artifact");
  }
  const distTag = acceptance?.context?.package?.distTag;
  if (
    packument?.name !== acceptance.context.package.name
    || packument?.["dist-tags"]?.[distTag] !== acceptance.context.package.version
  ) {
    fail("registry dist-tag does not resolve to the accepted version");
  }
  return {
    schemaVersion: 1,
    kind: "opendexter-registry-reconciliation/v1",
    package: {
      name: metadata.name,
      version: metadata.version,
      integrity: metadata.dist.integrity,
      shasum: metadata.dist.shasum,
      distTag,
    },
    acceptedArtifactSha256: acceptance.artifact.sha256,
  };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const values = {};
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    if (!key.startsWith("--")) fail(`unexpected argument: ${key}`);
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) fail(`${key} requires a value`);
    values[key.slice(2)] = value;
    index += 1;
  }
  return { command, values };
}

function absolute(values, key) {
  const value = requireString(values[key], `--${key}`);
  if (!isAbsolute(value)) fail(`--${key} must be absolute`);
  return realpathSync(value);
}

function outputPath(values, key) {
  const value = requireString(values[key], `--${key}`);
  if (!isAbsolute(value)) fail(`--${key} must be absolute`);
  return value;
}

function githubOutput(values, entries) {
  if (!values["github-output"]) return;
  const output = values["github-output"];
  if (!isAbsolute(output)) fail("--github-output must be absolute");
  const lines = Object.entries(entries).map(([key, value]) => `${key}=${value}`);
  writeFileSync(output, `${lines.join("\n")}\n`, { flag: "a" });
}

function exactEvidenceRoot(root) {
  const entries = readdirSync(root).sort();
  same(
    entries,
    ["producer-receipt.json", "proposal.json", "review.json"],
    "release evidence files",
  );
  for (const name of entries) {
    const info = lstatSync(resolve(root, name));
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      fail(`release evidence is not one regular file: ${name}`);
    }
  }
  return {
    reviewPath: resolve(root, "review.json"),
    proposalPath: resolve(root, "proposal.json"),
    producerPath: resolve(root, "producer-receipt.json"),
    review: readJson(resolve(root, "review.json")),
    proposal: readJson(resolve(root, "proposal.json")),
    producer: readJson(resolve(root, "producer-receipt.json")),
  };
}

function exactProposalRoot(root) {
  same(readdirSync(root).sort(), ["proposal.json"], "release proposal files");
  const path = resolve(root, "proposal.json");
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    fail("release proposal is not one regular file");
  }
  return { path, proposal: readJson(path) };
}

function validateEvidenceWorkflowRun(run, {
  config,
  runId,
  releaseTag,
  commit,
  requireCompleted = false,
}) {
  if (
    String(run?.id) !== runId
    || run?.event !== "workflow_dispatch"
    || run?.head_sha !== commit
    || run?.head_branch !== releaseTag
    || run?.repository?.full_name !== config.repository
    || String(run?.path ?? "").split("@")[0] !== config.evidence.workflowPath
    || !Number.isSafeInteger(run?.run_attempt)
    || run.run_attempt <= 0
    || (requireCompleted && (
      run?.status !== "completed" || run?.conclusion !== "success"
    ))
  ) {
    fail("evidence producer workflow run differs");
  }
  exactActor(run.actor, "workflow actor");
  exactActor(run.triggering_actor, "workflow triggering actor");
  return run;
}

async function exactReleaseSubjectFromWorkflow(values) {
  const config = loadConfig(values.config ?? defaultConfigPath);
  const identity = repositoryIdentity(repositoryRoot, { requireClean: true });
  const manifest = readJson(resolve(packageRoot, "package.json"));
  const releaseTag = requireString(values["release-tag"], "--release-tag");
  validateReleaseSubject({
    config,
    repository: process.env.GITHUB_REPOSITORY,
    ref: process.env.GITHUB_REF,
    refType: process.env.GITHUB_REF_TYPE,
    refName: process.env.GITHUB_REF_NAME,
    releaseTag,
    sha: process.env.GITHUB_SHA,
    commit: identity.commit,
    tree: identity.tree,
    containerImage: process.env.OPENDXTER_RELEASE_CONTAINER_IMAGE,
    packageManifest: manifest,
  });
  const runId = requireDecimalId(process.env.GITHUB_RUN_ID, "GITHUB_RUN_ID");
  const run = validateEvidenceWorkflowRun(
    await githubJson(`/repos/${config.repository}/actions/runs/${runId}`),
    {
      config,
      runId,
      releaseTag,
      commit: identity.commit,
    },
  );
  return { config, identity, releaseTag, runId, run };
}

async function commandPrepareReview(values) {
  const { config, identity, releaseTag, runId, run } =
    await exactReleaseSubjectFromWorkflow(values);
  const protectedRulesets = await protectedTagRulesets(config, releaseTag);
  const output = outputPath(values, "output");
  if (existsSync(output)) fail("proposal output already exists");
  mkdirSync(output);
  const proposal = {
    schemaVersion: 1,
    kind: "opendexter-release-review-proposal/v1",
    subject: {
      repository: config.repository,
      releaseTag,
      ref: `refs/tags/${releaseTag}`,
      commit: identity.commit,
      tree: identity.tree,
    },
    producer: {
      workflowPath: config.evidence.workflowPath,
      runId,
      runAttempt: run.run_attempt,
      event: "workflow_dispatch",
      actor: exactActor(run.actor, "workflow actor"),
      triggeringActor: exactActor(
        run.triggering_actor,
        "workflow triggering actor",
      ),
    },
    protectedRulesets,
  };
  writeJson(resolve(output, "proposal.json"), proposal);
  githubOutput(values, {
    proposal_name: `${config.evidence.proposalArtifactNamePrefix}${identity.commit}`,
  });
  return proposal;
}

async function commandApproveReview(values) {
  const { config, identity, releaseTag, runId, run } =
    await exactReleaseSubjectFromWorkflow(values);
  const proposalRoot = exactProposalRoot(absolute(values, "proposal"));
  const proposalArtifactId = requireDecimalId(
    values["proposal-artifact-id"],
    "--proposal-artifact-id",
  );
  const proposalArtifactDigest = requireDigest(
    values["proposal-artifact-digest"],
    "--proposal-artifact-digest",
  );
  const [proposalArtifact, approvals, environment, protectedRulesets] =
    await Promise.all([
      githubJson(`/repos/${config.repository}/actions/artifacts/${proposalArtifactId}`),
      githubJson(`/repos/${config.repository}/actions/runs/${runId}/approvals`),
      githubJson(`/repos/${config.repository}/environments/${encodeURIComponent(config.evidence.environment)}`),
      protectedTagRulesets(config, releaseTag),
    ]);
  const proposalName = `${config.evidence.proposalArtifactNamePrefix}${identity.commit}`;
  if (
    String(proposalArtifact?.id) !== proposalArtifactId
    || proposalArtifact?.name !== proposalName
    || proposalArtifact?.digest !== proposalArtifactDigest
    || proposalArtifact?.expired !== false
    || String(proposalArtifact?.workflow_run?.id) !== runId
    || proposalArtifact?.workflow_run?.head_sha !== identity.commit
  ) {
    fail("proposal artifact service metadata differs");
  }
  validateReviewProposal(proposalRoot.proposal, {
    config,
    repository: config.repository,
    releaseTag,
    commit: identity.commit,
    tree: identity.tree,
    run,
    protectedRulesets,
  });
  const dispatcher = {
    actor: exactActor(run.actor, "workflow actor"),
    triggeringActor: exactActor(run.triggering_actor, "workflow triggering actor"),
  };
  const approval = approvedEnvironmentReview(
    approvals,
    config.evidence.environment,
    [dispatcher.actor, dispatcher.triggeringActor],
    config.evidence.requiredReviewer,
  );
  const environmentProtection = validateReviewEnvironmentProtection(
    environment,
    config.evidence.environment,
    config.evidence.requiredReviewer,
  );
  const proposalBinding = {
    id: proposalArtifactId,
    name: proposalName,
    digest: proposalArtifactDigest,
    proposalSha256: canonicalJsonDigest(proposalRoot.proposal),
  };
  const review = {
    schemaVersion: 1,
    kind: config.evidence.reviewKind,
    decision: "accepted",
    source: {
      repository: `https://github.com/${config.repository}`,
      releaseTag,
      commit: identity.commit,
      tree: identity.tree,
    },
    approval,
    dispatcher,
    proposalArtifact: proposalBinding,
  };
  const producerReceipt = {
    schemaVersion: 1,
    kind: "opendexter-github-evidence-producer/v1",
    subject: proposalRoot.proposal.subject,
    producer: {
      workflowPath: config.evidence.workflowPath,
      runId,
      runAttempt: run.run_attempt,
      event: "workflow_dispatch",
      ...dispatcher,
    },
    approval,
    environmentProtection,
    proposalArtifact: proposalBinding,
    files: { reviewSha256: canonicalJsonDigest(review) },
  };
  const output = outputPath(values, "output");
  if (existsSync(output)) fail("evidence output already exists");
  mkdirSync(output);
  writeJson(resolve(output, "proposal.json"), proposalRoot.proposal);
  writeJson(resolve(output, "review.json"), review);
  writeJson(resolve(output, "producer-receipt.json"), producerReceipt);
  githubOutput(values, {
    evidence_name: `${config.evidence.artifactNamePrefix}${identity.commit}`,
  });
  return producerReceipt;
}

async function fetchEvidenceServiceMetadata(
  config,
  runId,
  artifactId,
  proposalArtifactId,
) {
  const [run, artifact, proposalArtifact, approvals, environment] = await Promise.all([
    githubJson(`/repos/${config.repository}/actions/runs/${runId}`),
    githubJson(`/repos/${config.repository}/actions/artifacts/${artifactId}`),
    githubJson(`/repos/${config.repository}/actions/artifacts/${proposalArtifactId}`),
    githubJson(`/repos/${config.repository}/actions/runs/${runId}/approvals`),
    githubJson(`/repos/${config.repository}/environments/${encodeURIComponent(config.evidence.environment)}`),
  ]);
  return { run, artifact, proposalArtifact, approvals, environment };
}

async function commandEvidence(values) {
  const config = loadConfig(values.config ?? defaultConfigPath);
  const evidence = exactEvidenceRoot(absolute(values, "evidence"));
  const runId = requireDecimalId(values["run-id"], "--run-id");
  const artifactId = requireDecimalId(values["artifact-id"], "--artifact-id");
  const artifactDigest = requireDigest(
    values["artifact-digest"],
    "--artifact-digest",
  );
  const sha = requireSha(process.env.GITHUB_SHA, 40, "GITHUB_SHA");
  const tree = git(repositoryRoot, ["rev-parse", "HEAD^{tree}"]);
  const releaseTag = requireString(values["release-tag"], "--release-tag");
  const proposalArtifactId = requireDecimalId(
    evidence.producer?.proposalArtifact?.id,
    "proposal artifact id",
  );
  const service = await fetchEvidenceServiceMetadata(
    config,
    runId,
    artifactId,
    proposalArtifactId,
  );
  if (canonicalJsonDigest(evidence.review) !== evidence.producer?.files?.reviewSha256) {
    fail("downloaded review evidence digest differs");
  }
  const protectedRulesets = await protectedTagRulesets(config, releaseTag);
  const binding = validateEvidenceProducerBinding({
    config,
    repository: process.env.GITHUB_REPOSITORY,
    releaseTag,
    sha,
    tree,
    runId,
    artifactId,
    artifactDigest,
    ...service,
    producerReceipt: evidence.producer,
    reviewEvidence: evidence.review,
    proposal: evidence.proposal,
    protectedRulesets,
  });
  binding.protectedRulesets = protectedRulesets;
  writeJson(outputPath(values, "output"), binding);
  return binding;
}

function commandContext(values) {
  const config = loadConfig(values.config ?? defaultConfigPath);
  const manifest = readJson(resolve(packageRoot, "package.json"));
  const identity = repositoryIdentity(repositoryRoot, { requireClean: true });
  const evidenceBinding = readJson(absolute(values, "evidence-binding"));
  const context = validateReleaseInvocation({
    config,
    repository: process.env.GITHUB_REPOSITORY,
    ref: process.env.GITHUB_REF,
    refType: process.env.GITHUB_REF_TYPE,
    refName: process.env.GITHUB_REF_NAME,
    releaseTag: values["release-tag"],
    sha: process.env.GITHUB_SHA,
    commit: identity.commit,
    tree: identity.tree,
    containerImage: process.env.OPENDXTER_RELEASE_CONTAINER_IMAGE,
    packageManifest: manifest,
    evidenceBinding,
  });
  writeJson(outputPath(values, "output"), context);
  const hosted = readJson(hostedContractPath);
  githubOutput(values, {
    mcp_repository: hosted.source.repository,
    mcp_commit: hosted.source.commit,
    mcp_tree: hosted.source.tree,
  });
  return context;
}

function commandSources(values) {
  const context = readJson(absolute(values, "context"));
  const mcpRoot = absolute(values, "mcp-root");
  const { contracts } = sourceContractDescriptor(mcpRoot);
  if (values.mode === "plan") {
    githubOutput(values, {
      api_repository: contracts.integratedApiRelease.repository,
      api_commit: contracts.integratedApiRelease.commit,
      api_tree: contracts.integratedApiRelease.tree,
      facilitator_repository: contracts.facilitator.repository,
      facilitator_commit: contracts.facilitator.commit,
      facilitator_tree: contracts.facilitator.tree,
    });
    return contracts;
  }
  if (values.mode !== "verify") fail("--mode must be plan or verify");
  const receipt = validateSourceContracts({
    context,
    mcpRoot,
    apiRoot: absolute(values, "api-root"),
    facilitatorRoot: absolute(values, "facilitator-root"),
  });
  writeJson(outputPath(values, "output"), receipt);
  return receipt;
}

function candidateFiles(root) {
  const entries = readdirSync(root).sort();
  const tarballs = entries.filter((name) => name.endsWith(".tgz"));
  if (tarballs.length !== 1) fail("candidate bundle must contain one tarball");
  for (const required of ["release-attestation.json", "hosted-receipt.json"]) {
    if (!entries.includes(required)) fail(`candidate bundle lacks ${required}`);
  }
  return {
    tarball: resolve(root, tarballs[0]),
    attestation: resolve(root, "release-attestation.json"),
    receipt: resolve(root, "hosted-receipt.json"),
  };
}

async function commandBuild(values) {
  const context = readJson(absolute(values, "context"));
  const sourceReceipt = validateSourceReceipt({
    receipt: readJson(absolute(values, "sources")),
    context,
  });
  const evidence = exactEvidenceRoot(absolute(values, "evidence"));
  const outputParent = outputPath(values, "output-parent");
  if (!existsSync(outputParent)) mkdirSync(outputParent, { recursive: true });
  const built = await buildReviewedReleaseCandidate([
    "--output-dir",
    outputParent,
    "--hosted-source",
    absolute(values, "mcp-root"),
    "--api-source",
    absolute(values, "api-root"),
    "--facilitator-source",
    absolute(values, "facilitator-root"),
    "--review",
    evidence.reviewPath,
    "--dist-tag",
    context.package.distTag,
  ]);
  const receipt = {
    schemaVersion: 1,
    kind: "opendexter-github-candidate-receipt/v1",
    context,
    sourceReceipt,
    attestationSha256: built.attestationSha256,
    artifact: built.attestation.artifact,
    inventoryDigest: canonicalJsonDigest(built.attestation.inventory),
  };
  writeJson(resolve(built.candidateRoot, "hosted-receipt.json"), receipt);
  validateCandidateReceipt({
    receipt,
    context,
    sourceReceipt,
    artifactPath: built.tarball,
    attestationPath: built.attestationPath,
  });
  githubOutput(values, { bundle: built.candidateRoot });
  return { ...built, receipt };
}

async function artifactServiceMetadata(config, artifactId) {
  return githubJson(
    `/repos/${config.repository}/actions/artifacts/${artifactId}`,
  );
}

async function commandVerify(values) {
  const config = loadConfig(values.config ?? defaultConfigPath);
  const context = readJson(absolute(values, "context"));
  const sourceReceipt = validateSourceReceipt({
    receipt: readJson(absolute(values, "sources")),
    context,
  });
  const candidateRoot = absolute(values, "candidate");
  const candidate = candidateFiles(candidateRoot);
  const receipt = readJson(candidate.receipt);
  validateCandidateReceipt({
    receipt,
    context,
    sourceReceipt,
    artifactPath: candidate.tarball,
    attestationPath: candidate.attestation,
  });
  const runId = requireDecimalId(values["candidate-run-id"], "--candidate-run-id");
  const artifactId = requireDecimalId(
    values["candidate-artifact-id"],
    "--candidate-artifact-id",
  );
  const artifactDigest = requireDigest(
    values["candidate-artifact-digest"],
    "--candidate-artifact-digest",
  );
  const artifactName = `opendexter-candidate-${context.commit}`;
  const service = await artifactServiceMetadata(config, artifactId);
  if (
    String(service?.id) !== artifactId
    || service?.name !== artifactName
    || service?.digest !== artifactDigest
    || service?.expired !== false
    || String(service?.workflow_run?.id) !== runId
    || service?.workflow_run?.head_sha !== context.commit
  ) {
    fail("candidate artifact service metadata differs");
  }
  const candidateHandoff = createArtifactHandoff({
    repository: config.repository,
    runId,
    artifactId,
    artifactDigest,
    artifactName,
    headSha: context.commit,
    receiptSha256: digestFile(candidate.receipt),
  });
  const evidence = exactEvidenceRoot(absolute(values, "evidence"));
  const verified = await verifyCoordinatedRelease({
    attestationPath: candidate.attestation,
    tarball: candidate.tarball,
    reviewReceipt: evidence.reviewPath,
    hostedSource: absolute(values, "mcp-root"),
    apiSource: absolute(values, "api-root"),
    facilitatorSource: absolute(values, "facilitator-root"),
    attestationDigest: receipt.attestationSha256,
    explicitTag: context.package.distTag,
    npmTag: context.package.distTag,
  });
  const output = outputPath(values, "output");
  if (existsSync(output)) fail("accepted output already exists");
  mkdirSync(output);
  cpSync(candidate.tarball, resolve(output, basename(candidate.tarball)), {
    errorOnExist: true,
    force: false,
  });
  const acceptance = {
    schemaVersion: 1,
    kind: "opendexter-github-rebuild-acceptance/v1",
    context,
    sourceReceipt,
    candidateHandoff,
    candidateReceiptSha256: digestFile(candidate.receipt),
    attestationSha256: receipt.attestationSha256,
    artifact: receipt.artifact,
    inventoryDigest: receipt.inventoryDigest,
    verificationDigest: canonicalJsonDigest({
      attestation: verified.attestation,
      candidateSha256: verified.candidateSha256,
    }),
  };
  writeJson(resolve(output, "acceptance.json"), acceptance);
  githubOutput(values, { bundle: output });
  return acceptance;
}

function acceptedFiles(root) {
  const entries = readdirSync(root).sort();
  const tarballs = entries.filter((name) => name.endsWith(".tgz"));
  if (tarballs.length !== 1 || !entries.includes("acceptance.json")) {
    fail("accepted bundle is incomplete");
  }
  return {
    tarball: resolve(root, tarballs[0]),
    acceptance: resolve(root, "acceptance.json"),
  };
}

function commandPublishInput(values) {
  const config = loadConfig(values.config ?? defaultConfigPath);
  const root = absolute(values, "accepted");
  const files = acceptedFiles(root);
  const acceptance = readJson(files.acceptance);
  if (
    acceptance?.schemaVersion !== 1
    || acceptance?.kind !== "opendexter-github-rebuild-acceptance/v1"
  ) {
    fail("rebuild acceptance schema is unsupported");
  }
  validateSourceReceipt({
    receipt: acceptance.sourceReceipt,
    context: acceptance.context,
  });
  const inspected = inspectTarball(files.tarball);
  same(inspected.artifact, acceptance.artifact, "publish artifact");
  if (
    acceptance.context.commit !== process.env.GITHUB_SHA
    || acceptance.context.releaseTag !== process.env.GITHUB_REF_NAME
    || process.env.GITHUB_REF_TYPE !== "tag"
    || process.env.GITHUB_REPOSITORY !== config.repository
  ) {
    fail("publish job context differs from the accepted build");
  }
  if (process.env.OPENDXTER_RELEASE_CONTAINER_IMAGE !== config.runner.containerImage) {
    fail("publish container differs from candidate/rebuild");
  }
  createArtifactHandoff({
    repository: config.repository,
    runId: values["accepted-run-id"],
    artifactId: values["accepted-artifact-id"],
    artifactDigest: values["accepted-artifact-digest"],
    artifactName: `opendexter-accepted-${acceptance.context.commit}`,
    headSha: acceptance.context.commit,
    receiptSha256: digestFile(files.acceptance),
  });
  githubOutput(values, {
    tarball: files.tarball,
    version: acceptance.context.package.version,
  });
  return { acceptance, tarball: files.tarball };
}

function commandPublisherNpm(values) {
  const config = loadConfig(values.config ?? defaultConfigPath);
  for (const name of [
    "NODE_AUTH_TOKEN",
    "NPM_TOKEN",
    "OPENDXTER_RELEASE_NPM_TOKEN",
  ]) {
    if (process.env[name]) fail(`${name} must be absent from OIDC publish`);
  }
  if (
    process.env.GITHUB_ACTIONS !== "true"
    || process.env.OPENDXTER_RELEASE_ENVIRONMENT !== config.publisher.environment
    || !process.env.ACTIONS_ID_TOKEN_REQUEST_URL
    || !process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  ) {
    fail("publisher is not inside the protected GitHub OIDC environment");
  }
  if (process.version !== config.runner.node) fail("publisher Node version drifted");
  const output = outputPath(values, "output");
  if (existsSync(output)) fail("npm publisher output already exists");
  mkdirSync(output);
  const npmVersion = run("npm", ["--version"], { env: npmEnvironment() });
  if (npmVersion !== config.runner.npm) fail("bootstrap npm version drifted");
  const raw = run("npm", [
    "pack",
    `npm@${config.publisher.npm}`,
    "--json",
    "--ignore-scripts",
    `--pack-destination=${output}`,
    `--registry=${config.publisher.registry}`,
  ], { cwd: output, env: npmEnvironment() });
  const [packed] = JSON.parse(raw);
  const tarball = resolve(output, packed.filename);
  if (
    sha512Integrity(tarball) !== config.publisher.npmPackageIntegrity
    || digestFile(tarball, "sha1") !== config.publisher.npmPackageShasum
  ) {
    fail("downloaded npm publisher bytes differ from the reviewed pin");
  }
  const extracted = resolve(output, "npm");
  mkdirSync(extracted);
  run("/usr/bin/tar", ["-xzf", tarball, "-C", extracted, "--no-same-owner"]);
  const npmRoot = resolve(extracted, "package");
  const manifest = readJson(resolve(npmRoot, "package.json"));
  if (manifest.name !== "npm" || manifest.version !== config.publisher.npm) {
    fail("reviewed publisher package identity differs");
  }
  const npmCli = realpathSync(resolve(npmRoot, "bin/npm-cli.js"));
  githubOutput(values, { npm_cli: npmCli });
  return { npmCli, tarball };
}

async function commandReconcile(values) {
  const root = absolute(values, "accepted");
  const acceptance = readJson(acceptedFiles(root).acceptance);
  const config = loadConfig();
  const encoded = encodeURIComponent(acceptance.context.package.name);
  const version = encodeURIComponent(acceptance.context.package.version);
  const versionUrl = `${config.publisher.registry}${encoded}/${version}`;
  const packumentUrl = `${config.publisher.registry}${encoded}`;
  let metadata;
  let packument;
  let receipt;
  let lastError;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      const [versionResponse, packumentResponse] = await Promise.all([
        fetch(versionUrl, {
          headers: { accept: "application/vnd.npm.install-v1+json" },
        }),
        fetch(packumentUrl, {
          headers: { accept: "application/vnd.npm.install-v1+json" },
        }),
      ]);
      if (!versionResponse.ok || !packumentResponse.ok) {
        throw new Error(
          `registry returned HTTP ${versionResponse.status}/${packumentResponse.status}`,
        );
      }
      [metadata, packument] = await Promise.all([
        versionResponse.json(),
        packumentResponse.json(),
      ]);
      receipt = verifyRegistryReconciliation({ acceptance, metadata, packument });
      break;
    } catch (error) {
      lastError = error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000));
    }
  }
  if (!metadata || !packument || !receipt) {
    throw lastError ?? new Error("registry reconciliation timed out");
  }
  writeJson(outputPath(values, "output"), receipt);
  return receipt;
}

export async function main(argv = process.argv.slice(2)) {
  const { command, values } = parseArgs(argv);
  if (command === "prepare-review") return commandPrepareReview(values);
  if (command === "approve-review") return commandApproveReview(values);
  if (command === "evidence") return commandEvidence(values);
  if (command === "context") return commandContext(values);
  if (command === "sources") return commandSources(values);
  if (command === "build") return commandBuild(values);
  if (command === "verify") return commandVerify(values);
  if (command === "publish-input") return commandPublishInput(values);
  if (command === "publisher-npm") return commandPublisherNpm(values);
  if (command === "reconcile") return commandReconcile(values);
  fail(
    "Usage: github-hosted-release.mjs "
      + "prepare-review|approve-review|evidence|context|sources|build|verify|"
      + "publish-input|publisher-npm|reconcile",
  );
}

if (
  process.argv[1]
  && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `OpenDexter hosted release refused: ${error.message}\n`,
    );
    process.exitCode = 1;
  }
}
