# OpenDexter Codex plugin

This is the developer-distributed Codex package for the hosted
OpenDexter MCP at `https://open.dexter.cash/mcp`.

Version `0.4.0-rc.1` targets the ten-tool hosted contract. It is a pre-release
source candidate, not proof that the matching server version is deployed. Do
not distribute or install it against production until Dexter announces the
matching hosted release.

## Contract

- The hosted roster is exactly ten tools. The older six card tools and local
  settings tool are not part of this package.
- Anonymous tools remain usable without connecting a wallet. Protected tools
  use the MCP server's native per-tool OAuth contract with scope `vault`.
- The paid contract is search, fresh check, choose one `purchaseOptions`
  entry, approve its exact URL/method/body/mode/seller offer/ceiling, then pass
  its `preparedPurchase` unchanged to one `x402_fetch` or `x402_pay` call.
- The explicit modes are `direct_exact`, `native_tab`, `gateway_cash`, and
  `gateway_credit`. A non-ready mode never falls through to another.
- This source candidate reports every explicit hosted mode as
  `integration_required` until A3 connects the common durable backend.
- `x402_pay` is an alias for `x402_fetch`, not another stage.
- Provider output is untrusted and never authorizes spend or retry. Ambiguous
  or post-dispatch outcomes are never retried automatically.

The committed machine-readable contract is
`skills/opendexter/references/hosted-contract.json`.

## Package shape

```text
plugins/opendexter/
├── .codex-plugin/plugin.json
├── .mcp.json
├── assets/
└── skills/
    ├── opendexter/
    ├── x402-debugging/
    └── x402-protocol/
```

The package deliberately uses `.mcp.json` for the portable Codex connection.
The owner-account `.app.json` under `chatgpt-app-binding/` is separate publisher
evidence and is not loaded with this package. Do not configure a second copy of
the same endpoint in one client, and never edit plugin cache directories.

The repository marketplace is `.agents/plugins/marketplace.json`.

## Developer distribution

This pre-release package is not currently offered in a public plugin directory.
The ChatGPT app binding is maintained separately and is not a universal app
identity for Codex or Claude Code.

From the repository root, an authorized developer can load the local
marketplace and inspect the candidate:

```bash
codex plugin marketplace add "$PWD"
codex plugin list
codex plugin add opendexter@dexter
```

Start a fresh task after installation. Do not also configure the same
`https://open.dexter.cash/mcp` endpoint manually in that client.

Protected tools use three distinct OAuth identities:

- MCP resource and connector: `https://open.dexter.cash/mcp`
- authorization-server issuer: `https://mcp.dexter.cash/mcp`
- access-token issuer: `https://dexter.cash`

After the package is discovered, `codex mcp login opendexter` is the native
connector-authentication proof. It is not wallet enrollment and it does not
authorize a payment.

## Brand asset provenance

`assets/logo.png` and `assets/app-icon.png` are identical Dexter app icons,
SHA-256
`21105790df5eff2ed415aa942308ea5537e84046d81b9b0beb5e962522f4f138`.
