<p align="center">
  <img src="./packages/mcp/assets/dexter-wordmark.svg" alt="Dexter" width="360">
</p>

<h1 align="center">OpenDexter</h1>

<p align="center">
  <strong>Your agent can find an API, see what it costs, and call it.</strong><br>
OpenDexter searches paid services by the job they do, checks the current terms, and makes a bounded request through the connected Dexter Wallet.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@dexterai/opendexter"><img src="https://img.shields.io/npm/v/@dexterai/opendexter.svg" alt="npm version"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D22-339933" alt="Node 22 or newer"></a>
  <a href="https://x402.org"><img src="https://img.shields.io/badge/protocol-x402-6f5cff" alt="x402 protocol"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-111111" alt="MIT license"></a>
</p>

OpenDexter starts with the job, not the provider. Ask for an image model, a
market-data feed, an address validator, or another paid capability. It searches
the current catalog, explains why each result matches, checks the selected
endpoint's current terms, and can make the call from a wallet whose authority
you chose.

## Choose how it runs

OpenDexter has two connection forms and one payment-authority model. Both use
the passkey-controlled Dexter Wallet and the same hosted governed executor.

| | Hosted connector | Local package |
|---|---|---|
| Best for | Chat clients with remote MCP and native OAuth | Codex, Claude Code, Cursor, VS Code, Windsurf, Gemini CLI, scripts |
| Client connection | Remote MCP at `https://open.dexter.cash/mcp` | Local npm/stdio proxy to that hosted runtime |
| Payment source | Connected Dexter Wallet grant | The same connected Dexter Wallet grant |
| Setup | Add the MCP URL; the client handles OAuth | Install the proxy, then run `connect` |
| Authority | Server-verified grant limits, capacity, expiry, role, and revocation | The same live server-verified authority; no local signer fallback |

The combined ChatGPT/Codex plugin and the Claude Code plugin connect directly
to the hosted service. They share one generated hosted workflow. The npm
package runs a local stdio proxy for clients that need one, but it does not
create or select a second payment wallet.

### Local: start in one command

These commands deliberately pin the stable source candidate. The stable npm channel remains available as `@latest`,
but proving and publishing this version there remains a separate,
evidence-gated step. Never replace the exact version below with a floating tag
in client configuration.

```bash
npx @dexterai/opendexter@1.24.0-rc.2 setup
```

`setup` detects supported AI clients, configures the clients it can edit safely,
and prints any remaining manual step plus the shortest path to `connect` and a
first search. It does not create, import, or enable a payment wallet. To target
one client:

```bash
npx @dexterai/opendexter@1.24.0-rc.2 install --client cursor
```

Use `claude-code`, `codex`, `vscode`, `windsurf`, or `gemini-cli` in place of
`cursor`. The Claude Code route adds only the local stdio MCP. To add that
connection directly:

```bash
claude mcp add --scope user opendexter -- npx -y @dexterai/opendexter@1.24.0-rc.2
```

This local installer never adds the repository's hosted Claude Code plugin.
For a manual stdio MCP configuration in another client:

```json
{
  "mcpServers": {
    "opendexter": {
      "command": "npx",
      "args": ["-y", "@dexterai/opendexter@1.24.0-rc.2"]
    }
  }
}
```

See the [local package guide](./packages/mcp/README.md) for authority, client,
CLI, recovery, and seller workflows.

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

ChatGPT and Codex use the combined package under `plugins/opendexter`: it binds
the current owner-created ChatGPT app, the hosted MCP, and the hosted skill
tree in one installable plugin. Updating source does not automatically replace
an already installed app-only ChatGPT package; install or submit the combined
package as one new plugin version, then test it in a fresh chat.

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

Run `npx @dexterai/opendexter@1.24.0-rc.2 doctor` for a read-only report. Doctor
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
   API-key protected, or unprotected. A non-GET probe can still mutate seller
   state, needs separate probe approval, and is never automatically retried
   after possible dispatch.
