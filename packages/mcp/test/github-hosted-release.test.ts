import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createArtifactReceipt,
  validateArtifactHandoff,
  validateEvidenceProducerBinding,
  validateCredentialFreeGitConfigKeys,
  validateHostedReleaseConfig,
  validateProtectedTagRulesets,
  validateReviewEnvironmentProtection,
  validateReleaseInvocation,
  verifyIndependentRebuild,
  verifyRegistryReconciliation,
} from "../scripts/github-hosted-release.mjs";
import {
  canonicalJsonDigest,
  inspectTarball,
} from "../scripts/package-provenance.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function read(relative: string): string {
  return readFileSync(resolve(repositoryRoot, relative), "utf8");
}

function workflowRunBlocks(source: string): string[] {
  const lines = source.split("\n");
  const blocks: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s+)run:\s*\|\s*$/.exec(lines[index]);
    if (!match) continue;
    const indent = match[1].length;
    const block: string[] = [];
    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index];
      const lineIndent = /^(\s*)/.exec(line)?.[1].length ?? 0;
      if (line.trim() && lineIndent <= indent) {
        index -= 1;
        break;
      }
      block.push(line);
    }
    blocks.push(block.join("\n"));
  }
  return blocks;
}

function config() {
  return JSON.parse(readFileSync(
    resolve(packageRoot, "release/github-hosted-release.json"),
    "utf8",
  ));
}

function invocation() {
  const policy = config();
  const version = "1.23.0-rc.3";
  const releaseTag = `opendexter-v${version}`;
  const commit = "a".repeat(40);
  const tree = "b".repeat(40);
  return {
    config: policy,
    repository: policy.repository,
    ref: `refs/tags/${releaseTag}`,
    refType: "tag",
    refName: releaseTag,
    releaseTag,
    sha: commit,
    commit,
    tree,
    containerImage: policy.runner.containerImage,
    packageManifest: {
      name: policy.package.name,
      version,
      publishConfig: { tag: policy.package.distTag },
    },
    evidenceBinding: {
      schemaVersion: 1,
      kind: "opendexter-github-evidence-binding/v1",
      producer: {
        repository: policy.repository,
        workflowPath: policy.evidence.workflowPath,
        runId: "123456789",
        runAttempt: 1,
        headSha: commit,
        tree,
        releaseTag,
      },
      artifact: {
        id: "987654321",
        name: `opendexter-release-evidence-${commit}`,
        digest: `sha256:${"c".repeat(64)}`,
      },
      approval: {
        environment: policy.evidence.environment,
        state: "approved",
        reviewer: { ...policy.evidence.requiredReviewer },
      },
      environmentProtection: {
        environment: policy.evidence.environment,
        independentApprovalHistoryRequired: true,
        requiredReviewers: {
          id: 7,
          preventSelfReview: true,
          reviewer: { ...policy.evidence.requiredReviewer },
        },
      },
      proposalArtifact: {
        id: "111111111",
        name: `${policy.evidence.proposalArtifactNamePrefix}${commit}`,
        digest: `sha256:${"e".repeat(64)}`,
        proposalSha256: "f".repeat(64),
      },
      files: { reviewSha256: "d".repeat(64) },
    },
  };
}

function sourceReceipt(context: ReturnType<typeof validateReleaseInvocation>) {
  return {
    schemaVersion: 1,
    kind: "opendexter-hosted-source-receipt/v1",
    subject: { commit: context.commit, tree: context.tree },
    descriptorSha256: "1".repeat(64),
    descriptorDigest: "2".repeat(64),
    mcp: {
      repository: "https://github.com/Dexter-DAO/dexter-mcp",
      commit: "3".repeat(40),
      tree: "4".repeat(40),
    },
    api: {
      repository: "https://github.com/Dexter-DAO/dexter-api",
      commit: "5".repeat(40),
      tree: "6".repeat(40),
    },
    facilitator: {
      repository: "https://github.com/Dexter-DAO/dexter-facilitator",
      commit: "7".repeat(40),
      tree: "8".repeat(40),
    },
    governedApi: { commit: "9".repeat(40), tree: "a".repeat(40) },
    contractsDigest: "b".repeat(64),
  };
}

