---
name: opendexter
description: "Use OpenDexter to find and pay for x402 APIs from any AI agent. Trigger this skill whenever the user asks to find, price-check, or call a paid API; pay in USDC; check or fund a wallet; settle on Solana, Base, Polygon, Arbitrum, Optimism, Avalanche, BSC, or SKALE; or work with a Dextercard. Trigger on mentions of x402, OpenDexter, paid APIs, agent payments, or `npx @dexterai/opendexter`."
---

# OpenDexter

OpenDexter is the public x402 gateway for AI agents: one MCP server and one wallet that works across eight chains. From it an agent can search thousands of paid APIs, see the price before paying, call any of them with automatic USDC settlement, and optionally drive a Dextercard from the same surface.

## When to use this skill

Anytime the user wants to:

- **Find a paid API** (e.g. "is there an API for X?", "find me a price feed for ETH", "anything that generates an image?")
- **Call an x402 endpoint** (paste a URL, run a request that hits a 402)
- **Check or fund a wallet** for x402 payments
- **Manage a Dextercard** (issue a card, link a funding wallet, freeze, check status)

This skill applies if the user mentions `x402`, `OpenDexter`, `dexter.cash`, `open.dexter.cash/mcp`, paid APIs, USDC payments for APIs, or pasting a URL that returns 402.

## Hosted vs local: which mode am I on?

OpenDexter ships in two flavors. Most of the surface is identical; a few tools and instructions differ. **Detect mode from the tool list before answering setup questions.**

| Mode | URL / install | Wallet model | Tools that exist |
|---|---|---|---|
| **Hosted MCP** | `https://open.dexter.cash/mcp` (added as a connector in Claude.ai, ChatGPT, Cursor, etc.) | Non-custodial passkey vault bound to the session (Solana). Pairing via dexter.cash; `dexter_passkey` drives wallet onboarding. | The x402 family (`x402_search`, `x402_check`, `x402_fetch`, `x402_pay`, `x402_access`, `x402_wallet`), the card family incl. `card_login_request_otp`/`card_login_complete`, plus hosted-only `x402_compose_skill`, `promote_skill`, `dexter_passkey`, `dexter_passkey_probe`. NOT present: `x402_settings`, `card_login_start`. |
| **Local npx** | `npx @dexterai/opendexter@latest` (Claude Code, Cursor, Codex, Windsurf, Gemini CLI) | Local file at `~/.dexterai-mcp/wallet.json` (override with `DEXTER_PRIVATE_KEY` / `EVM_PRIVATE_KEY`). | The x402 family plus local-only `x402_settings`, and the card family incl. `card_login_start`. NOT present: the passkey/skill tools. |

**Quick detection rule**: `x402_settings` registered → **local npx**. `dexter_passkey` registered → **hosted**. (`card_login_request_otp`/`card_login_complete` exist on BOTH surfaces — never use them to detect the mode.) The server's own served instructions are the authority for your surface's exact roster.

Setup advice depends on mode:

- **Hosted**: never tell the user to set environment variables, edit `~/.dexterai-mcp/settings.json`, or run a CLI command. They paired through dexter.cash; that's all the bootstrap they need.
- **Local npx**: the wallet file lives at `~/.dexterai-mcp/wallet.json`. Spend cap edits go in `~/.dexterai-mcp/settings.json` (or call `x402_settings`). Env-var override available for production keys.

When in doubt, run `x402_wallet`. It tells you whether you have a session and where to deposit.

## Tools, in the order they should be used

### 1. `x402_search`: Find APIs

**Always start here for discovery.** Semantic capability search across the marketplace. Returns two tiers: `strongResults` (high-confidence capability matches) and `relatedResults` (adjacent services worth knowing about). Each result includes name, URL, price, network, qualityScore (0–100), verified status, host, tier, similarity, a short `why` ranking explanation, and a `chains[]` array with every payment option.

