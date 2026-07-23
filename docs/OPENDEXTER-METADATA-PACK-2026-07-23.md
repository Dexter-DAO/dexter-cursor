# OpenDexter Production Metadata Pack — v2 (10-tool roster, card tools removed)

**Drafted:** 2026-07-23 v2 (verification seat; supersedes v1 `req-drafts/metadata-pack.md`)
**Ruling applied:** Jul 23 owner decision — all six card tools (card_status, card_issue, card_link_wallet, card_freeze, card_login_request_otp, card_login_complete) come off the MCP product entirely: package, skills, metadata, server roster. The card becomes a wallet-widget design concern later (board #71). Chat answers about cards point to the wallet + https://dexter.cash/dextercard. Directory submission is the FULL remaining roster (payments included) — a deliberate stance probe against OpenAI's written policy; no scoped variant.
**Sources:** everything v1 cited, PLUS a fresh live-wire probe this verification session (2026-07-23): `initialize` + `tools/list` + `resources/list` against https://open.dexter.cash/mcp; fresh curls of all dexter.cash URLs; `dexter-fe/brand.md` re-read; `@dexterai/mcp-instructions` dist read; open-mcp-server.mjs re-read.

**Certainty labels:** `[VERIFIED]` = checked against live wire, live URL, or source read this session. `[UNVERIFIED]` = only visible inside OpenAI's dashboard. `[RECOMMENDATION]` = judgment call, owner/controller may override.

---

## v2 CORRECTION LOG (every change from v1, labeled)

| # | Type | Correction |
|---|---|---|
| C1 | **WRONG in v1** | v1 §2.1 claimed the server's initialize instructions "never mention dexter_passkey, x402_compose_skill, or promote_skill" and labeled it `[VERIFIED — instructions text on wire]`. FALSE on today's wire: the live instructions mention `dexter_passkey` 4×, `dexter_passkey_probe` 1×, `x402_compose_skill` 1×, `promote_skill` 1× `[VERIFIED — live initialize this session]`. Instructions come from `@dexterai/mcp-instructions` with `HOSTED_CAPS = {hasPasskeyTools:true, hasSkillTools:true}` `[VERIFIED — dist read]`. Replaced with the accurate, card-relevant parity note (§2.1). |
| C2 | **WRONG in v1** | v1 §1.11 said legacy `#F26B1A` "still appears once in dexter-fe CSS." It appears **443 times** across dexter-fe CSS files (5 in globals.css alone) `[VERIFIED — grep this session]`. The conclusion is unchanged (brand.md supersedes; use `#E67C3E`), but the count was false. |
| C3 | **OVERSTATED in v1** | v1 listed `skills` among the observed manifest fields. The requisition's cache inspection records "There is no `skills` field" — its **absence** was observed, not the field. Field list corrected. |
| C4 | **STALE fact-map** | The fact-map (wireProbe) says the card tools carry NO `_meta` on the tools/list descriptor. Today's live wire shows all four widget-backed card tools DO carry `_meta` (with a reduced, resource-domains-only widgetCSP) `[VERIFIED — tools/list this session]`. The server drifted after the fact-map capture. Moot once the cards are removed, but the controller's diff baseline (§2.5) is corrected. |
| C5 | **OBSOLETE by ruling** | All card content removed everywhere: app descriptions, default prompts, namespace description, change table, annotation matrix, per-tool copy (v1 §2.4 items 9–14), screenshot recommendations, and the test-credential ask. v1's card metadata copy is dead — do not resurrect it from v1. |
| C6 | **CONSTRAINT applied** | Default prompts cut from five to three, each ≤128 chars (36 / 49 / 75 chars — measured). |
| C7 | **COUNTS restated** | Widget/tool counts for the 10-tool roster: today the server serves 9 `ui://` templates; after card pruning it is **6** (marketplace-search, fetch-result, pricing, wallet, passkey-probe, passkey-onboard — there is no card-freeze widget to begin with `[VERIFIED — resources/list]`). 8 of the 10 remaining tools announce widgets; x402_compose_skill and promote_skill have no widget metadata `[VERIFIED]`. |
| C8 | **RE-VERIFIED, kept** | URL table (all 9 statuses re-curled, identical); privacy page (Dexter Labs Corporation, last updated Feb 4 2026, "Using Dexter through ChatGPT" section present, "trading assistant" framing mismatch confirmed — 3 occurrences on each legal page); terms page (SMS-consent + crypto language confirmed); brand `#E67C3E` and dark `#15100C` from brand.md; §2.5 wire titles/annotations (matched the live wire exactly, tool by tool); x402_compose_skill `readOnlyHint:true` mislabel (on wire AND in source line 1721); compose publish path (Dexter-DAO/composed-skills GitHub monorepo, x402gle.com/skills, claimed-handle requirement, default "unlisted"); promote_skill archived semantics; CSP drift (Sentry ingest + `*.oaistatic.com` on resources only; `open.dexter.cash` on tool-level connect only — confirmed live); serverInfo `{OpenDexter 1.0.0}`; app id + "Testing" placeholders + `defaultPrompt: null` per requisition; dexter_passkey's five states in source (not_enrolled / provisioning / ready / user_not_paired / error); x402_wallet's `vault_required` payload shape; 16 tools on today's wire with no `card_login_start` (hosted). |

---
---

# HALF 1 — DASHBOARD PASTE PACK

Everything in this half is pasted by hand into OpenAI's UI (the app registration `asdk_app_6a615ae3385c8191b05cc4c420514022` / `dev-6a615ae3385c8191b05cc4c420514022`, plus the submission portal when going public). No repo carries these fields `[VERIFIED — fact-map: "Testing" metadata exists in no repo]`.

The observed manifest fields are: `description`, `shortDescription`, `longDescription`, `defaultPrompt`, `capabilities` — all placeholders or empty today; there is no `skills` field and no `skills/` directory `[VERIFIED — requisition's cache inspection; corrected per C3]`. Which UI surface renders which description field is `[UNVERIFIED]`; copy is supplied for all three so every field is final-quality regardless of where it shows.

**Stance note (owner ruling):** the directory submission describes the FULL product, payments included. Do not soften "pays in USDC from the user's wallet" into review-friendly euphemism anywhere in this half. The read-vs-spend boundary is stated plainly instead — that is the honest version of full-strength.

## 1.1 App name

```
OpenDexter
```

Use exactly this string everywhere: app registration, connector metadata, plugin display name, docs, assets. OpenAI's guidelines warn against overly generic single-word names; "OpenDexter" is distinctive and already the serverInfo name on the live wire (`serverInfo: {name: "OpenDexter", version: "1.0.0"}` `[VERIFIED — re-probed this session]`). The Claude plugin currently displays "OpenDexter — x402 Payments"; the suffix is acceptable as a plugin subtitle but the app name field must be the bare word.

## 1.2 `description` (one-sentence field) — [C5: card clause removed]

```
OpenDexter connects your chat to a non-custodial Dexter wallet: search the x402 catalog of paid APIs, check real prices, pay per call in USDC on Solana, and publish composed skills.
```

## 1.3 `shortDescription` — [C5: card clause removed]

```
Discover and pay for x402 APIs in USDC on Solana, from a passkey-secured wallet you control — plus the composed-skill marketplace.
```

(130 chars. Alternate, if the field wants something punchier: `A wallet your agent can use: x402 API discovery and USDC payments, secured by your passkey.`)

## 1.4 `longDescription` — [C5: DEXTERCARD section removed; free/paid paragraph rewritten without card actions]

```
OpenDexter gives your chat a real wallet — one you control.

YOUR WALLET, YOUR KEYS. OpenDexter connects to a non-custodial Dexter wallet secured by a passkey (Face ID, Touch ID, or your device PIN). Dexter never holds your keys and cannot move your funds. Setup takes about a minute: the app opens dexter.cash in a new tab, you approve with your device's passkey, and the wallet links back to your conversation.

PAY FOR APIS AS YOU USE THEM. x402 is an open standard for paying for API calls with small USDC payments instead of subscriptions and API keys. OpenDexter searches a live catalog of thousands of x402 services — data feeds, image generation, translation, research, and more — shows you the exact price before anything is paid, and settles in USDC on Solana from your wallet when you approve a call.

COMPOSED SKILLS. Turn any x402 service you like into a reusable skill, and — if you choose — publish it to the public marketplace at x402gle.com/skills.

WHAT'S FREE AND WHAT COSTS MONEY. Searching the catalog, checking an endpoint's price, and viewing your wallet balance are read-only and never cost anything. Money moves only when you approve a specific paid API call, with the exact price shown first. Publishing a skill is always an explicit action you ask for — OpenDexter never spends and never publishes on its own.
```

(If the field is plain-text-only, the ALL-CAPS section leads read as headers; if it renders markdown, swap them for `**bold**`.)

## 1.5 Default prompts — [C5 + C6: card prompt removed; max 3, each ≤128 chars]

The observed manifest has a singular `defaultPrompt: null` `[VERIFIED — requisition]`. If the UI takes one prompt, use #1. If it takes a list, use all three in this order.

1. `Set up my OpenDexter passkey wallet.` (36 chars)
2. `What's my Dexter wallet address and USDC balance?` (49 chars)
3. `Find an x402 API that can generate images, and show me what each one costs.` (75 chars)

Rationale carried from v1: #1 is the new-user funnel (a starter prompt should onboard, not "check" a wallet that doesn't exist yet); #2 merges address + balance into one natural question; #3 is concrete (no dangling "this job" antecedent) and shows off check-before-pay. v1's prompts #4 (paste-URL price check) and #5 (card status) are dropped: #5 by the card ruling, #4 by the 3-prompt cap — it survives as a routing-eval case, not a starter prompt.

## 1.6 Category

`[UNVERIFIED]` — The allowed category values are shown only in OpenAI's dashboard picker; the docs pages fetched do not enumerate them, and we do not invent enums. `[RECOMMENDATION]`: pick the closest match to **Finance** first; if no finance-like category exists, **Developer tools** / **Productivity**. Report back what the picker actually offered so the pack can be updated.

## 1.7 Capabilities — [C7: counts restated for the 10-tool roster]

`[UNVERIFIED]` — The observed manifest has `capabilities: {}` and the allowed keys/values could not be verified from any doc fetched. Do not paste anything invented. When the owner opens the capabilities section of the dashboard: enable only capabilities the app really uses. Based on verified app behavior, the things to look for (whatever OpenAI names them) are:
- widget / custom UX rendering — after card pruning the app serves 6 `ui://` widget templates and 8 of the 10 tools announce them (all but x402_compose_skill and promote_skill) `[VERIFIED — live resources/list + tools/list this session; today's pre-pruning wire is 9 templates]`
- opening external links — the passkey widget opens dexter.cash in a new tab via `ui/open-link` `[VERIFIED]`
- authentication / account linking — the app has an OAuth-protected-resource flow (401 + PRM at open.dexter.cash) `[VERIFIED]`

Record the exact enum names the dashboard shows; those become the source of truth.

## 1.8 URLs — what is live and what is not

Re-checked live 2026-07-23 this verification session with curl `[VERIFIED — identical to v1's table]`:

| URL | Status | Verdict |
|---|---|---|
| `https://dexter.cash/opendexter` | 200 | **Use as website URL** (product page; 404s on bogus paths prove routing is real, not an SPA catch-all) |
| `https://dexter.cash` | 200 | Fallback website URL |
| `https://dexter.cash/privacy` | 200 | **Use as privacy policy URL** |
| `https://dexter.cash/terms` | 200 | **Use as terms URL** |
| `https://dexter.cash/dextercard` | 200 | Live — the destination for card questions in chat (per ruling). NOT part of app metadata. |
| `https://dexter.cash/privacy-policy` | 404 | Do not paste |
| `https://dexter.cash/legal` | 404 | Do not paste |
| `https://dexter.cash/tos` | 404 | Do not paste |
| `https://dexter.cash/terms-of-service` | 404 | Do not paste |

Content notes on the live legal pages `[VERIFIED — text re-extracted this session]`:
- `/privacy` is a real Dexter Labs Corporation privacy policy, last updated 2026-02-04, and **already contains an explicit "Using Dexter through ChatGPT" section** covering prompt processing by OpenAI + Dexter. A genuine asset for submission review.
- `/terms` is real, same date, includes SMS-consent and crypto-risk language.
- **Framing mismatch to flag (re-confirmed):** both documents describe Dexter as an "AI trading assistant" (3 occurrences on each page). The app being submitted is a wallet + x402 payments product. A reviewer reading the policy against the app description will notice. Not a blocker (the policies are live, legitimate, and cover the data flows), but a copy refresh before public submission is worth an owner decision.

## 1.9 Company / publisher identity

```
Dexter Labs Corporation
```
`[VERIFIED — the legal entity named in the live privacy policy]`. Submission requires developer/org identity verification through the OpenAI Platform Dashboard `[VERIFIED — docs fetched in v1 session]` — owner action, cannot be done from a repo.

## 1.10 Support contact

`[RECOMMENDATION]` `dev@dexter.cash` (already the published author contact in the Claude plugin manifest). Submission guidelines require customer support contact details. Owner decides: dev@ vs branch@dexter.cash.

## 1.11 Brand color — [C2: occurrence count corrected]

```
#E67C3E
```
`[VERIFIED source]` — "Dexter Ember" primary from `dexter-fe/brand.md` (`oklch(0.72 0.18 42)` → `#E67C3E`, canonical brand doc, last updated 2026-04-18 via the brand-design skill). The legacy accent `#F26B1A` still appears extensively in dexter-fe CSS (443 matches across module CSS + globals.css `[VERIFIED — grep this session]`), but brand.md explicitly supersedes it ("sharpened from the legacy `#F26B1A`") and its own rule is to use the shadcn tokens for anything new. Use `#E67C3E`. Brand dark background: `#15100C` (bg-base dark, brand.md) `[VERIFIED]`.

## 1.12 Assets needed — [C5: card screenshot recommendation replaced]

| Asset | Requirement | Status |
|---|---|---|
| App icon / logo | Square PNG. Exact dimensions `[UNVERIFIED]` — read the dashboard upload dialog. `[RECOMMENDATION]`: prepare 512×512 and 1024×1024 PNG plus the SVG master, on transparent and on `#15100C` (brand dark). | **MISSING — must be produced.** The only existing candidate, `opendexter-ide/assets/logo.svg`, is a placeholder (green "x402 payments" monospace text on black) `[VERIFIED in v1 session]` and must not ship. Source the APPROVED Dexter wallet mark (Jul 7 ruling: wallet mark approved; never image-gen a flat brand substitute). |
| Composer icon | Small glyph shown in the composer/app picker. Dimensions `[UNVERIFIED]`. `[RECOMMENDATION]`: prepare 64×64 and 128×128, one monochrome variant and one brand-color variant. | MISSING — derive from the same wallet mark. |
| Screenshots (optional) | Only for apps with UI; must accurately represent functionality; dimensions `[UNVERIFIED]`. | `[RECOMMENDATION]`: capture the three strongest remaining widgets live — x402 search results, wallet (balance + deposit QR), and the pricing/check widget or passkey onboarding. No card screenshots — the widgets are being removed with the tools. |

## 1.13 Submission-only items (public directory, not needed for dev mode) — [C5: test-card ask removed]

From OpenAI's submission docs fetched in the v1 session `[VERIFIED as requirements; exact form fields unverified]`:
- Identity/org verification (Dexter Labs Corporation) — owner.
- A working public MCP endpoint for review — exists: `https://open.dexter.cash/mcp` `[VERIFIED live, re-probed this session]`.
- **Test credentials: login + password for a fully-featured demo account** — owner must provision one (a Dexter account with a funded test wallet). Nothing like this exists today in any repo.
- Test prompts and responses (reviewers verify functionality) — reuse the three default prompts plus the routing-eval cases from the requisition's Phase 6 table (minus its card rows, which are void under the ruling).
- Localization information — fields `[UNVERIFIED]`; English-only initially.
- CSP configuration consistent between what's declared and what widgets load — the live CSP drift is re-confirmed this session `[VERIFIED]`: resource-level connect domains include the Sentry ingest host but omit `open.dexter.cash`; tool-level widgetCSP connect domains include `open.dexter.cash` but omit Sentry; `*.oaistatic.com` appears only in resource-level resourceDomains. A Phase 5 fix that should land before submission, since reviewers check CSP.
- **Stance-probe expectation:** the roster includes real payment tools (x402_fetch / x402_pay) described plainly. If OpenAI's review rejects on payments policy, that outcome is the data the owner wants — do not pre-emptively descope.

---
---

# HALF 2 — SERVER-SIDE METADATA (implemented in code by the controller seat)

Scope — **[C5: reduced from 16 to 10]**: the 10 tools that remain after the card ruling: `x402_search`, `x402_check`, `x402_fetch`, `x402_pay`, `x402_access`, `x402_wallet`, `x402_compose_skill`, `promote_skill`, `dexter_passkey`, `dexter_passkey_probe`. The six card tools are being REMOVED from the hosted roster, the shared package, the skills, and all metadata (owner ruling Jul 23); their v1 metadata copy is void. Current state below was read from source and re-verified against a fresh live-wire probe this session `[VERIFIED]`.

## 2.0 Ground rules for the controller

1. **Set all four annotation hints explicitly on every tool.** MCP spec defaults (2025-06-18 schema era): `readOnlyHint` defaults **false**, `destructiveHint` defaults **true**, `idempotentHint` defaults **false**, `openWorldHint` defaults **true**; `destructiveHint`/`idempotentHint` are only meaningful when `readOnlyHint` is false. `[Stated from spec knowledge — controller should re-confirm against the pinned SDK's types before shipping.]` Explicit values on every tool also permanently kill the "readOnly+destructive both true" ghost the Codex agent reported (not reproduced on today's wire — re-confirmed by this session's tools/list probe `[VERIFIED]`).
2. **[REPLACES v1's card-migration rule — C5]** Card removal mechanics: on the hosted server, stop calling `composeCardTools` and delete the two positional `server.tool()` blocks for `card_login_request_otp` / `card_login_complete`, and stop registering the three card `ui://` resources (card-status, card-issue, card-link-wallet). **Instructions parity is a hard gate:** the served instructions come from `@dexterai/mcp-instructions` and the live text mentions `card_status` 7× `[VERIFIED — live initialize this session]`; `assertInstructionRosterParity` **throws at startup** if instructions mention tools missing from the registered roster `[VERIFIED — dist read]`. So the card removal MUST ship together with an instructions change (HOSTED_CAPS/surface caps dropping the card section) or the server refuses to serve. Per the ruling the card tools also come out of `@dexterai/x402-mcp-tools` itself — a shared-package change, so every consumer must be migrated (standing drift rule); the npm/local `dexter-x402` surface still registers all card tools plus `card_login_start` today.
3. Where a description below is marked **KEEP**, do not churn it — the requisition says preserve what works.
4. **Card questions in chat:** with no card tools on the roster, any Dextercard question routes to the wallet surface and https://dexter.cash/dextercard. The namespace description and tool copy below deliberately contain zero card references.

## 2.1 Namespace description (replaces "Testing") — [C1 + C5: rewritten; card clause removed; full-strength payments language per ruling]

This is what Codex/ChatGPT show as the description of the `opendexter.*` tool namespace. Today it lives ONLY in OpenAI's dashboard (paste it there — cross-ref Half 1 §1.2); if/when a manifest field carries it in the plugin package, use the same string.

```
OpenDexter: a non-custodial, passkey-secured Dexter wallet (USDC on Solana) your agent can use, plus the x402 paid-API marketplace. Use these tools when the user wants to: set up or check a Dexter wallet or passkey; see their wallet address or USDC balance; find an x402 API for a job; check what a paid endpoint costs; pay for an API call in USDC from their own wallet; sign in to a wallet-gated endpoint; or turn an x402 service into a reusable skill and publish it to the marketplace. Searching, price checks, and wallet views are read-only and free; payments and skill publishing move money or make public writes, and happen only on explicit user approval.
```

**[C1 — CORRECTED observation for the controller]:** v1 claimed the server's initialize instructions never mention `dexter_passkey`, `x402_compose_skill`, or `promote_skill`. That is FALSE on today's wire — the live instructions already cover all three (dexter_passkey 4 mentions, compose/promote one each) via `HOSTED_CAPS {hasPasskeyTools:true, hasSkillTools:true}` `[VERIFIED — live initialize + @dexterai/mcp-instructions dist, this session]`. No instructions gap exists for those tools. The real instructions work item is the card-section removal (see rule 2.0-2): the current text routes card intents to card tools 7+ times and will violate roster parity the moment the cards come off.

## 2.2 At-a-glance: what changes per tool — [C5: 10 rows, card rows deleted]

| # | Tool | Title | Description | Annotations |
|---|---|---|---|---|
| 1 | x402_search | CHANGE ("x402 Search" → user-facing) | REWRITE (add "Use this when", next-tool) | EXTEND (RO:true kept; add explicit others) |
| 2 | x402_pay | CHANGE | TIGHTEN (alias framing kept) | EXTEND (destructive:true kept) |
| 3 | x402_fetch | CHANGE | REWRITE (spend framing, settlement rule) | EXTEND (destructive:true kept) |
| 4 | x402_check | CHANGE | REWRITE | EXTEND (RO:true kept) |
| 5 | x402_access | CHANGE | REWRITE | **ADD — currently none at all** |
| 6 | x402_wallet | CHANGE | REWRITE | EXTEND (RO:true kept) |
| 7 | x402_compose_skill | CHANGE | REWRITE (drop "Claude Code" phrasing) | **FIX — readOnlyHint:true is wrong (publish:true writes)** |
| 8 | promote_skill | CHANGE | REWRITE | EXTEND (RO:false kept; add destructive:true) |
| 9 | dexter_passkey_probe | CHANGE (demotion) | **DEMOTE (internal-diagnostic first sentence)** | EXTEND (RO:true kept) |
| 10 | dexter_passkey | CHANGE | REWRITE (auth states, no-loop rule) | EXTEND (RO:true kept, with caveat below) |

The single actively-misleading annotation on today's wire is **x402_compose_skill `readOnlyHint: true`** — with `publish: true` it commits to the Dexter-DAO/composed-skills GitHub monorepo and publishes to x402gle `[VERIFIED — source + live wire re-checked this session]`. Everything else is under-annotation (absent hints falling back to spec defaults), not mislabeling.

## 2.3 Full annotation matrix (proposed; one-line justification each) — [C5: card rows deleted; surviving rows re-verified against source]

RO = readOnlyHint, D = destructiveHint, I = idempotentHint, OW = openWorldHint. All values to be set explicitly.

| Tool | RO | D | I | OW | Justification |
|---|---|---|---|---|---|
| x402_search | true | false | true | false | Queries Dexter's own catalog index only; mutates nothing; same query → same class of results; no arbitrary external systems touched. |
| x402_check | true | false | true | **true** | Pays nothing and mutates no user state, but it does send a live probe request to an arbitrary caller-supplied URL — that is open-world. |
| x402_fetch | **false** | **true** | **false** | **true** | SPENDS: irreversibly settles USDC on Solana from the user's wallet against any x402 URL; every repeat call pays again. |
| x402_pay | **false** | **true** | **false** | **true** | Byte-identical alias of x402_fetch; annotation parity is mandatory so neither route reads softer than the other. |
| x402_access | **false** | false | false | **true** | No funds move and nothing is destroyed, but it signs a wallet-ownership proof and can create seller-side sessions at arbitrary URLs — not a pure read. |
| x402_wallet | true | false | true | false | Reads Dexter backend/chain state for the bound wallet; the unbound path returns a setup payload without creating anything. |
| x402_compose_skill | **false** | false | false | false | publish:true is a permanent external write (GitHub commit + marketplace listing) — must not read as harmless; additive though, nothing destroyed. **This is the FIX row.** |
| promote_skill | false | **true** | true | false | Changes public availability of a published artifact; "archived" pulls a live skill from discovery AND direct install — availability-destroying; setting the same visibility twice is a no-op. |
| dexter_passkey_probe | true | false | true | false | Capability check only: fires a WebAuthn ceremony in the widget sandbox and discards the credential; enrolls nothing, reads no user state. |
| dexter_passkey | true | false | true | false | Reads vault status; never runs enrollment or mutates vault state from the MCP side. **Caveat:** on an unbound not-enrolled session it mints a short-lived pairing link (ephemeral server-side auth artifact that grants nothing by itself). If the controller reads the spec more strictly, the fallback is RO:false + D:false + I:true — but RO:true matches the tool's user-meaningful behavior and today's wire, and the tool is separately guarded by the HTTP-401 spend gate. `[RECOMMENDATION: keep RO:true]` |

Note on the Codex agent's reported defect ("passkey tools advertise readOnlyHint:true AND destructiveHint:true"): NOT REPRODUCED — re-confirmed against this session's live tools/list (`dexter_passkey` and `dexter_passkey_probe` each carry exactly `{readOnlyHint: true}`) `[VERIFIED]`. Stamping `destructiveHint:false` explicitly on both (per rule 2.0-1) resolves it permanently regardless of which stale layer produced it.

## 2.4 Per-tool copy (titles + descriptions, final) — [C5: card items 9–14 of v1 deleted; remainder renumbered]

Format per tool: proposed title → proposed description (final copy, paste-ready) → what changed and why. Descriptions are grounded in verified behavior only.

### 1. x402_search — title: `Search paid x402 APIs`

```
Use this when the user wants to find a paid API for a job — "find an API that generates images", "is there an x402 feed for ETH prices". Read-only semantic search over the live x402 catalog; it never pays and never answers from memory. Pass the user's words verbatim as the query and do not pre-filter by category — the ranker expands internally. Pass network:"solana" whenever the paying wallet is a Dexter passkey vault (vaults pay on Solana only). Returns strongResults (high-confidence) and relatedResults (adjacent), each with price, chains[], and a 0–100 quality score (90+ excellent, under 50 untested); searchMeta.mode distinguishes a direct hit from related_only or empty. Next step: x402_check the chosen result before any payment.
```

Changed: title de-jargoned; description rewritten into "Use this when" form; adds the spend boundary ("never pays"), the Solana constraint, quality-score bands, and the next-tool pointer. All facts carried over from the current description + server instructions `[re-verified against source this session]`.

### 2. x402_pay — title: `Pay for an API call (alias of x402_fetch)`

```
Identical to x402_fetch — same schema, same wallet, same spending behavior. Kept so "pay for this API" phrasing routes correctly; prefer x402_fetch. Everything in x402_fetch's description applies: this tool SPENDS USDC on Solana from the user's own non-custodial Dexter wallet, check the price with x402_check first, send only the raw payload the seller expects, and never report payment success unless the result confirms settlement.
```

Changed: keeps the alias framing (current description already does this well) but pulls the safety rules forward so the alias can never read softer than the primary.

### 3. x402_fetch — title: `Call a paid API (pays from user's wallet)`

```
Use this when the user has approved calling a specific x402 endpoint at a known price — this tool SPENDS: it pays automatically in USDC on Solana from the user's own non-custodial Dexter passkey wallet. Run x402_check first and surface price, currency, network, and seller unless current pricing is already established in this conversation. Send the RAW body the seller expects — never a schema descriptor; unwrap it and send only the inner fields with real values. Multipart file uploads are supported. If no wallet is bound, nothing is paid: the call returns a short one-time setup link to relay to the user (or the platform shows its own connect prompt); after setup, retry the same call. The result carries the API response plus a payment receipt, transaction link, and settlement status — only report success when settlement is confirmed. Responses may include a running-tab offer (set tab:false to suppress); treat any tab or spend-cap arrangement as a commitment requiring explicit user approval.
```

Changed: rewritten into "Use this when" form; adds the check-first prerequisite, the settlement-confirmation rule, and the tab-consent rule (all requisition Phase 2/3 requirements). The raw-body rule stays in the `body` param description too — keep both.

### 4. x402_check — title: `Check an API's price (no payment)`

```
Use this when the user asks what an endpoint costs, and before any x402_fetch or x402_pay call — this tool never pays and needs no wallet. Probes the URL for x402 payment requirements and returns pricing per chain (Solana, Base, others if supported), the payTo address per chain, and input/output schemas. When the endpoint is in the Dexter catalog it also returns enrichment: quality score, AI verifier verdict and notes, recent verification history, display name, and hit count — enough to answer "should I pay $0.05 to call this?" rather than reciting a bare price. For input-dependent pricing, pass sampleInputBody to price the exact request instead of the endpoint's advisory default. Key result fields: pricing options, inputSchema, enrichment, enrichment_source. Next step: present price + seller to the user, then x402_fetch once they approve.
```

Changed: "Use this when" form, explicit no-wallet/no-payment framing up front, next-tool pointer. Facts unchanged from current description `[re-verified against source this session]`.

### 5. x402_access — title: `Access a wallet-gated API (no payment)`

```
Use this when an endpoint requires proof of wallet ownership (Sign-In-With-X or wallet-based authentication) instead of a payment — no funds move. Signs a wallet proof and calls the protected URL. It maintains its own per-session access context, separate from the Dexter passkey wallet that x402_fetch spends from: omit sessionToken to start fresh, or pass sessionKey to reuse a stable context across calls. If the endpoint actually demands payment rather than identity, use x402_check + x402_fetch instead. Send only the raw payload the endpoint expects in body.
```

Changed: "Use this when" form; states the no-spend boundary and the separation from the paying wallet (both true today, buried in param descriptions `[re-verified]`). **Annotations added from zero** (see matrix — confirmed absent on today's wire).

### 6. x402_wallet — title: `Show Dexter wallet & USDC balance`

```
Use this when the user asks for their wallet address, USDC balance, or where to deposit. Read-only — never moves funds, and there is no server-side wallet to create or fund: Dexter holds no keys. When a passkey wallet is bound to this session, returns the Solana address and USDC balance (the widget adds a copy button and deposit QR). When none is bound, returns a setup payload instead of a balance — mode:"vault_required" with enroll_url/pairing_url and next_action:"call_dexter_passkey" — relay the link to the user or run dexter_passkey; do not misreport this state as "you have no wallet", it means no wallet is CONNECTED here yet.
```

Changed: "Use this when" form; adds the key unbound-state fields `[payload shape re-verified in source]` and the misreporting guard (requisition Phase 6 negative case).

### 7. x402_compose_skill — title: `Turn an x402 host into a reusable skill`

```
Use this when the user wants to ADOPT an x402 host as a reusable agent skill — "turn blockrun.ai into a skill" — not when they want to call it now (use x402_fetch for that). Two modes with very different weight. Default (publish:false) is read-only: returns the skill bundle inline for ad-hoc install; nothing is persisted or published. publish:true is a permanent external write: it publishes the composition at x402gle.com/skills/<handle>/<slug>, commits it to the Dexter-DAO/composed-skills GitHub repo, and lists it per the visibility setting (default "unlisted"; "public" appears in the open marketplace). Publishing requires a claimed handle (one-time setup at dexter.cash/wallet/claim-handle) and a bound identity — without them the call returns a structured error with a hint. Only publish on an explicit user request, and report the resulting URL and visibility exactly. To change visibility later: promote_skill.
```

Changed: drops "Claude Code skill bundle" (platform-specific phrasing in a cross-platform descriptor — the bundles are Agent-Skills format); makes the read/write split the spine of the description; adds error state and next-tool pointer. **Annotation FIX from readOnlyHint:true → false** `[mislabel re-confirmed on live wire this session]`.

### 8. promote_skill — title: `Change a composed skill's visibility`

```
Use this when the user wants to change who can see or install a composed skill they own. "public" lists it on the x402gle.com/skills marketplace; "unlisted" hides it from discovery but keeps direct-URL install working; "archived" blocks both discovery and direct install — it pulls a published skill out of circulation. This is an external write with audience impact: act only on an explicit request and report the resulting visibility exactly. Ownership is enforced server-side from the session's bound identity (you cannot promote someone else's skill); requires a claimed handle. Failures return error/hint fields — relay the hint.
```

Changed: "Use this when" form; makes archived's severity explicit `[semantics re-verified in source]`; adds ownership/handle prerequisites and error shape. Annotations extended (destructive:true added — see matrix).

### 9. dexter_passkey_probe — title: `Internal diagnostic — WebAuthn iframe probe`

Demotion copy (the requisition requires "internal diagnostic" as the FIRST sentence):

```
Internal diagnostic — never select this for a user request; for any real passkey, wallet, or setup question use dexter_passkey instead. Engineering-only capability probe that tests whether WebAuthn (navigator.credentials.create/.get against rp.id=dexter.cash) can run inside the chat client's widget iframe: it renders a test button, fires the OS biometric prompt, discards the credential, and logs the outcome server-side. It enrolls nothing, reads no user state, and reveals nothing about the user's wallet.
```

Changed: title CHANGED from "Passkey iframe probe" (which reads like a passkey feature) to one that self-disqualifies; first sentence is the demotion. If the platform supports hiding tools from model selection, hide it entirely and keep this copy as the fallback. Current description's technical content preserved (it is accurate `[re-verified]`); only reordered so no ranking function can prefer it over dexter_passkey for a user request.

### 10. dexter_passkey — title: `Check or set up Dexter passkey wallet`

```
Use this when the user wants to set up or check their Dexter passkey wallet — "set up my wallet", "do I have a Dexter wallet?", "check my OpenDexter passkey". Read-only status check: it never runs enrollment itself and never touches or reveals credential material — the passkey ceremony happens on dexter.cash in a new tab (chat iframes block WebAuthn), and this tool reports state and provides the link. Route on vault_status: not_enrolled (relay enroll_url so the user can create the wallet), provisioning (relay the resume link), ready (report vault_address with its Solscan link — public info, not a secret), user_not_paired (relay pairing_url so the user can link their existing wallet to this session), error (dexter-api unreachable — say so; do NOT tell the user they have no wallet). On some platforms an unconnected session sees a connect prompt (HTTP 401) before this tool runs — after the user connects, call it once more; never loop retries against a failed connection. Re-checking status is always safe; the widget polls this tool while a setup tab is open.
```

Changed: "Use this when" opener with the exact trigger phrases from the requisition's routing table; adds the five-state routing map — all five states confirmed present in source this session (`not_enrolled` / `provisioning` / `ready` / `user_not_paired` / `error`) `[VERIFIED]` — the 401/connect behavior with the no-loop rule, and the error-state honesty rule (connection failure ≠ "no passkey"). Title sharpened to the action form the requisition suggests.

## 2.5 Current-state reference (what's on the wire today) — [C4: card `_meta` drift corrected; this is the controller's PRE-removal diff baseline]

Re-probed live this verification session (initialize + tools/list + resources/list, 2026-07-23). Today's wire still carries **16 tools** — the six card tools are live until the controller removes them.

**Titles today:** x402_search "x402 Search" · x402_pay "x402 Pay" · x402_fetch "x402 Fetch" · x402_check "x402 Check" · x402_access "x402 Access" · x402_wallet "x402 Wallet" · x402_compose_skill "x402 Compose Skill" · promote_skill "Promote Composed Skill" · dexter_passkey_probe "Passkey iframe probe" · dexter_passkey "Dexter passkey wallet" · **all six card tools: no title** (positional registration). `[VERIFIED — matched live wire exactly]`

**Annotations today:** readOnlyHint:true on x402_search, x402_check, x402_wallet, x402_compose_skill, dexter_passkey_probe, dexter_passkey · destructiveHint:true on x402_pay, x402_fetch · readOnlyHint:false on promote_skill · **nothing at all** on x402_access and all six card tools. `[VERIFIED — matched live wire exactly]`

**Widget metadata today [C4 correction]:** the fact-map's wire capture recorded the four widget-backed card tools with NO descriptor `_meta`; today's wire shows card_status/card_issue/card_link_wallet/card_freeze DO carry `_meta` (with a reduced widgetCSP carrying only resource_domains) — the server drifted after the fact-map capture. The two OTP card tools and x402_compose_skill/promote_skill carry no `_meta`. Moot after removal; noted so the controller's diff doesn't trip on it.

**Widgets today:** 9 `ui://` templates (marketplace-search, fetch-result, pricing, wallet, card-status, card-issue, card-link-wallet, passkey-probe, passkey-onboard) — the three card templates go with the tools, leaving 6. There is no card-freeze template. `[VERIFIED — live resources/list]`

**Descriptions today:** the x402 six and the passkey pair are accurate, information-dense prose — just not in behavioral-cue form and missing next-tool/auth-state coverage. No description on the surviving roster is factually wrong; the rewrite is for routing form, consent posture, and error-state coverage — with ONE exception: x402_compose_skill's "Claude Code skill bundle" phrasing and its readOnlyHint.

**Where the code changes land:** the ten surviving tools all live in `dexter-mcp/open-mcp-server.mjs` (all registered via `registerTool` with config — titles/annotations are straightforward edits). The card REMOVAL additionally touches: the `composeCardTools` call + the two positional `server.tool()` OTP blocks in the same file; the three card `ui://` resource registrations; `@dexterai/mcp-instructions` (drop the card section from hosted caps — the roster-parity assert otherwise throws at startup, see rule 2.0-2); and `@dexterai/x402-mcp-tools` itself per the ruling (shared package — every consumer must be migrated per the standing drift rule; the npm/local `dexter-x402` surface currently registers all card tools plus `card_login_start`).