function evidenceInput() {
  const release = invocation();
  const { config: policy, releaseTag, sha, tree } = release;
  const runId = "123456789";
  const artifactId = "987654321";
  const artifactDigest = `sha256:${"c".repeat(64)}`;
  const actor = { login: "dispatcher", id: 111 };
  const triggeringActor = { login: "trigger", id: 222 };
  const protectedRulesets = [{ id: 7, name: "OpenDexter releases" }];
  const approval = {
    environment: policy.evidence.environment,
    state: "approved",
    reviewer: { ...policy.evidence.requiredReviewer },
  };
  const proposal = {
    schemaVersion: 1,
    kind: "opendexter-release-review-proposal/v1",
    subject: {
      repository: policy.repository,
      releaseTag,
      ref: `refs/tags/${releaseTag}`,
      commit: sha,
      tree,
    },
    producer: {
      workflowPath: policy.evidence.workflowPath,
      runId,
      runAttempt: 1,
      event: "workflow_dispatch",
      actor,
      triggeringActor,
    },
    protectedRulesets,
  };
  const proposalArtifactBinding = {
    id: "111111111",
    name: `${policy.evidence.proposalArtifactNamePrefix}${sha}`,
    digest: `sha256:${"e".repeat(64)}`,
    proposalSha256: canonicalJsonDigest(proposal),
  };
  const dispatcher = { actor, triggeringActor };
  const reviewEvidence = {
    schemaVersion: 1,
    kind: policy.evidence.reviewKind,
    decision: "accepted",
    source: {
      repository: `https://github.com/${policy.repository}`,
      releaseTag,
      commit: sha,
      tree,
    },
    approval,
    dispatcher,
    proposalArtifact: proposalArtifactBinding,
  };
  const environment = {
    name: policy.evidence.environment,
    protection_rules: [{
      id: 7,
      type: "required_reviewers",
      prevent_self_review: true,
      reviewers: [{
        type: "User",
        reviewer: { ...policy.evidence.requiredReviewer },
      }],
    }],
  };
  const environmentProtection = validateReviewEnvironmentProtection(
    environment,
    policy.evidence.environment,
    policy.evidence.requiredReviewer,
  );
  return {
    config: policy,
    repository: policy.repository,
    releaseTag,
    sha,
    tree,
    runId,
    artifactId,
    artifactDigest,
    run: {
      id: Number(runId),
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "success",
      head_sha: sha,
      head_branch: releaseTag,
      path: policy.evidence.workflowPath,
      run_attempt: 1,
      repository: { full_name: policy.repository },
      actor,
      triggering_actor: triggeringActor,
    },
    artifact: {
      id: Number(artifactId),
      name: `${policy.evidence.artifactNamePrefix}${sha}`,
      digest: artifactDigest,
      expired: false,
      workflow_run: { id: Number(runId), head_sha: sha },
    },
    proposalArtifact: {
      id: Number(proposalArtifactBinding.id),
      name: proposalArtifactBinding.name,
      digest: proposalArtifactBinding.digest,
      expired: false,
      workflow_run: { id: Number(runId), head_sha: sha },
    },
    approvals: [{
      state: "approved",
      comment: "",
      user: { ...approval.reviewer },
      environments: [{ name: approval.environment }],
    }],
    environment,
    protectedRulesets,
    producerReceipt: {
      schemaVersion: 1,
      kind: "opendexter-github-evidence-producer/v1",
      subject: {
        repository: policy.repository,
        releaseTag,
        ref: `refs/tags/${releaseTag}`,
        commit: sha,
        tree,
      },
      producer: {
        workflowPath: policy.evidence.workflowPath,
        runId,
        runAttempt: 1,
        event: "workflow_dispatch",
        actor,
        triggeringActor,
      },
      approval,
      environmentProtection,
      proposalArtifact: proposalArtifactBinding,
      files: { reviewSha256: canonicalJsonDigest(reviewEvidence) },
    },
    reviewEvidence,
    proposal,
  };
}

function packedFixture() {
  const root = mkdtempSync(resolve(tmpdir(), "opendexter-hosted-test-"));
  temporaryRoots.push(root);
  const packageDir = resolve(root, "package");
  mkdirSync(resolve(packageDir, "dist"), { recursive: true });
  writeFileSync(resolve(packageDir, "package.json"), JSON.stringify({
    name: "@dexterai/opendexter",
    version: "1.23.0-rc.3",
    files: ["dist"],
    bin: { opendexter: "dist/index.js" },
  }));
  writeFileSync(resolve(packageDir, "dist/index.js"), "#!/usr/bin/env node\n");
  chmodSync(resolve(packageDir, "dist/index.js"), 0o755);
  const tarball = resolve(root, "candidate.tgz");
  execFileSync("/usr/bin/tar", ["-czf", tarball, "package"], { cwd: root });
  return { root, tarball, inspected: inspectTarball(tarball) };
}

