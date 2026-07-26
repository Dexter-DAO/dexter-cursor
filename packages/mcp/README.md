<p align="center">
  <img src="./assets/dexter-wordmark.svg" alt="Dexter" width="360">
</p>

<h1 align="center">@dexterai/opendexter</h1>

<p align="center">
  <strong>Your agent can find an API, see what it costs, and call it.</strong><br>
  The local OpenDexter CLI and MCP server for compatible x402 services.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@dexterai/opendexter"><img src="https://img.shields.io/npm/v/@dexterai/opendexter.svg" alt="npm version"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D18-339933" alt="Node 18 or newer"></a>
  <a href="../../LICENSE"><img src="https://img.shields.io/badge/license-MIT-111111" alt="MIT license"></a>
</p>

This package runs on your machine. It combines:

- a live capability search over the OpenDexter catalog;
- a free price and requirements check for an exact endpoint;
- wallet-proof access for identity-gated services;
- bounded USDC settlement for compatible x402 calls;
- the same seven operations as CLI commands and MCP tools.

It is the local OpenDexter surface. For the remote, passkey-wallet connector,
start at the [repository guide](../../README.md).

## Start

Run the guided setup:

```bash
npx @dexterai/opendexter@latest setup
```

Setup creates or loads a local Solana and EVM wallet, detects supported AI
clients, configures the clients it can edit safely, and prints any remaining
manual step. Codex uses TOML, so OpenDexter prints the exact block instead of
editing that file automatically.

Then try a search that describes the result you need:

```bash
npx @dexterai/opendexter@latest search "extract tables from a PDF"
```

Search does not spend money. Neither does checking the selected endpoint:

```bash
npx @dexterai/opendexter@latest check "https://service.example/x402/route"
```

Only call `fetch` or `pay` after the URL, method, input, current price, and
accepted route match the intended request:

```bash
npx @dexterai/opendexter@latest fetch \
  "https://service.example/x402/route" \
  --method POST \
  --body '{"document_url":"https://example.com/report.pdf"}'
```

That final command can move real USDC.

## Install into an AI client

Target one supported client:

```bash
npx @dexterai/opendexter@latest install --client cursor
```

Valid client names are `cursor`, `claude-code`, `codex`, `vscode`, `windsurf`,
and `gemini-cli`. Use `--all` to process every supported client detected on the
machine.

For Claude Code, `setup` and `install --client claude-code` add this local stdio
MCP through Claude's supported CLI. To add the same connection directly, use:

```bash
claude mcp add --scope user opendexter -- npx -y @dexterai/opendexter@latest
```

The separately prepared repository plugin is hosted-only and remains a release
candidate. These published-package commands never install it, so a local wallet
setup cannot silently become a hosted-wallet connection.

### Manual stdio MCP

JSON-based clients can use:

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

Codex uses TOML:

```toml
[mcp_servers.opendexter]
command = "npx"
args = ["-y", "@dexterai/opendexter@latest"]
```

Restart the client after adding or changing its MCP configuration.

## The working path

### 1. Find by capability

`x402_search` takes the user's natural-language job. It returns strong matches
first and related matches second. Results can include:

- why the service matched;
- quality score and verification state;
- advertised prices and networks;
- structured input meaning and a good-response description when the catalog
  has OpenAPI-derived evidence;
- a triangulation warning when the top answer is marketing-only and an
  ambiguous query should be cross-checked.

Do not treat a search result's cached or advertised price as approval to pay.

```bash
npx @dexterai/opendexter@latest search "current ETH price"
```

### 2. Check the exact route

`x402_check` probes a URL without paying. It reports current per-chain terms,
accepted assets, input and output schemas when the service publishes them, and
an authentication mode:

- `paid` — use `x402_fetch`;
- `siwx` — use `x402_access`;
- `unprotected` — no x402 settlement is required;
- `apiKey` or `apiKey+paid` — in MCP, supply an authorized provider credential
  through the tool's request-header field; the CLI has no header flag;
- `unknown` — inspect the response before choosing a next action.

The HTTP method is part of the route. Check the same method you intend to call.
Checking does not make an x402 payment, but a non-GET request can still mutate
provider state. Obtain approval for that external action.

### 3. Call

`x402_fetch` sends the request. When the endpoint returns compatible x402
requirements, it selects a supported route, applies the active spending policy,
signs with the local wallet, and returns the provider response plus payment
detail on success.

`x402_pay` is an exact alias. It is not a second stage and must not be called
after a successful fetch.

Once any request has left the process, a timeout can hide provider mutation or
payment. Do not retry automatically unless the result explicitly proves the
attempt was rejected before dispatch and marks a retry safe. Reconcile an
uncertain first attempt; another call could duplicate work or payment.

### Identity-gated calls

`x402_access` handles Sign-In-With-X endpoints. It proves control of the local
wallet without making a payment, then returns the protected response.

