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
 * Then a SECOND drift appeared: the two servers register DIFFERENT tool
 * rosters (the hosted authenticated surface has passkey onboarding + skill
 * composition and no local settings/env-var wallet; the local surface has
 * x402_settings + env-var wallet + card_login_start and no passkey tools).
 * A single hardcoded string served verbatim to both was structurally
 * guaranteed to LIE to one of them. This package fixes that by making the
 * instructions a FUNCTION of the surface's capabilities: each server passes
 * its SurfaceCaps and gets per-surface truth. assertInstructionRosterParity
 * turns any future text/roster mismatch into a boot failure.
 *
 * The string is intentionally written as a PRESCRIPTIVE operating
 * procedure, not a descriptive tool list: explicit "if the user asks X,
 * do Y" routing, failure recipes keyed to the real error strings the
 * tools return, and a short safety model. An agent follows a procedure
 * far more reliably than it follows a feature list.
 *
 * Consumed via:
 *   import { buildServerInstructions, LOCAL_CAPS } from '@dexterai/mcp-instructions';
 *   const server = new McpServer(
 *     { name: 'OpenDexter', version: VERSION },
 *     { instructions: buildServerInstructions(LOCAL_CAPS) },
 *   );
 */

import pkg from '../package.json';

export interface SurfaceCaps {
  surface: 'local' | 'hosted';
  hasSettings: boolean;
  hasCardLoginStart: boolean;
  hasPasskeyTools: boolean;
  hasSkillTools: boolean;
  hasDocsResources: boolean;
  multichainFunding: boolean;
  /** Whether this surface exposes the session-bound governed asset inventory. */
  hasPortfolioTool?: boolean;
  /**
   * Whether the surface exposes the six card_* tools. Optional, DEFAULT TRUE
   * so existing consumers render unchanged until they opt out. Owner ruling
   * Jul 23 (card-removal runbook): cards come off the MCP product on both
   * first-party surfaces — the card lives in the wallet widget instead
   * (widget-side reveal; no card tools feed it).
   */
  hasCardTools?: boolean;
}

/** Card tools present unless the surface explicitly opts out. */
function cardsOn(caps: SurfaceCaps): boolean {
  return caps.hasCardTools !== false;
}

// ---------------------------------------------------------------------------
// Preamble — the framing + the one rule. Surface-independent.
// ---------------------------------------------------------------------------

const PREAMBLE_LEAD_CARDS =
  'You are connected to OpenDexter, an MCP server for discovering and paying for x402 APIs and for provisioning a Dextercard. This is your operating procedure for these tools. Follow it.';

const PREAMBLE_LEAD_NO_CARDS =
  'You are connected to OpenDexter, an MCP server for discovering and paying for x402 APIs. This is your operating procedure for these tools. Follow it.';

const PREAMBLE_RULE = `# The one rule that prevents every common failure

Never answer "is there an x402 API for X?", "can I pay for X?", or "what does X cost?" from memory or prior knowledge. The catalog has thousands of paid endpoints and changes constantly. The only correct source is a live tool call. If a question is about what exists or what it costs, the first action is x402_search or x402_check, not a sentence.

When you have a concrete endpoint URL, never describe what it probably costs. Call x402_check and report what it actually returned.`;

function preamble(caps: SurfaceCaps): string {
  return [cardsOn(caps) ? PREAMBLE_LEAD_CARDS : PREAMBLE_LEAD_NO_CARDS, PREAMBLE_RULE].join('\n\n');
}

// ---------------------------------------------------------------------------
// Tool routing — one entry per intent, some conditioned on the surface.
// ---------------------------------------------------------------------------

const ROUTING_HEADER = `# Tool routing — match the user's intent to the first tool`;

const ROUTE_SEARCH = `"Find / is there / recommend an API that does X"
  -> x402_search with the user's words. Then present results. Then x402_check the chosen one.`;

const ROUTE_CALL_URL = `"Call this URL" / "use this endpoint" / "fetch X from <url>"
  -> x402_check first to learn the cost and auth mode, then x402_fetch.`;

const ROUTE_COST = `"What does <url> cost" / "how much is X"
  -> x402_check only. It does not pay.`;

const ROUTE_PAY = `"Pay for / buy / get data from <known x402 endpoint>"
  -> x402_check, let the user choose one purchaseOption whose availability.state is ready, then pass its exact preparedPurchase and the approved atomic ceiling to x402_fetch (or x402_pay, identical).`;

