# OpenDexter local architecture

`@dexterai/opendexter` is the local CLI and stdio MCP distribution. It shares
the same six model-facing operation names as hosted OpenDexter:

```text
x402_search  x402_fetch  x402_check
x402_access  x402_wallet  dexter_portfolio
```

Matching names do not mean matching custody.

## Local authority

- `x402_fetch`, `x402_access`, and `x402_wallet` use the local Solana/EVM
  wallet loaded from environment variables or
  `~/.dexterai-mcp/wallet.json`.
- `x402_check` uses the actual local signer and Tab capabilities when it marks
  a purchase mode ready.
- Local spending policy is stored in
  `~/.dexterai-mcp/settings.json` and changed explicitly with
  `opendexter settings`. It is not an MCP tool.

## Linked Dexter account

`opendexter connect` stores a short-lived OAuth connector session. The local
package uses that session only for read-only hosted-account views:

- the `opendexter wallet` CLI can display the linked Dexter Wallet;
- `dexter_portfolio` returns the linked account's governed asset inventory.

The connector session never replaces, exports, or gains access to the local
payment signer. A portfolio response therefore proves neither local signing
authority nor permission to spend from the linked Dexter Wallet.

## Hosted distribution

The Codex and Claude plugins connect directly to
`https://open.dexter.cash/mcp`. Hosted wallet, portfolio, and payment operations
are bound to the authenticated Dexter Wallet session. They do not read the
local package's key file.

The hosted release contract and local npm package each expose exactly the
canonical six MCP tools. Neither contract has a hidden paid-call alias,
compose/promote route, passkey probe/status tool, or settings tool.

## Paid-call state

New paid calls follow one prepared identity:

1. `x402_check` records one exact URL, method, request digest, seller offer,
   route, mode, network, asset, and amount.
2. The user approves the atomic ceiling.
3. `x402_fetch` claims and executes that same prepared identity once.
4. Any dispatched or ambiguous attempt is reconciled; it is not silently
   retried under a new identity or payment mode.

Direct Exact, Native Tab, Gateway cash, and Gateway credit remain distinct
receipt and accounting modes. An unavailable mode is never substituted.
