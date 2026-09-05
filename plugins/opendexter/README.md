# OpenDexter for ChatGPT and Codex

OpenDexter gives ChatGPT and Codex a governed Dexter Wallet through the hosted
MCP at `https://open.dexter.cash/mcp`. This is one combined plugin: the current
owner app binding, the remote MCP dependency, and the hosted workflow skills
ship together.

Version `0.6.4` uses the hosted contract recorded with this plugin. Native MCP OAuth completes
before tool discovery. The authenticated server registers thirteen tools: twelve model-callable
tools for Indexter discovery, x402 access and purchases, Dexter Wallet reads,
and governed asset actions, plus app-only `indexter_discover` for UI
continuations. `indexter_search` routes one complete request to an overview,
provider browsing, or task results. No compatibility, card, passkey-status,
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
  Dexter Wallet. Before OAuth, initialization and tool discovery receive HTTP
  401 until the host completes its native Connect flow;
  `authentication_required` on an established connection means OAuth must be
  resumed.
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

The release-pinned raw machine contract is
`skills/opendexter/references/hosted-contract.json`.
It is regenerated from the exact public release identity and descriptor digest
reported by `https://open.dexter.cash/health` with:

```bash
npm run release:prepare-plugin --workspace=@dexterai/opendexter
```

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
