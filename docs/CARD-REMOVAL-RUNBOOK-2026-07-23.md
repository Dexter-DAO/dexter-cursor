# Card-tool removal runbook — both-surfaces, drift-free

Owner ruling (Jul 23): card tools come off the MCP product entirely; the card
becomes a wallet-widget concern (board #71). Chosen approach: **both-surfaces via
a single capability flag** in the shared `@dexterai/mcp-instructions` package, so
card presence is one switch, not a per-server hand-edit. This runbook is the
ordered, reversible execution plan. Nothing here touches the payment path, keys,
or the vault. Every step is fail-loud (a wrong step = a server that won't boot,
caught instantly) and git-revertible.

## Why order matters (the boot trap)

`open-mcp-server.mjs:2595` calls `assertInstructionRosterParity(SERVER_INSTRUCTIONS,
ALL_TOOLS)` — it THROWS at startup if the served instructions name any tool absent
from the roster. The hosted instructions currently mention `card_status` 7×. So the
instructions must stop naming card tools **before or in the same install as** the
roster loses them, or the server refuses to boot. The safe sequence publishes the
instruction change first, installs it, then removes the tools.

## Step order

### 1. `@dexterai/mcp-instructions` — add the `hasCardTools` cap flag
- Add `hasCardTools?: boolean` to `SurfaceCaps`; default **true** (existing
  consumers unaffected).
- Gate the Dextercard tool-reference section and the card-login provisioning /
  fallback sections behind `caps.hasCardTools`.
- Set `HOSTED_CAPS.hasCardTools = false` (hosted loses cards) and, per the
  both-surfaces ruling, `LOCAL_CAPS.hasCardTools = false` too (also drop
  `hasCardLoginStart`).
- Bump version, `npm publish`.
- **Rollback:** consumers stay pinned to the prior version until upgraded; a bad
  publish is corrected by publishing the next patch. Old versions keep working.

### 2. Hosted server (`dexter-mcp/open-mcp-server.mjs`)
- `npm install @dexterai/mcp-instructions@<new>` (brings the gated instructions).
- Remove the six card tools from `ALL_TOOLS`.
- Stop calling `composeCardTools`; delete the two positional `server.tool()` blocks
  (`card_login_request_otp`, `card_login_complete`).
- Stop registering the three card `ui://` resources (status/issue/link-wallet).
- Build, `pm2 restart dexter-open-mcp`, then WIRE-VERIFY: `tools/list` shows exactly
  10 tools, zero `card_*`; `initialize` instructions contain no card mention; the
  parity assert did not throw (process is `online`, not restart-looping).
- **Rollback:** `git revert` the server commit + reinstall prior instructions
  version + `pm2 restart`. Back in under a minute.

### 3. Local / npm server (`opendexter-ide`, published as `@dexterai/opendexter`)
- Same removal in the local server path; drop `card_login_start` too.
- The card tools also come out of `@dexterai/x402-mcp-tools` (`composeCardTools`) —
  shared package, so migrate BOTH servers in lockstep (Rule 7), bump, publish.
- Publish a new `@dexterai/opendexter`; existing installs keep cards until users
  upgrade (no drift in our repos; natural migration).

### 4. Claude plugin (`opendexter` marketplace entry)
- The plugin's MCP points at the same hosted/npm server, so cards vanish there once
  steps 2–3 ship. Bump the plugin version; republish the marketplace entry.
- Its bundled skills swap to the verified v2 skill set (already built in
  `codex-plugin/skills/`) — this is the #82 skill-rewrite deliverable landing on the
  Claude surface. Card content already absent from v2.

### 5. Verify no card tool anywhere
- Hosted wire: 10 tools. Local published tarball: no `card_*` registrars.
- Chat card questions → the wallet + https://dexter.cash/dextercard redirect
  (already encoded in the v2 skills).

## What this deliberately does NOT do
- Does not touch payments, settlement, keys, the vault, or any x402 logic.
- Does not delete the web card at dexter.cash/dextercard (unchanged, still works).
- Does not build the wallet card face — that is board #71, sequenced after.
