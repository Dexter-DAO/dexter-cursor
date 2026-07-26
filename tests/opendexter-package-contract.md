# OpenDexter package validation

The v0.3.0 model-evaluation reports and 16-tool mock suite were removed from
the active package because they described a superseded hosted roster. Git
history preserves them; they are not evidence for this release candidate.

The current validation is deliberately local and non-mutating:

```bash
node --test tests/opendexter-package-contract.test.mjs
```

It checks:

- the release-pinned ten-tool and OAuth contract;
- Codex and Claude manifest/MCP/marketplace shapes;
- the three hosted-contract skills in both packages;
- absence of old card, local-wallet, pairing, and npm-latest routes from active
  skill and manifest content;
- separation of the publisher-side `.app.json` from the portable Codex package;
- clean staging into a temporary marketplace root, discovery of both package
  manifests/MCPs/skills through their marketplace entries, and absence of
  symlinks or special files.

The automated test does not change a client configuration, connect to the
hosted MCP, complete OAuth, or make a payment. A separate disposable Claude
profile can prove supported-client installation without touching the user's
active profile.