const ROUTE_WALLET = `"Check my balance" / "what's in my wallet" / "where do I deposit"
  -> x402_wallet.`;

const ROUTE_PORTFOLIO = `"Show my assets" / "what tokens do I own" / "what is my portfolio worth"
  -> dexter_portfolio. Keep portfolio value separate from spendable cash.`;

const ROUTE_SETTINGS = `"Set / lower / raise my spend limit" / "why was my payment blocked by policy"
  -> x402_settings.`;

const ROUTE_PASSKEY = `"Set up / bind my wallet"
  -> dexter_passkey.`;

const ROUTE_CARD = `Anything about a Dextercard (status, get a card, freeze it, link a wallet, sign in)
  -> the Dextercard section below. Always card_status first.`;

const ROUTE_CARD_TO_WALLET = `Anything about a Dextercard (get a card, see it, freeze it)
  -> the card lives in the wallet: call x402_wallet, or direct the user to https://dexter.cash/dextercard. There are no card tools on this surface.`;

function routingSection(caps: SurfaceCaps): string {
  const entries = [ROUTE_SEARCH, ROUTE_CALL_URL, ROUTE_COST, ROUTE_PAY, ROUTE_WALLET];
  if (caps.hasPortfolioTool) entries.push(ROUTE_PORTFOLIO);
  if (caps.hasSettings) entries.push(ROUTE_SETTINGS);
  if (caps.hasPasskeyTools) entries.push(ROUTE_PASSKEY);
  entries.push(cardsOn(caps) ? ROUTE_CARD : ROUTE_CARD_TO_WALLET);
  return [ROUTING_HEADER, ...entries].join('\n\n');
}

// ---------------------------------------------------------------------------
// The x402 tools. search/check/fetch/access are surface-independent; the
// wallet line, settings block, passkey block and skills line are conditional.
// ---------------------------------------------------------------------------

const TOOL_SEARCH = `x402_search — Semantic search over the marketplace. Pass the user's natural-language intent verbatim ("ETH price feed", "generate an image", "translate text"). Do NOT pre-filter by chain or category; the ranker expands and ranks internally. Returns two tiers: strongResults (high-confidence) and relatedResults (adjacent). Present strong results first, with price and quality score. Quality score bands: 90-100 excellent, 75-89 good, 50-74 mediocre, under 50 untested. Testnet and unverified resources are hidden by default; pass testnets:true or unverified:true only if the user explicitly wants them.

  Honesty signals on the response — READ THESE before paying:
    • Each result has serviceProfile. When non-null it carries input_semantics (per-field meaning, NOT just type) and good_response_looks_like. This is structured truth derived from the provider's OpenAPI. Trust it over the prose description if they conflict.
    • A null serviceProfile on a strong-banded result means the ranker judged it from marketing text alone. The result may still be correct, but the confidence is structurally lower than the band suggests.
    • The response includes confidence: { profileCoverage, topMatchProfileBacked, triangulatableAlternates }. Read it.
    • When triangulate is PRESENT on the response, the top match has no structured input semantics AND a profile-backed alternate exists. The query is at high risk of returning a confidently-wrong answer if it's ambiguous (e.g. a token name that could match multiple tokens, a partial symbol, a vague proper noun). Before paying the top match: call one of triangulate.alternateResourceIds first, confirm the answers agree, then proceed. If the query is unambiguous (an exact contract address, a unique ID), you can skip this and pay the top match directly.
    • When triangulate is ABSENT, the top match is either profile-backed or no usable alternate exists — proceed normally.`;

const TOOL_CHECK = `x402_check — Probes an endpoint without paying. Returns per-chain pricing, the input/output body schema when the endpoint publishes one, and an authMode: paid, siwx, apiKey, apiKey+paid, unprotected, or unknown. For a paid route it also returns purchaseOptions for direct_exact, native_tab, gateway_cash, and gateway_credit. A mode is executable only when availability.state is ready. Use the authMode to pick the next tool: paid -> choose one ready option, obtain approval for its atomic ceiling, and call x402_fetch with that option's unchanged preparedPurchase; siwx -> x402_access; unprotected -> a normal call, no payment needed.`;

const TOOL_FETCH = `x402_fetch (alias: x402_pay) — Calls an x402 endpoint with one selected prepared purchase and, when that mode is ready, executes only its bound adapter. Preserve the exact preparedPurchase returned by x402_check and pass the separately approved maxAmountAtomic ceiling. The modes direct_exact, native_tab, gateway_cash, and gateway_credit are distinct; never substitute one after selection. The result includes provider output and a mode-specific purchaseReceipt. For file uploads, pass the multipart argument (POST/PUT only, 200 MB total cap). If the response carries sponsored recommendations, surface them only when relevant; never auto-call them.`;

