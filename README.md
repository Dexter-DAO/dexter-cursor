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

| | Hosted connector candidate | Local package |
|---|---|---|
| Best for | Chat clients with remote MCP and OAuth | Codex, Claude Code, Cursor, VS Code, Windsurf, Gemini CLI, scripts |
| Runs | At `https://open.dexter.cash/mcp` | On your machine through npm/stdio |
| Wallet | Passkey-protected Dexter Wallet, bound to the authenticated session | Solana and EVM keys stored locally, or keys supplied through environment variables |
| Networks | Solana | Solana plus configured EVM networks |
| Setup | Add one MCP URL; the client handles OAuth when a protected tool needs it | Run the setup command below |
| Spending policy | Managed by the hosted wallet experience | Default per-call limit and optional rolling 24-hour budget stored on this machine |

The public npm package is ready to install today. The repository's Codex and
Claude Code packages connect to the hosted service instead; they do not launch
the local npm wallet. Those hosted packages are release candidates pending
final client-host validation and are not public marketplace releases.

### Local: start in one command

```bash
npx @dexterai/opendexter@latest setup
```

`setup` creates or loads the local wallet, detects supported AI clients,
configures the clients it can edit safely, and prints any remaining manual step
plus the shortest path to a first search. To target one client:

```bash
npx @dexterai/opendexter@latest install --client cursor
```

Use `claude-code`, `codex`, `vscode`, `windsurf`, or `gemini-cli` in place of
`cursor`. The Claude Code route adds only the local stdio MCP. To add that
connection directly:

```bash
claude mcp add --scope user opendexter -- npx -y @dexterai/opendexter@latest
```

This local installer never adds the repository's hosted Claude Code plugin.
For a manual stdio MCP configuration in another client:

```json
{
  "mcpServers": {
    "opendexter": {
      "command": "npx",
      "args": ["-y", "@dexterai/opendexter@latest"]
    }
  }
}
```

See the [local package guide](./packages/mcp/README.md) for wallet, policy,
client, CLI, and seller workflows.

### Hosted release candidate

When the hosted release is declared available, clients with remote MCP and
OAuth use this URL:

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
- calling `x402_fetch` or `x402_pay` can move USDC under that wallet's limits.

Connecting does not itself approve a payment. A hosted release must pass its
client OAuth and wallet-result checks before this setup is treated as available.
Never paste a bearer token into the MCP configuration.

The connector and OAuth identities are related but deliberately not
interchangeable:

- MCP resource and connector: `https://open.dexter.cash/mcp`
- authorization-server issuer: `https://mcp.dexter.cash/mcp`
- access-token issuer: `https://dexter.cash`

### Test the hosted source packages

The source checkout contains distinct developer candidates for Codex and
Claude Code. These commands modify the active client's plugin configuration,
so use them only in a disposable client profile or when a release owner has
authorized a developer install.

Codex, from the repository root:

```bash
codex plugin marketplace add "$PWD"
codex plugin list
codex plugin add opendexter@dexter
```

Claude Code, from the repository root:

```bash
claude plugin marketplace add "$PWD" --scope user
claude plugin install opendexter@opendexter --scope user
claude plugin details opendexter@opendexter
```

Start a fresh task so the client can discover the package. Protected hosted
tools then use the client's native MCP OAuth action. The local npm package and
the hosted plugin should not both register an `opendexter` server in one client.

## From request to result

OpenDexter keeps discovery and spending separate:

1. **Find.** `x402_search` searches the live catalog using the user's actual
   request. Results include strong and related matches, ranking reasons,
   quality evidence, structured input guidance when available, and advertised
   payment routes.
2. **Inspect.** `x402_check` probes the exact URL and method without paying. It
   returns current per-chain pricing, accepted assets, schemas when published,
   and whether the endpoint is paid, identity-gated, API-key protected, or
   unprotected.
3. **Call.** `x402_fetch` makes the request and, when required, settles a
   compatible x402 payment within the active policy. `x402_pay` is the same
   operation under a more explicit name.
4. **Receive.** The tool returns the provider response with settlement detail
   when payment succeeds.

Search cards are leads, not payment authorization. Check the selected route
again before spending. If a dispatched payment has an uncertain outcome, do
not blindly retry it; reconcile the first attempt before another payment can be
safe.

## What the local package exposes

The local MCP server registers exactly seven tools:

| Tool | What it does | Moves money? |
|---|---|---|
| `x402_search` | Finds services by capability in the OpenDexter catalog | No |
| `x402_check` | Reads current price, route, schema, and authentication requirements | No |
| `x402_access` | Uses a wallet signature for Sign-In-With-X access | No payment |
| `x402_fetch` | Calls an endpoint and settles a compatible x402 charge when required | Yes |
| `x402_pay` | Alias of `x402_fetch` | Yes |
| `x402_wallet` | Shows local addresses and verified balance reads | No |
| `x402_settings` | Reads or changes this installation's spending policy | No |

The hosted release contract deliberately differs. It does not expose the
filesystem-backed `x402_settings` tool. It adds passkey enrollment and
reusable-skill tools plus a session-bound governed portfolio read, for an
eleven-tool roster. `dexter_portfolio` cannot select a wallet or user from its
arguments and does not change the local seven-tool package. After release, the
server's own advertised tool list is authoritative.

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

`npx @dexterai/opendexter@latest connect` creates a connector session. The
local package currently uses that session only to let
`npx @dexterai/opendexter@latest wallet` show the hosted wallet's balance and
Solana deposit address.

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
npx @dexterai/opendexter@latest settings
npx @dexterai/opendexter@latest settings --max-amount 2.50 --daily-budget 20
```

## Build or sell

- **Build an x402 client or server:** use
  [`@dexterai/x402`](https://www.npmjs.com/package/@dexterai/x402).
- **Prepare a compatible service for discovery:** run
  `npx @dexterai/opendexter@latest audition https://your-service.example`.
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
