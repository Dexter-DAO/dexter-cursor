<!--
Durable capture of the 2026-07-22 widget-render investigation.
Two independent probes converged: a 4-angle research workflow (with a LIVE ListMcpResources
probe of both OpenDexter servers) + a claude-code-guide agent against Anthropic's own docs.
This doc is the implementation spec. Any capable agent can execute from it cold.
-->

# OpenDexter Widget Rendering — Verdict, Fix, and v2 Spec

**Date:** 2026-07-22
**Status:** Root cause CONFIRMED (live probe + source + Anthropic docs). Fix specified, not yet applied.
**Owner:** unassigned — pick up from this doc.

Tags: **[CONFIRMED]** observed/documented this session · **[INFERENCE]** reasoned from confirmed facts · **[SPECULATION]** plausible, unproven.

---

## TL;DR

1. Our **local/shared** MCP server (`@dexterai/opendexter` a.k.a. `dexter-x402`) is **structurally incapable of announcing a widget to any host** — the widget `_meta` is attached to the tool **result**, never to the tool **descriptor** (`tools/list`). Hosts associate a tool with its widget via the *descriptor*. So this server renders a widget on **zero** surfaces. **[CONFIRMED, source]**
2. The **hosted** server (`open.dexter.cash` / the `claude.ai OpenDexter` connector) is **already correct** — descriptor `_meta` present, full dual-format CSP. **[CONFIRMED, live probe]**
3. The render Branch saw once **was real** and came from the **hosted** server on a render-capable session. It stopped because (a) he later exercised the broken local server, and (b) Claude's renderer has documented intermittent bugs. **[INFERENCE from confirmed facts]**
4. **Two gates must both pass to render:** **Gate A** (our descriptor `_meta` — fixable, below) and **Gate B** (the specific Claude surface actually mounting the iframe — Anthropic's, undocumented for the mobile Code section, and buggy/intermittent). **[CONFIRMED framing]**
5. **Live A/B on 2026-07-22:** even the already-correct **hosted** wallet did **not** render on the mobile Code section. So the mobile Code blocker right now is **Gate B (Anthropic), not our bug.** Our fix cannot flip Gate B. **[CONFIRMED empirical]**
6. **The prize:** widget buttons can call tools back directly (`ui/tools/call` over postMessage) = **tap-to-pay**. That plus live settle-progress and live balance refresh is a genuine v2 card, ~29h. **[CONFIRMED, spec]**

---

## The two gates

| Gate | Owner | Local/shared (`dexter-x402`) | Hosted (`open.dexter.cash`) |
|---|---|---|---|
| **A. Tool descriptor binds the widget** (`_meta.ui.resourceUri` on `tools/list`) | **Us** | ❌ missing **[CONFIRMED]** | ✅ present **[CONFIRMED]** |
| **B. The surface's display layer mounts an iframe from that `_meta`** | **Anthropic** | undocumented for mobile Code; **failed live 2026-07-22** | undocumented for mobile Code; **failed live 2026-07-22** |

`ui://` resources on the local server DO use the correct spec MIME `text/html;profile=mcp-app`, but they also **lack `_meta.ui.csp`** (the hosted server's resources have it). CSP is optional per spec, but a strict host may refuse without it — secondary gap. **[CONFIRMED, live probe]**

---

## THE FIX (Gate A) — exact

**Root cause [CONFIRMED, source-verified]:** every shared registrar uses the 4-arg `server.tool()` form. The already-built dual-format `meta` rides only the result:

```ts
// packages/x402-mcp-tools/src/tools/wallet.ts
const meta = opts.metas.wallet;                       // :14  ALREADY dual-format (openai/* + ui.*)
server.tool("x402_wallet", description, {}, async () => ({ /* … */ _meta: meta }));  // :20  descriptor gets NO _meta
```

The MCP SDK emits `_meta: tool._meta` in the `ListTools` handler; the 4-arg `server.tool` leaves `tool._meta = undefined`, so `tools/list` announces no widget → no host (MCP Apps **or** ChatGPT) can associate the tool with its `ui://` resource.

**The change** — move `meta` onto the descriptor via the config form:

```ts
// registerAppTool is the @modelcontextprotocol/ext-apps helper (already a dependency);
// it validates _meta.ui is present.
registerAppTool(server, "x402_wallet", {
  description,
  inputSchema: {},
  _meta: meta,            // <- FIX: dual-format meta now on the DESCRIPTOR
}, handler);
// Base-SDK equivalent: server.registerTool("x402_wallet", { description, inputSchema, _meta: meta }, handler)
```

**Files to touch** (all in shared pkg `@dexterai/x402-mcp-tools`, repo `opendexter-ide`):
- `packages/x402-mcp-tools/src/tools/wallet.ts:20`
- `packages/x402-mcp-tools/src/tools/search.ts:24`
- `packages/x402-mcp-tools/src/tools/check.ts:18`
- `packages/x402-mcp-tools/src/tools/access.ts:143`
- `packages/x402-mcp-tools/src/tools/fetch.ts:786,788`
- `packages/x402-mcp-tools/src/tools/cards/{freeze,status,issue,link-wallet}.ts`

**Second gap:** verify the deployed `packages/mcp/src/resources/widgets.ts` build actually emits `_meta.ui.csp` on the `ui://` resources — the live listing says it isn't reaching the wire (stale build vs source suspected). **[CONFIRMED gap; cause INFERENCE]**

**Do NOT:**
- **Retire `openai/outputTemplate`.** Dual-emit is free — each host reads its own namespace, no collision (`widget-meta.ts:52-68`). Killing the OpenAI keys forfeits **ChatGPT**, the largest surface that renders *today*. **[CONFIRMED]**
- **Route users to the hosted server as "the fix."** The point is the **local CLI** (`@dexterai/opendexter`) — the artifact that ships to other people's agents — which renders nowhere until Gate A is fixed.

**Shared-package win (rule #7):** this one shared fix repairs the local CLI's x402 tools **and** the card widgets on *both* servers (the hosted server routes card tools through these same shared registrars via `composeCardTools`). Fix once, every consumer benefits, no drift. **[CONFIRMED, source]**

**Sufficiency:** necessary for every host; **sufficient on the documented-render surfaces**; **does NOT by itself make the mobile Code section render** (that's Gate B).

Correct reference impl to copy: `dexter-mcp/open-mcp-server.mjs:1657` — `registerTool('x402_wallet', { _meta: WALLET_META }, …)`.

---

## Why it renders once then stops (Branch's sighting explained)

The one-time render could **not** have come from the local server (can't announce). It came from the **hosted** server on a render-capable session. Non-replication is over-determined:

1. **He later tested the broken local server** → nothing to render. **[INFERENCE from confirmed source]**
2. **Anthropic's renderer path is unstable/gated** — all documented:
   - 1P Claude Chat renders iframes while sending **empty** capabilities; a 3P surface with a byte-identical handshake returns text only, because the iframe-injection logic isn't wired into that code path — [claude-ai-mcp#236](https://github.com/anthropics/claude-ai-mcp/issues/236). **[CONFIRMED]**
   - "Renders then torn down by HTTP 400 mid-completion" — [claude-code#53030](https://github.com/anthropics/claude-code/issues/53030), unresolved as of Jul 2026. **[CONFIRMED]**
   - Claude Desktop renders empty labeled boxes — [claude-code#65653](https://github.com/anthropics/claude-code/issues/65653). **[CONFIRMED]**
   - Server-side feature gates toggle MCP behavior between sessions — [claude-code#22653](https://github.com/anthropics/claude-code/issues/22653). **[CONFIRMED]**
   - MCP Apps launched 2026-01-26; an incident was marked "resolved" 2026-04-23 with only a partial fix.

**Most likely single story:** correct payload (hosted) met a render-capable session once; every retry used the broken server or hit a session where the render path wasn't wired. Not a mirage — a correct payload meeting an intermittent client. **[INFERENCE]**

**On the mobile "Code" section specifically:** it is Claude Code **Remote Control** — a tunnel to the EC2 Claude Code session, which is the real MCP host (so both the stdio local server and the remote hosted server are reachable; the mobile question is purely display-layer). One source says its render path mirrors claude.ai/code (renders, buggy); another notes Claude Code is absent from the official MCP Apps client matrix. **Unresolved [SPECULATION]** — the live retest (below) settles it.

---

## Distribution take

The instinct (Claude app = best distribution surface) is **right about the app, unproven about the Code section**. Confirmed-renderable prizes, ranked by certainty:

1. **ChatGPT (Apps SDK, shipping)** — hosted server already speaks `openai/outputTemplate` + CSP. Largest surface where render is documented + shipping. **[CONFIRMED]**
2. **claude.ai web chat + Claude Desktop chat** — documented MCP Apps hosts, buggy but real. Hosted server format-correct today. **[CONFIRMED]**
3. **Claude app mobile Code section** — huge DAU, **unproven** render path. Upside probe, not a foundation. **[SPECULATION]**

**Play:** ship the Gate-A fix (unblocks every host) → prove on claude.ai web → Desktop → ChatGPT → treat mobile Code as an upside probe. Don't design v2 solely for the one surface least likely to render.

---

## Untapped capabilities + tap-to-pay v2 (Branch's "more will fall out" — CONFIRMED)

| # | Capability | Unlocks | Effort | Host support | Verdict |
|---|---|---|---|---|---|
| **1** | **App-driven tool calls from widget buttons** (`ui/tools/call` via postMessage) | **THE tap-to-pay primitive** — tap "Pay" → widget calls `x402_pay`/`x402_fetch` directly, updates in place, no model round-trip | ~12h | MCP Apps spec **[CONFIRMED]**; render surface must support it | **v2 core** |
| **2** | **Progress notifications** (`notifications/progress`) | Live "signing → settling → confirmed" during the 5–30s `x402_fetch`; kills mobile abandonment | ~6h | Claude Code supports progress streaming | **HIGH** |
| **3** | **Resource subscriptions** (`resources/subscribe`) | Wallet card balance refreshes live after deposit/settle instead of going stale | ~8h | Claude Code v2.1+ yes; Desktop no | **HIGH for Code, MED elsewhere** |
| **4** | **Tool annotations** (`readOnlyHint`/`destructiveHint`/`idempotentHint`) | Gate `x402_fetch`/`x402_pay` (destructive, non-idempotent) behind explicit approval; auto-approve read-only `x402_wallet` | ~2h | Broad client support | **MED benefit, LOW effort — do now** |
| **5** | **Tool visibility** (`["app"]` vs `["model","app"]`) | App-only pay/refresh/paginate tools so widget interactions don't clutter agent context or re-invoke the model | ~3h | MCP Apps spec **[CONFIRMED]** | **MED — required for clean tap-to-pay loop** |
| 6 | **Dynamic context** (`ui/context`) | Dark-mode / viewport adapt without reload | ~2h | MCP Apps | LOW — polish |
| — | Sampling | Model completions inside a widget | — | Claude Code does **not** support ([claude-code#1785](https://github.com/anthropics/claude-code/issues/1785)) | **Defer** |

**v2 widget = #1 + #5 (app-only pay tool) + #2 (progress) + #3 (balance refresh).** ~29h combined; they compose into one coherent card that degrades gracefully to a static card where `ui/tools/call` isn't wired.

---

## Verification plan (ordered — separates our bug from Anthropic's)

1. **Ship the Gate-A fix**, rebuild, republish `@dexterai/opendexter`.
2. **Prove on claude.ai web** (documented render surface): load the fixed local server, run `x402_wallet` → expect an iframe. Renders → **Gate A fix confirmed**, ambiguity from the muddied A/B is gone for good.
3. **Retest hosted wallet on the mobile Code section.** If a correct server *still* won't render there → mobile Code is blocked on **Gate B (Anthropic)**; file the bug, lean on the surfaces that render. If it renders → ship-and-done, move to v2.
4. **Cheaper pre-step (no phone):** tail the hosted server's request log while a Code-section session initializes; capture whether it advertises `capabilities.extensions["io.modelcontextprotocol/ui"]` with `text/html;profile=mcp-app`. Per [claude-ai-mcp#236](https://github.com/anthropics/claude-ai-mcp/issues/236) negotiation isn't decisive — a hint, not proof.

---

## Sources
- MCP Apps spec (2026-01-26): https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
- MCP Apps launch: https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/
- Render-then-fail HTTP 400: https://github.com/anthropics/claude-code/issues/53030
- Desktop empty boxes: https://github.com/anthropics/claude-code/issues/65653
- 1P vs 3P iframe injection: https://github.com/anthropics/claude-ai-mcp/issues/236
- Feature-gate session toggling: https://github.com/anthropics/claude-code/issues/22653
- Resource-rendering issue: https://github.com/modelcontextprotocol/ext-apps/issues/671
- Remote Control docs: https://code.claude.com/docs/en/remote-control
- Tool annotations: https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/

## Key files
- Fix site: `packages/x402-mcp-tools/src/tools/{wallet,search,check,access,fetch,cards/*}.ts`
- Dual-format meta builder (already correct): `packages/x402-mcp-tools/src/widget-meta.ts`
- Local resource registration (verify CSP reaches wire): `packages/mcp/src/resources/widgets.ts`
- Correct reference impl: `../dexter-mcp/open-mcp-server.mjs:1657`
