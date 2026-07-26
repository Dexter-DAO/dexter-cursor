---
name: setup-opendexter
description: Configure the local OpenDexter MCP server and verify its seven-tool surface.
---

# Install OpenDexter MCP

Set up the local OpenDexter server so the agent can search compatible x402
services, inspect current terms, and execute one explicitly selected purchase.

## Steps

1. Run the guided setup:

```bash
npx @dexterai/opendexter@latest setup
```

To target one client, use:

```bash
npx @dexterai/opendexter@latest install --client cursor
```

Supported client names are `cursor`, `claude-code`, `codex`, `vscode`,
`windsurf`, and `gemini-cli`. Codex uses TOML, so the installer prints the
exact block instead of editing it.

2. Verify discovery by asking the client to list the OpenDexter tools. The
local runtime has exactly seven:

`x402_search`, `x402_check`, `x402_access`, `x402_fetch`, `x402_pay`,
`x402_wallet`, and `x402_settings`.

3. Run `x402_wallet`. A failed balance read is unavailable, not zero. Fund only
a receive address returned by the current wallet result and only on a network
accepted by the current endpoint check.

4. Test the non-paying path:

```
x402_search("extract tables from a PDF")
```

Choose one result, then call `x402_check` for its exact URL, HTTP method, and
request body. Search does not authorize payment.

5. For a paid call, choose only a `purchaseOption` whose `availability.state`
is `ready`. Preserve its `preparedPurchase` unchanged and obtain approval for
the atomic ceiling before calling `x402_fetch`. Never switch among
`direct_exact`, `native_tab`, `gateway_cash`, or `gateway_credit` after
selection. Never automatically retry after consequential dispatch.

## Authority boundary

The local server pays with the local wallet file or configured environment
keys. The optional `connect` flow is view-only for hosted wallet reads and
does not change the local payment signer.

| Variable | Description |
|----------|-------------|
| `DEXTER_PRIVATE_KEY` | Override wallet (base58 Solana private key) |
| `SOLANA_PRIVATE_KEY` | Alias for DEXTER_PRIVATE_KEY |
| `EVM_PRIVATE_KEY` | Override EVM wallet (0x-prefixed private key) |
| `SOLANA_RPC_URL` | Custom Solana RPC endpoint |

Never ask the user to paste a private key into the conversation.