const TOOL_ACCESS = `x402_access — For identity-gated endpoints (authMode siwx) that want a wallet signature instead of a payment. If you call this on an endpoint that is actually paid, it tells you so; switch to x402_fetch.`;

const WALLET_MULTICHAIN = `x402_wallet — Reads the local file-backed or environment-configured Solana/EVM wallet and reports its receive addresses and verified balance state. Funding chains: Solana, Base, Polygon, Arbitrum, Optimism, Avalanche. The local payment adapter can additionally settle compatible calls on BSC and SKALE.`;

// New hosted-variant prose (the ONLY new sentences; no dollar amounts):
const WALLET_SOLANA_ONLY =
  'x402_wallet — Reads the Dexter Wallet bound to the authenticated MCP session and shows its Solana receive address and verified balance state. It accepts no caller-supplied wallet address or user handle. Funding: USDC on Solana only — the passkey vault settles on Solana. Never quote a deposit address on any other chain on this surface.';

const TOOL_PORTFOLIO =
  'dexter_portfolio — Reads the exact governed asset inventory bound to the authenticated MCP session. It accepts no caller-supplied handle, wallet, vault, actor, agent, grant, role, or authority. Use its canonical mint, quantity, valuation, and availableActions fields; keep portfolio value separate from spendable cash and never infer a capability from display metadata.';

const TOOL_SETTINGS = `x402_settings — Shows and sets the per-call USDC spend cap (maxAmountUsdc). The cap is live; changing it takes effect on the next call with no restart.`;

const PASSKEY_TOOLS = `dexter_passkey — Compatibility wallet-status view for this surface. Protected wallet and payment tools use the host's native OpenDexter Connect action. Connector authentication, MCP-session wallet binding, and passkey-wallet readiness are separate states; do not claim one proves another.

dexter_passkey_probe — One-button WebAuthn capability test for environments where passkey support is uncertain. Use only when the user reports the enroll ceremony failing.`;

const SKILLS_TOOLS = `x402_compose_skill / promote_skill — Compose a multi-step paid workflow into a reusable skill, and promote it to the catalog. Use only when the user asks to save or share a workflow.`;

function toolsSection(caps: SurfaceCaps): string {
  const entries = [
    TOOL_SEARCH,
    TOOL_CHECK,
    TOOL_FETCH,
    TOOL_ACCESS,
    caps.multichainFunding ? WALLET_MULTICHAIN : WALLET_SOLANA_ONLY,
  ];
  if (caps.hasPortfolioTool) entries.push(TOOL_PORTFOLIO);
  if (caps.hasSettings) entries.push(TOOL_SETTINGS);
  if (caps.hasPasskeyTools) entries.push(PASSKEY_TOOLS);
  if (caps.hasSkillTools) entries.push(SKILLS_TOOLS);
  return ['# The x402 tools', ...entries].join('\n\n');
}

// ---------------------------------------------------------------------------
// Failure recipes. Policy-block and walletless recipes vary by surface; the
// balance recipe, the 402 recipe and the explorer line are surface-independent.
// ---------------------------------------------------------------------------

const FAIL_POLICY_LOCAL = `"Payment policy blocked this call ... Current maxAmountUsdc is $N"
  The endpoint costs more than the per-call cap. Tell the user the real price and the current cap. Do not silently raise the cap. Offer: raise it with x402_settings, or pass a one-call maxAmountUsdc override on x402_fetch. Let the user choose.`;

const HOSTED_POLICY_RECIPE =
  `A payment refused for exceeding a spend limit
  Spend caps on this surface are enforced server-side by the wallet mandate (a per-call cap and a daily cap). Report the limit named in the error to the user. Caps cannot be raised in this conversation; the user manages their wallet at https://dexter.cash/wallet.`;

const FAIL_BALANCE = `"Insufficient balance for this call"
  The cap is fine; the wallet is short of USDC on that chain. Call x402_wallet, give the user the deposit address for the chain named in the error, and the amount needed.`;

