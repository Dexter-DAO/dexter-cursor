# Drift Pass Wave 1 — Surface-Conditioned Instructions + Parity Physics

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kill every breaks-agents-now and instructions-drift finding from `docs/DRIFT-REGISTER-2026-07-20.md` by making the shared instructions a function of surface capabilities, adding a boot-time parity assertion so this bug class can never boot again, and closing the small register cleanups.

**Architecture:** `@dexterai/mcp-instructions` stops exporting one string and starts exporting `buildServerInstructions(caps)` — each connector renders only the tools/behaviors it actually has. A shared `assertInstructionRosterParity()` makes any future text/roster mismatch a boot failure, not a silent lie. Local package and hosted server both adopt; schema parity and dependency hygiene ride along.

**Tech Stack:** TypeScript (opendexter-ide workspace, vitest), plain ESM .mjs (dexter-mcp), npm workspaces publishing.

## Global Constraints

- Subagent implementers: **Opus 4.8 floor** (Branch's standing rule). Controller (Fable, main loop) does ALL builds, publishes, PM2 restarts, and live verification — subagents never build or restart live repos.
- `git add` with **explicit file paths only** — both repos carry parallel-session uncommitted work. Never `git add -A`/`.`.
- **Never publish from uncommitted source** (standing landmine): every publish step is preceded by a commit and a `git status --short` check on the published package dir.
- Preserve existing prose **verbatim** when moving text behind a flag — this is conditioning, not rewriting. New hosted-variant sentences are the only new prose, and they must contain **no hardcoded cap numbers** (the caps are unconfirmed ⚠ policy values).
- One name per concept; no new synonyms.
- dexter-mcp's `open-mcp-server.mjs` is dirty with another session's live-deployed edits — Task 6 has an explicit controller triage step before touching it.

## File Structure

- `packages/mcp-instructions/src/index.ts` — becomes: `SurfaceCaps`, `buildServerInstructions()`, `LOCAL_CAPS`, `HOSTED_CAPS`, `assertInstructionRosterParity()`, version stamp from package.json; keeps `SERVER_INSTRUCTIONS` as deprecated local-default alias.
- `packages/mcp-instructions/src/index.test.ts` — NEW: rendering + parity tests.
- `packages/mcp/src/server/index.ts` — consume `buildServerInstructions(LOCAL_CAPS)` + boot assertion.
- `packages/mcp/src/resources/docs.ts` — NEW: `docs://opendexter/*` resources for the local package.
- `packages/mcp/package.json` — SDK floor bumps + ship skill markdown in `files`.
- `~/websites/dexter-mcp/open-mcp-server.mjs` — consume `buildServerInstructions(HOSTED_CAPS)` + boot assertion + `x402_pay` schema parity.
- `~/websites/dexter-api/package.json` — remove phantom `@dexterai/opendexter` dep.

---

### Task 1: Surface-conditioned instructions package

**Files:**
- Modify: `packages/mcp-instructions/src/index.ts`
- Create: `packages/mcp-instructions/src/index.test.ts`

**Interfaces:**
- Produces (later tasks rely on these exact exports):
  `interface SurfaceCaps { surface: 'local'|'hosted'; hasSettings: boolean; hasCardLoginStart: boolean; hasPasskeyTools: boolean; hasSkillTools: boolean; hasDocsResources: boolean; multichainFunding: boolean }`
  `function buildServerInstructions(caps: SurfaceCaps): string`
  `const LOCAL_CAPS: SurfaceCaps` (surface:'local', hasSettings:true, hasCardLoginStart:true, hasPasskeyTools:false, hasSkillTools:false, hasDocsResources:true, multichainFunding:true)
  `const HOSTED_CAPS: SurfaceCaps` (surface:'hosted', hasSettings:false, hasCardLoginStart:false, hasPasskeyTools:true, hasSkillTools:true, hasDocsResources:true, multichainFunding:false)
  `const SERVER_INSTRUCTIONS: string` — `buildServerInstructions(LOCAL_CAPS)`, kept for back-compat, JSDoc `@deprecated use buildServerInstructions`
  `function assertInstructionRosterParity(instructions: string, registeredTools: string[]): void` — throws listing missing tools
  `const SERVER_INSTRUCTIONS_VERSION: string` — from package.json `version`

- [ ] **Step 1: Write the failing tests**

Create `packages/mcp-instructions/src/index.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  buildServerInstructions, LOCAL_CAPS, HOSTED_CAPS,
  SERVER_INSTRUCTIONS, SERVER_INSTRUCTIONS_VERSION,
  assertInstructionRosterParity,
} from './index.js';
import pkg from '../package.json';

const local = buildServerInstructions(LOCAL_CAPS);
const hosted = buildServerInstructions(HOSTED_CAPS);

describe('hosted rendering (HOSTED_CAPS)', () => {
  it('never mentions tools the hosted roster lacks', () => {
    expect(hosted).not.toContain('x402_settings');
    expect(hosted).not.toContain('card_login_start');
    expect(hosted).not.toContain('maxAmountUsdc');
  });
  it('uses the dexter.cash card fallback instead of card_login_start', () => {
    expect(hosted).toContain('https://dexter.cash/dextercard');
  });
  it('is Solana-only on funding and forbids EVM deposit advice', () => {
    expect(hosted).toContain('USDC on Solana only');
    expect(hosted).not.toContain('Funding chains: Solana, Base');
  });
  it('documents the passkey onboarding tools', () => {
    expect(hosted).toContain('dexter_passkey');
  });
  it('routes walletless users to dexter_passkey, not env vars', () => {
    expect(hosted).not.toContain('DEXTER_PRIVATE_KEY');
  });
  it('contains no hardcoded cap dollar amounts', () => {
    expect(hosted).not.toMatch(/\$\s?(10|50|100) (USDC|per)/);
  });
});

describe('local rendering (LOCAL_CAPS)', () => {
  it('keeps settings routing and the policy-block recipe', () => {
    expect(local).toContain('x402_settings');
    expect(local).toContain('maxAmountUsdc');
  });
  it('keeps card_login_start fallback and env-var wallet recipe', () => {
    expect(local).toContain('card_login_start');
    expect(local).toContain('DEXTER_PRIVATE_KEY');
  });
  it('never mentions hosted-only tools', () => {
    expect(local).not.toContain('dexter_passkey');
  });
  it('SERVER_INSTRUCTIONS alias equals the local rendering', () => {
    expect(SERVER_INSTRUCTIONS).toBe(local);
  });
});

describe('version stamp', () => {
  it('tracks package.json exactly', () => {
    expect(SERVER_INSTRUCTIONS_VERSION).toBe(pkg.version);
  });
});

describe('assertInstructionRosterParity', () => {
  it('passes when every mentioned tool is registered', () => {
    expect(() => assertInstructionRosterParity(
      'use x402_search then x402_fetch', ['x402_search', 'x402_fetch', 'extra_tool'],
    )).not.toThrow();
  });
  it('throws naming each missing tool', () => {
    expect(() => assertInstructionRosterParity(
      'call x402_settings or card_login_start', ['x402_search'],
    )).toThrow(/x402_settings.*card_login_start|card_login_start.*x402_settings/);
  });
  it('both shipped renderings are self-consistent with their caps rosters', () => {
    const hostedRoster = ['x402_search','x402_pay','x402_fetch','x402_check','x402_access','x402_wallet','x402_compose_skill','promote_skill','card_status','card_issue','card_link_wallet','card_freeze','card_login_request_otp','card_login_complete','dexter_passkey_probe','dexter_passkey'];
    const localRoster  = ['x402_search','x402_pay','x402_fetch','x402_check','x402_access','x402_wallet','x402_settings','card_status','card_issue','card_link_wallet','card_freeze','card_login_request_otp','card_login_complete','card_login_start'];
    expect(() => assertInstructionRosterParity(hosted, hostedRoster)).not.toThrow();
    expect(() => assertInstructionRosterParity(local, localRoster)).not.toThrow();
  });
});
```

If `packages/mcp-instructions/package.json` has no `test` script: add `"test": "vitest run"` and dev-dep `vitest` matching the version other workspace packages use (check `packages/x402-mcp-tools/package.json`); also add `"resolveJsonModule": true` to the package tsconfig if `import pkg from '../package.json'` errors.

- [ ] **Step 2: Run tests, confirm they fail** — `cd packages/mcp-instructions && npx vitest run` → FAIL (`buildServerInstructions` not exported).

- [ ] **Step 3: Implement the builder**

Rewrite `src/index.ts`. Keep the header comment (update the "Consumed via" example to `buildServerInstructions`). Structure — the existing string is decomposed into template sections; **every kept sentence is moved verbatim**:

```ts
import pkg from '../package.json';

export interface SurfaceCaps {
  surface: 'local' | 'hosted';
  hasSettings: boolean;
  hasCardLoginStart: boolean;
  hasPasskeyTools: boolean;
  hasSkillTools: boolean;
  hasDocsResources: boolean;
  multichainFunding: boolean;
}

export function buildServerInstructions(caps: SurfaceCaps): string {
  const sections: string[] = [];
  sections.push(PREAMBLE);              // current lines: "You are connected…" through the one-rule section, verbatim
  sections.push(routingSection(caps));  // routing table; settings line only if caps.hasSettings;
                                        // hosted adds: '"Set up / bind my wallet" -> dexter_passkey.' when hasPasskeyTools
  sections.push(toolsSection(caps));    // x402_search/check/fetch/access blocks verbatim;
                                        // wallet line: multichainFunding ? WALLET_MULTICHAIN (verbatim current) : WALLET_SOLANA_ONLY;
                                        // settings block only if hasSettings;
                                        // passkey tools block only if hasPasskeyTools; skills one-liner if hasSkillTools
  sections.push(failuresSection(caps)); // policy-block recipe: hasSettings ? current verbatim : HOSTED_POLICY_RECIPE;
                                        // walletless recipe: hasSettings…no—: caps.surface==='local' ? current env-var text : HOSTED_WALLETLESS_RECIPE;
                                        // balance + 402 recipes verbatim; explorer line verbatim
  sections.push(cardSection(caps));     // card machine verbatim; fallback line: hasCardLoginStart ? current verbatim : CARD_URL_FALLBACK
  sections.push(SAFETY.replace(caps.hasSettings ? '' : /- Every paid call is bounded by the per-call USDC cap \(maxAmountUsdc\)\..*?on your own\.\n/s, ''));
  if (caps.hasDocsResources) sections.push(DOCS_POINTER); // current "Deeper reference" verbatim
  return sections.join('\n\n');
}

// New hosted-variant prose (the ONLY new sentences; no dollar amounts):
const WALLET_SOLANA_ONLY =
  'x402_wallet — Creates or resumes the wallet session and shows the deposit address and USDC balance. Funding: USDC on Solana only — the passkey vault settles on Solana. Never quote a deposit address on any other chain on this surface.';
const HOSTED_POLICY_RECIPE =
  `A payment refused for exceeding a spend limit\n  Spend caps on this surface are enforced server-side by the wallet mandate (a per-call cap and a daily cap). Report the limit named in the error to the user. Caps cannot be raised in this conversation; the user manages their wallet at https://dexter.cash/wallet.`;
const HOSTED_WALLETLESS_RECIPE =
  `No wallet is bound to this session / a setup link is returned\n  Call dexter_passkey and relay the enroll link it returns. The user completes a passkey ceremony at dexter.cash; when they finish, retry the original call and it pays.`;
const CARD_URL_FALLBACK =
  'Fallback: if card_login_request_otp returns captcha_solver_not_configured or captcha_solve_failed, direct the user to provision at https://dexter.cash/dextercard, then continue at step 2.';

export const LOCAL_CAPS: SurfaceCaps = { surface:'local', hasSettings:true, hasCardLoginStart:true, hasPasskeyTools:false, hasSkillTools:false, hasDocsResources:true, multichainFunding:true };
export const HOSTED_CAPS: SurfaceCaps = { surface:'hosted', hasSettings:false, hasCardLoginStart:false, hasPasskeyTools:true, hasSkillTools:true, hasDocsResources:true, multichainFunding:false };

/** @deprecated Use buildServerInstructions(caps) — this is the local-default rendering. */
export const SERVER_INSTRUCTIONS = buildServerInstructions(LOCAL_CAPS);

export const SERVER_INSTRUCTIONS_VERSION: string = pkg.version;

const TOOL_NAME_RE = /\b(?:x402_[a-z_]+|card_[a-z_]+|dexter_passkey(?:_probe)?|promote_skill)\b/g;
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
```

The hosted passkey tools block (inside `toolsSection` when `hasPasskeyTools`):

```
dexter_passkey — Wallet onboarding for this surface. Returns the user's wallet state; when no wallet is bound, returns an enroll link to relay. The user completes a passkey ceremony at dexter.cash and the wallet binds to this session.

dexter_passkey_probe — One-button WebAuthn capability test for environments where passkey support is uncertain. Use only when the user reports the enroll ceremony failing.
```

And when `hasSkillTools`: `x402_compose_skill / promote_skill — Compose a multi-step paid workflow into a reusable skill, and promote it to the catalog. Use only when the user asks to save or share a workflow.`

- [ ] **Step 4: Run tests to green** — `npx vitest run` → all pass. Iterate on section decomposition until the verbatim-preservation tests and absence tests both hold.

- [ ] **Step 5: Commit**

```bash
cd ~/websites/opendexter-ide
git add packages/mcp-instructions/src/index.ts packages/mcp-instructions/src/index.test.ts packages/mcp-instructions/package.json packages/mcp-instructions/tsconfig.json
git commit -m "feat(mcp-instructions): surface-conditioned instructions + roster parity assertion

One string served to two different rosters was structurally guaranteed to lie
to one of them (drift register R1/B1/B2/B3/D3/D4/Q1/Q2). buildServerInstructions(caps)
renders per-surface truth; assertInstructionRosterParity() makes any future
text/roster mismatch a boot failure. Version stamp now derives from package.json."
```

---

### Task 2: Local server adopts caps + boot assertion

**Files:** Modify: `packages/mcp/src/server/index.ts`

**Interfaces:** Consumes Task 1's `buildServerInstructions`, `LOCAL_CAPS`, `assertInstructionRosterParity`.

- [ ] **Step 1:** Replace the import and constructor (current lines 3 and 41-44):

```ts
import { buildServerInstructions, LOCAL_CAPS, assertInstructionRosterParity } from "@dexterai/mcp-instructions";
// …
const instructions = buildServerInstructions(LOCAL_CAPS);
const server = new McpServer(
  { name: "OpenDexter", version: VERSION },
  { instructions },
);
```

- [ ] **Step 2:** After the last registration call (currently `registerWidgetResources(server);` line 133 — after Task 3 it is `registerDocsResources(server);`), add:

```ts
// Physics, not vigilance: if these instructions ever name a tool this
// server doesn't register, refuse to start (drift register, R1).
assertInstructionRosterParity(instructions, [
  "x402_search", "x402_pay", "x402_fetch", "x402_check", "x402_access", "x402_wallet",
  "x402_settings",
  "card_status", "card_issue", "card_link_wallet", "card_freeze",
  "card_login_request_otp", "card_login_complete", "card_login_start",
]);
```

- [ ] **Step 3:** Build + boot smoke: `cd ~/websites/opendexter-ide && npm run build -w @dexterai/opendexter` then run the package's existing test suite `npm test -w @dexterai/opendexter` → PASS; then a 5-second stdio boot check (`timeout 5 node packages/mcp/dist/…/cli.js serve </dev/null; echo $?` per the package's bin entry — confirm it starts without throwing the parity error).

- [ ] **Step 4: Commit** — `git add packages/mcp/src/server/index.ts && git commit -m "feat(mcp): local server renders LOCAL_CAPS instructions + boot parity assertion"`

---

### Task 3: docs:// resources ship in the local package (register B4)

**Files:** Create: `packages/mcp/src/resources/docs.ts` · Modify: `packages/mcp/src/server/index.ts`, `packages/mcp/package.json`

- [ ] **Step 1:** Locate the three skill sources the hosted server reads (`open-mcp-server.mjs` SKILL_RESOURCES: `opendexter/SKILL.md`, `x402-protocol/SKILL.md`, `x402-debugging/SKILL.md` under its SKILLS_ROOT — find with `grep -n "SKILLS_ROOT" ~/websites/dexter-mcp/open-mcp-server.mjs` and `ls` the resolved dir, expected `~/websites/opendexter-ide/skills/`). Copy them into `packages/mcp/assets/docs/{workflow,protocol,debugging}.md` (build-time copy in the package's build script, or commit the copies — match how the package already ships widget HTML assets; follow that pattern).

- [ ] **Step 2:** Create `packages/mcp/src/resources/docs.ts`:

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "docs");

const DOCS = [
  { name: "workflow",  uri: "docs://opendexter/workflow",  file: "workflow.md",  description: "OpenDexter tool reference — search → check → fetch workflow, parameter tables, quality scores, tips" },
  { name: "protocol",  uri: "docs://opendexter/protocol",  file: "protocol.md",  description: "x402 v2 protocol specification — payment flow, core types, CAIP-2 networks, error codes, transport layers" },
  { name: "debugging", uri: "docs://opendexter/debugging", file: "debugging.md", description: "x402 payment debugging — facilitator health, error code reference, common issues and fixes" },
] as const;

export function registerDocsResources(server: McpServer): void {
  for (const d of DOCS) {
    server.resource(d.name, d.uri, { description: d.description, mimeType: "text/markdown" }, async () => ({
      contents: [{ uri: d.uri, mimeType: "text/markdown", text: readFileSync(join(ASSETS, d.file), "utf-8") }],
    }));
  }
}
```

- [ ] **Step 3:** Wire in `server/index.ts` (`import { registerDocsResources } from "../resources/docs.js";` + call after `registerWidgetResources(server);`). Ensure `package.json` `files` includes the assets dir. Adjust asset path if the package's dist layout differs (mirror how widget HTML is resolved — check `widget-uris.ts`).

- [ ] **Step 4:** Test: extend the boot smoke from Task 2; then `resources/read` round-trip via the SDK inspector if the workspace has one, else assert `readFileSync` path resolves in a unit test:

```ts
it('docs assets ship with the package', () => {
  for (const f of ['workflow.md','protocol.md','debugging.md'])
    expect(existsSync(join(ASSETS, f))).toBe(true);
});
```

- [ ] **Step 5: Commit** — `git add packages/mcp/src/resources/docs.ts packages/mcp/src/server/index.ts packages/mcp/package.json packages/mcp/assets/docs && git commit -m "feat(mcp): ship docs://opendexter resources locally (register B4)"`

---

### Task 4: SDK floor bumps in the local package (register D5)

**Files:** Modify: `packages/mcp/package.json` (and any other workspace package pinning the same floors — `grep -rn '"@dexterai/vault"\|"@dexterai/x402"\|"@dexterai/x402-core"' packages/*/package.json`)

- [ ] **Step 1:** Bump floors: `@dexterai/vault` `^0.34.0` → `^0.37.3`; `@dexterai/x402` `^5.2.0` → `^5.4.2`; `@dexterai/x402-core` `^1.4.4` → `^1.4.8` (same bump in x402-mcp-tools if it declares them).
- [ ] **Step 2:** `npm install` at the workspace root; `npm ls @dexterai/vault @dexterai/x402 @dexterai/x402-core` → resolved at the new versions.
- [ ] **Step 3:** Full workspace test run: `npm test --workspaces --if-present` → PASS (this is the point of the task — prove the dev tree works on what users actually resolve).
- [ ] **Step 4: Commit** — `git add packages/*/package.json package-lock.json && git commit -m "chore(deps): raise @dexterai SDK floors to current minors (register D5)"`

---

### Task 5 (CONTROLLER ONLY — Fable): publish the packages

- [ ] **Step 1:** `git status --short packages/mcp-instructions packages/mcp` → clean (all committed). This gate is mandatory (stranded-source rule).
- [ ] **Step 2:** Version bumps: `packages/mcp-instructions` → **2.1.0** (new API, back-compat alias kept); `packages/mcp` (@dexterai/opendexter) → **1.20.0**. Commit the bumps.
- [ ] **Step 3:** Publish both (workspace publish flow the repo already uses — check root package.json scripts for the release script and use it; otherwise `npm publish -w @dexterai/mcp-instructions && npm publish -w @dexterai/opendexter`).
- [ ] **Step 4:** `npm view @dexterai/mcp-instructions version` → 2.1.0; `npm view @dexterai/opendexter version` → 1.20.0.

---

### Task 6 (CONTROLLER triage, then implement): hosted server adoption + x402_pay schema parity

**Files:** Modify: `~/websites/dexter-mcp/open-mcp-server.mjs`, `~/websites/dexter-mcp/package.json`

- [ ] **Step 0 (controller judgment, before any edit):** `cd ~/websites/dexter-mcp && git diff open-mcp-server.mjs` — the file carries another session's uncommitted, ALREADY-DEPLOYED edits (passkey-probe work, running live since 17:46 Jul 20). Per the stranded-work principle, commit those foreign hunks FIRST as their own labeled commit (`chore: commit parallel-session passkey-probe changes already live in prod`) so Wave-1 edits never mingle with them. If the diff is other than passkey-probe-shaped, stop and reconcile with Branch.
- [ ] **Step 1:** `npm i @dexterai/mcp-instructions@^2.1.0 --legacy-peer-deps` (matches the tree's existing zod-3 resolution mode).
- [ ] **Step 2:** Replace the import (line ~59) and the alias (line ~1295):

```js
import { buildServerInstructions, HOSTED_CAPS, assertInstructionRosterParity } from '@dexterai/mcp-instructions';
// …
const SERVER_INSTRUCTIONS = buildServerInstructions(HOSTED_CAPS);
```

- [ ] **Step 3:** In `createOpenMcpServer()`, after the last `server.registerTool` call, add:

```js
// Boot-time parity: instructions may never name a tool this roster lacks.
assertInstructionRosterParity(SERVER_INSTRUCTIONS, ALL_TOOLS);
```

- [ ] **Step 4 (register Q3):** Make `x402_pay`'s `inputSchema` byte-identical to `x402_fetch`'s — copy the `url/method/body(z.string with the raw-payload describe)/multipart/tab` block from the `x402_fetch` registration into the `x402_pay` registration (replacing its current `body: z.any()`, no-multipart schema). Handlers stay as they are (`x402Pay` already delegates).
- [ ] **Step 5 (controller):** restart + verify: `pm2 restart dexter-mcp dexter-open-mcp` → both `online`; `pm2 logs dexter-open-mcp --lines 15 --nostream` shows the normal boot banner and NO parity throw; then live-verify the served instructions changed: initialize an MCP session against `open.dexter.cash/mcp` (curl the initialize handshake) and confirm the instructions text contains `dexter_passkey` and does NOT contain `x402_settings`.
- [ ] **Step 6: Commit** — `git add open-mcp-server.mjs package.json package-lock.json && git commit -m "feat(open-mcp): serve HOSTED_CAPS instructions + boot parity assertion + x402_pay schema parity (register B1-B3/D3/D4/Q1/Q3)"`

---

### Task 7: remove the phantom dependency (register Q4)

**Files:** Modify: `~/websites/dexter-api/package.json`

- [ ] **Step 1:** Confirm still unused: `grep -rn "@dexterai/opendexter" ~/websites/dexter-api/src` → 0 hits (if any appear, STOP — a consumer arrived; bump instead of remove).
- [ ] **Step 2:** Remove the `"@dexterai/opendexter"` line from dependencies; `npm install` to update the lockfile.
- [ ] **Step 3 (controller):** `npm run build` in dexter-api → clean; NO pm2 restart needed (dependency-only change, but restart anyway per house rule after any build: `pm2 restart dexter-api`, verify `/health` 200).
- [ ] **Step 4: Commit** — `git add package.json package-lock.json && git commit -m "chore(deps): drop phantom @dexterai/opendexter dependency (register Q4)"`

---

## Wave-1 exit criteria

1. Both connectors boot with the parity assertion armed; killing a tool from a roster without fixing caps now fails the boot loudly.
2. Live claude.ai OpenDexter instructions contain `dexter_passkey`, the dextercard URL fallback, Solana-only funding — and no `x402_settings`, no `card_login_start`, no `maxAmountUsdc`.
3. Local `npx @dexterai/opendexter@1.20.0` serves unchanged-in-meaning local instructions, resolves current SDK minors, and answers `docs://opendexter/*` reads.
4. Register items B1 B2 B3 B4 D3 D4 D5 Q1 Q2 Q3 Q4 marked closed in `docs/DRIFT-REGISTER-2026-07-20.md` (one-line status edits, committed).

## Queued next (separate plans, in order)
- **Wave 2 — hosted x402_settings** (vault-keyed store, agent-lowers/principal-raises, rolling 24h windows + injected-clock boundary tests, FE Agents-tab card): plan written after Branch confirms the ⚠ cap numbers; its instructions change is then just `HOSTED_CAPS.hasSettings = true` + boot assertion keeps everyone honest.
- **Wave 3 — physics pass remainder** (vault-key resolver + owner-key rule, prepublish dirty-tree hook, job-alarm template, consumers manifest).
- **Wave 4 — R2** shared x402-tools payment adapter (kills schema drift permanently).