| Param | Type | Description |
|---|---|---|
| `query` | string | Natural-language query. e.g. `"check wallet balance on Base"`, `"generate an image"`, `"ETH price feed"` |
| `limit` | number | Max results across both tiers (1–50, default 20) |
| `unverified` | boolean | Include unverified resources (default false) |
| `testnets` | boolean | Include testnet-only resources (default false) |
| `rerank` | boolean | LLM cross-encoder rerank of top results (default true). Set `false` for deterministic order. |

Do not pre-filter by chain or category. The ranker handles synonyms and expansion internally.

### 2. `x402_check`: Preview pricing

Probes an endpoint and returns its 402 payment requirements (price per chain, accepted assets, schema hints) **without paying**. Use this before the first paid call.

| Param | Type | Description |
|---|---|---|
| `url` | string | The URL to check |
| `method` | string | GET / POST / PUT / DELETE (default GET) |

If the endpoint returns 200 with no 402, tell the user it's free. If it returns 401/403, the provider requires its own auth before x402 settlement is offered.

### 3. `x402_fetch`: Call and pay

Calls the endpoint and pays automatically from the local wallet. Returns the API response **plus** a settlement receipt (transaction hash, amount, chain). On success, link the hash to the right explorer:

| Chain | Explorer |
|---|---|
| Solana | `solscan.io/tx/<sig>` |
| Base | `basescan.org/tx/<hash>` |
| Polygon | `polygonscan.com/tx/<hash>` |
| Arbitrum | `arbiscan.io/tx/<hash>` |
| Optimism | `optimistic.etherscan.io/tx/<hash>` |
| Avalanche | `snowtrace.io/tx/<hash>` |
| BSC | `bscscan.com/tx/<hash>` |
| SKALE | `<chain>.explorer.mainnet.skalenodes.com/tx/<hash>` |

| Param | Type | Description |
|---|---|---|
| `url` | string | The x402 resource URL |
| `method` | string | HTTP method (default GET) |
| `body` | string | JSON request body for POST/PUT |
| `maxAmountUsdc` | number | Optional per-call spend cap, overrides the default for this one call |
| `multipart` | object | For file uploads. POSTs `multipart/form-data` instead of JSON; carries `fields` (text) and `files` (read from disk). POST/PUT only, 200 MB max. |

If the wallet has no USDC, the call fails. Run `x402_wallet` first, surface the deposit address for the right chain, tell the user to fund it, then retry the call.

### 4. `x402_pay`: Alias of `x402_fetch`

Use whichever name reads more naturally. Same parameters, same behavior.

### 5. `x402_access`: Identity-gated endpoints

Some endpoints require a wallet signature (Sign-In-With-X) instead of a per-call payment. Use this tool for those: it presents the wallet proof and returns the response.

| Param | Type | Description |
|---|---|---|
| `url` | string | The identity-gated endpoint URL |
| `method` | string | HTTP method (default GET) |

### 6. `x402_wallet`: Multi-chain wallet

Returns deposit addresses and USDC balances across **Solana, Base, Polygon, Arbitrum, Optimism, Avalanche**. (The facilitator additionally settles on **BSC** and **SKALE** when an endpoint requires those chains.)

What "the wallet" means depends on mode:

- **Hosted**: the session wallet managed by the gateway, provisioned when the user paired through dexter.cash. Funded by deposits to the addresses this tool returns.
- **Local npx**: the file at `~/.dexterai-mcp/wallet.json`, or whatever key is in `DEXTER_PRIVATE_KEY` / `EVM_PRIVATE_KEY` if those env vars are set.

Use it:

- Before a fetch, to confirm sufficient funds
- When the user asks "how much do I have?" or "where do I send USDC?"
- After a fetch fails on insufficient funds

If a balance is zero, proactively show the deposit address and tell the user to fund before attempting the call.

### 7. `x402_settings` *(local npx only)*

Read or update the per-call USDC cap that gates automatic payments. Backed by `~/.dexterai-mcp/settings.json` and hot-reloaded, so no restart is needed after a change.

**This tool does not exist on the hosted server.** If you're on hosted and the user wants to change spend limits, direct them to dexter.cash account settings.

