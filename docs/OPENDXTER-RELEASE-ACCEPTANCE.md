# OpenDexter release acceptance map

Status: `@dexterai/opendexter@1.24.0-rc.2` is a Node.js 22 x402 V6 source
candidate for `@dexterai/x402@6.0.0-rc.3`. Public prereleases
`@dexterai/opendexter@1.24.0-rc.1`,
`@dexterai/x402-mcp-tools@0.9.0-rc.0`, and
`@dexterai/x402-discovery@1.1.0-rc.0` are immutable on npm under `next`; their
stable `latest` tags remain unchanged. The rc.2/rc.1 successor train in this
source is not yet published. This document records inclusion and integration
boundaries; it is not deployment, registry-install, or live-host proof. The
checked-in historical hosted receipt names the previously accepted MCP release at
`7e7b3d0d49459567fba66531e8e2f7daa83d5587`, tree
`ae18395cc5b4fab267cc50e6fd5a6aebdb662abc`, artifact-manifest SHA-256
`43f40ec43fa81ff9f3c82e4dbb9dc700015341a4a86b80372cdde4713eacd3cd`, and
descriptor SHA-256
`52a10cdab9391abec0422c86616a10d3669ab0a16fba8a2d8082281a21624d7c`. It is
not acceptance for this successor. A fresh hosted receipt and release bytes
must wait until the confirmed-fast API commit `6c243` and its compatible
facilitator are live and proven; this source preparation does not generate
either artifact.

The protected `opendexter-v1.23.0` tag is an immutable failed-release receipt.
Its workflow stopped before artifact creation, upload, or npm publication, and
version `1.23.0` remains absent from npm. Public `1.23.1` is the immutable
cache-invariant recovery release. Public `1.23.2` moved the local runtime to
the hosted governed x402 authority exclusively. Public `1.23.3` kept that
dependency train and recognizes only its exact v2 payment-authority contract.
The protected `opendexter-v1.24.0-rc.0` tag is also an immutable failed-release
receipt: its workflow rejected a stale `latest` release-policy pin before
building or publishing, and that npm version remains absent. The reviewed
`1.24.0-rc.1` release binds its prerelease workflow explicitly to `next` and
adds the local x402 V6 and Native Tab V2 migration. The rc.2 successor updates
that client train to x402 rc.3 without changing or claiming the historical
hosted MCP receipt.

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

The combined ChatGPT/Codex package uses a path-based `.mcp.json`, packages the
canonical hosted skill tree, and binds the verified owner-created registration
`plugin_asdk_app_6a7557267fb88191bc336aa99bf5bf03` through `.app.json`. The
separate Claude package uses Claude's `.mcp.json` wrapper and generated copies
of the same hosted workflow files. Both point to the one hosted connector at
`https://open.dexter.cash/mcp`; neither package embeds the local stdio runtime
or revives hosted card tools. Source packaging is not proof that an existing
app-only ChatGPT installation has been updated, submitted, or published.

The local package candidate is `@dexterai/opendexter@1.24.0-rc.2` on Node.js
22 or newer. Its coordinated source train is:

- `@dexterai/mcp-instructions@2.4.1` — published and reconciled;
- `@dexterai/x402-core@1.5.2` — published and reconciled;
- `@dexterai/x402@6.0.0-rc.3` — published on the `next` dist-tag;
- `@dexterai/vault@0.43.2` — published and required as x402's exact peer;
- `@dexterai/x402-mcp-tools@0.9.0-rc.1` — source candidate, not published;
- `@dexterai/opendexter@1.23.3` — published and immutable;
- `@dexterai/opendexter@1.24.0-rc.1` — published and immutable under `next`;
- `@dexterai/opendexter@1.24.0-rc.2` — source candidate, not published;
- `@dexterai/x402-discovery@1.1.0-rc.1` — source alias candidate pinned to
  this exact OpenDexter candidate, not published.

All three RC package manifests are restricted to the `next` dist-tag. None is
eligible for `latest` while its version remains a prerelease.

The clean source graph resolves MCP SDK `1.30.0`, MCP Apps extension `1.7.5`,
and Zod `3.25.76`. The canonical root lock matches the local RC source and its
published and source-candidate dependency versions. This is local release
evidence for the successor workspace and registry evidence only for x402
rc.3. It is not proof that the new MCP tools or OpenDexter candidates exist in
npm or that either is deployed in a user client.

Earlier releases and candidates remain immutable registry bytes. The
`1.24.0-rc.2` candidate requires the committed canonical root lock,
clean-archive `npm ci`,
one exact packed artifact, full inventory/hash attestation, normal and
scripts-disabled installs of that artifact, protected GitHub OIDC publication
to `next`, and post-publication registry-integrity proof. This source lane
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
- recognition of only the v2 agent payment-authority tuple for Solana-mainnet
  USDC, action `pay`, protocol `x402` version `2`, and the exact ordered
  `exact`, `tab` scheme set for any valid x402 seller;
- fail-closed behavior when that authority evidence is missing or incomplete;
- explicit read-only public-address and balance recovery for an existing local
  wallet file, which is never selected as a payer or fallback.

The hosted governed runtime—not the local package—owns request binding, grant
evaluation, policy enforcement, execution, settlement, and durable receipts.
A non-GET `x402_check` or `x402_access` probe requires separate approval and is
never automatically retried after a possible dispatch. Probe approval is not
payment approval.

Still requiring separate receipts:

- publication and registry reconciliation of exact
  `@dexterai/x402-mcp-tools@0.9.0-rc.1`, followed by this exact
  `@dexterai/opendexter@1.24.0-rc.2` artifact;
- clean installation in supported clients;
- a live authority projection proving the exact active grant and remaining
  capacity for the connected principal;
- one separately approved, one-dispatch payment followed by settlement,
  revocation, and restart-persistence proof.

Until those receipts exist, this document claims source-candidate behavior
only. It does not claim that `1.24.0-rc.2` is published, that a live grant is
active, or that a paid acceptance run has succeeded.
