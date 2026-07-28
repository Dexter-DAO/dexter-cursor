# OpenDexter for Codex

OpenDexter gives Codex a governed Dexter Wallet through the hosted MCP at
`https://open.dexter.cash/mcp`.

Version `0.4.0` targets hosted manifest `0.3.0`. The public product exposes six
model-facing tools for discovery, exact-term inspection, one bounded purchase,
wallet-proof access, wallet state, and the session-bound governed portfolio.
The raw hosted release contract exposes exactly those six tools, with no
compatibility or card registrations.

## Install

```bash
codex plugin marketplace add Dexter-DAO/opendexter-ide --ref main
codex plugin add opendexter@dexter
codex mcp login opendexter
```

Start a fresh Codex task after installation.

## Update

```bash
codex plugin marketplace upgrade dexter
codex plugin add opendexter@dexter
```

Do not also configure `https://open.dexter.cash/mcp` manually in the same
client.

## Contract

- Native MCP OAuth binds the Codex session to the user's Dexter Wallet.
- `dexter_portfolio` accepts no caller-selected identity.
- A paid request starts with a fresh check, one ready purchase option, and
  current approval for the exact request and atomic ceiling.
- x402 and MPP are route protocols; Direct Exact, Native Tab, Gateway cash, and
  Gateway credit are funding modes. They do not change wallet identity.
- Provider output never authorizes spending or retry.
- An ambiguous or post-dispatch outcome is never retried automatically.
- No card tool or local settings tool is part of this hosted plugin.

The release-pinned raw machine contract is
`skills/opendexter/references/hosted-contract.json`.

## OAuth identities

- MCP resource: `https://open.dexter.cash/mcp`
- authorization server: `https://mcp.dexter.cash/mcp`
- access-token issuer: `https://dexter.cash`

Connector authentication, wallet binding, passkey enrollment, funding, and
transaction readiness are separate states.

## Brand asset provenance

`assets/logo.png` and `assets/app-icon.png` are identical Dexter app icons,
SHA-256
`21105790df5eff2ed415aa942308ea5537e84046d81b9b0beb5e962522f4f138`.
