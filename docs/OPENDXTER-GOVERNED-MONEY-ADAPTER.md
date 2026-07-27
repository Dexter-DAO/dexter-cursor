# OpenDexter governed-money adapter boundary

Status: preserved integration seam; no executable money tools are registered.

This is the narrow B3 interface that the hosted MCP and local package will
consume after A3/E2 publish one stable, user-scoped backend contract. The
operation names below are adapter methods, not proposed HTTP routes. B3 must not
implement a second trading, signing, submission, or reconciliation engine.

## Current usable boundary

The only current money read that is suitable for OpenDexter is the
session-bound portfolio producer. Its server implementation resolves the
durable MCP binding and stored Swig identity. The adapter sends no wallet
address, user handle, agent label, grant, or Swig identity supplied by a caller.

Current owner-only prepare paths are not enough for delegated agents. A
prepared response that proves no signature, submission, dispatch, or landing is
preparation evidence only. There is not yet a complete user-scoped
approve/execute/status/reconcile/history contract for B3 to register.

## Interface B3 will consume

All identifiers and policy evidence are issued or resolved by the common
backend. Atomic amounts, decimal amounts, prices, and totals remain strings.

```ts
type MoneyAction = "send" | "buy" | "sell";
type ViewerRole = "owner" | "delegated_agent";

interface PreparedIdentity {
  intentId: string;
  idempotencyKey: string;
  preparationRevision: string;
  requestDigest: string;
}

interface BoundAuthority {
  ownerSubject: string;
  actorSubject: string;
  viewerRole: ViewerRole;
  grant:
    | null
    | {
        grantId: string;
        revision: string;
        policyDigest: string;
      };
}

interface PrepareInput {
  action: MoneyAction;
  network: string;
  asset: string;
  amountAtomic: string;
  maximumAmountAtomic: string;
  quoteId?: string;
  routeId?: string;
}

interface ExecuteInput {
  prepared: PreparedIdentity;
  approvalId?: string;
}

interface GovernedMoneyBackend {
  portfolioRead(): Promise<PortfolioSnapshotV1>;
  intentPrepare(input: PrepareInput): Promise<PrepareResult>;
  intentApprove(prepared: PreparedIdentity): Promise<ApprovalResult>;
  intentExecute(input: ExecuteInput): Promise<ExecutionResult>;
  intentStatus(prepared: PreparedIdentity): Promise<ExecutionResult>;
  intentReconcile(prepared: PreparedIdentity): Promise<ExecutionResult>;
  historyList(input: {
    cursor?: string;
    limit?: number;
  }): Promise<UnifiedHistoryPage>;
}
```

The transport may use different field or route names, but it must carry all of
the evidence above without allowing the MCP caller to choose its authority.

## Required backend behavior

- `portfolioRead` fails closed as available, partial, or unavailable; missing
  data never becomes zero assets.
- `intentPrepare` durably binds the actor, grant revision, policy decision,
  action, asset, network, exact atomic amount, ceiling, quote/route, request
  digest, expiry, intent ID, and idempotency key.
- `intentApprove` records the authenticated owner's approval or escalation
  decision against the same prepared identity.
- `intentExecute` atomically revalidates grant revision and policy, claims the
  intent, and records pending before the protected Vault executor is called.
- `intentStatus` is read-only. `intentReconcile` investigates an ambiguous
  dispatch; neither operation creates a new attempt.
- `historyList` returns one ordered owner-and-agent history with actor role,
  grant evidence when applicable, intent/correlation IDs, action, asset,
  network, exact amount, outcome, timestamps, and settlement evidence.

## Truthful result contract

Execution results are a discriminated union. They distinguish:

- `refused` and `approval_required`, both with exact nonexecution evidence;
- `ready` and `claimed`, before external dispatch;
- `signed`, `broadcast`, and `ambiguous`, after consequential work may have
  begun;
- `confirmed`, with terminal settlement evidence;
- `provably_not_landed`, with backend reconciliation evidence.

No result after signing or dispatch exposes an automatic retry instruction.
Only a new, explicitly prepared intent can create another consequential
attempt. A changed or revoked grant fails before execution.

## Registration gate

B3 registers these operations only after A3/E2 provide:

1. a committed common contract and user-scoped transport;
2. authenticated principal and durable session-binding evidence;
3. grant revision and policy enforcement at prepare and execute;
4. protected Vault execution, ambiguity handling, and reconciliation;
5. unified owner-and-agent history and typed receipt fixtures.

Until then, the captain-accepted adapter foundation stays preserved on its
isolated branch and remains absent from both hosted and local tool rosters.
Its earlier test receipt is external to this documentation commit; this
release candidate does not claim to revalidate or register it.
