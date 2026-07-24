# OpenDexter Connect — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any AI-agent CLI bind to a user's real, passkey-controlled Dexter vault — so the CLI shows the user's actual wallet (Phase 1) and, once a rail is chosen, spends from it within user-authorized on-chain bounds (Phase 2) — with the whole handshake packaged as an SDK primitive other tools can embed (Phase 3).

**Architecture:** The user's wallet is a non-custodial passkey-controlled Solana Swig vault. The private key never leaves the platform authenticator — so "connect" never means copying a key. It means a **device-connect handshake**: the CLI mints a request, the user approves it with their passkey on dexter.cash (reachable by browser, phone-QR, or device-code so a headless/biometric-less machine still works), and the CLI receives a binding that lets it *read* the vault immediately and — after Phase 2 — *spend* within limits the chain enforces. The delegation model is the one already shipped for tabs: Dexter is fee-payer/sponsor with zero signing authority; the chain is the referee.

**Tech Stack:** TypeScript. CLI = `@dexterai/opendexter` (`opendexter-ide/packages/mcp`) + shared registrars (`opendexter-ide/packages/x402-mcp-tools`). Backend = `dexter-api` (Express, Prisma/Postgres). Consent UI = `dexter-fe` (Next.js). On-chain = `@dexterai/vault` SDK over the `dexter-vault` Anchor program (Solana). Node crypto: `tweetnacl` (ed25519), `@solana/web3.js`.

## Global Constraints

- **No custody, ever.** Dexter holds no wallet keys and signs nothing on the user's behalf as an unbounded party. Any spend authority is on-chain-scoped (cap + expiry) and user-revocable. (Standing ruling: no custodial tier anywhere.)
- **OAuth is transport only — passkey is the sole authentication.** The device grant is just the standard envelope for handing a token to a terminal. The one and only thing that authorizes a connection is the user's passkey ceremony (WebAuthn / Face ID / Touch ID) on dexter.cash, verified against the vault's registered credential via the existing verifier. There must be NO password, email/OTP, or account-based login path anywhere in the connect flow. Any task or review that finds a non-passkey auth path rejects it.
- **Solana-only for the vault rail.** The Swig vault and all authority primitives are Solana. EVM x402 payments stay on the local hot key. **Do not build EVM vault code in this plan** (see "Deferred").
- **Browser is not assumed.** Every human-approval step must be completable via at least: (a) browser handoff, (b) QR to a phone, (c) device-code entered on any device. Never a localhost-callback-only flow.
- **Agent-facing docs live in the payloads.** The primary documentation surface is the tool response itself: every state returns `message` (relay verbatim to the human), `instructions` (what the agent does next), and where a call could be re-run, a `retry` echo. Prose docs are secondary. This mirrors the existing tab-offer contract.
- **Shared SDK over local copies.** The connect handshake, once proven in the CLI, is extracted to a shared package and every consumer imports it — no hand-rolled re-implementations (Phase 3). Prefer the shared thing.
- **Credentials file rigor.** Any new file holding a bearer secret uses the atomic-write pattern from `tabs/store.ts` (0700 dir / 0600 file, temp-then-rename, corrupt-file-tolerant load), not the plain `writeFileSync` used by `wallet.json`/`settings.json`.
- **The user owns the limits (Phase 2).** Spend controls — per-call cap, daily cap, expiry, and how much autonomy the agent gets — are the USER's to set. The on-chain grant the passkey signs already encodes a user-chosen `maxAmount` + `expiresAt` at approval time, and the chain enforces it; Dexter must never present its own hardcoded server guardrails (currently ~$10/call, ~$100/day) as the user's ceiling or silently lower what the user chose. Ship sensible defaults, expose them as user-editable controls (the existing `x402_settings` tool is the seam), and make the user's chosen number the one that governs. This shapes Phase 2, not Phase 1.
- **Copy discipline.** No emojis in any user-facing CLI or web copy. No AI-slop patterns. Purposeful formatting only. **Apple-polish over confession on user surfaces:** reports to Branch are fully honest about every gap; the CLI/web copy an end user sees is polished and does not confess micro-caveats or transient noise. Honest waiting states are fine; apologetic hedging is not.