## Seven MCP tools

| Tool | Purpose | Payment |
|---|---|---|
| `x402_search` | Search the live catalog by job | Never |
| `x402_check` | Inspect current price, route, schema, and auth mode | Never |
| `x402_access` | Present a wallet-control proof | No payment |
| `x402_fetch` | Call and settle a compatible x402 charge when required | Possible |
| `x402_pay` | Alias of `x402_fetch` | Possible |
| `x402_wallet` | Show addresses and verified balance reads | Never |
| `x402_settings` | Read or change local spending policy | Never |

There are no Dextercard MCP tools in this package. The server's tool list is
the authority; old sixteen-tool examples are obsolete.

## Wallet

On first use, OpenDexter creates:

```text
~/.dexterai-mcp/wallet.json
```

The file contains a Solana keypair and an EVM keypair and is written with
owner-only permissions. Existing Solana-only files are upgraded once with an
EVM keypair.

You can supply keys instead of using the file:

```bash
export DEXTER_PRIVATE_KEY="your-solana-base58-private-key"
export EVM_PRIVATE_KEY="0x-prefixed-evm-private-key"
```

`SOLANA_PRIVATE_KEY` is also accepted. Environment keys take precedence over
the wallet file. Do not paste a private key into an agent conversation or commit
one to a repository.

Inspect verified balances and deposit addresses with:

```bash
npx @dexterai/opendexter@latest wallet
```

A failed RPC read is reported as unavailable, not as a zero balance. A displayed
total can therefore be a verified subtotal when one or more networks could not
be read.

### Supported local networks

| Network | Identifier |
|---|---|
| Solana | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` |
| Base | `eip155:8453` |
| Polygon | `eip155:137` |
| Arbitrum | `eip155:42161` |
| Optimism | `eip155:10` |
| Avalanche | `eip155:43114` |
| BNB Chain | `eip155:56` |
| SKALE | `eip155:1187947933` |

Support in the local wallet does not mean every service accepts every network.
Use the fresh `x402_check` result for the exact endpoint.

## Spending policy

The local package stores policy at:

```text
~/.dexterai-mcp/settings.json
```

It supports:

- `maxAmountUsdc` — the default limit when a call supplies no override;
- `dailyBudgetUsdc` — an optional rolling 24-hour ceiling; `0` disables it.

```bash
npx @dexterai/opendexter@latest settings
npx @dexterai/opendexter@latest settings --max-amount 2.50
npx @dexterai/opendexter@latest settings --daily-budget 20
```

A caller can provide a different maximum for one call, so the stored
`maxAmountUsdc` is not an immutable wallet ceiling. The rolling budget only
counts x402 payments observed by this installation on this machine. It does not
include payments made by the same wallet through another client, machine, or
application.

## What `connect` does

```bash
npx @dexterai/opendexter@latest connect
```

This optional device flow creates a connector session. The local package
currently uses it only to read the user's hosted Dexter Wallet. After passkey approval,
`npx @dexterai/opendexter@latest wallet` shows that wallet's Solana deposit
address and balance.

This connection is **view-only for the local package today**. It does not change
the payment signer used by the local MCP server, `fetch`, or `pay`. Local paid
calls still use the local wallet in `wallet.json` or the configured environment
keys.

```bash
npx @dexterai/opendexter@latest connect status
npx @dexterai/opendexter@latest connect disconnect
```

Read the [connection walkthrough](../../docs/connect-your-wallet.md) for the
browser, QR, and headless-server paths.

## CLI map

Every core tool has a CLI command:

```text
search <query>          Find services by capability
check <url>             Inspect current terms without paying
access <url>            Use wallet-proof access
fetch <url>             Call and pay when required
pay <url>               Alias of fetch
wallet                  Show the active wallet view
settings                Read or change local spending policy
```

Setup and advanced workflows:

```text
setup                   Create/load a wallet and configure detected clients
install                 Configure one or more AI clients
connect                 Connect the terminal's hosted-wallet view
tab                     Open, inspect, settle, or remove seller spend-tabs
audition <url>          Run paid seller-quality tests and synthesize guidance
dextercard              Manage a local Dextercard account session
```

`dextercard` is a CLI-only account-session command. It does not add card tools
to the MCP server. `audition` makes real paid calls. Run
`npx @dexterai/opendexter@latest --help` for current flags and subcommands.

## For API sellers

`audition` discovers paid routes, makes real test calls, reports response
quality, and produces agent-call guidance:

```bash
npx @dexterai/opendexter@latest audition \
  "https://your-service.example" \
  --json
```

Because audition spends from the local wallet, test with deliberate funding and
review the candidate routes before running it.

To build an x402 client or server, use
[`@dexterai/x402`](https://www.npmjs.com/package/@dexterai/x402).

## License

MIT
