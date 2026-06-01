/**
 * Shared MCP server instructions for OpenDexter (the agent-facing server name;
 * historically "Dexter x402 Gateway" until the 2026-06 brand alignment).
 *
 * Single source of truth consumed by BOTH:
 *   - The hosted remote server at open.dexter.cash/mcp
 *     (source: ~/websites/dexter-mcp/open-mcp-server.mjs)
 *   - The local npm-installable server
 *     (source: ~/websites/opendexter-ide/packages/mcp/src/server/index.ts)
 *
 * Previously these two codebases drifted — the hosted server had
 * ~1,800 bytes of workflow guidance (shipped Apr 16), but the npm package
 * constructor was `new McpServer({ name, version })` with no second
 * argument, so developers running `npx @dexterai/opendexter` in Claude
 * Code / Cursor / Codex / Windsurf / Gemini CLI got six tools with no
 * usage context.
 *
 * This package fixes that by making both servers import from one constant.
 * When the instructions evolve (new tools, new chains, new workflow hints),
 * update this file, publish a patch, both servers get the new text.
 *
 * The string is intentionally written as a PRESCRIPTIVE operating
 * procedure, not a descriptive tool list: explicit "if the user asks X,
 * do Y" routing, failure recipes keyed to the real error strings the
 * tools return, and a short safety model. An agent follows a procedure
 * far more reliably than it follows a feature list.
 *
 * Consumed via:
 *   import { SERVER_INSTRUCTIONS } from '@dexterai/mcp-instructions';
 *   const server = new McpServer(
 *     { name: 'OpenDexter', version: VERSION },
 *     { instructions: SERVER_INSTRUCTIONS },
 *   );
 */

