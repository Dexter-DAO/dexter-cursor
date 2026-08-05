# OpenDexter governed x402 workflow

The local `@dexterai/opendexter` MCP is a proxy to OpenDexter's hosted governed
runtime. It exposes exactly seven tools and never derives or enables a local
private key for payment or identity proof. Search and check can use the anonymous hosted
surface. Access is a separate anonymous fresh one-call legacy wallet-proof
operation, not OAuth/governed authority, and has no cross-call continuity.
Every account-bound operation requires the OAuth bearer created by
`opendexter connect`. Its audience is `https://open.dexter.cash/mcp` and its
exact requested scope is `vault`. Dexter's signed top-level dexter_surface
token claim is separate authority evidence, not a requested OAuth scope. No
local executor or fallback exists.

## Exact roster

| Tool | Role | Connection |
|---|---|---|
| `x402_search` | Search the hosted catalog by job | Optional |
| `x402_check` | Read exact current terms and, when connected, one opaque intent | Optional |
| `x402_fetch` | Execute exactly one governed server-owned intent | Required |
| `x402_status` | Read the same intent after uncertain or completed execution | Required |
| `x402_access` | Use one fresh anonymous legacy SIWX wallet-proof context; no continuity | No |
| `x402_wallet` | Read hosted wallet and exact authority evidence | Required |
| `dexter_portfolio` | Read the connected governed asset inventory | Required |

The server's `tools/list` result is authoritative. There are no settings,
payment-alias, card, or local-executor MCP tools.

## Safe sequence

1. Use `x402_search` for the user's actual job. A catalog result and advertised
   price are not payment authorization.
2. While connected, call `x402_check` for the exact URL, method, and request
   body. Checking does not make an x402 payment, although a non-GET probe can
   still mutate provider state. Obtain separate approval for that exact probe;
   probe approval is not payment approval. A dispatched non-GET probe is never
   auth-refreshed and retried automatically.
3. Keep the returned `intentId` opaque. Present the exact current terms and
   obtain approval for a separate atomic-unit ceiling.
4. Call `x402_fetch` once with only `intentId` and `maxAmountAtomic`.
5. If the result is uncertain, call `x402_status` with that same `intentId`.
   Never repeat the fetch merely because its result was lost or authentication
   was rejected.

The hosted server binds the intent to the URL, body, seller, route, asset, and
amount. The client must not parse, reconstruct, replace, or widen it. The
atomic ceiling does not authorize a different action.

## Route by intent

- Find a capability → `x402_search`, then check the selected route.
- Read a URL's current terms → `x402_check`.
- Execute a paid action → connected `x402_check`, explicit approval, then one
  `x402_fetch` with the opaque intent and ceiling.
- Reconcile an ambiguous action → `x402_status` with the same intent.
- Access an SIWX-protected resource → `x402_access` as one fresh anonymous
  legacy wallet-proof operation, separate from OAuth/governed authority.
- Read deposit, balance, or exact authority evidence → `x402_wallet`.
- Read the connected governed asset inventory → `dexter_portfolio`; portfolio
  value is not spendable-cash proof.

## Search and check

Search responses can include match evidence, quality and verification state,
advertised prices and networks, and structured input/output evidence. Present
strong matches before related matches. A degraded ranking is a live fallback,
not an empty catalog and not proof that the first result is best.

An anonymous check can inspect terms. Only a connected check can return an
account-bound intent for later execution. A previous check or cached price is
not current payment approval.

## Fetch and status

Before a fetch, require all of the following:

- the account-bound OAuth bearer;
- complete live active bounded-authority evidence;
- the opaque `intentId` from the current connected check;
- the exact seller, action, asset, amount, and relevant provider terms shown to
  the user;
- explicit current approval for `maxAmountAtomic`.

The consequential fetch never auth-refreshes and retries after possible
dispatch. A timeout, transport failure, or bearer rejection can hide a
completed payment or provider mutation. The only safe next step is the
read-only status call for the same intent. Do not create a replacement intent
or fetch again until status proves another action is safe and the user approves
it.

## One-call legacy access

Use the access tool only when current route requirements call for SIWX. Every
call starts one fresh anonymous hosted wallet-proof context. It is not Dexter
OAuth, not the connected governed payment wallet, and does not preserve
continuity across calls. The proxy accepts and persists no access-session
credentials. It does not use a local file or environment key, and it does not
bypass a charge. A non-GET access request needs separate approval for that
exact one-call request and is never automatically retried after possible
dispatch.

## Authority truth

A connect bearer proves account authorization only. It does not prove an
active grant, active on-chain role, or remaining capacity.

Treat `runtimeAuthority` as active only when the exact live evidence reports a
complete active bounded-payment tuple: authority source, grant and revision,
logical state, principal, limits and internally consistent remaining capacity,
expiry, scopes, active role, revocation, and no fallback. Missing evidence is
unavailable. Never infer authority from a balance, address, bearer claim, or
portfolio field.

Manage or revoke authority at `https://dexter.cash/wallet`.

## Legacy recovery

The only legacy file surface is:

```bash
opendexter wallet --legacy-recovery
```

It parses an existing JSON file, validates its public addresses, and returns
only those addresses and balance reads. It never creates, migrates, repairs,
derives, returns, exports, or enables private-key fields as a signer. It cannot
satisfy any account-bound tool and is never a fallback.

Legacy local settings have no effect on the hosted grant or its limits.

## Failure handling

- A backend error is not an empty catalog.
- A disconnected account-bound operation requires `opendexter connect`; do not
  substitute another signer.
- Unavailable authority or balance data stays unavailable, not zero.
- A price above the approved ceiling requires a newly reviewed action.
- An uncertain fetch is status-only until reconciled.

## Separate SDK boundary

The `@dexterai/x402` SDK can be used to build an independent
application-owned payment client. It is not the OpenDexter MCP runtime, does
not inherit its OAuth bearer or grant, and must never be used as a hidden
fallback when an OpenDexter tool is disconnected or unavailable.

## References

- `docs://opendexter/protocol` — generic x402 protocol details; not an
  OpenDexter executor contract
- `docs://opendexter/debugging` — SDK diagnostics plus the OpenDexter
  status-only recovery boundary