---

## ⚠ SPIKE UPDATE (2026-07-19) — read before building anything below

A pre-build spike (workflow wf_c8632d1e) changed two things. The task-level Phase 1 below (bespoke `/connect/start,approve,poll` endpoints, `vault_connect_requests` table, raw-handle release) is **SUPERSEDED — do not build it as written.**

- **Phase 1 binding = reuse, not build.** `dexter-api/src/routes/connectorOAuth.ts` already mints a revocable `dlt_` refresh token + short-lived aud-pinned ES256 vault bearer and never releases the raw handle (solves G1/G4). Phase 1 becomes: (1) add the OAuth **Device Authorization Grant** (RFC 8628) to connectorOAuth.ts for a browser-optional CLI; (2) CLI drives it, stores `{access_token, refresh_token}` 0600; (3) read the vault via the ES256 bearer. SIWX is not the binding (its verifier enforces no nonce/expiry — replayable).
- **Phase 2 spend splits:** PRAGMATIC (generalize the shipped tab-connect rail — CLI session key, passkey-registered on-chain authority, chain-enforced cap, Dexter co-signs settlement as a bounded party; machinery mostly exists) vs PURE (remove `dexter_authority` from settle + passkey-gated add-authority + client-side Swig payment builder; weeks of Anchor-program money-perimeter work). Pending Branch's pragmatic-vs-pure call.

**Phase 1 below is now rewritten to the OAuth-reuse design — those tasks are authoritative and are what gets built. The "File Structure" section immediately below is the pre-spike map (bespoke endpoints) and is superseded by the Phase 1 tasks.** Phase 2's pragmatic-vs-pure decision is still open (Branch leaning pragmatic); its tasks decompose once Phase 1 lands.

## The Phase 2 rail — DECIDED: Rail B (2026-07-19, Branch)

