# OpenDexter for Claude Code

OpenDexter gives Claude Code a governed Dexter Wallet through the hosted MCP at
`https://open.dexter.cash/mcp`.

Version `2.1.1` targets hosted manifest `0.5.0`. Before OAuth the public
product exposes five entry tools for discovery, exact-term inspection,
wallet-proof access, wallet connection, and portfolio connection. OAuth
promotes seven protected purchase and governed-action tools, making the
connected roster exactly twelve. No compatibility, card, passkey-status,
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
- `dexter_portfolio` accepts no caller-selected identity.
- An anonymous paid check is quote-only. Repeat the same check after OAuth to
  create one API-custodied opaque intent, then execute it once with the exact
  approved atomic ceiling.
- Governed Send, Buy, and Sell use only a canonical server-approved `assetId`
  and exact atomic amount. The reusable mandate may authorize execution;
  enrollment, extension, and owner escalation remain outside model calls.
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
