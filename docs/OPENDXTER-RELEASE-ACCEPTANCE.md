# OpenDexter release acceptance map

Status: stable `@dexterai/opendexter@1.23.2` source candidate with its public
dependency train reconciled. Public `1.23.1` remains immutable; `1.23.2` is not
yet published. This document records inclusion and integration boundaries; it
is not deployment, registry-install, or live-host proof. The checked-in hosted
receipt names the accepted public MCP release at
`405b87300f8e4babd65b271895cbf960de25facb`, tree
`33e8ce727c591a3fac35f75ecf6ed38f4290e7a9`, artifact-manifest SHA-256
`a039e348612d6f86c0922a068911ba60f731fb1000c61ba1070b84503dd5350a`, and
descriptor SHA-256
`4e094576110306689de83aa901a876e31c9c0decda76c8076263027222a4c038`; that
hosted receipt is independent of local npm publication.

The protected `opendexter-v1.23.0` tag is an immutable failed-release receipt.
Its workflow stopped before artifact creation, upload, or npm publication, and
version `1.23.0` remains absent from npm. Public `1.23.1` is the immutable
cache-invariant recovery release. The `1.23.2` candidate preserves its exact
dependency train and changes the local runtime to use the hosted governed x402
authority exclusively.

## Frozen release-candidate surfaces

The authoritative detailed matrix is
[OPENDEXTER-SURFACE-MATRIX-2026-07-28.md](./OPENDEXTER-SURFACE-MATRIX-2026-07-28.md).

The local npm/stdio product exposes exactly seven operation names:

`x402_search`, `x402_check`, `x402_fetch`, `x402_status`, `x402_access`,
`x402_wallet`, and `dexter_portfolio`. The local runtime proxies those exact
operations to the hosted governed runtime; it does not mount a local signer or
payment executor. Hosted OpenDexter exposes five anonymous entry tools and
twelve after OAuth: the common x402/wallet/portfolio operations plus five
governed asset tools for prepare, execute, status, reconciliation, and history.

Neither surface registers a hidden paid-call alias, compose/promote route,
passkey probe/status tool, or card tool. Existing local wallet files are
preserved for an explicit read-only public-address and balance recovery view;
they are never a payment fallback. Legacy local settings remain an explicit
CLI record and do not govern hosted authority.

The Codex manifest uses its documented inline `mcpServers` map. The separate
Claude package uses Claude's `.mcp.json` `mcpServers` wrapper.
Both point to the one hosted connector at `https://open.dexter.cash/mcp`;
neither package embeds the local stdio runtime or revives hosted card tools.
The publisher-side ChatGPT app
binding stays separate because its current `asdk_app_...` identity is not a
portable Codex/Claude app registration. A current `plugin_asdk_app_...`
registration, if required by the target host, is a publisher proof rather than
something this source candidate may fabricate.

The local package candidate is `@dexterai/opendexter@1.23.2` on Node.js
20 or newer. Its coordinated publication train is:

- `@dexterai/mcp-instructions@2.4.1` — published and reconciled;
- `@dexterai/x402-core@1.5.2` — published and reconciled;
- `@dexterai/x402-mcp-tools@0.8.2` — published and reconciled;
- `@dexterai/opendexter@1.23.2` — source candidate, not yet published.

The clean source graph resolves MCP SDK `1.30.0`, MCP Apps extension `1.7.5`,
and Zod `3.25.76`. The canonical root lock matches the stable source and the
three immutable dependency artifacts. This is local release evidence, not
proof that OpenDexter `1.23.2` exists in npm or is deployed in a user client.

Earlier releases and candidates remain immutable registry bytes. Stable
`1.23.2` requires the committed canonical root lock, clean-archive `npm ci`,
one exact packed artifact, full inventory/hash attestation, normal and
scripts-disabled installs of that artifact, protected GitHub OIDC publication
to `latest`, and post-publication registry-integrity proof. This source lane
does not tag or publish OpenDexter, and local builds do not claim publication.

The local tarball carries the four current widget HTML entrypoints. They load
hashed assets from Dexter's hosted app-asset origin, so successful tarball
inspection is not proof that those exact hashes have been copied to the host.
Asset publication and one clean Codex/Claude/ChatGPT render remain release
proofs after the hosted candidate is deployed.

## Local source receipt

The dated `1.22.2-rc.1` smoke document remains historical evidence. The stable
seven-tool proxy candidate requires a fresh clean-source install, exact tarball
inventory, both normal and scripts-disabled tarball installs, non-paying local
smoke, and later post-publication registry proof.

No source/workspace test may be represented as npm-registry publication, a
clean registry dependency resolution, a user-client install, or live
OAuth/rendering/payment proof.

## Lineage resolution

- Portfolio `023f7fd` is externally verified in the hosted source ancestry; it
  is not an object in this package repository.
- Auth `183609b9` was externally verified as replayed and hardened in the
  hosted candidate; its
  per-tool schemes, protected-resource metadata, runtime challenges, and strict
  finalizer are semantically included rather than cherry-picked again.
- Productization `24530fa2` is an external hosted-source lineage superseded by
  the later hosted/local package contracts. Its old sixteen-tool/card
  assumptions are deliberately excluded.
- The governed money-adapter foundation is preserved in isolated B3 branches,
  unregistered and fail-closed. Its next integration contract is
  [OPENDXTER-GOVERNED-MONEY-ADAPTER.md](./OPENDXTER-GOVERNED-MONEY-ADAPTER.md).

## Governed hosted execution — current slice

Included in this source candidate:

- the exact seven-tool local proxy roster listed above;
- exact `vault` OAuth scope requests, with `dexter_surface` treated only as a
  separately signed authority claim;
- server-owned opaque intents from `x402_check`, followed by a separately
  approved `x402_fetch` call carrying only `intentId` and
  `maxAmountAtomic`;
- `x402_status` recovery for uncertain outcomes before any later dispatch;
- hosted wallet, portfolio, grant, role, capacity, expiry, scope, revocation,
  and payment-source projection;
- fail-closed behavior when that authority evidence is missing or incomplete;
- explicit read-only public-address and balance recovery for an existing local
  wallet file, which is never selected as a payer or fallback.

The hosted governed runtime—not the local package—owns request binding, grant
evaluation, policy enforcement, execution, settlement, and durable receipts.
A non-GET `x402_check` or `x402_access` probe requires separate approval and is
never automatically retried after a possible dispatch. Probe approval is not
payment approval.

Still requiring separate receipts:

- publication and registry reconciliation of this exact `1.23.2` artifact;
- clean installation in supported clients;
- a live authority projection proving the exact active grant and remaining
  capacity for the connected principal;
- one separately approved, one-dispatch payment followed by settlement,
  revocation, and restart-persistence proof.

Until those receipts exist, this document claims source-candidate behavior
only. It does not claim that `1.23.2` is published, that a live grant is active,
or that a paid acceptance run has succeeded.