**Ruling:** Rail B — the CLI registers its own machine key as a capped, expiring native-Swig authority; the CLI signs its own payments; Dexter never signs. Truly non-custodial; the primitive competitors embed. Rail A (reuse the hosted pay door, Dexter's session-master signs) is rejected — it leaves Dexter in the signing loop and needs the G1/G4 security fix anyway.

Phase 1 below does not depend on this and is buildable now. Phase 2's first task is the **blocking spike**: prove `@dexterai/x402/client` can build+sign a Swig-authority x402 payment with a local ed25519 session key. Phase 2 tasks get decomposed after the spike resolves.

Execution mode (2026-07-19, Branch): **subagent-per-task.** A fresh subagent implements each task and runs unit tests; the controller (Fable seat) reviews between tasks, reviews the auth-touching tasks (3, 4) inline, and owns all builds + PM2 restarts (subagents never build live repos).

---

## File Structure

**Phase 1 — connect + real-wallet read (this document specs these in full):**

`dexter-api` (new device-connect endpoints on the anon vault rail):
- Create: `src/routes/vaultConnect.ts` — `POST /connect/start`, `POST /connect/approve`, `POST /connect/poll`. One responsibility: the device-connect rendezvous (mint request → passkey-approve → release handle+addresses to the polling CLI).
- Modify: `src/app.ts` — mount `createVaultConnectRouter()` under `/api/passkey-vault-anon`.
- Create: `prisma/migrations/<ts>_vault_connect_requests/migration.sql` + schema block `vault_connect_requests` (request lifecycle store). Applied via the DB-first convention (raw SQL + hand-edit schema.prisma), not `migrate deploy`.

`dexter-fe` (consent page):
- Create: `app/wallet/connect/ConnectApprove.tsx` — renders the device-connect approval, runs the passkey ceremony, POSTs to `/connect/approve`. Reuses the existing passkey ceremony helper (`app/lib/passkey.ts`) — do not hand-roll a second one.
- Create: `app/wallet/connect/page.tsx` — route wrapper reading `?request=` / `?code=`.

`opendexter-ide/packages/mcp` (CLI command + state):
- Create: `src/connect/connect.ts` — `cliConnect()`: start → print/open/QR + device-code → poll → persist.
- Create: `src/connect/store.ts` — `~/.dexterai-mcp/vault.json` read/write (atomic, tabs.json pattern).
- Create: `src/connect/store.test.ts`.
- Modify: `src/index.ts` — register the `connect` yargs command (+ `connect status`, `connect disconnect`).
- Create: `src/util/browser.ts` — promote `tryOpenInBrowser` out of `cli/dextercard.ts` to a shared util; add terminal QR rendering.
- Modify: `cli/dextercard.ts` — import `tryOpenInBrowser` from the shared util instead of its private copy (kill the duplicate).

`opendexter-ide/packages/x402-mcp-tools` (wallet-adapter vault-read mode):
- Create: `src/vault-adapter.ts` — `createVaultReadAdapter(binding)`: a read-only `WalletAdapter` that reports the bound vault's address + balances and returns `null` from every signing method.
- Modify: `src/tools/wallet.ts` — surface a `lane` field (`quickstart` | `connected`) and connected-vault identity in the `x402_wallet` payload.
- Create: `src/vault-adapter.test.ts`.

**Phase 2 — autonomous spend (specced after the rail is chosen):** a payment-lane seam in `packages/x402-mcp-tools/src/tools/fetch.ts` + rail-specific backend. Not decomposed here.

**Phase 3 — SDK extraction:** move `src/connect/*` into a shared `@dexterai/connect` (or `@dexterai/vault/connect`) primitive; migrate the CLI to consume it. Not decomposed here.

---

## Phase 1 — Connect + real-wallet read (REWRITTEN for OAuth-reuse, per the spike)

Design: the CLI does not invent a binding or receive the raw handle. It drives the **OAuth Device Authorization Grant** (RFC 8628) against the OAuth server that already exists in `dexter-api/src/routes/connectorOAuth.ts`. That server already mints a revocable `dlt_` refresh token + a short-lived, audience-pinned ES256 vault bearer, with the handle sealed inside the signed token (this is the G1/G4 fix, already in prod for the claude.ai connector). The CLI stores the returned token pair and reads the vault with the bearer. Device grant is the browser-optional flow by construction: the user approves on any device via a short code.

Implementer note for every task: **follow the conventions already in `connectorOAuth.ts` and the existing authorization_code+PKCE path** (token shape, error codes, dlt_/ES256 minting via `mintLinkToken` + `mintVaultSessionToken`). Do not fork a second minting path. Reuse `connectorOAuth.ts` helpers.

### Task 1: OAuth Device Authorization Grant (dexter-api) — MONEY-PERIMETER, controller (Fable) reviews inline

**Files:**
- Modify: `dexter-api/src/routes/connectorOAuth.ts` (add `POST /device_authorization`; extend `POST /token` to accept `grant_type=urn:ietf:params:oauth:grant-type:device_code`)
- Create: `dexter-api/prisma/migrations/<ts>_oauth_device_codes/migration.sql` + `schema.prisma` model `oauth_device_codes` (subagent writes SQL + schema edit; controller applies to prod at Task 7 via the dexter-db-migration skill — subagent NEVER applies)
- Test: `dexter-api/src/routes/__tests__/connectorOAuth.device.test.ts` (mock Prisma per the repo's 29-test convention — no real DB)

**Interfaces:**
- Produces: `POST /device_authorization` body `{ client_id, scope? }` → `200 { device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval }` per RFC 8628. `user_code` = two 4-char Crockford-base32 groups; `verification_uri = https://dexter.cash/wallet/connect`. Row in `oauth_device_codes(device_code_hash, user_code, status, user_handle, expires_at, last_polled_at)`, `status ∈ {pending, approved, denied, claimed}`, device_code stored as `sha256` only.
- Produces: `POST /token` with `grant_type=…device_code` + `device_code` → while pending `400 { error: "authorization_pending" }`; too-fast polling `400 { error: "slow_down" }`; on approval, **the exact same `{ access_token (ES256), refresh_token (dlt_), expires_in, scope: "vault" }` the authorization_code path returns** (reuse its minting), then the row flips to `claimed` (single dispensation).
- Consumes: the existing `mintLinkToken`, `mintVaultSessionToken`, and principal/handle resolution already in connectorOAuth.ts.

- [ ] **Step 1: Write failing test** — device_authorization issues a pending code; /token returns authorization_pending until approved; slow_down on rapid re-poll.

```ts
test("device grant: pending until approved, then issues the vault token pair", async () => {
  const da = await request(app).post("/device_authorization").send({ client_id: "opendexter-cli", scope: "vault" });
  expect(da.body.user_code).toMatch(/^[0-9A-HJ-NP-Z]{4}-[0-9A-HJ-NP-Z]{4}$/);
  const pend = await tokenPoll(da.body.device_code);
  expect(pend.status).toBe(400);
  expect(pend.body.error).toBe("authorization_pending");
  await approveDeviceCode(da.body.user_code, TEST_VAULT); // simulates Task 2's passkey approval
  const tok = await tokenPoll(da.body.device_code);
  expect(tok.status).toBe(200);
  expect(tok.body.scope).toBe("vault");
  expect(tok.body.access_token.split(".").length).toBe(3);      // ES256 JWT
  expect(tok.body.refresh_token).toMatch(/^dlt_[0-9a-f]{48}$/);
  const again = await tokenPoll(da.body.device_code);
  expect(again.body.error).toBe("expired_token");                // single dispensation, RFC 8628 §3.5
});
```

- [ ] **Step 2: Run test, verify it fails** — `npm --prefix dexter-api test -- connectorOAuth.device` → FAIL.
- [ ] **Step 3: Implement** the two endpoints reusing the existing minting; write the migration SQL + schema model (do not apply). Enforce `interval` (default 5s) with `slow_down`; expire per RFC 8628.
- [ ] **Step 4: Run test, verify it passes** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(oauth): device authorization grant for CLI vault connect (RFC 8628)"`

### Task 2: Device approval page (dexter-fe)

**Files:**
- Create: `dexter-fe/app/wallet/connect/page.tsx` + `app/wallet/connect/DeviceApprove.tsx`
- Test: `dexter-fe/app/wallet/connect/DeviceApprove.test.tsx` (add `@testing-library/react` + `@testing-library/user-event` to dexter-fe devDeps — controller installs)

**Interfaces:**
- Consumes: existing passkey ceremony helper `app/lib/passkey.ts` (reuse — do not hand-roll); a new `POST /device_approve` on connectorOAuth (subagent adds it in Task 1's file if not present: body `{ user_code, signedPasskeyPayload }` → verifies passkey for the resolved vault, flips the matching `oauth_device_codes` row to `approved` + stamps `user_handle`).
- Produces: page at `dexter.cash/wallet/connect` — user enters the `user_code` (or arrives via `verification_uri_complete` with it prefilled), taps passkey, sees confirmation.

- [ ] **Step 1: Write failing test** — entering a code + tapping approve POSTs the ceremony to `/device_approve`.
- [ ] **Step 2: Run test, verify it fails** → FAIL.
- [ ] **Step 3: Implement.** Apple-polish copy per Global Constraints: "Connect **opendexter-cli** to your Dexter wallet", one clean confirm, no emojis, no micro-caveats. State plainly it can be revoked at dexter.cash/wallet.
- [ ] **Step 4: Run test, verify it passes** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(wallet): device-code approval page"`

### Task 3: CLI vault token store (opendexter-ide/packages/mcp)

**Files:**
- Create: `opendexter-ide/packages/mcp/src/connect/store.ts` + `store.test.ts`

**Interfaces:**
- Produces: `interface VaultSession { version: 1; accessToken: string; refreshToken: string; vaultAddress: string; vaultPda: string; expiresAt: number; deviceLabel: string }`; `loadSession(): VaultSession | null`; `saveSession(s): void`; `clearSession(): void`. File `~/.dexterai-mcp/vault.json`, atomic temp-then-rename, 0700 dir / 0600 file, corrupt→null (never throws on the paid path). Follows `tabs/store.ts:100-116` exactly.

- [ ] **Step 1: Write failing test** — session round-trips; corrupt file loads as null.
- [ ] **Step 2: Run, verify fail** → FAIL.
- [ ] **Step 3: Implement** using `DATA_DIR` from `config.ts` + the atomic pattern.
- [ ] **Step 4: Run, verify pass** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(cli-connect): atomic vault session store"`

### Task 4: `opendexter connect` command (opendexter-ide/packages/mcp)

**Files:**
- Create: `opendexter-ide/packages/mcp/src/connect/connect.ts` + `connect.test.ts`
- Create: `opendexter-ide/packages/mcp/src/util/browser.ts` (promote `tryOpenInBrowser` from `cli/dextercard.ts:30-41`; add `renderQr(url)`)
- Modify: `opendexter-ide/packages/mcp/src/cli/dextercard.ts` (import shared `tryOpenInBrowser`, delete the private copy)
- Modify: `opendexter-ide/packages/mcp/src/index.ts` (register `connect` + `connect status` + `connect disconnect`, following the `dextercard` subcommand-switch yargs pattern)

**Interfaces:**
- Consumes: `/device_authorization` + `/token` (Task 1); `saveSession` (Task 3); `tryOpenInBrowser`, `renderQr`.
- Produces: `cliConnect(opts?: { dev?: boolean; noBrowser?: boolean }): Promise<void>`.

- [ ] **Step 1: Write failing test** — connect polls /token until approved, then persists the session (endpoints mocked).
- [ ] **Step 2: Run, verify fail** → FAIL.
- [ ] **Step 3: Implement**, mirroring `tabs/connect.ts` UX: POST device_authorization; present all three paths — print `verification_uri_complete`, offer to open a browser unless `--no-browser`, render a terminal QR, and print the `user_code` for entry on any device; poll `/token` honoring `interval`/`slow_down` until approved or expiry (Ctrl-C-safe/resumable); `saveSession`. **The touch:** on success immediately read + print the real wallet — name, address, balance — then "Revoke anytime at dexter.cash/wallet." Apple-polish, no emojis.
- [ ] **Step 4: Run, verify pass** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(cli): opendexter connect via OAuth device grant + shared browser/QR util"`

### Task 5: vitest harness + vault-read wallet adapter (opendexter-ide/packages/x402-mcp-tools)

**Files:**
- Modify: `opendexter-ide/packages/x402-mcp-tools/package.json` (add `"test": "vitest run"` + vitest devDep) + `vitest.config.ts`
- Create: `opendexter-ide/packages/x402-mcp-tools/src/vault-adapter.ts` + `vault-adapter.test.ts`

**Interfaces:**
- Consumes: the `WalletAdapter` contract (`wallet-adapter.ts:73-96`); the ES256 bearer from `VaultSession`.
- Produces: `createVaultReadAdapter(session: VaultSession, opts: { apiBaseUrl: string }): WalletAdapter`. `getInfo()` → `{ solanaAddress: session.vaultAddress, descriptor: { kind: "vault", vaultPda } }`; `getAllBalances()` → reads vault USDC using the bearer; **all signing methods return null** (`getPaymentSigners()` → `{}`, `getSolanaSigner()`/`getEvmSigner()` → null). A read adapter never signs.

- [ ] **Step 1: Write failing test** — adapter reports the vault and refuses to sign.
- [ ] **Step 2: Run, verify fail** → FAIL.
- [ ] **Step 3: Implement**; add the vitest harness (the package has none today).
- [ ] **Step 4: Run, verify pass** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(x402-tools): vitest harness + read-only vault wallet adapter"`

### Task 6: `x402_wallet` lanes + token refresh (x402-mcp-tools + mcp)

**Files:**
- Modify: `opendexter-ide/packages/x402-mcp-tools/src/tools/wallet.ts` + `wallet.test.ts`
- Modify: `opendexter-ide/packages/mcp/src/server/index.ts` (select the vault-read adapter when a session exists, else the hot-key adapter; on `401`/expired bearer, refresh via the `dlt_` at `/token` grant_type=refresh_token and re-save)

**Interfaces:**
- Consumes: `createVaultReadAdapter` (Task 5); `loadSession`/`saveSession` (Task 3).
- Produces: `x402_wallet` payload gains `lane: "quickstart" | "connected"`; connected → `vault: { address, vaultPda }`; quickstart → a self-describing `connect` hint (`message`/`instructions` telling the agent to run `opendexter connect` to use the real wallet). In-band-docs constraint.

- [ ] **Step 1: Write failing tests** — connected lane surfaces the vault; quickstart surfaces the connect hint.
- [ ] **Step 2: Run, verify fail** → FAIL.
- [ ] **Step 3: Implement** lane derivation (`getInfo().descriptor?.kind === "vault"`) + adapter selection + bearer refresh.
- [ ] **Step 4: Run, verify pass** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(wallet): quickstart vs connected lanes + bearer refresh"`

### Task 7: End-to-end verification (controller — includes the prod DB apply + PM2 restart)

**Files:** none (verification + the two gated production actions).

- [ ] **Step 1:** Apply the `oauth_device_codes` migration to prod Supabase via the dexter-db-migration skill (raw SQL + hand-edit schema.prisma + `prisma generate`). **Branch's explicit go required before this step.**
- [ ] **Step 2:** Build all touched packages (controller builds, never subagents): dexter-api, dexter-fe, x402-mcp-tools, mcp.
- [ ] **Step 3:** `pm2 restart dexter-api dexter-fe --update-env`.
- [ ] **Step 4:** Run `node packages/mcp/dist/index.js connect --no-browser` against a real test vault; approve on dexter.cash with the test passkey; confirm the CLI prints the real wallet address + USDC balance.
- [ ] **Step 5:** Verify the actual data (not just exit code): `opendexter wallet` returns `lane: "connected"`, the address matches the on-chain Swig wallet PDA, the USDC balance matches a direct on-chain read; quickstart mode (no session) still returns `lane: "quickstart"` + the connect hint.
- [ ] **Step 6: Commit** — `git commit -m "test(connect): phase 1 e2e verified on mainnet test vault"`

## Phase 2 — Autonomous spend (decision-gated; specced after the rail is chosen)

Do not begin until the rail is confirmed. Both rails add a **payment-lane seam** to `packages/x402-mcp-tools/src/tools/fetch.ts`: the current `tabLane` hook (`fetch.ts:296,380-401`) is tab-specific, so generalize it to an ordered `lanes: PaymentLaneHook[]` (the `TabLaneRequest`/`TabLaneOutcome` shapes are reusable verbatim; only the scheme trigger differs).

**If Rail B (recommended):**
1. **Spike first (blocking):** prove `@dexterai/x402/client` can build + sign a Swig-authority x402 payment with a local ed25519 session key. If it cannot, Rail B needs client-side work before anything else — surface that as its own decision.
2. New authority-registration path: generalize `buildOnboardTransactions` (`dexter-api/src/swig/transactionBuilder.ts:376-397`) / the session-key register (`vaultGrants.ts`) to register a **caller-supplied** ed25519 pubkey as a `programAll` USDC-token-limited, TTL-bounded authority (not counterparty-scoped). One passkey tap, Dexter sponsors, chain enforces.
3. `connect --spend` extends Task 7: mint a machine key, register it as the scoped authority, persist it in `vault.json`.
4. Vault lane in fetch.ts signs x402 payments locally with the machine key; own cap/budget gating (the lane bypasses the exact-path money gate, exactly as the tab lane does).

**If Rail A:**
1. **Close G1/G4 first (blocking):** replace `/api/passkey-anon/bind-mcp-session` with a passkey- or dlt-gated bind that produces a per-device-revocable binding. A CLI must never rely on the unauthenticated NULL-token path.
2. `connect --spend` mints a revocable binding; the vault lane POSTs to `/v2/pay/anon/x402/fetch`.

Either way: add `x402_activity` (the statement tool — receipts, spend-by-day, open authorities/tabs, exposure, revoke) so the user can see and cut what the CLI can spend. Add minimal per-tool telemetry while in the pay path (none exists today).

---

## Phase 3 — SDK extraction (later)

Move `src/connect/*` into a shared `@dexterai/connect` (or `@dexterai/vault/connect`) primitive: `startConnect()`, `pollConnect()`, `approveConnectUrl()`, binding storage interface. Migrate the OpenDexter CLI to consume it (consumer #1, per the shared-over-local rule), then document the embed path so a third-party CLI adds "Connect your Dexter wallet" in an afternoon. Hunt and kill any consumer that hand-rolls the handshake.

---

## Tracked — what this build does NOT give you (plain English, nothing under the rug)

When Phase 1 ships, here is exactly what is still missing, why, and where it lives so it can't get lost:

1. **You can see your real wallet but can't spend from it yet.** Phase 1 is read-only. Paid calls still come from the throwaway hot key. Spend is Phase 2 (Rail B), gated on the signing spike. → tracked: "Phase 2" section + the spike.
2. **Solana only.** Connecting does nothing for EVM x402 calls — those stay on the hot key. → tracked: "Deferred — EVM vault lane" below + the EVM-future spike finding.
3. **"Revoke" is thin until spend exists.** A read binding is just the CLI holding a credential; there is no scoped on-chain authority to cut yet. Real per-device revoke arrives with the Phase 2 spend authority. If the spike says connect can hand the CLI a revocable token instead of the raw handle, that closes the security gap earlier — decision pending the spike. → tracked: security finding G1/G4 in the connect memory + Phase 2.
4. **It's our CLI, not "any CLI."** The embeddable "Connect your Dexter wallet" primitive a competitor drops in is Phase 3. → tracked: "Phase 3" section.
5. **No spend statement / activity view.** `x402_activity` (receipts, spend-by-day, exposure) is Phase 2. Nothing to state until there's spend anyway. → tracked: Phase 2.
6. **No new way to fund the vault.** An empty vault is still funded on the website. → not planned; note if it becomes a friction point.
7. **The throwaway hot key still exists** as the quickstart lane for someone who wants to try with a dollar of dust and no account. It is a starter-wheel, not the destination. → tracked: quickstart lane, Task 9.

This register is the promise that these are known and sequenced, not forgotten.


## Phase 4 — "Open in your app" (site-initiated connect button) — TRACKED, required (Branch, 2026-07-19)

A button on dexter.cash (wallet already connected in-browser) that launches the user's local app already connected to their vault. Same OAuth token machinery as Phase 1, entered from the site side. Three targets; build all three on ONE shared site-initiated OAuth flow.

### Target doability (source-verified where noted)
- **Our CLI — full one-click, we control both ends.** The `gh auth login` pattern: CLI listens on a loopback port, the site button hands it the token. Ship ourselves, no third-party dependency. Build first.
- **Cursor — one-click via public deep link.** Cursor ships an "Add to Cursor" MCP-install deep link (`cursor://…/mcp/install?…`). We craft it; our MCP already exists. Biggest reach.
- **Hermes (Nous Research) — protocol connection is nearly FREE; true one-click needs Nous.** Source-verified from `NousResearch/hermes-agent@main`.

### Hermes specifics (verbatim-sourced, wf_6bf29d30)
- **Connecting Dexter to Hermes works today, ~zero code from us.** Hermes natively drives OAuth 2.1 PKCE for MCP servers via the official MCP Python SDK — PRM + Authorization-Server-Metadata `.well-known` discovery, RFC 7591 dynamic client registration, token exchange, refresh (`tools/mcp_oauth_manager.py:117` `HermesMCPOAuthProvider(OAuthClientProvider)`). OpenDexter is already a hosted OAuth MCP. User config:
  ```yaml
  mcp_servers:
    opendexter:
      url: "https://open.dexter.cash/mcp"
      auth: oauth
  ```
  then `hermes mcp login opendexter`. Hermes opens a browser, waits on a loopback port, user does the passkey OAuth. Tokens persist to `~/.hermes/mcp-tokens/<server>.json` (0600).
- **`hermes://` URL scheme EXISTS** (`apps/desktop/package.json` `protocols:["hermes"]` + `electron/main.ts` `setAsDefaultProtocolClient`, 3 OS delivery paths). Nous already ships a "Send to App" button pattern with it. **BUT the renderer only honors `kind === 'blueprint'`** — a `hermes://mcp/add?...` link silently no-ops today. Their local gateway API (`POST /api/mcp/servers`, `/auth`) can add + OAuth-connect but is sealed against browsers (loopback-only CORS + ephemeral session token + DNS-rebind defense).
- **Ranked one-click paths for Hermes:** (1) land OpenDexter in the Nous-approved catalog (`optional-mcps/<name>/manifest.yaml`, same shape as `optional-mcps/linear/manifest.yaml` = `transport.url` + `auth: oauth`) via a merged PR → true one-click in Hermes's own UI. (2) ship-now: our button generates a copy-paste `hermes mcp add dexter --url https://open.dexter.cash/mcp --auth oauth` (works immediately, not literally one-click). (3) upstream ~15-line patch to route `hermes://mcp/` → true one-click desktop button (Nous-dependent, but their deep-link plumbing already exists). Rule out: direct gateway call (sealed) and writing config.yaml from a browser (no FS access).

### Strategic gap (act on)
The `0xNyk/awesome-hermes-agent` community directory has a thriving x402 cluster — **AgentCash (Merit Systems), blacktea, hermes-payguard, Spraay x402 Gateway, and more — and ZERO Dexter/OpenDexter entries.** Our competitors are listed in the Hermes ecosystem directory and we are absent. Publishing OpenDexter as a Hermes skill + MCP catalog entry closes a live distribution gap.

### Our-side verification — CONFIRMED (2026-07-19, live-tested)
`open.dexter.cash/mcp` fully supports what Hermes's bare `auth: oauth` needs — verified against the LIVE server, not docs:
- PRM `open.dexter.cash/.well-known/oauth-protected-resource` → `authorization_servers: ["https://mcp.dexter.cash"]`, scope `vault`.
- AS metadata `mcp.dexter.cash/.well-known/oauth-authorization-server` → `registration_endpoint: https://mcp.dexter.cash/mcp/register`, `code_challenge_methods_supported: ["S256"]`, grants `authorization_code`+`refresh_token`, scopes `wallet.read`/`wallet.trade`/`openid`/`vault`.
- A live POST to the registration endpoint issued a `dcr_…` client_id with `pkce_required: true` — RFC 7591 DCR works. Source: `dexter-api/src/routes/mcpDcr.ts` (`/api/mcp/dcr/register`).
So Hermes connects to OpenDexter with `url + auth: oauth` and ZERO server changes. (Note: one throwaway `dcr-probe` public client was registered during the live test — harmless, PKCE-only, localhost redirect.)


## Deferred — EVM vault lane (DO NOT BUILD IN THIS PLAN)

There is no EVM authority/spend-limit primitive anywhere in the umbrella (confirmed: Swig is Solana-only, zero EVM signing deps in `@dexterai/vault`). EVM x402 payments stay on the local hot-key wallet. A vault lane for EVM requires a net-new EVM-side vault + authority model — a separate future project Branch has explicitly deferred. The CLI's wallet must continue to report the EVM hot key honestly and never imply the connected vault covers EVM.

---

## Hygiene (fold into the first task that touches each file)

- **Vault SDK drift:** `opendexter-ide/packages/mcp` pins `@dexterai/vault ^0.34.0` (resolves 0.34.0); source is 0.37.3. Bump and re-test before relying on any session/grant export.
- **PasskeySigner bypass:** the SDK `PasskeySigner` is interface-only (task #235); dexter-fe hand-rolls its ceremony. Task 5 must reuse `app/lib/passkey.ts`, not add a third ceremony. Note the bypass so it's closed when #235 ships.

---

## Self-Review

- **Spec coverage:** connect handshake (Tasks 1-7), browser-optional approval (Task 7 step 3: URL + QR + device-code), real-wallet visibility (Tasks 8-9), verification with actual-data check (Task 10), agent-facing in-band docs (Task 9 connect hint; Global Constraints), touches (Task 7 step 3 payoff + revoke line), EVM deferred (section), the Phase 2 rail fork (section + top callout), telemetry gap (Phase 2). Covered.
- **Type consistency:** `VaultBinding` fields (`userHandle`/`vaultPda`/`swigWalletAddress`) are identical across Tasks 6, 8, 9. `lane` values (`quickstart`/`connected`) identical in Tasks 8-9. Endpoint paths identical across Tasks 2-5 and 7.
- **Placeholders:** none — each code step carries real content; Phase 2/3 are deliberately architecture-level and marked decision-gated (writing fake-precise TDD for an unresolved fork would be the placeholder anti-pattern).
