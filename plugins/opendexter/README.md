# OpenDexter for Codex

OpenDexter gives Codex a governed Dexter Wallet through the hosted MCP at
`https://open.dexter.cash/mcp`.

Version `0.5.0` targets hosted manifest `0.5.0`. Before OAuth the public
product exposes five entry tools for discovery, exact-term inspection,
wallet-proof access, wallet connection, and portfolio connection. OAuth
promotes seven protected purchase and governed-action tools, making the
connected roster exactly twelve. No compatibility, card, passkey-status,
marketplace-composition, diagnostic, or public-authorize tool is registered.

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
- An anonymous paid check is quote-only. Repeat the same check after OAuth to
  create one API-custodied opaque intent, then execute it once with the exact
  approved atomic ceiling.
- Governed Send, Buy, and Sell use only a canonical server-approved `assetId`
  and exact atomic amount. The reusable mandate may authorize execution;
  enrollment, extension, and owner escalation remain outside model calls.
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
