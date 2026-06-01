<p align="center">
  <img src="https://raw.githubusercontent.com/Dexter-DAO/dexter-x402-sdk/main/assets/dexter-wordmark.svg" alt="Dexter" width="360">
</p>

<h1 align="center">OpenDexter</h1>

<p align="center">
  <strong>x402 payments for AI agents — search, pay, and build with paid APIs.</strong><br>
  Skills, rules, tools, and an MCP server for Claude Code, Cursor, and any MCP client.
</p>

<p align="center">
  <a href="https://x402.org"><img src="https://img.shields.io/badge/protocol-x402_v2-00FF88" alt="x402"></a>
  <a href="https://www.npmjs.com/package/@dexterai/opendexter"><img src="https://img.shields.io/npm/v/@dexterai/opendexter.svg" alt="npm"></a>
  <a href="https://www.npmjs.com/package/@dexterai/x402"><img src="https://img.shields.io/npm/v/@dexterai/x402.svg?label=%40dexterai%2Fx402" alt="SDK"></a>
  <a href="https://dexter.cash/opendexter"><img src="https://img.shields.io/badge/Marketplace-the_full_index-blueviolet" alt="Marketplace"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT"></a>
</p>

<p align="center">
  <a href="https://dexter.cash/opendexter"><strong>Browse Marketplace</strong></a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="https://x402.org"><strong>x402 Protocol</strong></a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="https://www.npmjs.com/package/@dexterai/x402"><strong>SDK Docs</strong></a>
</p>

---

## Install

There are two ways to run OpenDexter. **Hosted** is the fastest: nothing to
install, and the wallet is a session you fund with a QR code. **Local** runs
the MCP server on your machine with a self-custodied wallet key.

### Hosted (no install)

Add the hosted MCP server to any MCP client's config. There is nothing to
download; you pair and fund a session wallet at `dexter.cash`.

```json
{
  "mcpServers": {
    "opendexter": {
      "url": "https://open.dexter.cash/mcp"
    }
  }
}
```

