# OpenDexter release acceptance map

Status: B3 local candidate. This document records inclusion and integration
boundaries; it is not deployment or live-host proof.

## Frozen release-candidate surfaces

The authoritative detailed matrix is
[OPENDEXTER-SURFACE-MATRIX-2026-07-28.md](./OPENDEXTER-SURFACE-MATRIX-2026-07-28.md).

Hosted and local MCP products expose exactly six operation names:

`x402_search`, `x402_check`, `x402_fetch`, `x402_access`, `x402_wallet`, and
`dexter_portfolio`.

Neither surface registers a hidden paid-call alias, compose/promote route,
passkey probe/status tool, or card tool. Local spending settings remain an
explicit CLI action, not an MCP tool.

The Codex manifest uses its documented inline `mcpServers` map. The separate
Claude package uses Claude's `.mcp.json` `mcpServers` wrapper.
Both point to the one hosted connector at `https://open.dexter.cash/mcp`;
neither package embeds the local stdio runtime or revives hosted card tools.
The publisher-side ChatGPT app
binding stays separate because its current `asdk_app_...` identity is not a
portable Codex/Claude app registration. A current `plugin_asdk_app_...`
registration, if required by the target host, is a publisher proof rather than
something this source candidate may fabricate.

The local package candidate is `@dexterai/opendexter@1.23.0-rc.2` on Node.js
20 or newer. Its coordinated publication train is:

- `@dexterai/x402-core@1.5.0`;
- `@dexterai/mcp-instructions@2.4.0`;
- `@dexterai/x402-mcp-tools@0.8.0`;
- `@dexterai/opendexter@1.23.0-rc.2`.

The B3 disposable installed-graph proof resolved MCP SDK `1.30.0`, MCP Apps
extension `1.7.5`, and Zod `3.25.76`. This is local test evidence, not proof of
registry availability or a deployed graph; the hosted registry lock must
reproduce those exact runtime versions before deployment.

Registry publication and a registry-resolved lock are separate release gates.
Local source builds and tarball inspection do not claim those packages are
already available from npm.

The local tarball carries the four current widget HTML entrypoints. They load
hashed assets from Dexter's hosted app-asset origin, so successful tarball
inspection is not proof that those exact hashes have been copied to the host.
Asset publication and one clean Codex/Claude/ChatGPT render remain release
proofs after the hosted candidate is deployed.

## Local source receipt

The prior `1.22.2-rc.1` evidence is superseded for publication purposes by the
six-tool candidate. The required current proof is tracked in
[OPENDEXTER-LOCAL-RELEASE-SMOKE-2026-07-28.md](./OPENDEXTER-LOCAL-RELEASE-SMOKE-2026-07-28.md).

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

## Universal Purchasing Parity — current slice

Included in this candidate:

- explicit `direct_exact`, `native_tab`, `gateway_cash`, and
  `gateway_credit` wire modes;
- complete seller-offer witness, original/resolved route, request digest,
  network, asset, exact atomic amount, ceiling, and prepared identity;
- durable local preparation and attempt claims;
- no cross-mode fallback after selection or consequential dispatch;
- mode-specific receipts and reconciliation-only ambiguous outcomes;
- aligned local MCP/CLI and hosted Codex/Claude package guidance.

Integration-gated:

- hosted durable preparation and execution owned by A3;
- Gateway cash/credit adapters in the common backend;
- real ChatGPT, Claude, and Codex host proof after A3 integrates the contract;
- publication, installation on user clients, deployment, and money movement.

The hosted candidate reports explicit modes as `integration_required` until the
common backend is connected. B3 does not create a second server or payment
engine to bypass that gate.

## Named follow-on: Governed Agent Money Surface

Portfolio, Send, Buy, and Sell on OpenDexter/MCP/plugin surfaces are required
for delegated agents, but are deliberately deferred until E2/A3's branch is
integrated. This follow-on must reuse the exact common wallet/trading backend:

- E2/A3 portfolio and trade contracts;
- durable intents and idempotency identities;
- common policy checks and approval/escalation;
- D4's protected Vault executor;
- ambiguous-result handling, reconciliation, and typed receipts;
- one owner-and-agent wallet history.

OpenDexter must not add a separate trading engine, direct Vault signing path, or
plugin-only balance/history store.

### Minimum common API contract required by B3

Every request derives the wallet/account from the authenticated MCP session and
durable binding. Caller-supplied wallet addresses, user handles, agent labels,
or Swig identities are never authoritative.

The common backend must expose user-scoped equivalents of:

1. `portfolio.read`
   - exact decimal strings and inventory/pricing completeness;
   - spendable, portfolio value, earning positions, and obligations remain
     separate.
2. `intent.prepare`
   - durable `intentId`, `idempotencyId`, actor identity, grant revision,
     action, asset, network, exact amount/ceiling, quote/route, expiry, and
     policy decision.
3. `intent.approve`
   - owner approval or escalation state tied to that same intent identity.
4. `intent.execute`
   - atomically re-checks grant revision and policy, claims the intent, and
     enters pending before calling the protected D4 executor.
5. `intent.status` and `intent.reconcile`
   - distinguish not dispatched, dispatched, settled, rejected, and unknown;
     uncertain settlement never authorizes automatic retry.
6. `history.list`
   - one ordered history for owner and delegated actions, including actor role,
     agent/grant ID when applicable, intent/correlation IDs, action, network,
     asset, exact amount, state, timestamps, and settlement identifier.

### Grant and policy evidence required

Agent identity binds to a revocable owner grant. The prepare and execute
responses must identify the owner, delegated agent, grant ID/revision, and
viewer role. The backend—not plugin copy—enforces:

- allowed assets and actions;
- per-action amount and ceiling;
- daily limits;
- risk limits;
- expiry and revocation;
- owner approval or escalation when required.

A revoked or changed grant fails before execution. Owner and agent activity
must not appear as separate wallets or separate histories.

### Collision owners

- E2/A3: integrate the common portfolio/trade API and durable intent contract.
- D4: protected Vault execution contract and receipt/finality evidence.
- B3: host/plugin schemas, approval presentation, action routing, ambiguity
  presentation, receipts, and unified history UI after the common contract is
  integrated.

B3 must not implement this follow-on against an unintegrated E2 branch.
