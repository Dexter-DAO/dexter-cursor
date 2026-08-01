# OpenDexter package validation

The v0.3.0 model-evaluation reports and 16-tool mock suite were removed from
the active package because they described a superseded hosted roster. Git
history preserves them; they are not evidence for this release candidate.

The current validation is deliberately local and non-mutating:

```bash
node --test tests/opendexter-package-contract.test.mjs

# Release checkout: also prove the fixture against the pinned hosted source.
OPENDXTER_HOSTED_SOURCE_ROOT=../dexter-mcp \
  node --test tests/opendexter-package-contract.test.mjs
```

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