That is the whole setup. Skip to [Fund your wallet](#fund-your-wallet).

### Local (self-custody)

Runs `@dexterai/opendexter` on your machine; the wallet key lives in
`~/.dexterai-mcp/wallet.json`.

**Claude Code.** Install the plugin (skills, rules, agent, commands, and
the MCP server). Do not also add the hosted or local server by hand. The
plugin already includes it.

```bash
claude plugins marketplace add Dexter-DAO/opendexter-ide
claude plugins install opendexter
```

**Cursor**

```bash
npx @dexterai/opendexter install --client cursor
```

**Any other MCP client.** The installer covers Codex, VS Code, Windsurf,
and Gemini CLI:

```bash
npx @dexterai/opendexter install --client <codex|vscode|windsurf|gemini-cli>
```

Or add the server to your client's MCP config by hand:

```json
{
  "mcpServers": {
    "opendexter": {
      "command": "npx",
      "args": ["-y", "@dexterai/opendexter"]
    }
  }
}
```

### Fund your wallet

A paid call needs USDC. After install, fund whichever wallet you are using:

- **Hosted:** pair the session at `dexter.cash` and fund it with the QR code.
- **Local:** send USDC (Solana or Base) to the address printed during
  install, or run the `card_issue` tool to set up a Dextercard and fund
  calls from that.

Your agent can call `x402_wallet` at any time to show the address and
current balance.

---

## What This Plugin Does

This plugin ships with a **real MCP server** that gives your agent live tools for searching, paying for, and calling paid APIs. On top of that, it has deep SDK knowledge so the agent can help you **build** x402 payments into your own projects.

After installing, your agent can immediately:

- **Search** the Dexter Marketplace for any paid API (image generation, DeFi, analytics, AI, games — thousands of endpoints)
- **Check** what an API costs before paying
- **Pay and call** any x402 API with automatic USDC settlement
- **Help you build** x402 clients, servers, React apps, Stripe integrations, and access passes

---

## What is x402?

[x402](https://x402.org) is an open protocol for machine-to-machine payments over HTTP. When an API returns `402 Payment Required`, it includes payment instructions. The client pays (USDC on Solana, Base, or other chains), and the API delivers the response. No API keys, no subscriptions, no invoices.

Dexter operates the most-used x402 facilitator at `https://x402.dexter.cash`, processing millions of settlements across thousands of indexed endpoints from every major x402 facilitator — Dexter, Coinbase, PayAI, and more.

---

## Plugin Contents

### MCP Server — `@dexterai/opendexter`

Seven tools cover everything:

| Tool | Description |
|------|-------------|
| **`x402_search`** | Semantic capability search over thousands of paid APIs. Returns tiered results (strong + related matches) ranked by quality, usage, and reputation. |
| **`x402_check`** | Preview pricing per chain without spending anything. See exactly what an API costs before committing. |
| **`x402_fetch`** | Call any x402 API with automatic USDC payment. Signs, pays, retries — returns the response directly with an on-chain settlement receipt. |
| **`x402_pay`** | Alias for `x402_fetch`. |
| **`x402_access`** | Access identity-gated endpoints with wallet proof (Sign-In-With-X). |
| **`x402_wallet`** | Show wallet address, USDC/SOL balances, and deposit instructions. |
| **`x402_settings`** | Read or update your per-call spending limit. |

Two wallets are auto-created at `~/.dexterai-mcp/wallet.json` on first run — one Solana, one EVM. Fund either address with USDC and your agent can start paying for APIs immediately.

---

### Skills (6)

Deep knowledge the agent invokes when relevant:

| Skill | What it teaches |
|-------|-----------------|
| **opendexter** | How to use the x402 tools: search → check → fetch workflow, quality scores, funding flows, error recovery |
| **x402-client** | Build x402 clients: `wrapFetch()`, `createX402Client()`, Budget Accounts for agents, Sponsored Access, keypair wallets, access passes |
| **x402-server** | Add x402 paywalls: `x402Middleware()` with multi-chain accept, Stripe PayTo, dynamic/token pricing, access passes, sponsored access injection |
| **x402-react** | React hooks: `useX402Payment()` (payment state, balances, tx info), `useAccessPass()` (tier discovery, purchase, auto-fetch) |
| **x402-protocol** | v2 spec: core types, payment flow, 3 schemes (exact, upto, bridge), HTTP/MCP/A2A transports, all CAIP-2 networks, error codes |
| **x402-debugging** | Diagnose failures: 27 SDK error codes, facilitator health, fee payer safety, retry support, pre-payment callbacks |

---

### Rules (2, always-on)

Injected into every conversation so the agent always knows the fundamentals:

- **x402-protocol** — CAIP-2 network identifiers, header conventions, atomic units, facilitator URL, supported chains
- **x402-coding** — Import from subpaths (`@dexterai/x402/client`), prefer `wrapFetch()` for agents, `x402Middleware()` for servers

---

### Agent

- **x402-engineer** — Specialized persona that knows the full Dexter x402 stack. Validates amounts and balances before payment, never exposes private keys, reaches for `x402_search` whenever a user mentions paid APIs.

---

### Commands (3)

| Command | What it does |
|---------|-------------|
| **setup-opendexter** | Install the OpenDexter MCP server into Cursor, Claude Code, Codex, VS Code, Windsurf, or Gemini CLI. |
| **setup-x402-client** | Add `@dexterai/x402` to a Node.js project with `wrapFetch()` boilerplate and a test call. |
| **setup-x402-server** | Add `x402Middleware()` to an Express app with paywall configuration and test. |

---

## Supported Chains

| Chain | Network ID (CAIP-2) | Gas Token |
|-------|---------------------|-----------|
| Solana | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | SOL |
| Base | `eip155:8453` | ETH |
| Polygon | `eip155:137` | POL |
| Arbitrum | `eip155:42161` | ETH |
| Optimism | `eip155:10` | ETH |
| Avalanche | `eip155:43114` | AVAX |
| BSC (BNB Chain) | `eip155:56` | BNB |
| SKALE Base | `eip155:1187947933` | sFUEL (free) |

---

## Links

- [Dexter Marketplace](https://dexter.cash/opendexter) — Browse thousands of paid APIs
- [Dexter Facilitator](https://x402.dexter.cash) — Payment infrastructure
- [@dexterai/x402 SDK](https://www.npmjs.com/package/@dexterai/x402) — Build x402 clients and servers
- [@dexterai/opendexter](https://www.npmjs.com/package/@dexterai/opendexter) — MCP gateway for AI agents
- [x402 Protocol Spec](https://x402.org) — The open standard
- [Become a Seller](https://dexter.cash/onboard) — List your API on the marketplace
- [Twitter](https://twitter.com/dexteraisol)
- [Telegram](https://t.me/dexterdao)

---

## License

MIT
