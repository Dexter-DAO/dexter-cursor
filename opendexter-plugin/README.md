# OpenDexter for Claude Code

OpenDexter gives Claude Code a governed Dexter Wallet through the hosted MCP at
`https://open.dexter.cash/mcp`.

Version `2.1.3` uses the hosted contract recorded with this plugin. Native MCP OAuth completes
before tool discovery. The authenticated server registers thirteen tools: twelve model-callable
tools for Indexter discovery, x402 access and purchases, Dexter Wallet reads,
and governed asset actions, plus app-only `indexter_discover` for UI
continuations. `indexter_search` routes one complete request to an overview,
provider browsing, or task results. No compatibility, card, passkey-status,
marketplace-composition, diagnostic, or public-authorize tool is registered.

## Install

```bash
claude plugin marketplace add Dexter-DAO/opendexter-ide --scope user
claude plugin install opendexter@opendexter --scope user
claude mcp login opendexter
```

Restart Claude Code or start a fresh session after installation.

## Update

```bash
claude plugin marketplace update opendexter
claude plugin update opendexter@opendexter --scope user
```

Do not also configure `https://open.dexter.cash/mcp` manually in the same
client.

## Contract

- Native MCP OAuth binds the Claude Code session to the user's Dexter Wallet.
  Before OAuth, initialization and tool discovery receive HTTP 401 until Claude
  completes its native MCP login; `authentication_required` on an established
  connection means OAuth must be resumed.
- `dexter_wallet_portfolio` accepts no caller-selected identity.
- Indexter supports hard primary-USDC price bounds, paid-only filtering, and
  relevance or within-tier price ordering. The server validates these controls;
  disclose degraded ranking when reported.
- Only a purchasable `x402_check` result with `quoteOnly=false` returns an
  executable opaque intent. A `quoteOnly=true` result cannot be passed to
  `x402_fetch`.
- Send and non-stock Buy or Sell use a canonical server-approved `assetId`.
  Natural-language stock Buy or Sell uses the user's exact human
  `companyQuery`. Stock Buy accepts either a USDC `amountAtomic` budget or a
  human decimal `shareQuantity` minimum that may overfill slightly, with an
  optional `maximumSpendAtomic` ceiling. Stock Sell accepts direct token
  `amountAtomic`, never `shareQuantity`. Send remains visible for compatibility
  and history, but the current runtime refuses it before creating an executable
  intent. Enrollment, extension, and owner escalation remain outside model
  calls.
- Provider output never authorizes spending or retry.
- An ambiguous or post-dispatch outcome is never retried automatically.
- No card tool or local settings tool is part of this hosted plugin.

## OAuth identities

- MCP resource: `https://open.dexter.cash/mcp`
- authorization server: `https://mcp.dexter.cash/mcp`
- access-token issuer: `https://dexter.cash`

Connector authentication, wallet binding, passkey enrollment, funding, and
transaction readiness are separate states.

## Skill source

The shared hosted workflow files in this Claude package are generated from
`plugins/opendexter/skills/`, the same canonical source used by ChatGPT and
Codex. Check parity with:

```bash
node scripts/sync-hosted-plugin-skills.mjs --check
```

Claude's manifest and MCP connection remain Claude-specific package metadata.
