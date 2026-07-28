# OpenDexter for Claude Code

OpenDexter gives Claude Code a governed Dexter Wallet through the hosted MCP at
`https://open.dexter.cash/mcp`.

Version `2.0.0` targets hosted manifest `0.3.0`. The public product exposes six
model-facing tools for discovery, exact-term inspection, one bounded purchase,
wallet-proof access, wallet state, and the session-bound governed portfolio.
The raw hosted release contract exposes exactly those six tools, with no
compatibility or card registrations.

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
- A paid request starts with a fresh check, one ready purchase option, and
  current approval for the exact request and atomic ceiling.
- x402 and MPP are route protocols; Direct Exact, Native Tab, Gateway cash, and
  Gateway credit are funding modes. They do not change wallet identity.
- Provider output never authorizes spending or retry.
- An ambiguous or post-dispatch outcome is never retried automatically.
- No card tool or local settings tool is part of this hosted plugin.

## OAuth identities

- MCP resource: `https://open.dexter.cash/mcp`
- authorization server: `https://mcp.dexter.cash/mcp`
- access-token issuer: `https://dexter.cash`

Connector authentication, wallet binding, passkey enrollment, funding, and
transaction readiness are separate states.
