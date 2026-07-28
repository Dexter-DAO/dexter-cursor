# OpenDexter local release and client smoke checklist

Candidate: `@dexterai/opendexter@1.23.0-rc.2`.

This is a proof checklist, not publication authority. Do not publish packages,
edit a user's client profile, create or replace a wallet, link an account,
sign, or pay until the captain opens the corresponding gate.

## 1. Source and package train

- [ ] Worktree is clean and the candidate commit is frozen.
- [ ] Node satisfies the declared Node 20+ contract.
- [ ] `@dexterai/mcp-instructions@2.4.0` typecheck, tests, build, pack dry-run,
      and archive inspection pass.
- [ ] `@dexterai/x402-mcp-tools@0.8.0` typecheck, tests/consumer tests, build,
      no-sourcemap check, pack dry-run, and archive inspection pass.
- [ ] `@dexterai/opendexter@1.23.0-rc.2` typecheck, full tests, build, widget
      copy, pack verification, and archive inspection pass.
- [ ] Each package archive contains its declared version and no escaping
      symlink, credential, source map, `.env`, or undeclared executable.
- [ ] Local dependencies pin instructions `2.4.0` and tools `0.8.0` exactly.

## 2. Installed-graph proof before publication

In a disposable directory, install the three locally packed archives as the
dependency graph a registry install will receive.

- [ ] Start the extracted local stdio server.
- [ ] `initialize` succeeds; the roster-parity guard does not throw.
- [ ] `tools/list` is exactly:
      `x402_search`, `x402_check`, `x402_fetch`, `x402_access`,
      `x402_wallet`, `dexter_portfolio`.
- [ ] `tools/list` contains neither the historical payment alias nor a settings
      tool.
- [ ] Served instructions and `docs://opendexter/workflow` name exactly the
      same six operations.
- [ ] `opendexter settings` still reads and updates an isolated settings file;
      no MCP call can mutate it.
- [ ] Historical CLI payment compatibility, when explicitly tested, reaches
      the same `cliFetch`, signer adapter, policy, and attempt ledger as the
      canonical fetch command.

## 3. Wallet and portfolio separation

Use isolated no-funds fixtures first.

- [ ] Local `x402_wallet` labels
      `local_file_or_environment_payment_signer`.
- [ ] `x402_fetch` and `x402_access` use that same local signer.
- [ ] `dexter_portfolio` accepts an empty input schema and refuses all identity
      selectors.
- [ ] With no connector session, portfolio returns connection-required and
      does not derive holdings from the local key.
- [ ] With a test connector session, portfolio relays only the hosted
      session-bound snapshot and refreshes once on a 401.
- [ ] Portfolio output never changes the local signer, spend policy, or local
      wallet address.
- [ ] Wallet cash, portfolio value, pricing completeness, and available actions
      remain separate fields and are not inferred from one another.

## 4. Fresh public-registry proof after publication

Publish only in the declared order and only after authorization.

- [ ] Registry shows instructions `2.4.0`.
- [ ] Registry shows tools `0.8.0`.
- [ ] A clean registry install of the local RC resolves exactly those versions.
- [ ] Registry tarball integrity matches the reviewed archives.
- [ ] A second clean installed-graph `initialize` and exact-six `tools/list`
      proof passes.
- [ ] The npm `latest` tag is not moved to the RC accidentally; release tags
      are inspected explicitly.

## 5. Live client and renderer smoke

Use disposable client profiles before touching normal profiles.

- [ ] Codex local stdio install starts and discovers exact six tools.
- [ ] Claude Code local stdio install starts and discovers exact six tools.
- [ ] Cursor package install discovers exact six tools and the packaged skills,
      rules, commands, and specialist agent.
- [ ] Search, pricing/check, fetch-result, and wallet widgets load their exact
      packaged assets with no console error or horizontal overflow.
- [ ] Keyboard focus, 44-point/touch targets where applicable, reduced motion,
      loading, refusal, unavailable, degraded, and ambiguous states render.
- [ ] No widget or guidance suggests a retired alias, settings MCP tool,
      private-key paste, or payment from the linked portfolio.
- [ ] Hosted Codex/Claude plugins continue to discover the same six public
      operation names after the local release.

### Dynamic portfolio artwork acceptance

This gate applies to every portfolio asset, not a named-token allowlist.

- [ ] A non-intercepted, production-like run begins with canonical asset
      identity (network, mint/contract, and token program where applicable),
      resolves canonical metadata, tries the metadata image, then tries
      general enrichment fallbacks.
- [ ] Every accepted image completes a real browser fetch and decode; a URL
      string or fixture-backed screenshot is not image proof.
- [ ] The run includes familiar assets such as SOL, USDC, syrupUSDC, DEXTER,
      and SPCX plus arbitrary previously unseen assets.
- [ ] No symbol switch, mint switch, or hand-maintained token-image map decides
      which real artwork appears.
- [ ] A monogram appears only after all real metadata and enrichment sources
      fail. Synthetic fixtures and intercepted image responses do not satisfy
      this acceptance gate.

## 6. Consequential proof gates

These require separate authority and are not part of source publication.

- [ ] Real `opendexter connect` OAuth link and unlink.
- [ ] Real account-bound wallet and portfolio read.
- [ ] One non-paying public search and exact endpoint check.
- [ ] One explicitly approved, bounded payment with the intended local signer.
- [ ] Receipt/finality and ambiguous-result behavior.
- [ ] No duplicate dispatch through CLI compatibility or client retry.
- [ ] Remove the disposable client profile and revoke the test connector
      session without deleting or replacing the user's wallet.

## Candidate evidence recorded before publication

- Shared instructions: typecheck, 25/25 tests, build, and packed archive pass.
- Shared tools: typecheck, build, consumer coverage, no-source-map check, and
  packed archive pass.
- Local package: typecheck, 187/187 deterministic tests pass with three
  explicitly live-only checks skipped, exact hosted-widget build, and packed
  archive pass.
- Package contract: 10/10.
- Disposable installed graph resolves instructions `2.4.0`, tools `0.8.0`,
  local package `1.23.0-rc.2`, x402 core `1.5.0`, MCP SDK `1.30.0`, MCP Apps
  extension `1.7.5`, and Zod `3.25.76`.
- The packed package starts through stdio as `OpenDexter 1.23.0-rc.2`;
  `tools/list` returns the ordered canonical six, the installed instructions
  contain those six and no retired route name, and an unlinked
  `dexter_portfolio` call returns `connector_session_required` without an
  inferred portfolio.

This evidence does not satisfy the registry-publication, real-client,
production artwork, OAuth, signing, or payment checkboxes above.
