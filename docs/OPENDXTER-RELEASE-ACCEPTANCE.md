# OpenDexter release acceptance map

Status: B3 local candidate. This document records inclusion and integration
boundaries; it is not deployment or live-host proof.

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
