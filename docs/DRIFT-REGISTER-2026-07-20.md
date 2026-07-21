# Sibling-drift register — local OpenDexter vs hosted connectors
**2026-07-20 · four read-only auditors (workflow wf_aaae0350-a3c) · all findings file-cited on both sides**

The siblings: LOCAL = `@dexterai/opendexter` (this repo, `packages/mcp`, what developers install).
HOSTED = `dexter-mcp` repo — `open-mcp-server.mjs` serves the claude.ai "OpenDexter" connector
(PM2 `dexter-open-mcp`); the "dexter-x402" connector runs the local package's roster. Both serve
the SAME byte-identical instructions from `@dexterai/mcp-instructions@2.0.2`.

## Wave-1 close-out (2026-07-21, plan docs/superpowers/plans/2026-07-21-drift-pass-wave1.md)

**CLOSED by Wave 1** (mcp-instructions@2.1.0 + opendexter@1.20.1 published; hosted live-verified):
R1 mechanism (surface-conditioned buildServerInstructions + boot parity assertion, both servers) ·
B1 (captcha fallback per-surface) · B2 instructions-half (hosted text no longer advertises
x402_settings; the hosted settings TOOL remains the Wave-2 build) · B3 (hosted policy recipe
matches real dexter-api cap errors, no hardcoded numbers) · B4 (docs:// ships locally) ·
D3 (Solana-only funding copy on hosted) · D4 (dexter_passkey documented, env-var recipe local-only) ·
D5 (SDK floors current) · Q1 (hosted tools documented) · Q2 (version stamp derives from
package.json) · Q3 (x402_pay schema byte-identical to x402_fetch) · Q4 (phantom dep removed).

**STILL OPEN:** B5 cap zoo (Wave 2 settings build + Branch's cap confirmation) · D2 schema
convergence via shared package (Wave 4 / R2) · **NEW: widgets.ts prod bug** — packages/mcp/src/
resources/widgets.ts:17 hardcodes ../widgets, nonexistent under the bundled build, so widgets
silently serve fallbackHtml in production (reviewer-confirmed; fix = candidate-probing like
docs.ts) · workflow-doc FROM-SCRATCH REWRITE per Branch's Jul 19 ruling (fresh seat, not
api-fable; Wave-1 applied only a falsehood-excision stopgap) · x402-mcp-tools declares
mcp-instructions ^2.0.1 (caret-fine; floor hygiene).

## The two root causes (fix these and most symptoms stop regenerating)

**R1 — One instructions string, two rosters, no parity check.** The shared instructions are served
verbatim by connectors whose toolsets differ in BOTH directions (hosted has passkey/compose/promote
tools the text never mentions; text routes to x402_settings ×3 and card_login_start ×1 which hosted
lacks). Nothing enforces that every tool named in the text exists in the serving roster.
*Fix:* make `SERVER_INSTRUCTIONS` a function of surface capabilities
(`{hasSettings, hasCardLoginStart, hasPasskey, ...}`) AND add a boot-time parity assertion in each
server: every tool name in the served text must be registered, or refuse to start loudly.

**R2 — Bypass drift (Rule 7) on the x402 tool family.** Local mounts all six x402 tools from shared
`@dexterai/x402-mcp-tools` (`composeAllTools`); hosted hand-rolls all six as bespoke
`registerTool` blocks (open-mcp-server.mjs:1451-1642) with forked schemas/descriptions — while the
card family IS shared on both sides (`composeCardTools`), proving the pattern works. Every
schema/description/cap divergence below is a symptom of this fork.
*Fix:* give `@dexterai/x402-mcp-tools` a pluggable payment-adapter seam (local-key vs
hosted-anon-vault) and have the hosted server call `composeAllTools` with the hosted adapter,
deleting the six hand-rolled blocks.

## Breaks-agents-now (an agent following the served instructions errors TODAY)

| # | Finding | Fix |
|---|---|---|
| B1 | **Captcha fallback → nonexistent tool.** Instructions: on `captcha_solver_not_configured` "call card_login_start instead". claude.ai roster has no card_login_start — AND the hosted tool's own description gives a *different* fallback (dexter.cash/dextercard), contradicting the served text. (instructions src/index.ts:129; ALL_TOOLS open-mcp-server.mjs:152; contradiction :2320) | Surface-conditional fallback text (R1), or register the tool hosted; reconcile with the URL fallback. |
| B2 | **x402_settings advertised ×3, absent on claude.ai.** Now with root cause: the exclusion is *deliberate and documented* (packages/mcp/src/server/index.ts:129-131 "hosted servers do not surface this tool") — yet the unconditioned shared text still routes hosted agents to it. | R1 gating now; the real hosted per-user settings tool is the queued build. |
| B3 | **The whole payment-policy-block recipe is dead on hosted.** The trigger string ("Payment policy blocked… Current maxAmountUsdc is $N") is produced only by the local fetch tool; hosted x402_fetch has no `maxAmountUsdc` param; hosted has no x402_settings. A capped hosted agent gets an unfamiliar vault-mandate error plus two impossible remediations. (index.ts:61-62,90-91; local trigger fetch.ts:126) | Hosted-specific recipe keyed to the real vault-mandate error string, remediation = raise the mandate at dexter.cash. |
| B4 | **docs:// resources dead on LOCAL** (reverse direction). Instructions point at docs://opendexter/{workflow,protocol,debugging}; hosted registers them, local registers only ui:// widgets → resource-not-found on the local surface. (index.ts:141; hosted :1432-1434; local widgets.ts:32-76) | Register the three docs resources in packages/mcp (sources already ship), or gate the pointer. |
| B5 | **The cap zoo.** Same tool name, different ceilings, undocumented: LOCAL x402_fetch = 5 USDC/call default (agent-adjustable, daily budget default OFF); HOSTED anon = 10 USDC/call + 100 USDC/UTC-day (fixed, server-side, `x402PayAnon.ts:61,68` — the ⚠ unconfirmed-policy-number comment); OPEN path = 50 USDC/call + 250/session (`x402Pay.ts:53-56`). Served text describes only the local model. | One cap table as data; per-surface instructions state the real numbers; hosted caps become readable (and later settable) via the settings build; Branch confirms the ⚠ policy numbers. |

## Drift-will-rot

| # | Finding | Fix |
|---|---|---|
| D1 | ~~Money-perimeter SDK skew~~ **FIXED TONIGHT**: dexter-mcp ran x402 5.4.0 / vault 0.37.0 — the exact versions hotfixed twice within hours (5.4.1/5.4.2 same day; 0.37.1-3 within ~1h) which dexter-api adopted. Bumped to 5.4.2/0.37.3 (--legacy-peer-deps, matching the tree's zod-3 status quo), both connectors restarted + serving, committed. | Done. Residual: the latent zod-3 vs claude-agent-sdk zod-4 peer clash is a pre-existing landmine — resolve when agent-sdk next bumps. |
| D2 | **Schema divergence under identical names**: hosted adds `network` (search) + `sampleInputBody` (check) + `sessionToken` (access); drops `headers`/`maxAmountUsdc` (fetch). An agent's learned schema doesn't survive the surface move; hosted's own network-param help mildly contradicts the shared "do NOT pre-filter by chain". | Converge through the shared package (R2): add the hosted params to shared schemas, keep the local ones, one contract. |
| D3 | **Six-chain funding promise vs Solana-only hosted vault.** Instructions/wallet copy advertise deposits on Solana+5 EVM chains; the hosted vault hardcodes EVM balances to '0' and settles Solana-only. An agent can quote a Base/Polygon deposit address story for money the vault cannot spend. (index.ts:84 vs open-mcp-server.mjs:1183-1194) — arguably breaks-now with money attached; treat as top of this tier. | Per-surface funding copy: hosted = Solana only. Fold into R1. |
| D4 | **Hosted wallet-setup recipe is local-only** (env-var private keys / CLI), while the actual hosted onboarding tool `dexter_passkey` is never mentioned in the served text. Hosted tool responses do emit the right next_action, softening impact. | R1: split walletless recipe by surface; document dexter_passkey on hosted. |
| D5 | **`@dexterai/opendexter` floors stale** (vault ^0.34.0, x402 ^5.2.0, x402-core ^1.4.4) and this repo's node_modules resolves AT the floors — the dev tree tests against older SDKs than fresh installs get via caret. | Bump floors to current minors + reinstall. |

## Quality

| # | Finding | Fix |
|---|---|---|
| Q1 | Four hosted tools registered but undocumented (dexter_passkey, dexter_passkey_probe, x402_compose_skill, promote_skill) — the actual hosted onboarding funnel is invisible to the served procedure. | R1 hosted section. |
| Q2 | `SERVER_INSTRUCTIONS_VERSION = '2.0.0'` while the package ships 2.0.2 — the drift-detection stamp is itself drifted. | Derive the stamp from package.json. |
| Q3 | "x402_pay identical to x402_fetch" is true locally, false hosted (pay lacks `multipart`, types body `z.any()`) — hosted uploads silently inexpressible via x402_pay. | Same schema for both (R2), or drop "identical". |
| Q4 | dexter-api pins `@dexterai/opendexter ^1.0.1` (18 minors stale) and never imports it — phantom dependency misleading consumer greps. | Remove from dexter-api package.json. |

## Clean bills
- `@dexterai/mcp-instructions` content byte-identical across source, npm, and both servers — no content skew.
- **No uncommitted-source landmine**: `@dexterai/opendexter@1.19.0` published == repo HEAD, tree clean.
- Card tool family properly shared on both surfaces (the R2 proof-of-pattern).

## Pass order
1. ~~D1 SDK bump~~ (done tonight) → 2. **R1** (surface-conditioned instructions + boot parity assertion — kills B1/B2/B3-text/B4/D3/D4/Q1/Q2 in one move) → 3. **hosted x402_settings build** (per-user, server-enforced, asymmetric authority: agent may lower, only the principal raises; rolling 24h windows — closes B2/B3/B5 for real; prerequisite: the one-cap-table decision, Branch confirms the ⚠ numbers) → 4. **R2** (shared x402 tools with payment adapter — kills D2/Q3 permanently) → 5. D5 floors + Q4 removal (minutes each).