describe("GitHub-hosted OpenDexter release", () => {
  it("rejects credential-capable settings left in a private source checkout", () => {
    expect(validateCredentialFreeGitConfigKeys([
      "core.repositoryformatversion",
      "remote.origin.url",
      "remote.origin.fetch",
    ])).toHaveLength(3);
    for (const key of [
      "credential.helper",
      "http.https://github.com/.extraheader",
      "url.https://token@github.com/.insteadOf",
      "include.path",
      "includeIf.gitdir:/tmp/.path",
      "core.sshCommand",
      "remote.origin.pushurl",
    ]) {
      expect(() => validateCredentialFreeGitConfigKeys([key]))
        .toThrow(/credential-capable Git setting/);
    }
  });

  it("pins one exact hosted policy and rejects identity drift", () => {
    const policy = config();
    expect(validateHostedReleaseConfig(policy)).toEqual(policy);
    for (const mutate of [
      (value: any) => { value.repository = "attacker/opendexter-ide"; },
      (value: any) => { value.runner.containerImage = `node:22.19.0-bookworm@sha256:${"0".repeat(64)}`; },
      (value: any) => { value.publisher.npm = "11.5.2"; },
      (value: any) => { value.sourceRead.repositories.push("dexter-mcp"); },
      (value: any) => { value.releaseAudit.permissions = ["actions:read"]; },
      (value: any) => { value.evidence.environment = "unprotected"; },
      (value: any) => { value.actions.checkout = `actions/checkout@${"0".repeat(40)}`; },
    ]) {
      const hostile = structuredClone(policy);
      mutate(hostile);
      expect(() => validateHostedReleaseConfig(hostile)).toThrow();
    }
  });

  it("cross-binds exact tag, SHA, tree, container, package, and evidence", () => {
    const valid = invocation();
    expect(validateReleaseInvocation(valid)).toMatchObject({
      commit: valid.commit,
      tree: valid.tree,
      releaseTag: valid.releaseTag,
    });
    for (const mutate of [
      (value: any) => { value.refType = "branch"; },
      (value: any) => { value.releaseTag = "opendexter-v1.23.0-rc.2"; },
      (value: any) => { value.sha = "c".repeat(40); },
      (value: any) => { value.tree = "c".repeat(40); },
      (value: any) => { value.containerImage = `node:22.19.0-bookworm@sha256:${"0".repeat(64)}`; },
      (value: any) => { value.evidenceBinding.kind = "forged"; },
      (value: any) => { value.evidenceBinding.producer.tree = "c".repeat(40); },
    ]) {
      const hostile = structuredClone(valid);
      mutate(hostile);
      expect(() => validateReleaseInvocation(hostile)).toThrow();
    }
  });

  it("requires an active tag ruleset that blocks update and deletion", () => {
    const policy = config();
    const releaseTag = "opendexter-v1.23.0-rc.3";
    const valid = [{
      id: 7,
      name: "OpenDexter releases",
      target: "tag",
      enforcement: "active",
      conditions: {
        ref_name: {
          include: ["refs/tags/opendexter-v*"],
          exclude: [],
        },
      },
      bypass_actors: [],
      rules: [{ type: "update" }, { type: "deletion" }],
    }];
    expect(validateProtectedTagRulesets({
      config: policy,
      repository: policy.repository,
      releaseTag,
      rulesets: valid,
    })).toEqual([{ id: 7, name: "OpenDexter releases" }]);
    for (const rulesets of [
      [],
      [{ ...valid[0], enforcement: "disabled" }],
      [{ ...valid[0], rules: [{ type: "deletion" }] }],
      [{ ...valid[0], bypass_actors: [{ actor_id: 1, actor_type: "User" }] }],
      [{
        ...valid[0],
        conditions: { ref_name: { include: ["~ALL"], exclude: [] } },
      }],
      [{
        ...valid[0],
        conditions: { ref_name: { include: ["refs/tags/**"], exclude: [] } },
      }],
      [{
        ...valid[0],
        conditions: {
          ref_name: {
            include: [`refs/tags/${releaseTag}`],
            exclude: [],
          },
        },
      }],
      [{
        ...valid[0],
        conditions: {
          ref_name: {
            include: ["refs/tags/opendexter-v*"],
            exclude: [`refs/tags/${releaseTag}`],
          },
        },
      }],
    ]) {
      expect(() => validateProtectedTagRulesets({
        config: policy,
        repository: policy.repository,
        releaseTag,
        rulesets,
      })).toThrow(/protected/);
    }
  });

  it("rejects forged producer, proposal, approval, environment, and review evidence", () => {
    const valid = evidenceInput();
    expect(() => validateEvidenceProducerBinding(valid)).not.toThrow();
    const mutations = [
      (value: any) => { delete value.producerReceipt; },
      (value: any) => { value.run.path = ".github/workflows/forged.yml"; },
      (value: any) => { value.run.event = "push"; },
      (value: any) => { value.run.conclusion = "failure"; },
      (value: any) => { value.run.head_sha = "d".repeat(40); },
      (value: any) => { value.artifact.id += 1; },
      (value: any) => { value.artifact.digest = `sha256:${"d".repeat(64)}`; },
      (value: any) => { value.artifact.expired = true; },
      (value: any) => { value.proposalArtifact.id += 1; },
      (value: any) => { value.proposalArtifact.digest = `sha256:${"0".repeat(64)}`; },
      (value: any) => { value.approvals = []; },
      (value: any) => { value.approvals[0].user = { login: "other", id: 99 }; },
      (value: any) => { value.approvals[0].environments[0].name = "unprotected"; },
      (value: any) => { value.producerReceipt.subject.tree = "d".repeat(40); },
      (value: any) => { value.producerReceipt.producer.runId = "123456790"; },
      (value: any) => { value.producerReceipt.approval.reviewer.login = "forged"; },
      (value: any) => { value.producerReceipt.files.reviewSha256 = "d".repeat(64); },
      (value: any) => { value.reviewEvidence.decision = "pending"; },
      (value: any) => { value.proposal.subject.tree = "d".repeat(40); },
      (value: any) => { value.proposal.protectedRulesets = []; },
      (value: any) => { value.environment.name = "unprotected"; },
      (value: any) => {
        value.environment.protection_rules[0].reviewers[0].reviewer = {
          login: "other",
          id: 99,
        };
      },
      (value: any) => { value.environment.protection_rules[0].prevent_self_review = false; },
      (value: any) => { value.run.actor = { ...value.approvals[0].user }; },
      (value: any) => { value.run.triggering_actor = { ...value.approvals[0].user }; },
    ];
    for (const mutate of mutations) {
      const hostile = structuredClone(valid);
      mutate(hostile);
      expect(() => validateEvidenceProducerBinding(hostile)).toThrow();
    }
    for (const hostile of ["1'", "1\n2", "$(id)", "`id`"]) {
      const badRun = structuredClone(valid);
      badRun.runId = hostile;
      expect(() => validateEvidenceProducerBinding(badRun)).toThrow();
      const badArtifact = structuredClone(valid);
      badArtifact.artifactId = hostile;
      expect(() => validateEvidenceProducerBinding(badArtifact)).toThrow();
      const badDigest = structuredClone(valid);
      badDigest.artifactDigest = hostile;
      expect(() => validateEvidenceProducerBinding(badDigest)).toThrow();
    }

    for (const dispatcherKey of ["actor", "triggering_actor"] as const) {
      const hostile = structuredClone(valid);
      const reviewer = { ...hostile.approvals[0].user };
      hostile.run[dispatcherKey] = reviewer;
      const receiptKey = dispatcherKey === "actor" ? "actor" : "triggeringActor";
      hostile.producerReceipt.producer[receiptKey] = reviewer;
      hostile.proposal.producer[receiptKey] = reviewer;
      hostile.reviewEvidence.dispatcher[receiptKey] = reviewer;
      const proposalSha256 = canonicalJsonDigest(hostile.proposal);
      hostile.producerReceipt.proposalArtifact.proposalSha256 = proposalSha256;
      hostile.reviewEvidence.proposalArtifact.proposalSha256 = proposalSha256;
      hostile.producerReceipt.files.reviewSha256 = canonicalJsonDigest(
        hostile.reviewEvidence,
      );
      expect(() => validateEvidenceProducerBinding(hostile))
        .toThrow(/independent approved/);
    }
  });

  it("binds source receipts, candidate/rebuild bytes, artifact handoffs, and registry bytes", () => {
    const context = validateReleaseInvocation(invocation());
    const packed = packedFixture();
    const base = {
      context,
      sourceReceipt: sourceReceipt(context),
      runtime: { node: "v22.19.0", npm: "10.9.3" },
      lockSha256: "c".repeat(64),
      inspected: packed.inspected,
    };
    const candidate = createArtifactReceipt({ phase: "candidate", ...base });
    const rebuild = createArtifactReceipt({ phase: "rebuild", ...base });
    const handoff = {
      runId: "314159",
      artifactId: "271828",
      artifactDigest: `sha256:${"d".repeat(64)}`,
    };
    expect(() => validateArtifactHandoff({
      receipt: candidate,
      phase: "candidate",
      context,
      artifactPath: packed.tarball,
      handoff,
      expectedHandoff: handoff,
    })).not.toThrow();
    expect(() => validateArtifactHandoff({
      receipt: candidate,
      phase: "candidate",
      context,
      artifactPath: packed.tarball,
      handoff,
      expectedHandoff: { ...handoff, artifactId: "271829" },
    })).toThrow(/handoff/);
    const acceptance = verifyIndependentRebuild({ candidate, rebuild });
    expect(acceptance.artifact).toEqual(candidate.artifact);
    expect(() => verifyIndependentRebuild({
      candidate,
      rebuild: {
        ...rebuild,
        sourceReceipt: {
          ...rebuild.sourceReceipt,
          contractsDigest: "d".repeat(64),
        },
      },
    })).toThrow();
    const metadata = {
      name: context.package.name,
      version: context.package.version,
      dist: {
        integrity: acceptance.artifact.integrity,
        shasum: acceptance.artifact.shasum,
      },
    };
    const packument = {
      name: context.package.name,
      "dist-tags": { [context.package.distTag]: context.package.version },
    };
    expect(verifyRegistryReconciliation({ acceptance, metadata, packument }))
      .toMatchObject({ acceptedArtifactSha256: acceptance.artifact.sha256 });
    expect(() => verifyRegistryReconciliation({
      acceptance,
      packument,
      metadata: {
        ...metadata,
        dist: { ...metadata.dist, integrity: "sha512-forged" },
      },
    })).toThrow(/integrity/);
    expect(() => verifyRegistryReconciliation({
      acceptance,
      metadata,
      packument: {
        ...packument,
        "dist-tags": { [context.package.distTag]: "1.23.0-rc.2" },
      },
    })).toThrow(/dist-tag/);
  });

  it("keeps evidence production operable and publishing OIDC-only", () => {
    const producer = read(".github/workflows/review-opendexter-release.yml");
    const publish = read(".github/workflows/publish-opendexter.yml");
    const helper = read("packages/mcp/scripts/github-hosted-release.mjs");
    const localPublisher = read("packages/mcp/scripts/publish-release-candidate.mjs");
    const packageManifest = JSON.parse(readFileSync(
      resolve(packageRoot, "package.json"),
      "utf8",
    ));
    const policy = config();
    expect(producer.match(/^  (prepare|approve):$/gm)).toHaveLength(2);
    expect(producer).toContain("environment: opendexter-release-review");
    expect(producer).toContain("prepare-review");
    expect(producer).toContain("approve-review");
    expect(producer).toContain("proposal.json");
    expect(producer.match(/OPENDXTER_RELEASE_AUDIT_APP_ID/g)).toHaveLength(2);
    expect(producer.match(/OPENDXTER_RELEASE_AUDIT_APP_PRIVATE_KEY/g))
      .toHaveLength(2);
    expect(producer.match(/permission-actions:\s*read/g)).toHaveLength(2);
    expect(producer.match(/permission-administration:\s*read/g)).toHaveLength(2);
    expect(producer.match(/repositories:\s*opendexter-ide/g)).toHaveLength(2);
    expect(producer).toContain("producer-receipt.json");
    expect(producer).toContain("artifact-id");
    expect(producer).toContain("artifact-digest");
    expect(publish.match(/^  (candidate|rebuild|publish):$/gm)).toHaveLength(3);
    expect(publish.match(/OPENDXTER_RELEASE_AUDIT_APP_ID/g)).toHaveLength(2);
    expect(publish.match(/OPENDXTER_RELEASE_AUDIT_APP_PRIVATE_KEY/g))
      .toHaveLength(2);
    expect(`${producer}\n${publish}`.match(
      /artifact_digest:\s*sha256:\$\{\{ steps\.upload\.outputs\.artifact-digest \}\}/g,
    )).toHaveLength(4);
    expect(`${producer}\n${publish}`).not.toMatch(
      /artifact_digest:\s*\$\{\{ steps\.upload\.outputs\.artifact-digest \}\}/,
    );
    expect(publish.match(/id-token:\s*write/g)).toHaveLength(1);
    expect(publish).toContain("environment: opendexter-source-read");
    expect(publish).toContain("environment: opendexter-npm-production");
    expect(publish).toContain("needs.candidate.outputs.artifact_digest");
    expect(publish).toContain("needs.rebuild.outputs.artifact_digest");
    expect(publish).toContain("permission-contents: read");
    expect(publish.match(
      /GH_TOKEN: \$\{\{ steps\.source-token\.outputs\.token \}\}/g,
    )).toHaveLength(2);
    expect(publish.match(/--api-root "\$GITHUB_WORKSPACE\/api"/g))
      .toHaveLength(4);
    expect(publish.match(
      /--facilitator-root "\$GITHUB_WORKSPACE\/facilitator"/g,
    )).toHaveLength(4);
    const candidateMaterialization = publish.slice(
      publish.indexOf("- name: Run the accepted archive materialization"),
      publish.indexOf("- name: Upload exact candidate bundle"),
    );
    expect(candidateMaterialization).toContain(
      "GH_TOKEN: ${{ steps.source-token.outputs.token }}",
    );
    const independentMaterialization = publish.slice(
      publish.indexOf("- name: Run the accepted independent rebuild"),
      publish.indexOf("- name: Upload exact accepted bundle"),
    );
    expect(independentMaterialization).toContain(
      "GH_TOKEN: ${{ steps.source-token.outputs.token }}",
    );
    expect(publish).toMatch(/repositories:\s*\|-\n\s+dexter-api\n\s+dexter-facilitator/);
    for (const block of publish.match(
      /repositories:\s*\|-\n\s+dexter-api\n\s+dexter-facilitator/g,
    ) ?? []) {
      expect(block).not.toContain("dexter-mcp");
    }
    for (const action of publish.match(/^\s+uses:\s*([^\s]+)$/gm) ?? []) {
      expect(action).toMatch(/@[0-9a-f]{40}$/);
    }
    const workflowUses = `${producer}\n${publish}`.match(
      /^\s+uses:\s*([^\s]+)$/gm,
    ) ?? [];
    const allowedActionPins = new Set(Object.values(policy.actions));
    for (const pin of allowedActionPins) {
      expect(workflowUses).toContain(`        uses: ${pin}`);
    }
    for (const line of workflowUses) {
      expect(allowedActionPins.has(line.trim().slice("uses: ".length)))
        .toBe(true);
    }
    expect(helper).toContain('from "./build-release-candidate.mjs"');
    expect(helper).toContain("buildReviewedReleaseCandidate([");
    expect(helper).toContain("verifyCoordinatedRelease({");
    expect(helper).not.toContain("OPENDXTER_REVIEW_JSON_BASE64");
    expect(helper).not.toContain("OPENDXTER_NOVICE_JSON_BASE64");
    for (const block of [
      ...workflowRunBlocks(producer),
      ...workflowRunBlocks(publish),
    ]) expect(block).not.toContain("${{");
    for (const hostile of [
      `opendexter-v1.23.0-rc.3'`,
      "opendexter-v1.23.0-rc.3\nforged",
      "opendexter-v1.23.0-rc.3$(id)",
      "opendexter-v1.23.0-rc.3`id`",
    ]) {
      const value = invocation();
      value.releaseTag = hostile;
      value.ref = `refs/tags/${hostile}`;
      value.refName = hostile;
      expect(() => validateReleaseInvocation(value)).toThrow();
    }
    expect(localPublisher).toContain("Local OpenDexter publishing is disabled");
    expect(localPublisher).not.toContain("OPENDXTER_RELEASE_NPM_TOKEN");
    expect(packageManifest.scripts.prepublishOnly)
      .toBe("node scripts/publish-release-candidate.mjs");
  });
});
