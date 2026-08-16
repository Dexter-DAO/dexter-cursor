# Changelog

## 2026-08-16 — stable 1.23.3 governed x402 payment authority

- Prepared one combined OpenDexter `0.6.1` plugin for ChatGPT and Codex with
  the current owner-created app binding, the hosted MCP descriptor, and the
  existing hosted skills in one package. This is source packaging only; the
  package must still be installed explicitly and source packaging does not
  claim publisher submission or public availability.
- Made the hosted OpenDexter workflow client-neutral and canonical for
  ChatGPT, Codex, and Claude Code. Claude `2.1.1` carries deterministic copies
  of the shared hosted files, while the materially different seven-tool local
  npm/stdio workflow remains separate.
- Expanded implicit skill triggers for ordinary requests such as "Do I have a
  Dexter Wallet?", "What is in my wallet?", and paid-API jobs that do not name
  OpenDexter, without weakening exact-term approval or no-retry boundaries.
- Updated the connected wallet projection to accept only the hosted governed
  payment-authority v2 contract: agent authority for Solana-mainnet USDC,
  action `pay`, protocol `x402` version `2`, and the exact ordered scheme set
  `exact`, `tab` for any valid x402 seller.
- Kept the client fail-closed for owner authority, the legacy v1/`send`/
  `x402-exact-v2` tuple, missing or future protocol versions, and partial,
  reordered, Bridge, or otherwise widened scheme sets. Wallet balances and
  connector authentication still never imply payment authority.
- Re-materialized the public hosted receipt from current
  `https://open.dexter.cash/health`; it reproduces the already accepted hosted
  MCP commit, tree, source archive, and public tool/OAuth descriptor exactly.
- Preserved the immutable dependency train at
  `@dexterai/mcp-instructions@2.4.1`, `@dexterai/x402-core@1.5.2`, and
  `@dexterai/x402-mcp-tools@0.8.2` through the canonical root lock.
- Public `@dexterai/opendexter@1.23.2` is immutable on npm.
  `@dexterai/opendexter@1.23.3` is the new source candidate and remains
  unpublished until its protected release gates, clean install, and registry
  reconciliation complete.

## 2026-08-05 — stable 1.23.2 governed-runtime convergence

- Replaced the local OpenDexter payment executor with one OAuth-connected
  proxy to the hosted governed x402 runtime. Connected checks create opaque
  server-owned intents; fetch executes only an exact intent plus a separately
  approved atomic ceiling; status is the no-blind-retry recovery path.
- Made wallet authority explicit. Wallet and connection status now distinguish
  connector authentication from active bounded payment authority and expose
  the live grant, limits, remaining capacity, expiry, role, revocation, source,
  and disabled fallback state when the server supplies that evidence.
- Preserved existing `wallet.json` files without deleting, moving, repairing,
  transferring, or loading their signers. `wallet --legacy-recovery` is an
  explicit read-only public-address and balance view; there is no automatic or
  opt-in local payment fallback. An in-product transfer migration is deferred
  and does not block this release.
- Corrected method truth for hosted probes: non-GET `x402_check` and
  `x402_access` requests may cause seller-side effects and require separate
  explicit request authorization before any later payment approval.
- Public `@dexterai/opendexter@1.23.1` remains immutable. Version `1.23.2`
  completed its protected release gates and is now the immutable public npm
  release superseded by the `1.23.3` source candidate above.

## 2026-08-04 — stable 1.23.1 release recovery

- Advanced the unchanged OpenDexter product and reconciled dependency train to
  `@dexterai/opendexter@1.23.1` after the protected `opendexter-v1.23.0`
  workflow stopped before artifact creation, upload, or npm publication.
- Preserved the signed `opendexter-v1.23.0` tag as the immutable failed-release
  receipt. Version `1.23.0` remains absent from npm and is not being rewritten.