## Dextercard tools

Dextercard is the optional payment-card surface. Issue a card backed by your funded wallet, then spend at any merchant. Cards are created via Crossmint and provisioned through the same MCP session.

### `card_status`: Always run this first

Returns the current account stage so the agent knows which next step to suggest. Possible stages:

| Stage | Meaning | Next step |
|---|---|---|
| `no_session` | No Dextercard session paired | **Local npx**: call `card_login_request_otp`, then `card_login_complete`. **Hosted**: surface the pairing URL the tool returns and tell the user to complete pairing on dexter.cash. |
| `onboarding_required` | Session exists, account not started | Call `card_issue` with `step: "auto"` |
| `pending_kyc` | KYC submitted, awaiting verification | Wait, then re-check |
| `pending_finalize` | KYC passed, address/terms not submitted | Call `card_issue` with `step: "auto"` |
| `not_issued` | Eligible but no card yet | Call `card_issue` with `step: "auto"` |
| `active` | Card live and unfrozen | Use `card_link_wallet` / `card_freeze` |
| `frozen` | Card paused | Call `card_freeze` with `frozen: false` to resume |

Always call `card_status` before `card_issue` or `card_link_wallet`. Do not assume state.

### `card_issue`: Drive issuance

Walks the user through KYC and provisioning one step at a time. Use `step: "auto"` and let the tool decide the right action; only override with explicit step names if the user wants manual control.

### `card_link_wallet`: Authorize a wallet to fund the card

| Param | Type | Description |
|---|---|---|
| `currency` | string | Native asset of the wallet (usually `"usdc"`) |
| `amount` | number | Spend cap in human-readable units (e.g. `5000` = 5,000 USDC) |

Pre-condition: card must be `active`. Post-condition: linked wallets show up in `card_status.wallets`.

### `card_freeze`: Pause or resume the card

Pass `frozen: true` to freeze or `frozen: false` to resume, and the tool returns the updated card metadata.

### `card_login_request_otp` / `card_login_complete` *(both surfaces)*

Bootstrap a Dextercard session from inside the agent without leaving the chat.

`card_login_request_otp` is the smooth path: it solves the carrier's captcha
server-side and asks the carrier to email the user a one-time code. No browser
tab. After it returns ok, ask the user for the 6-digit code from their email,
then call `card_login_complete` with `{email, code}` to persist the session.

If `card_login_request_otp` returns `captcha_solver_not_configured` or
`captcha_solve_failed`, the fallback depends on your surface: on **local npx**,
call `card_login_start` — it returns a MoonPay URL the user opens to solve the
captcha themselves, after which they still get an OTP email and you finish
with `card_login_complete`. On **hosted** (no `card_login_start`), direct the
user to provision at `https://dexter.cash/dextercard` instead.

Once `card_login_complete` succeeds, all `card_*` tools work as if the user
had paired through dexter.cash.

On hosted, an alternative to the OTP flow exists: when `card_status` returns
`auth_required`/`no_session` it includes a clickable pairing URL — surface it
and the user signs in at dexter.cash; after pairing, the standard `card_issue`
flow continues. Both paths are valid on hosted; the OTP flow keeps the user
in-chat.

## Workflow patterns

### "Find me an API for X"

1. `x402_search` with the user's query
2. Present the top 2–4 results with name, price, quality score, chain
3. Either suggest the top match or ask the user to pick
4. `x402_check` to confirm the price (and pick the cheapest chain if there are multiple)
5. `x402_fetch` to call

### "Call this URL"

1. `x402_check` first to surface the price
2. `x402_fetch` to settle and call

### "How much USDC do I have?" / "Where do I send funds?"

1. `x402_wallet`
2. Surface deposit addresses per chain
3. If a balance is zero, suggest funding via the chain with cheapest gas (Base or Solana for most users)

### "I want a Dextercard"

1. `card_status` to find the current stage
2. From the stage, route to the right next step (see table above)
3. Use `card_issue { step: "auto" }` to advance, repeat until `active`
4. `card_link_wallet` to authorize a funding wallet

