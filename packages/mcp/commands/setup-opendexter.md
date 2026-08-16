---
name: setup-opendexter
description: Configure the local OpenDexter proxy and verify its hosted-only seven-tool surface.
---

# Install OpenDexter MCP

Set up the local proxy for OpenDexter's hosted governed x402 runtime. Setup
never creates or enables a local payment wallet.

## Steps

1. Run the guided installer:

```bash
npx @dexterai/opendexter@1.24.0-rc.0 setup
```

To target one client:

```bash
npx @dexterai/opendexter@1.24.0-rc.0 install --client cursor
```

Supported client names are `cursor`, `claude-code`, `codex`, `vscode`,
`windsurf`, and `gemini-cli`. Codex uses TOML, so the installer prints its
exact block instead of editing it.

2. Connect the proxy to the hosted governed runtime:

```bash
npx @dexterai/opendexter@1.24.0-rc.0 connect
npx @dexterai/opendexter@1.24.0-rc.0 connect status
```

The connection stores an OAuth bearer. It does not by itself prove an active
grant. The bearer targets `https://open.dexter.cash/mcp` with exact requested
scope `vault`. Dexter's signed top-level dexter_surface token claim is
separate authority evidence, not a requested OAuth scope. Status must report the exact live grant, principal,
limits, remaining capacity, expiry, scopes, active role, and revocation evidence
before payment authority is treated as active.

3. Verify `tools/list`. The exact roster is:

`x402_search`, `x402_check`, `x402_fetch`, `x402_status`, `x402_access`,
`x402_wallet`, and `dexter_portfolio`.

4. Test the anonymous non-paying path:

```text
x402_search({"query":"extract tables from a PDF"})
```

Then call `x402_check` for the selected exact URL, method, and body. A search
result does not authorize payment. A non-GET check needs separate approval for
that exact probe; probe approval is not payment approval, and the request is
never automatically retried after possible dispatch.

5. For a paid action, use a connected check. Keep its returned `intentId`
opaque, show the exact current terms, obtain approval for
`maxAmountAtomic`, and call `x402_fetch` once with only those two fields.

If the fetch result is uncertain, call `x402_status` with the same `intentId`.
Never retry the consequential fetch merely because its result or bearer
response was ambiguous.

## Authority boundary

The local process never derives or enables a file or environment private key
to pay or prove identity. There is no local executor or fallback. `x402_wallet`,
`dexter_portfolio`, `x402_fetch`, and `x402_status` require the connected
bearer.

`x402_access` is separate: it starts one fresh anonymous legacy wallet-proof
context per call. It is not Dexter OAuth, not governed payment authority, and
does not preserve continuity across calls. The proxy accepts and persists no
access-session credentials. A non-GET request needs separate approval for that
exact one-call request and is never automatically retried.

`opendexter wallet --legacy-recovery` parses an existing legacy JSON file but
returns only validated public addresses and balances. It never derives,
returns, exports, or enables private-key fields as a signer and cannot satisfy
an account-bound tool.

Manage or revoke the hosted grant at `https://dexter.cash/wallet`.