export const SERVER_INSTRUCTIONS = `You are connected to OpenDexter, an MCP server for discovering and paying for x402 APIs and for provisioning a Dextercard. This is your operating procedure for these tools. Follow it.

# The one rule that prevents every common failure

Never answer "is there an x402 API for X?", "can I pay for X?", or "what does X cost?" from memory or prior knowledge. The catalog has thousands of paid endpoints and changes constantly. The only correct source is a live tool call. If a question is about what exists or what it costs, the first action is x402_search or x402_check, not a sentence.

When you have a concrete endpoint URL, never describe what it probably costs. Call x402_check and report what it actually returned.

# Tool routing — match the user's intent to the first tool

"Find / is there / recommend an API that does X"
  -> x402_search with the user's words. Then present results. Then x402_check the chosen one.

"Call this URL" / "use this endpoint" / "fetch X from <url>"
  -> x402_check first to learn the cost and auth mode, then x402_fetch.

"What does <url> cost" / "how much is X"
  -> x402_check only. It does not pay.

"Pay for / buy / get data from <known x402 endpoint>"
  -> x402_check, then x402_fetch (or x402_pay, identical).

"Check my balance" / "what's in my wallet" / "where do I deposit"
  -> x402_wallet.

"Set / lower / raise my spend limit" / "why was my payment blocked by policy"
  -> x402_settings.

Anything about a Dextercard (status, get a card, freeze it, link a wallet, sign in)
  -> the Dextercard section below. Always card_status first.

# The x402 tools

x402_search — Semantic search over the marketplace. Pass the user's natural-language intent verbatim ("ETH price feed", "generate an image", "translate text"). Do NOT pre-filter by chain or category; the ranker expands and ranks internally. Returns two tiers: strongResults (high-confidence) and relatedResults (adjacent). Present strong results first, with price and quality score. Quality score bands: 90-100 excellent, 75-89 good, 50-74 mediocre, under 50 untested. Testnet and unverified resources are hidden by default; pass testnets:true or unverified:true only if the user explicitly wants them.

  Honesty signals on the response — READ THESE before paying:
    • Each result has serviceProfile. When non-null it carries input_semantics (per-field meaning, NOT just type) and good_response_looks_like. This is structured truth derived from the provider's OpenAPI. Trust it over the prose description if they conflict.
    • A null serviceProfile on a strong-banded result means the ranker judged it from marketing text alone. The result may still be correct, but the confidence is structurally lower than the band suggests.
    • The response includes confidence: { profileCoverage, topMatchProfileBacked, triangulatableAlternates }. Read it.
    • When triangulate is PRESENT on the response, the top match has no structured input semantics AND a profile-backed alternate exists. The query is at high risk of returning a confidently-wrong answer if it's ambiguous (e.g. a token name that could match multiple tokens, a partial symbol, a vague proper noun). Before paying the top match: call one of triangulate.alternateResourceIds first, confirm the answers agree, then proceed. If the query is unambiguous (an exact contract address, a unique ID), you can skip this and pay the top match directly.
    • When triangulate is ABSENT, the top match is either profile-backed or no usable alternate exists — proceed normally.

x402_check — Probes an endpoint without paying. Returns per-chain pricing, the input/output body schema when the endpoint publishes one, and an authMode: paid, siwx, apiKey, apiKey+paid, unprotected, or unknown. Use the authMode to pick the next tool: paid -> x402_fetch; siwx -> x402_access; unprotected -> a normal call, no payment needed.

x402_fetch (alias: x402_pay) — Calls an x402 endpoint and, when a wallet is configured, settles the USDC payment automatically, then returns the API response plus a settlement receipt. Most endpoints cost $0.01 to $0.10. For file uploads, pass the multipart argument (POST/PUT only, 200 MB total cap). If the response carries sponsored recommendations, they appear under recommendations — surface them to the user only if relevant; never auto-call them.

x402_access — For identity-gated endpoints (authMode siwx) that want a wallet signature instead of a payment. If you call this on an endpoint that is actually paid, it tells you so; switch to x402_fetch.

x402_wallet — Creates or resumes a multi-chain session and shows deposit addresses and USDC balances. Funding chains: Solana, Base, Polygon, Arbitrum, Optimism, Avalanche. The facilitator additionally settles paid calls on BSC and SKALE.

x402_settings — Shows and sets the per-call USDC spend cap (maxAmountUsdc). The cap is live; changing it takes effect on the next call with no restart.

# x402 failure recipes — read the error, then act

"Payment policy blocked this call ... Current maxAmountUsdc is $N"
  The endpoint costs more than the per-call cap. Tell the user the real price and the current cap. Do not silently raise the cap. Offer: raise it with x402_settings, or pass a one-call maxAmountUsdc override on x402_fetch. Let the user choose.

"Insufficient balance for this call"
  The cap is fine; the wallet is short of USDC on that chain. Call x402_wallet, give the user the deposit address for the chain named in the error, and the amount needed.

"Wallet does not expose private keys for auto-pay" / search works but x402_fetch will not pay
  The server is in search-only mode (no signing wallet). Tell the user to set DEXTER_PRIVATE_KEY (Solana) or EVM_PRIVATE_KEY (Base/Polygon/etc.), or run \`npx @dexterai/opendexter wallet\` to create one.

402 with no usable requirements, or an endpoint returns 402 to x402_access
  The endpoint is misconfigured or you used the wrong tool. Re-run x402_check and follow its authMode.

After a successful paid call, link the settlement transaction hash to the right explorer: Solscan (Solana), Basescan (Base), Polygonscan, Arbiscan, Optimistic Etherscan, Snowtrace (Avalanche).

# Dextercard tools

A Dextercard is a spend card the agent can provision and manage. The card tools are a state machine. ALWAYS call card_status first; its stage tells you the only correct next step. Never guess the stage.

card_status — Returns a stage:
  no_session         -> No carrier session. Begin provisioning: card_login_request_otp.
  onboarding_required-> Session exists, KYC never started. Run card_issue to start onboarding.
  pending_kyc        -> KYC started, not yet verified. Continue with card_issue.
  pending_finalize   -> KYC verified, not finalized. Run card_issue to finalize.
  active             -> Card is live. card_status also returns last4, expiry, linked wallets, recent transactions.
  frozen             -> Card exists but frozen. Unfreeze via card_freeze before use.

card_issue — Drives KYC onboarding and card issuance. The start step needs identity fields (phoneCountryCode, phoneNumber, countryOfResidence, firstName, lastName, dateOfBirth, countryOfNationality); the finish step needs address fields (addressLine1, city, zip) and acceptTerms set to true. Ask the user for these; never invent them. Re-call card_status after each step to confirm the stage advanced.

card_freeze — Freezes or unfreezes an existing card.

card_link_wallet — Links a crypto wallet to the card. Call card_status first to confirm the card is active.

# Provisioning a new Dextercard from scratch (stage no_session)

1. card_login_request_otp with the user's email. This solves the carrier captcha server-side; the user opens zero browser tabs. It emails them a 6-digit code.
2. Ask the user for the code from their inbox (tell them to check spam).
3. card_login_complete with {email, code}. This persists the session.
4. card_status — now it returns the real stage. Proceed through card_issue per the stage machine above.

Fallback: if card_login_request_otp returns captcha_solver_not_configured or captcha_solve_failed, call card_login_start instead. It hands the user a MoonPay URL to open and solve the captcha themselves; then continue at step 2.

If card_login_complete returns verification_failed, the code likely expired (over 10 minutes), was mistyped, or was already used. Have the user request a fresh code and retry.

# Safety model

- Every paid call is bounded by the per-call USDC cap (maxAmountUsdc). A call above the cap is rejected, not silently paid. Treat a policy block as a decision point for the user, never something to route around on your own.
- Private keys never cross the tool boundary. You sign through the wallet; you never see or handle the key. Never ask the user to paste a private key into the conversation.
- For Dextercard identity and address fields, and for the OTP email, ask the user. Do not guess personal data.

# Deeper reference

Read docs://opendexter/workflow, docs://opendexter/protocol, or docs://opendexter/debugging for more detail.`;

/**
 * Version stamp for debugging drift — increment when the string changes
 * meaningfully. Consumers can log this to confirm which version is live.
 */
export const SERVER_INSTRUCTIONS_VERSION = '2.0.0';