### "Pay this and freeze my card after"

1. `card_status` to confirm `active`
2. `x402_fetch` for the actual payment
3. `card_freeze { frozen: true }` to pause

## Quality scores

| Range | Meaning |
|---|---|
| 90–100 | Excellent. Verified, returns correct data. |
| 75–89 | Good. Passed verification, reliable. |
| 50–74 | Mediocre. Works but has issues. |
| Below 50 | Poor or untested. Use with caution. |

A `verified: true` flag means the resource has passed Dexter's automated quality bot. Most production endpoints sit in the 75+ band.

## Supported chains

Wallet funding (any of these accepts USDC and is shown by `x402_wallet`):

- **Solana** (preferred: fastest finality, lowest fees for most users)
- **Base**
- **Polygon**
- **Arbitrum**
- **Optimism**
- **Avalanche**

The facilitator additionally settles paid calls on:

- **BSC** (Binance Smart Chain)
- **SKALE** (Base chain)

Endpoints declare which chains they accept; `x402_check` shows you the full per-chain price so you can pick the cheapest one.

## Pricing

- Most endpoints cost **$0.01 – $0.10** per call.
- Compute-heavy endpoints (image gen, large completions, on-chain analytics) cost more. `x402_check` shows the real number.
- The wallet only needs USDC. The facilitator pays gas on every supported chain.

## Quick install

### Hosted MCP (recommended for most users)

Add a single URL as a connector. No install, no env vars, no wallet file. Works in Claude.ai, ChatGPT, Cursor, and any MCP-compatible client.

```
https://open.dexter.cash/mcp
```

In Claude.ai: Settings → Connectors → Add custom connector, paste the URL. The first time `card_status` or `x402_wallet` runs, it'll surface a pairing URL to dexter.cash for one-time setup.

### Local npx (for terminal-native agents)

Best for Claude Code, Cursor, Codex, Windsurf, and Gemini CLI when you want the wallet on your own machine.

```bash
npx @dexterai/opendexter@latest
```

Or wire it into an MCP client config:

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

The wallet lives at `~/.dexterai-mcp/wallet.json`. Override with `DEXTER_PRIVATE_KEY` (Solana) or `EVM_PRIVATE_KEY` (EVM chains) env vars for production keys. Spend cap lives in `~/.dexterai-mcp/settings.json` or via the `x402_settings` tool.

## Key behaviors to remember

- **Search is semantic.** Typos and synonyms are handled. Describe what you want in plain English.
- **Don't filter by chain in the query.** The ranker does that for you.
- **Always run `x402_check` before the first paid call** to a new URL so the user sees the price.
- **Detect mode before giving setup advice.** If `x402_settings` is in the tool list you're on local npx; otherwise hosted. Don't tell hosted users to set env vars or edit JSON files.
- **Insufficient funds = soft failure.** Re-route to `x402_wallet` and surface the deposit address.
- **Card tools fail loud on missing session.** When `card_status` returns `no_session`, run `card_login_request_otp` (local npx) or surface the pairing URL the tool returns (hosted).
- **After settlement, link the explorer URL** for the chain that paid (see table under `x402_fetch`).

## For API sellers

Want your API on the marketplace?

1. Visit `https://dexter.cash/onboard`
2. Add `x402Middleware` from `@dexterai/x402/server` to your endpoints
3. Register your resource URL with the facilitator
4. Dexter's quality bot verifies and scores your endpoint automatically, usually within an hour

Listings update in `x402_search` results once the resource is verified.

## Reference

- npm package: `https://www.npmjs.com/package/@dexterai/opendexter`
- Hosted MCP: `https://open.dexter.cash/mcp`
- Marketplace explorer: `https://x402gle.com`
- Onboard a new API: `https://dexter.cash/onboard`
- Connector pages (for hosted MCP): `https://claude.ai/settings/connectors`
- Server-side reference docs: `docs://opendexter/workflow`, `docs://opendexter/protocol`, `docs://opendexter/debugging` (resources exposed by the MCP server itself)