- Made the reviewed Node/npm toolchain inventory invariant to disposable Python
  bytecode caches while continuing to reject symlinks, hard links, and special
  files. The package behavior, dependency pins, and accepted hosted MCP receipt
  remain unchanged.
- OpenDexter `1.23.1` remains an unpublished source candidate until its new
  signed tag passes the protected OIDC workflow and environment review.

## 2026-08-04 — stable 1.23.0 source candidate

- Reconciled the immutable public dependency train:
  `@dexterai/mcp-instructions@2.4.1`, `@dexterai/x402-core@1.5.2`, and
  `@dexterai/x402-mcp-tools@0.8.2`, including truthful dual ESM/CommonJS
  package contracts and exact registry integrity.
- Pinned `@dexterai/opendexter@1.23.0` to that train and regenerated its one
  canonical root lock. OpenDexter remains unpublished; its protected
  latest-channel publication and fresh registry install are still outstanding.
- Preserved the prior accepted hosted MCP receipt without rewriting it. The
  hosted refresh remains pending deployment and acceptance of current MCP
  source, after which the exact live receipt will be finalized separately.
- Preserved canonical strong/related search tiers and surfaced degraded-ranking
  truth instead of rebuilding or truncating the shared search response.
- Added a provider-neutral Gateway readiness/execution seam while preserving
  `opendexter.purchase.v1`, the unchanged prepared purchase, exact seller
  offer, approved atomic ceiling, durable claim, and mode-specific receipt.
- Made client collision checks complete before setup can create a wallet or
  edit client configuration. Added an explicit single-registration name and a
  read-only doctor that never creates a wallet, checks a balance, or pays.
- Clarified that search and live price checks require no wallet or funding. A
  configured signer or ready adapter is capability, never payment approval.

## 2026-08-01 — immutable RC.3 release-control successor

- Advanced the local candidate to `@dexterai/opendexter@1.23.0-rc.3` because
  RC.2 is already immutable registry content with different bytes.
- Added one committed root lock and prohibited conflicting nested workspace
  locks.
- Made plain publication fail closed unless an exact clean-source tarball,
  complete file/hash inventory, accepted review, ordinary-language routing
  evidence, hosted-source descriptor, and explicit prerelease tag agree.
- Added exact-artifact normal and scripts-disabled install gates plus a
  post-publication `dist.integrity`/`dist.shasum` verification seam.
- Corrected surface language: local remains six tools; hosted has five
  anonymous entry tools and twelve after OAuth. A hosted authenticated
  `x402_check` makes no payment but persists one exact quote/request intent.

## 2026-08-01 — hosted twelve-tool plugin candidate

- Prepared Codex `0.5.0` and Claude Code `2.1.0` guidance for the source-pinned
  hosted manifest `0.5.0` contract without publishing or installing either
  package.
- Recorded the exact five-tool anonymous roster and seven-tool OAuth promotion,
  yielding twelve connected tools across x402, wallet, portfolio, and governed
  Send, Buy, and Sell.
- Kept assets generic through the canonical server-approved `assetId`; owner
  mandate enrollment, extension, escalation, and signing remain outside
  model-callable tools.
- Kept compatibility aliases, card, passkey-status, marketplace-composition,
  diagnostics, and public authorization out of active routing.

## 2026-07-28 — hosted exact-six contract fixture

- Prepared `@dexterai/opendexter@1.23.0-rc.2` without changing local tool
  handlers, wallet/payment semantics, or its pinned instruction/tool
  dependencies.
- Updated the shipped hosted contract reference to the exact six raw tools:
  `x402_search`, `x402_check`, `x402_fetch`, `x402_access`, `x402_wallet`, and
  `dexter_portfolio`.
- Removed the five retired compatibility registrations from the fixture and
  package-contract expectations so Codex, Claude, ChatGPT, Cursor, Hermes, and
  generic MCP documentation no longer describe an eleven-tool hosted surface.
