# OpenDexter npm releases

OpenDexter uses one release workflow: `.github/workflows/publish-opendexter.yml`.
There is no evidence workflow, release-review bot, audit App, manual artifact-ID
handoff, or independent rebuild.

## One-time settings

The repository needs exactly these external settings:

1. Keep one GitHub environment named `opendexter-npm-production`. Require the
   intended human reviewer and allow deployment from tags matching
   `opendexter-v*`. Do not put an npm token in the environment.
2. Configure npm trusted publishing for `@dexterai/opendexter` with GitHub
   owner `Dexter-DAO`, repository `opendexter-ide`, workflow filename
   `publish-opendexter.yml`, and environment `opendexter-npm-production`.
3. Protect `refs/tags/opendexter-v*` from update and deletion with a GitHub
   ruleset. The workflow separately requires the tagged commit to be on
   `origin/main` and the tag to exactly equal `opendexter-v<package.version>`.

No Source App, private-source token, API checkout, or facilitator checkout is
part of the npm release. The obsolete `opendexter-release-review` and
`opendexter-source-read` environments, `OPENDXTER_SOURCE_APP_*`, and all
`OPENDXTER_RELEASE_AUDIT_*` settings are not used and can be removed after this
workflow lands.

## Every release

1. Before creating the release commit or tag, prepare the package's one public
   hosted dependency:

   ```bash
   npm run release:prepare-hosted --workspace=@dexterai/opendexter
   ```

   This reads `https://open.dexter.cash/health` once, resolves the exact
   accepted MCP commit/tree, clones that public commit when no local checkout
   is supplied, verifies its canonical Git advertisement, reproduces its
   committed tool/OAuth descriptor from a sterile archive, and writes
   `packages/mcp/release/hosted-public-release.json`. To reuse an exact local
   MCP checkout, append `-- --mcp-root /absolute/path/to/dexter-mcp`.
2. Update `packages/mcp/package.json` and run `npm run version:sync` from that
   package. Commit the version and generated public hosted contract, then merge
   the reviewed commit to `main`.
3. Create and push the exact tag `opendexter-v<version>` on that main commit.
   The tag push starts the workflow automatically.
4. Review the completed build job, then approve the one
   `opendexter-npm-production` deployment.

The tagged workflow never re-resolves hosted health or reconstructs the hosted
descriptor. It verifies the frozen public MCP commit/tree, source archive,
package lock, artifact-manifest digest, descriptor digest, full public
tool/OAuth projection, version/tag/main ancestry, and exact generated contract.
From one clean committed archive it runs tests, typechecking, one build, and one
`npm pack`. Before upload it fresh-installs that exact tarball once with
lifecycle scripts disabled and runs the installed `opendexter --help`. It
uploads that tarball plus a release receipt under a deterministic artifact name.

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