3. **Call.** `x402_fetch` makes one exact prepared request and, when required,
   settles a compatible payment within the active policy.
4. **Receive.** The tool returns the provider response with settlement detail
   when payment succeeds.

Search cards are leads, not payment authorization. Check the selected route
again before spending. If a dispatched payment has an uncertain outcome, do
not blindly retry it; reconcile the first attempt before another payment can be
safe.

## Product tool surfaces

The local proxy exposes exactly these seven model-facing tools:

| Tool | What it does | Consequential? |
|---|---|---|
| `x402_search` | Finds services by capability in the OpenDexter catalog | No |
| `x402_check` | Reads current terms and can prepare one opaque intent | A non-GET probe can mutate seller state; it requires separate probe approval |
| `x402_fetch` | Executes one opaque intent under a separately approved atomic ceiling | Yes; it can move USDC |
| `x402_status` | Reconciles the same intent after an uncertain or completed fetch | No |
| `x402_access` | Starts one fresh anonymous legacy SIWX wallet-proof context, separate from Dexter OAuth and governed payment authority, with no cross-call continuity | A non-GET request can mutate seller state; it requires separate request approval |
| `x402_wallet` | Reads the connected wallet and exact authority evidence | No |
| `dexter_portfolio` | Reads the governed portfolio bound to the same principal | No |

Every account-bound call uses the authenticated Dexter Wallet session. The
local package never swaps to a wallet file or environment key when hosted
authority is missing, rejected, expired, or revoked. Developer SDKs may still
accept an application-supplied signer for a separate application, but that is
not an OpenDexter MCP payment path or fallback.

## Wallets and authority

Run the device flow, approve with the wallet passkey, and then inspect the live
authority projection:

```bash
npx @dexterai/opendexter@1.24.0-rc.2 connect
npx @dexterai/opendexter@1.24.0-rc.2 connect status
npx @dexterai/opendexter@1.24.0-rc.2 wallet
```

The OAuth request uses the exact `vault` scope. The returned access token can
separately carry Dexter's signed `dexter_surface` claim; that claim is not a
client-requested scope. Connection alone is not proof of payment authority.
Treat it as active only when status reports the exact grant, principal, limits,
remaining capacity, expiry, scopes, role, and revocation state.

Older installations may still have `~/.dexterai-mcp/wallet.json`. OpenDexter
does not delete or transfer it automatically. The explicit
`wallet --legacy-recovery` command parses the existing file to recover validated
public addresses and balance reads; it never derives, returns, exports, or
enables private-key fields as a signer. Legacy settings and environment signer
variables do not govern the hosted runtime.

See [Connect your Dexter wallet](./docs/connect-your-wallet.md) for the exact
connection and authority boundary.

## Build or sell

- **Build an x402 client or server:** use
  [`@dexterai/x402`](https://www.npmjs.com/package/@dexterai/x402).
- **Prepare a compatible service for discovery:** run
  `npx @dexterai/opendexter@1.24.0-rc.2 audition https://your-service.example`.
  Audition performs real paid test calls, so use a testable endpoint and fund
  only the amount you intend those tests to spend.
- **Inspect the protocol:** read the [x402 specification](https://x402.org).

## Repository map

| Path | Audience |
|---|---|
| [`packages/mcp`](./packages/mcp) | Published local CLI and stdio MCP package |
| [`plugins/opendexter`](./plugins/opendexter) | Combined ChatGPT/Codex app, MCP, and canonical hosted skill package |
| [`opendexter-plugin`](./opendexter-plugin) | Claude Code package generated from the canonical hosted skill |
| [`packages/x402-mcp-tools`](./packages/x402-mcp-tools) | Shared MCP tool implementations |
| [`packages/mcp-instructions`](./packages/mcp-instructions) | Roster-aware agent instructions |

## License

MIT
