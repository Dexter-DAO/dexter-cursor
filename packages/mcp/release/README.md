# OpenDexter npm releases

OpenDexter uses one release workflow: `.github/workflows/publish-opendexter.yml`.
There is no evidence workflow, release-review bot, audit App, manual artifact-ID
handoff, or independent rebuild.

## One-time settings

The repository needs exactly these external settings:

1. Configure one GitHub App with **Contents: read-only**, installed only on the
   private `Dexter-DAO/dexter-api` and `Dexter-DAO/dexter-facilitator`
   repositories. In `Dexter-DAO/opendexter-ide`, add its ID as the repository
   Actions variable `OPENDXTER_SOURCE_APP_ID` and its private key as the
   repository Actions secret `OPENDXTER_SOURCE_APP_PRIVATE_KEY`. This is the
   only GitHub App used by the release. If both paired repositories become
   public, the workflow can remove this App step entirely.
2. Keep one GitHub environment named `opendexter-npm-production`. Require the
   intended human reviewer and allow deployment from tags matching
   `opendexter-v*`. Do not put an npm token in the environment.
3. Configure npm trusted publishing for `@dexterai/opendexter` with GitHub
   owner `Dexter-DAO`, repository `opendexter-ide`, workflow filename
   `publish-opendexter.yml`, and environment `opendexter-npm-production`.
4. Protect `refs/tags/opendexter-v*` from update and deletion with a GitHub
   ruleset. The workflow separately requires the tagged commit to be on
   `origin/main` and the tag to exactly equal `opendexter-v<package.version>`.

The obsolete `opendexter-release-review` and `opendexter-source-read`
environments and all `OPENDXTER_RELEASE_AUDIT_*` settings are not used and can
be removed after this workflow lands.

## Every release

1. Update `packages/mcp/package.json` and run `npm run version:sync` from that
   package. Commit the version and any updated hosted source contract, then
   merge the reviewed commit to `main`.
2. Create and push the exact tag `opendexter-v<version>` on that main commit.
   The tag push starts the workflow automatically.
3. Review the completed build job, then approve the one
   `opendexter-npm-production` deployment.

The build job verifies the version/tag/main ancestry and all pinned MCP, API,
and facilitator contracts. From one clean committed archive it runs tests,
typechecking, one build, and one `npm pack`. It uploads that tarball plus a
release receipt under a deterministic artifact name.

The production job downloads that artifact, verifies both SHA-256 hashes,
checks npm for an existing version, and publishes the exact tarball through
OIDC. It then verifies registry integrity, shasum, SLSA provenance subject,
workflow, repository, and tag.

## Retry behavior

Re-run the same workflow from the exact release tag, either in GitHub Actions
or with:

```bash
gh workflow run publish-opendexter.yml --ref opendexter-v<version>
```

The workflow always rebuilds from the exact tagged source because GitHub
artifacts are scoped to a run. If npm already has the same version with the
same integrity, shasum, and trusted-publisher provenance, publication is
skipped and reconciliation succeeds. If the version exists with different
bytes or provenance, the workflow fails closed. No artifact IDs or digests
need to be copied between workflows.
