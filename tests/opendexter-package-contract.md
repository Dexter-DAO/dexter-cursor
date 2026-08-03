# OpenDexter package validation

The v0.3.0 model-evaluation reports and 16-tool mock suite were removed from
the active package because they described a superseded hosted roster. Git
history preserves them; they are not evidence for this release candidate.

The current validation is deliberately local and non-mutating:

```bash
node --test tests/opendexter-package-contract.test.mjs

# Historical fixture check only; this does not satisfy the new release train.
OPENDXTER_HOSTED_SOURCE_ROOT=../dexter-mcp \
  node --test tests/opendexter-package-contract.test.mjs
```

An actual RC.3 release may not rely on the optional historical check. The final
clean `dexter-mcp` source must commit
`release/open-tool-descriptors.json` with every tool's title, description,
input schema, output schema, security, annotations, visibility, and widget
access. The single `publish-opendexter.yml` workflow makes that source root
mandatory, verifies it, and requires this repository's materialized hosted
contract to pin the same exact commit/tree. Until that file and final source
exist, its one build-and-pack job fails closed. Publication then waits for the
single `opendexter-npm-production` environment approval.

It checks:

- the source-pinned exact twelve-tool contract, including the anonymous five
  and seven OAuth-promoted tools;
- Codex and Claude manifest/MCP/marketplace shapes;
- the three hosted-contract skills in both packages;
- absence of old card, local-wallet, pairing, and npm-latest routes from active
  skill and manifest content;
- separation of the publisher-side `.app.json` from the portable Codex package;
- clean staging into a temporary marketplace root, discovery of both package
  manifests/MCPs/skills through their marketplace entries, and absence of
  symlinks or special files.

The automated test does not change a client configuration, connect to the
hosted MCP, complete OAuth, or make a payment. Publication, installation, and
fresh anonymous/connected live discovery remain separate release gates.

## Hosted non-paying live acceptance

The hosted gate is intentionally not part of the default test command and
refuses to make any network request unless the operator opts in. Point it at a
current, approved HTTPS GET endpoint that is expected to return an x402 quote:

```bash
OPENDXTER_HOSTED_LIVE_RUN=1 \
OPENDXTER_HOSTED_LIVE_QUOTE_URL='<current approved paid GET endpoint>' \
  node tests/hosted-opendexter-live-acceptance.mjs
```

That anonymous run reads the endpoint, version, five-tool roster, OAuth
metadata, tool contracts, and retired-tool denylist from the source-pinned
`hosted-contract.json`. It then checks live discovery, a quote-only GET, the
wallet and portfolio Connect results, and the governed-history HTTP challenge.
It does not use a stale built-in quote endpoint.

For the complete connected proof, inject a current test authorization through
the release secret mechanism; never paste or commit it:

```bash
OPENDXTER_HOSTED_LIVE_RUN=1 \
OPENDXTER_HOSTED_LIVE_REQUIRE_CONNECTED=1 \
OPENDXTER_HOSTED_LIVE_QUOTE_URL='<current approved paid GET endpoint>' \
OPENDXTER_HOSTED_LIVE_BEARER="$RELEASE_INJECTED_OPENDEXTER_BEARER" \
  node tests/hosted-opendexter-live-acceptance.mjs
```

The connected run requires the exact twelve-tool roster and current security,
annotation, visibility, input, and output schemas. It reads the bound wallet,
complete canonical-asset portfolio, one governed-history page, and the same
x402 intent after a connected price check. A connected `x402_check` persists a
quote intent, but the gate never calls `x402_fetch`, governed prepare, execute,
or reconcile, never signs or submits a transaction, and never moves money.
Without the bearer, output is explicitly `complete: false`; it is anonymous
evidence only, not a complete hosted acceptance receipt.
