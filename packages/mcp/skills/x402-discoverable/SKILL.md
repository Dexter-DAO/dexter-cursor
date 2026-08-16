---
name: x402-discoverable
description: "Get an x402 API discovered and listed on the OpenDexter / x402gle catalog so paying agents can find it. Trigger when the user has an x402 API and wants it listed, indexed, discoverable, or found by agents; wants to onboard or register a paid endpoint; asks how agents will find their API; or mentions `opendexter audition`, x402gle discovery, or making a server agent-discoverable. This is the step AFTER an API already speaks x402 (see x402-server for building that)."
---

# Make an x402 API discoverable

An API that speaks x402 can take payment — but no agent will pay it until an
agent can *find* it. Getting it into the OpenDexter / x402gle catalog is a
distinct step, and it is the one this skill handles.

The catalog does not list an API by reading its description. It **auditions**
it: discovers every paid route, makes a real paid call to each, AI-scores the
live response, and synthesizes the agent-callable Skill other agents will use
to call it. A passing audition lists the API automatically.

The verb is `audition`, and it is a subcommand of the OpenDexter CLI.

`audition` requests a server-side merchant test and can cause paid provider
calls and catalog changes. It does not load a local signer or spend through the
connected user's governed OpenDexter authority. Obtain explicit approval for
the audition itself.

## When this skill applies

Use it when the user's API already returns HTTP 402 with a valid payment
manifest (if it does not yet, that is the **x402-server** skill's job — build
the paywall first, then come back here).

## The one command

```bash
npx @dexterai/opendexter@1.24.0-rc.0 audition <server-url> --json
```

- Pass a **server origin** to audition every paid route on the server.
- Pass a **single endpoint URL** to audition that route (siblings are still
  discovered from it).
- Always use `--json` when you are an agent driving this — it is the
  machine-readable path. Omit it only for a human reading the summary.

No global install is needed; this command requests the exact pinned package
version.

## What discovery needs from the API

The audition finds paid routes three ways, in order of preference:

1. **OpenAPI 3.1 document at `/openapi.json`** (strongly preferred) — with
   `info.x-guidance`, a `requestBody` schema per paid operation, and an
   `x-payment-info` block carrying `protocols` (x402 and/or mpp) and a
   structured `price`.
2. **`/.well-known/x402`** — a descriptor listing the paid routes.
3. **Bare probe** — the URL returns HTTP 402 with a valid payment manifest.

If none resolve, the audition returns `discovery_failed`. The fix is almost
always: expose the OpenAPI document. Recommend that first.

## Reading the `--json` result

```
{
  "ok": true,
  "origin": "https://merchant-api.com",
  "summary": { "total": 3, "registered": 3, "failed": 0, "avgScore": 84 },
  "routes": [
    {
      "url": "https://merchant-api.com/price/eth",
      "score": 91,
      "status": "pass",
      "verdict": "<what an agent asked for and what came back>",
      "fixInstructions": null,
      "synthesizedSkill": { ... },
      "mcpTool": { ... }
    }
  ]
}
```

Per route:
- `score` (0–100) and `status` (`pass` / `fail` / `inconclusive`) — from a
  real paid call, not a metadata guess.
- `verdict` — what the test agent sent and what came back.
- `fixInstructions` — concrete steps when a route scored low; `null` on pass.
- `synthesizedSkill` + `mcpTool` — the agent-callable definition built from
  the live endpoint.

## The loop

1. Run `audition`.
2. For every route where `status` is not `pass`, apply `fixInstructions` to
   the API — the OpenAPI document, the endpoint behaviour, or the price.
3. Re-run `audition`. Repeat until every route passes.
4. A passing audition lists the API automatically.

The audition spends real USDC per run, so it is rate-limited per origin. A
re-run that returns HTTP 429 `cooldown_active` carries a `cooldownUntil`
timestamp — wait for it and retry.

## After it is listed

The synthesized Skill is served at, substituting the host:

- `https://x402gle.com/servers/{host}` — public host page
- `https://x402gle.com/servers/{host}/SKILL.md` — Anthropic SKILL.md format
- `https://x402gle.com/servers/{host}/skills.json` — flat skill index
- `https://x402gle.com/servers/{host}/.well-known/agent.json` — A2A card

A host that is already indexed also has a pre-filled audition prompt on its
own `x402gle.com/servers/{host}` page.

## Reference

- Agent-readable onboarding doc: https://x402gle.com/agent.md
- Human-facing version: https://x402gle.com/agent
- This is not a schema linter — it pays the API and grades the real response.
