<p align="center">
  <img src="./packages/mcp/assets/dexter-wordmark.svg" alt="Dexter" width="360">
</p>

<h1 align="center">OpenDexter</h1>

<p align="center">
  <strong>Your agent can find an API, see what it costs, and call it.</strong><br>
  OpenDexter searches paid services by the job they do, checks the current terms, and makes a bounded request through the configured wallet.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@dexterai/opendexter"><img src="https://img.shields.io/npm/v/@dexterai/opendexter.svg" alt="npm version"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D20-339933" alt="Node 20 or newer"></a>
  <a href="https://x402.org"><img src="https://img.shields.io/badge/protocol-x402-6f5cff" alt="x402 protocol"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-111111" alt="MIT license"></a>
</p>

OpenDexter starts with the job, not the provider. Ask for an image model, a
market-data feed, an address validator, or another paid capability. It searches
the current catalog, explains why each result matches, checks the selected
endpoint's current terms, and can make the call from a wallet whose authority
you chose.

## Choose how it runs

OpenDexter has two deliberately different ways to hold payment authority.

| | Hosted connector | Local package |
|---|---|---|
| Best for | Chat clients with remote MCP and OAuth | Codex, Claude Code, Cursor, VS Code, Windsurf, Gemini CLI, scripts |
| Runs | At `https://open.dexter.cash/mcp` | On your machine through npm/stdio |
| Wallet | Passkey-protected Dexter Wallet, bound to the authenticated session | Solana and EVM keys stored locally, or keys supplied through environment variables |
| Networks | Solana | Solana plus configured EVM networks |
| Setup | Add one MCP URL; the client handles OAuth when a protected tool needs it | Run the setup command below |
| Spending policy | Managed by the hosted wallet experience | Default per-call limit and optional rolling 24-hour budget stored on this machine |

The Codex and Claude Code plugins connect to the hosted service. The local npm
package runs a separate stdio MCP and uses an explicitly configured local
signer for payments.

### Local: start in one command

These commands deliberately pin the stable source candidate. The stable npm channel remains available as `@latest`,
but proving and publishing this version there remains a separate,
evidence-gated step. Never replace the exact version below with a floating tag
in client configuration.

```bash
npx @dexterai/opendexter@1.23.1 setup
```

`setup` creates or loads the local wallet, detects supported AI clients,
configures the clients it can edit safely, and prints any remaining manual step
plus the shortest path to a first search. To target one client:

```bash
npx @dexterai/opendexter@1.23.1 install --client cursor
```

Use `claude-code`, `codex`, `vscode`, `windsurf`, or `gemini-cli` in place of
`cursor`. The Claude Code route adds only the local stdio MCP. To add that
connection directly:

```bash
claude mcp add --scope user opendexter -- npx -y @dexterai/opendexter@1.23.1
```

This local installer never adds the repository's hosted Claude Code plugin.
For a manual stdio MCP configuration in another client:

```json
{
  "mcpServers": {
    "opendexter": {
      "command": "npx",
      "args": ["-y", "@dexterai/opendexter@1.23.1"]
    }
  }
}
```

See the [local package guide](./packages/mcp/README.md) for wallet, policy,
client, CLI, and seller workflows.

### Hosted connector

Clients with remote MCP and OAuth use this URL:

```json
{
  "mcpServers": {
    "opendexter": {
      "url": "https://open.dexter.cash/mcp"
    }
  }
}
```

The release contract uses native client sign-in when a protected tool requires
it. Connector sign-in, wallet enrollment, and a paid call are three separate
events:

- signing in lets the client call account-protected tools;
- enrolling the passkey wallet creates or resumes the user's payment authority;
- calling `x402_fetch` can move USDC under that wallet's limits.

Connecting does not itself approve a payment. Never paste a bearer token into
the MCP configuration.

The connector and OAuth identities are related but deliberately not
interchangeable:

- MCP resource and connector: `https://open.dexter.cash/mcp`
- authorization-server issuer: `https://mcp.dexter.cash/mcp`
- access-token issuer: `https://dexter.cash`

### Install the hosted plugins

Codex:

```bash
codex plugin marketplace add Dexter-DAO/opendexter-ide --ref main
codex plugin add opendexter@dexter
codex mcp login opendexter
```

Claude Code:

```bash
claude plugin marketplace add Dexter-DAO/opendexter-ide --scope user
claude plugin install opendexter@opendexter --scope user
claude mcp login opendexter
```

Start a fresh task so the client can discover the package. Protected hosted
tools then use the client's native MCP OAuth action. Keep exactly one
OpenDexter registration in a client unless that client's duplicate-tool
namespacing has been separately proven. `--registration-name` chooses the name
of that one registration; it does not bypass an existing hosted or local
OpenDexter registration. The installer never silently renames or overwrites one.

Run `npx @dexterai/opendexter@1.23.1 doctor` for a read-only report. Doctor
does not create a wallet, read balances, edit client configuration, or pay.

## From request to result

OpenDexter keeps discovery and spending separate:

1. **Find.** `x402_search` searches the live catalog using the user's actual
   request. Results include strong and related matches, ranking reasons,
   quality evidence, structured input guidance when available, and advertised
   payment routes.
2. **Inspect and prepare.** `x402_check` probes the exact URL and method without
   making a payment. An anonymous hosted check is quote-only; an authenticated
   hosted check also persists one exact quote/request intent for a later
   approved call. It returns current per-chain pricing, accepted assets,
   schemas when published, and whether the endpoint is paid, identity-gated,
   API-key protected, or unprotected.
3. **Call.** `x402_fetch` makes one exact prepared request and, when required,
   settles a compatible payment within the active policy.
4. **Receive.** The tool returns the provider response with settlement detail
   when payment succeeds.

Search cards are leads, not payment authorization. Check the selected route
again before spending. If a dispatched payment has an uncertain outcome, do
not blindly retry it; reconcile the first attempt before another payment can be
safe.

## Product tool surfaces

The local package keeps these six model-facing tools:

| Tool | What it does | Moves money? |
|---|---|---|
| `x402_search` | Finds services by capability in the OpenDexter catalog | No |
| `x402_check` | Reads current price, route, schema, and authentication requirements | No |
| `x402_access` | Uses a wallet signature for Sign-In-With-X access | No payment |
| `x402_fetch` | Calls an endpoint and settles a compatible x402 charge when required | Yes |
| `x402_wallet` | Shows local addresses and verified balance reads | No |
| `dexter_portfolio` | Reads the governed portfolio from an explicitly linked Dexter account | No |

The hosted contract uses those six names plus `x402_status` and five governed
asset tools for prepare, execute, status, reconciliation, and wallet history.
Its anonymous roster has five entry tools; native OAuth promotes seven more,
making the connected hosted roster exactly twelve.

The authority also differs. Hosted wallet, payment, portfolio, and governed
action calls use the authenticated Dexter Wallet session and its reusable
bounded mandate. The local package uses its file or environment signer for
wallet-proof and paid calls, while `dexter_portfolio` is a separate read-only
link to the user's hosted Dexter Wallet. Neither surface exposes compatibility,
card, passkey-status, marketplace-composition, diagnostic, or public-authorize
tools.

## Wallets and authority

### Local wallet

The npm package creates a Solana keypair and an EVM keypair at:

```text
~/.dexterai-mcp/wallet.json
```

The directory and file are created with owner-only permissions. You can supply
`DEXTER_PRIVATE_KEY` or `SOLANA_PRIVATE_KEY` for Solana and `EVM_PRIVATE_KEY`
for EVM instead; environment variables take precedence over the wallet file.

Local balance and signing support is configured for Solana, Base, Polygon,
Arbitrum, Optimism, Avalanche, BNB Chain, and SKALE. An endpoint still decides
which network and asset it accepts; `x402_check` shows the actual options before
a paid call.

### Local `connect`

`npx @dexterai/opendexter@1.23.1 connect` creates a read-only account link for
hosted wallet and portfolio views. It labels that account separately from local
payment authority.

It does **not** change the payment signer used by the local MCP server, `fetch`,
or `pay`. Local paid calls still use the local wallet file or configured
environment keys. See [Connect your Dexter wallet](./docs/connect-your-wallet.md)
for the exact boundary.

### Spending policy

The local package stores a default per-call USDC limit and can enforce an
optional rolling 24-hour budget. A caller can supply a different limit for one
call, so the stored value is not an immutable wallet ceiling. The rolling
budget counts only x402 spending witnessed by this installation on this
machine; it is not a complete view of the wallet's on-chain activity.

```bash
npx @dexterai/opendexter@1.23.1 settings
npx @dexterai/opendexter@1.23.1 settings --max-amount 2.50 --daily-budget 20
```

## Build or sell

- **Build an x402 client or server:** use
  [`@dexterai/x402`](https://www.npmjs.com/package/@dexterai/x402).
- **Prepare a compatible service for discovery:** run
  `npx @dexterai/opendexter@1.23.1 audition https://your-service.example`.
  Audition performs real paid test calls, so use a testable endpoint and fund
  only the amount you intend those tests to spend.
- **Inspect the protocol:** read the [x402 specification](https://x402.org).

## Repository map

| Path | Audience |
|---|---|
| [`packages/mcp`](./packages/mcp) | Published local CLI and stdio MCP package |
| [`plugins/opendexter`](./plugins/opendexter) | Developer-distributed Codex package for the hosted MCP |
| [`opendexter-plugin`](./opendexter-plugin) | Developer-distributed Claude Code package for the hosted MCP |
| [`chatgpt-app-binding`](./chatgpt-app-binding) | Publisher-side ChatGPT app identity; not a portable plugin |
| [`packages/x402-mcp-tools`](./packages/x402-mcp-tools) | Shared MCP tool implementations |
| [`packages/mcp-instructions`](./packages/mcp-instructions) | Roster-aware agent instructions |

## License

MIT
