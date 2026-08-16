# OpenDexter for ChatGPT and Codex

OpenDexter gives ChatGPT and Codex a governed Dexter Wallet through the hosted
MCP at `https://open.dexter.cash/mcp`. This is one combined plugin: the current
owner app binding, the remote MCP dependency, and the hosted workflow skills
ship together.

Version `0.6.0` targets hosted manifest `0.5.0`. Before OAuth the public
product exposes five entry tools for discovery, exact-term inspection,
wallet-proof access, wallet connection, and portfolio connection. OAuth
promotes seven protected purchase and governed-action tools, making the
connected roster exactly twelve. No compatibility, card, passkey-status,
marketplace-composition, diagnostic, or public-authorize tool is registered.

## Current ChatGPT registration

The owner-created OpenDexter registration currently has technical plugin ID
`plugin_asdk_app_6a7557267fb88191bc336aa99bf5bf03`. The package's `.app.json`
binds the corresponding developer app once, while `.mcp.json` describes the
same hosted endpoint for compatible clients.

The prior ChatGPT installation was app-only. Merging this source does not
silently update that installed package: the exact combined package must be
installed from the Dexter marketplace for local testing or attached to the
same publisher draft before a new plugin version is submitted.

## Install in Codex

```bash
codex plugin marketplace add Dexter-DAO/opendexter-ide --ref main
codex plugin add opendexter@dexter
codex mcp login opendexter
```

Start a fresh ChatGPT chat or Codex task after installation so the host loads
the skill metadata and MCP tools together.

## Update in Codex

```bash
codex plugin marketplace upgrade dexter
codex plugin add opendexter@dexter
```

Do not also configure `https://open.dexter.cash/mcp` manually in the same
client.

## Contract

- Native MCP OAuth binds the current ChatGPT or Codex session to the user's
  Dexter Wallet.
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

## One hosted skill source

`plugins/opendexter/skills/` is the canonical hosted skill source. The Claude
package's shared skill files are generated from it; verify they have not
drifted with:

```bash
node scripts/sync-hosted-plugin-skills.mjs --check
```

The local npm/stdio package remains separate because it exposes a different
seven-tool proxy contract.

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
