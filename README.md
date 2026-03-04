<p align="center">
  <img src="https://raw.githubusercontent.com/Dexter-DAO/dexter-x402-sdk/main/assets/dexter-wordmark.svg" alt="Dexter" width="360">
</p>

<h1 align="center">x402 Payments</h1>

<p align="center">
  <strong>The first payment protocol plugin for the Cursor Marketplace.</strong><br>
  Search 5,000+ paid APIs. Pay with USDC. Build x402 into any project.
</p>

<p align="center">
  <a href="https://x402.org"><img src="https://img.shields.io/badge/protocol-x402_v2-00FF88" alt="x402"></a>
  <a href="https://www.npmjs.com/package/@dexterai/opendexter"><img src="https://img.shields.io/npm/v/@dexterai/opendexter.svg" alt="npm"></a>
  <a href="https://www.npmjs.com/package/@dexterai/x402"><img src="https://img.shields.io/npm/v/@dexterai/x402.svg?label=%40dexterai%2Fx402" alt="SDK"></a>
  <a href="https://dexter.cash/opendexter"><img src="https://img.shields.io/badge/Marketplace-5%2C000%2B_APIs-blueviolet" alt="Marketplace"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT"></a>
</p>

<p align="center">
  <a href="https://dexter.cash/opendexter"><strong>Browse Marketplace →</strong></a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="https://x402.org"><strong>x402 Protocol →</strong></a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="https://www.npmjs.com/package/@dexterai/x402"><strong>SDK Docs →</strong></a>
</p>

---

## What This Plugin Does

Most Cursor plugins are rules and skills — static knowledge. This one ships with a **real MCP server** that gives your agent four live tools for searching, paying for, and calling paid APIs. On top of that, it has deep SDK knowledge so the agent can help you **build** x402 payments into your own projects.

Install the plugin and your Cursor agent can immediately:

- **Search** the Dexter Marketplace for any paid API (image generation, DeFi, analytics, AI, games — 5,000+ endpoints)
- **Check** what an API costs before paying
- **Pay and call** any x402 API with automatic USDC settlement
- **Help you build** x402 clients, servers, React apps, Stripe integrations, and access passes

---

## What is x402?

