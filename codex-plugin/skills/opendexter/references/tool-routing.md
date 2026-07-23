# OpenDexter tool routing

The OpenDexter app exposes exactly these 10 tools. This document is the routing
authority: match the user's words to the first tool, in this order of precedence.

## The full decision table

| # | User says (patterns) | Tool | Notes |
|---|---|---|---|
| 1 | "check my (OpenDexter/Dexter) passkey", "do I have a Dexter wallet?", "set up my wallet", "resume wallet setup", "link my wallet to this chat" | `dexter_passkey` | Read-only status + setup/pairing link. The default for existence/enrollment/setup questions. |
| 2 | "what's my wallet address?", "USDC balance", "where do I deposit?", "how much do I have?" | `x402_wallet` | Read-only. Returns Solana address + USDC balance when bound; a one-time setup link when not. |
| 3 | "find/is there/recommend an API that does X" | `x402_search` | Semantic search. Pass the user's words verbatim as `query`. |
| 4 | "what does <url> cost?", "how much is this endpoint?", "is it any good?" | `x402_check` | Probes without paying. Also returns quality score, verifier verdict, history when cataloged. |
| 5 | "call/fetch/pay for <x402 url>", "get the data from X" | `x402_check` first, then confirmed `x402_fetch` | Never fetch a new URL blind — check, surface price, get approval. |
| 6 | "pay" phrasing where fetch applies | `x402_fetch` (preferred) or `x402_pay` | `x402_pay` is an alias with the same schema and payment path. Prefer `x402_fetch` — file uploads (`multipart`) only work through `x402_fetch`. |
| 7 | endpoint wants wallet sign-in / Sign-In-With-X / wallet proof, not a per-call price | `x402_access` | Auth proof, not payment. Its optional session context is separate from the wallet. |
| 8 | "turn this host/API into a skill", "compose a skill from X" | `x402_compose_skill` | Default (`publish` unset) returns the bundle inline; persists nothing. |
| 9 | "publish my skill", "put it on the marketplace" | `x402_compose_skill` with `publish: true` | External write. Explicit user request + confirmation required. Needs a claimed handle. |
| 10 | "make my skill public/unlisted", "archive my skill" | `promote_skill` | External visibility write. Confirmation required. |
| 11 | anything Dextercard: "card status", "get a card", "freeze my card", "fund my card", "sign in to my card" | — no tool | The card lives in the user's Dexter wallet on the web: https://dexter.cash/dextercard. This app has no card tools — relay the link, never invent card state. |
| 12 | user explicitly asks for the "passkey probe" / "iframe WebAuthn diagnostic" by name | `dexter_passkey_probe` | The ONLY route to the probe. Diagnostic; never for ordinary requests. |

## Ordering rules that beat everything above

1. **Live data beats memory.** Never answer "is there an API for X", "what does X cost", or any
   balance/status question from prior knowledge. The catalog and the user's state change
   constantly; the answer is always a tool call.
2. **check before fetch.** The first paid call to any URL in a conversation is preceded by
   `x402_check` and explicit user approval of the price. Exception: the user already approved
   this exact call and you are retrying it after an auth detour (`retry` envelope, see
   authentication.md). Never re-run a call whose settlement came back unconfirmed
   (see safety-and-confirmation.md).
3. **search does not pay, check does not pay.** No read escalates into a write without a
   fresh user decision.

## Disambiguation

- **"Do I have a Dexter wallet?"** → `dexter_passkey`. It answers existence
  (`vault_status`: `not_enrolled` / `provisioning` / `ready`). Use `x402_wallet` instead when
  the user's actual want is the address or balance — its answer for an unbound session is a
  setup link, not a clean "no".
- **"Wallet" vs "card":** "wallet" (vault, passkey, USDC balance, deposit) → wallet tools;
  "card", "Dextercard", "Mastercard", "freeze", "card KYC" → the web answer
  (https://dexter.cash/dextercard), no tool. "Link my wallet" means linking the wallet **to
  this chat session** → `dexter_passkey`; if the user means linking a wallet to fund their
  Dextercard, that also happens in the wallet on the web, not here.
- **"Skill":** in OpenDexter, "skill" can mean a composed marketplace skill (rows 8-10). If
  the user means an agent skill for their own IDE/assistant, that is not a tool call at all.
- **Generic passkey talk** ("how do passkeys work?", another product's passkey) with no
  Dexter/OpenDexter context: do not invoke any OpenDexter tool.

## Names, aliases, speech-to-text variants

Treat all of these as OpenDexter triggers: "OpenDexter", "Open Dexter", "open dexter",
"OpenDex", "Dexter", "dexter.cash", "Dexter wallet", "my passkey wallet", "Dextercard",
"Dexter card", "x402", "x-402", "x 402", "x four oh two", "402 API", "x402gle",
"paid API (in USDC)", "agent payments". Speech-to-text commonly renders "Dexter" as "Dexters"
or "deckster" and "x402" as "x four oh two" / "ex 402" — when a wallet/payment intent is
present with a near-miss name, assume OpenDexter and confirm naturally in the reply rather
than asking a clarifying question first.

## Network constraint

The paying wallet on this app is a Dexter passkey vault, and passkey vaults pay **on Solana
only**. Consequences:

- `x402_search`: always pass `network: "solana"` so every result is actually payable by this
  user. Do not otherwise pre-filter by chain or category — the ranker handles that.
- `x402_check`: when multiple chain prices come back, the Solana price is the one this wallet
  can pay. Present that one; mention others only if the user asks.
- Never route the user toward an endpoint that has no Solana payment option and then fail at
  pay time.

## What is NOT on this surface

- **Card tools.** There are none on this app. Every Dextercard request gets the web answer:
  the card lives in the user's Dexter wallet at https://dexter.cash/dextercard.
- **`x402_settings`** belongs to other OpenDexter distributions (the local npm server), not
  to this app. Never call it here, and never tell users to edit `~/.dexterai-mcp/*` files or
  set wallet env vars — those are npm-CLI instructions and are wrong here. If the user asks
  about spend limits, say this app has no spend-limit control and point them at their wallet
  at https://dexter.cash/wallet.