- Made CLI upgrade notices name the exact discovered version instead of a
  floating npm tag, and removed the unused settings-tool registrar while
  preserving `opendexter settings` as a local CLI command.
- Kept `@dexterai/mcp-instructions@2.4.0` and
  `@dexterai/x402-mcp-tools@0.8.0` unchanged; this RC patch does not republish
  either dependency.

## 2026-07-28 — local six-tool convergence candidate

- Prepared `@dexterai/opendexter@1.23.0-rc.1` with the same six
  model-facing operation names as hosted OpenDexter.
- Removed the historical payment alias and filesystem settings mutation from
  the local MCP roster. The existing CLI compatibility path and
  `opendexter settings` command remain on the same signer, policy, and attempt
  implementation.
- Added the read-only linked `dexter_portfolio` surface without changing the
  local file/environment payment signer.
- Prepared the required publication train in order:
  `@dexterai/mcp-instructions@2.4.0`,
  `@dexterai/x402-mcp-tools@0.8.0`, then
  `@dexterai/opendexter@1.23.0-rc.1`.
- This entry records a source candidate. None of those three versions is
  represented as published until registry and fresh-client proof completes.

## 2026-07-28 — hosted plugins

- Released Codex `0.4.0` and Claude Code `2.0.0` for the hosted OpenDexter
  contract, including the authenticated, session-bound `dexter_portfolio`
  read.
- Reduced the public model-facing product to six tools. Five dated
  compatibility endpoints remain raw app-only so existing clients do not
  break, but they are absent from product routing and agent instructions.
- Replaced the Claude Code npm-latest launcher with the remote HTTP MCP at
  `https://open.dexter.cash/mcp`.
- Materialized Claude Code skills inside the package; removed escaping
  symlinks to the older local SDK/tooling lineage.
- Removed hosted card and local settings routes from active package guidance.
- Kept the published Claude installer on the local seven-tool stdio MCP instead
  of silently installing the separate hosted package.
- Added release-pinned OAuth/tool drift tests and disposable marketplace
  discovery validation.
- Retired the v0.3.0 sixteen-tool model reports from active release evidence.
- Prepared `@dexterai/mcp-instructions@2.3.0`,
  `@dexterai/x402-mcp-tools@0.7.1`, and
  `@dexterai/opendexter@1.22.2-rc.1` as one ordered local release candidate.
- Made the local package rebuild its four declared widgets from an explicitly
  pinned source and validate the exact packed tarball without a registry,
  client install, network request, or live wallet.

## 1.4.0

- Moved `@dexterai/opendexter` and `@dexterai/x402-discovery` npm package source into this repo
- Added npm workspaces monorepo structure (`packages/mcp/`, `packages/x402-discovery/`)
- Skills, rules, agents, and commands are now a single source of truth in `packages/mcp/`
- Plugin directories (`opendexter-plugin/`) symlink to `packages/mcp/` — no more manual sync
- Widget HTML files committed as static assets with sibling-repo auto-detection fallback
- Updated all docs for new repo structure

## 1.1.0

- Bumped plugin version for CC update propagation
- Skills audit: all 6 skills synced against SDK v3.0.1 source
- Merged x402-marketplace skill content into opendexter skill (6 skills total)
- Added MCP server instructions and 3 skill resources to hosted server
- Fixed CC installer to use CC CLI instead of raw JSON manipulation
- Added full Cursor plugin installer (skills + rules + agents + commands)

## 1.0.0

- Initial release
- 6 skills: opendexter, x402-client, x402-server, x402-react, x402-protocol, x402-debugging
- 2 always-on rules: x402-protocol, x402-coding
- 1 agent: x402-engineer
- 3 commands: setup-opendexter, setup-x402-client, setup-x402-server
- Ships with @dexterai/opendexter MCP server (x402_search, x402_fetch, x402_check, x402_wallet, x402_pay, x402_access, x402_settings)