[x402](https://x402.org) is an open protocol for machine-to-machine payments over HTTP. When an API returns `402 Payment Required`, it includes payment instructions. The client pays (USDC on Solana, Base, or other chains), and the API delivers the response. No API keys, no subscriptions, no invoices.

Dexter operates the most-used x402 facilitator at `https://x402.dexter.cash`, processing millions of settlements across 5,000+ indexed endpoints from every major x402 facilitator — Dexter, Coinbase, PayAI, and more.

---

## Plugin Contents

### MCP Server — `@dexterai/opendexter`

The plugin auto-configures the [OpenDexter](https://www.npmjs.com/package/@dexterai/opendexter) MCP server. Five tools cover everything:

| Tool | Description |
|------|-------------|
| **`x402_search`** | Search 5,000+ paid APIs by keyword, category, chain, or price. Returns quality scores, verification status, and seller reputation. |
| **`x402_check`** | Preview pricing per chain without spending anything. See exactly what an API costs before committing. |
| **`x402_fetch`** | Call any x402 API with automatic USDC payment. Signs, pays, retries — returns the response directly with an on-chain settlement receipt. |
| **`x402_pay`** | Lower-level payment flow for agents that manage their own wallet signing. |
| **`x402_wallet`** | Show wallet address, USDC/SOL balances, and deposit instructions. |

Everything else — Jupiter DEX quotes, image generation, on-chain analytics, social sentiment, games — is a marketplace resource you discover through `x402_search` and call through `x402_fetch`. Five tools, infinite capabilities.

A local Solana wallet is auto-created at `~/.dexterai-mcp/wallet.json` on first run. Fund it with USDC and your agent can start paying for APIs immediately.

---

### Skills (7)

Deep knowledge the agent invokes when relevant:

| Skill | What it teaches |
|-------|-----------------|
| **opendexter** | How to use the x402 tools effectively: search → check → fetch → wallet workflow patterns, quality scores, funding flows, error recovery |
| **x402-client** | Build x402 clients with `wrapFetch()`, `createX402Client()`, Solana/EVM keypair wallets, access passes, dual-chain support |
| **x402-server** | Add x402 paywalls with `x402Middleware()`, `createX402Server()`, Stripe PayTo, dynamic pricing, token pricing, browser paywalls, model registry |
| **x402-react** | React hooks: `useX402Payment()`, `useAccessPass()`, wallet adapter and wagmi integration, full component examples |
| **x402-protocol** | v2 spec reference: core types, payment flow, HTTP/MCP/A2A transports, EVM and Solana scheme mechanics, all CAIP-2 networks, all error codes |
| **x402-marketplace** | Marketplace discovery: search API, quality scoring, categories, sort options, seller reputation, becoming a seller, dynamic tool discovery |
| **x402-debugging** | Diagnose payment failures: facilitator health checks, error code reference, common issues and fixes, fee payer isolation rules |

---

### Rules (2, always-on)

Injected into every conversation so the agent always knows the fundamentals:

- **x402-protocol** — CAIP-2 network identifiers, header conventions (`PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`), atomic units, facilitator URL, supported chains, SDK package structure
- **x402-coding** — Import from subpaths (`@dexterai/x402/client`), prefer `wrapFetch()` for agents, `x402Middleware()` for servers, `X402Error` handling, tool workflow order

---

### Agent

- **x402-engineer** — Specialized persona that knows the full Dexter x402 stack. Prefers the simplest pattern first, validates amounts and balances before payment, never exposes private keys, and reaches for `x402_search` whenever a user mentions paid APIs.

---

### Commands (3)

Guided scaffolding workflows:

| Command | What it does |
|---------|-------------|
| **setup-opendexter** | Install the OpenDexter MCP server into Cursor, Claude Code, Codex, VS Code, Windsurf, or Gemini CLI. Creates wallet and writes config. |
| **setup-x402-client** | Add `@dexterai/x402` to a Node.js project with `wrapFetch()` boilerplate, env vars, and a test call example. |
| **setup-x402-server** | Add `x402Middleware()` to an Express app with paywall configuration, curl test, and facilitator flow explanation. |

---

## Quick Start

### Use paid APIs (agent tools)

After installing the plugin, your agent has the tools immediately. Try:

```
"Search for image generation APIs under $0.10"
→ x402_search(query: "image generation", maxPriceUsdc: 0.10)

"How much does this cost?"
→ x402_check("https://x402.dexter.cash/api/v2-test", method: "POST")

"Call it"
→ x402_fetch("https://x402.dexter.cash/api/v2-test", method: "POST")

"Check my balance"
→ x402_wallet()
```

### Build an x402 client (SDK)

```typescript
import { wrapFetch } from '@dexterai/x402/client';

const x402Fetch = wrapFetch(fetch, {
  walletPrivateKey: process.env.SOLANA_PRIVATE_KEY!,
});

const response = await x402Fetch('https://x402-api.example.com/data');
```

### Build an x402 server (SDK)

```typescript
import { x402Middleware } from '@dexterai/x402/server';

app.get('/api/data',
  x402Middleware({
    payTo: 'YourSolanaAddress...',
    amount: '0.01',
  }),
  (req, res) => res.json({ data: 'premium content' })
);
```

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
| SKALE Europa | `eip155:2046399126` | sFUEL (free) |

The MCP and SDK auto-detect which chain a 402 response requires and sign with the appropriate method.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Cursor Plugin (this repo)                 │
│                                                             │
│  ┌─────────┐  ┌──────────┐  ┌────────┐  ┌──────────┐      │
│  │  Rules  │  │  Skills  │  │ Agent  │  │ Commands │      │
│  │ (2)     │  │ (7)      │  │ (1)    │  │ (3)      │      │
│  └─────────┘  └──────────┘  └────────┘  └──────────┘      │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  MCP Server: @dexterai/opendexter                    │   │
│  │  x402_search · x402_check · x402_fetch · x402_wallet│   │
│  └──────────────────────┬──────────────────────────────┘   │
└─────────────────────────┼───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│              @dexterai/x402 SDK (npm package)                │
│                                                             │
│  /client          /server           /react                  │
│  wrapFetch        x402Middleware    useX402Payment           │
│  createX402Client createX402Server  useAccessPass            │
│  keypairWallet    stripePayTo      wallet adapters           │
│                   dynamicPricing                             │
│                   accessPass                                 │
│                   browserSupport                             │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│           Dexter Facilitator (x402.dexter.cash)              │
│                                                             │
│  /verify    /settle    /supported    /healthz                │
│                                                             │
│  Solana · Base · Polygon · Arbitrum · Optimism · Avalanche  │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│              Dexter Marketplace (5,000+ APIs)                │
│                                                             │
│  AI · DeFi · Data · Tools · Games · Creative                │
│  Quality-verified · Reputation-scored · Multi-chain          │
└─────────────────────────────────────────────────────────────┘
```

---

## Links

- [Dexter Marketplace](https://dexter.cash/opendexter) — Browse 5,000+ paid APIs
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
