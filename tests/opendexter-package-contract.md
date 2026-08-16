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

The `@dexterai/opendexter@1.24.0-rc.0` source candidate pins
`@dexterai/mcp-instructions@2.4.1`, `@dexterai/x402-core@1.5.2`,
`@dexterai/x402-mcp-tools@0.9.0-rc.0`, `@dexterai/x402@6.0.0-rc.2`, and
`@dexterai/vault@0.43.2` through one canonical Node.js 22 root lock. Public
`1.23.3` is immutable on npm; neither the OpenDexter nor x402 MCP tools RC is
published. The maintained discovery alias is also advanced to
`@dexterai/x402-discovery@1.1.0-rc.0` and pins this exact OpenDexter candidate.
Every RC manifest is `next`-only. The protected
`opendexter-v1.23.0` tag records a workflow that stopped before artifact
creation, upload, or npm publication; it is not a registry release. The
checked-in public hosted receipt pins the accepted live MCP release at
`7e7b3d0d49459567fba66531e8e2f7daa83d5587`, tree
`ae18395cc5b4fab267cc50e6fd5a6aebdb662abc`, artifact-manifest SHA-256
`43f40ec43fa81ff9f3c82e4dbb9dc700015341a4a86b80372cdde4713eacd3cd`, and
descriptor SHA-256
`52a10cdab9391abec0422c86616a10d3669ab0a16fba8a2d8082281a21624d7c`.
This receipt refresh and the V6 migration are source evidence only; they do
not tag, publish, deploy, or exercise the local package against a live seller.

The local MCP exposes exactly seven hosted-runtime proxy tools. It never reads
or creates a local signer for payment. Existing `wallet.json` files remain
untouched and can be inspected only through the explicit read-only legacy
recovery view. Non-GET checks and access requests are classified as potentially
side-effectful and require separate request authorization.

The stable release may not rely on the optional historical check. The final
clean `dexter-mcp` source must commit
`release/open-tool-descriptors.json` with every tool's title, description,
input schema, output schema, security, annotations, visibility, and widget
access. The single `publish-opendexter.yml` workflow makes that source root
mandatory, verifies it, and requires this repository's materialized hosted
contract to pin the same exact commit/tree. The public receipt is refreshed
only after the MCP release is accepted. Its credential-free source
reconstruction and the optional private cross-repository verification must
agree on every contract byte and digest; only their explicitly named
verification recipes may differ. Publication also waits for the single
`opendexter-npm-production` environment approval.

It checks:

- the source-pinned exact twelve-tool contract, including the anonymous five
  and seven OAuth-promoted tools;
- combined ChatGPT/Codex and Claude manifest/MCP/marketplace shapes;
- the three hosted-contract skills in both packages;
- absence of old card, local-wallet, pairing, and npm-latest routes from active
  skill and manifest content;
- the exact current owner app binding packaged once with the hosted skill and
  absence of the retired conflicting top-level binding;
- byte parity between the canonical ChatGPT/Codex hosted skill and the
  generated Claude shared files;
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