const FAIL_WALLETLESS_LOCAL = `"Wallet does not expose private keys for auto-pay" / search works but x402_fetch will not pay
  The server is in search-only mode (no signing wallet). Tell the user to set DEXTER_PRIVATE_KEY (Solana) or EVM_PRIVATE_KEY (Base/Polygon/etc.), or run \`npx @dexterai/opendexter wallet\` to create one.`;

const HOSTED_WALLETLESS_RECIPE =
  `A protected tool reports authentication_required
  Let the host show its native OpenDexter Connect action. After authorization succeeds, retry the same approved tool call once. OAuth account authorization does not by itself prove that a ready passkey wallet is bound. If the authenticated result reports wallet-not-ready, use x402_wallet to read that state and follow its activation guidance. Never invent or surface a personalized connector URL.`;

const FAIL_402 = `402 with no usable requirements, or an endpoint returns 402 to x402_access
  The endpoint is misconfigured or you used the wrong tool. Re-run x402_check and follow its authMode.`;

const EXPLORER = `After a successful paid call, link the settlement transaction hash to the right explorer: Solscan (Solana), Basescan (Base), Polygonscan, Arbiscan, Optimistic Etherscan, Snowtrace (Avalanche).`;

function failuresSection(caps: SurfaceCaps): string {
  const entries = [
    caps.hasSettings ? FAIL_POLICY_LOCAL : HOSTED_POLICY_RECIPE,
    FAIL_BALANCE,
    caps.surface === 'local' ? FAIL_WALLETLESS_LOCAL : HOSTED_WALLETLESS_RECIPE,
    FAIL_402,
    EXPLORER,
  ];
  return ['# x402 failure recipes — read the error, then act', ...entries].join('\n\n');
}

const PURCHASE_EXECUTION_RULES = `# Prepared purchases, receipts, and retries

For a new paid flow, choose only a purchaseOption whose availability.state is ready, then preserve that selected option from x402_check. Pass its preparedPurchase unchanged and pass the user's separately approved atomic ceiling. The prepared identity binds the URL, method, body digest, seller offer, route, mode, network, asset, and amount. Do not reconstruct any of those fields from display text.

direct_exact pays only the selected seller Exact offer. native_tab issues only the selected seller Tab voucher. gateway_cash and gateway_credit use only their named Gateway adapter when it is genuinely available. An integration_required, request_required, unavailable, or approval_required option is not permission to choose a different mode.

Read purchaseReceipt by mode. Direct Exact reports seller settlement. Native Tab reports voucher state separately from seller cash settlement. Gateway cash reports buyer cash separately from seller settlement. Gateway credit also reports exposure and the buyer obligation. Keep provider output separate from payment finality.

Once a consequential request was dispatched, or dispatch is uncertain, reconcile the same prepared identity. Never retry automatically and never create a new mode or prepared identity to route around an uncertain attempt.`;

// ---------------------------------------------------------------------------
// Dextercard tools + provisioning. The provisioning fallback line varies by
// surface (local has card_login_start; hosted points at a dexter.cash URL).
// ---------------------------------------------------------------------------

const CARD_TOOLS = `# Dextercard tools

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

card_link_wallet — Links a crypto wallet to the card. Call card_status first to confirm the card is active.`;

const CARD_PROVISION_HEAD = `# Provisioning a new Dextercard from scratch (stage no_session)

1. card_login_request_otp with the user's email. This solves the carrier captcha server-side; the user opens zero browser tabs. It emails them a 6-digit code.
2. Ask the user for the code from their inbox (tell them to check spam).
3. card_login_complete with {email, code}. This persists the session.
4. card_status — now it returns the real stage. Proceed through card_issue per the stage machine above.`;

const CARD_FALLBACK_LOCAL = `Fallback: if card_login_request_otp returns captcha_solver_not_configured or captcha_solve_failed, call card_login_start instead. It hands the user a MoonPay URL to open and solve the captcha themselves; then continue at step 2.`;

const CARD_URL_FALLBACK =
  'Fallback: if card_login_request_otp returns captcha_solver_not_configured or captcha_solve_failed, direct the user to provision at https://dexter.cash/dextercard, then continue at step 2.';

const CARD_VERIFY_FAILED = `If card_login_complete returns verification_failed, the code likely expired (over 10 minutes), was mistyped, or was already used. Have the user request a fresh code and retry.`;

function cardSection(caps: SurfaceCaps): string {
  return [
    CARD_TOOLS,
    CARD_PROVISION_HEAD,
    caps.hasCardLoginStart ? CARD_FALLBACK_LOCAL : CARD_URL_FALLBACK,
    CARD_VERIFY_FAILED,
  ].join('\n\n');
}

// ---------------------------------------------------------------------------
// Safety model. When the surface has no x402_settings tool, the first bullet
// keeps the spend-cap promise but drops the tool name it can't honor.
// ---------------------------------------------------------------------------

const SAFETY_SETTINGS_BULLET =
  '- Every paid call is bounded by the per-call USDC cap (maxAmountUsdc). A call above the cap is rejected, not silently paid. Treat a policy block as a decision point for the user, never something to route around on your own.';

const SAFETY_NEUTRAL_BULLET =
  '- Every paid call is bounded by server-enforced spend caps. A call above the cap is rejected, not silently paid. Treat a policy block as a decision point for the user, never something to route around on your own.';

const SAFETY_KEYS_BULLET = `- Private keys never cross the tool boundary. You sign through the wallet; you never see or handle the key. Never ask the user to paste a private key into the conversation.`;

const SAFETY_CARD_BULLET = `- For Dextercard identity and address fields, and for the OTP email, ask the user. Do not guess personal data.`;

function safetySection(caps: SurfaceCaps): string {
  const firstBullet = caps.hasSettings ? SAFETY_SETTINGS_BULLET : SAFETY_NEUTRAL_BULLET;
  const bullets = [firstBullet, SAFETY_KEYS_BULLET];
  if (cardsOn(caps)) bullets.push(SAFETY_CARD_BULLET);
  return `# Safety model\n\n${bullets.join('\n')}`;
}

const DOCS_POINTER = `# Deeper reference

Read docs://opendexter/workflow, docs://opendexter/protocol, or docs://opendexter/debugging for more detail.`;

// ---------------------------------------------------------------------------
// The builder — assembles the surface-appropriate instruction string.
// ---------------------------------------------------------------------------

export function buildServerInstructions(caps: SurfaceCaps): string {
  const sections: string[] = [];
  sections.push(preamble(caps));
  sections.push(routingSection(caps));
  sections.push(toolsSection(caps));
  sections.push(PURCHASE_EXECUTION_RULES);
  sections.push(failuresSection(caps));
  if (cardsOn(caps)) sections.push(cardSection(caps));
  sections.push(safetySection(caps));
  if (caps.hasDocsResources) sections.push(DOCS_POINTER);
  return sections.join('\n\n');
}

// Both first-party surfaces ship cards-off (owner ruling Jul 23, card-removal
// runbook): the card is a wallet-widget concern now. hasCardLoginStart goes
// false with it — the flag is meaningless without the card tool family.
export const LOCAL_CAPS: SurfaceCaps = { surface: 'local', hasSettings: true, hasCardLoginStart: false, hasPasskeyTools: false, hasSkillTools: false, hasDocsResources: true, multichainFunding: true, hasPortfolioTool: false, hasCardTools: false };
export const HOSTED_CAPS: SurfaceCaps = { surface: 'hosted', hasSettings: false, hasCardLoginStart: false, hasPasskeyTools: true, hasSkillTools: true, hasDocsResources: true, multichainFunding: false, hasPortfolioTool: true, hasCardTools: false };

/** @deprecated Use buildServerInstructions(caps) — this is the local-default rendering. */
export const SERVER_INSTRUCTIONS = buildServerInstructions(LOCAL_CAPS);

/**
 * Version stamp for debugging drift — sourced directly from this package's
 * package.json so it can never fall out of sync with the published version.
 * Consumers can log this to confirm which version is live.
 */
export const SERVER_INSTRUCTIONS_VERSION: string = pkg.version;

// ---------------------------------------------------------------------------
// Parity guard — any tool named in served instructions MUST be registered on
// the surface serving them. A mismatch is a boot failure, not a runtime lie.
// ---------------------------------------------------------------------------

const TOOL_NAME_RE = /\b(?:x402_[a-z_]+|card_[a-z_]+|dexter_passkey(?:_probe)?|dexter_portfolio|promote_skill)\b/g;

export function assertInstructionRosterParity(instructions: string, registeredTools: string[]): void {
  const mentioned = new Set(instructions.match(TOOL_NAME_RE) ?? []);
  const missing = [...mentioned].filter((t) => !registeredTools.includes(t));
  if (missing.length > 0) {
    throw new Error(
      `Served instructions mention tools missing from the registered roster: ${missing.join(', ')}. ` +
      `Fix the SurfaceCaps for this server (or register the tools) — refusing to serve lying instructions.`,
    );
  }
}
