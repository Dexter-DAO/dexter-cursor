---
name: opendexter-skill-marketplace
description: "The composed-skill marketplace on x402gle: adopt an x402 host as a reusable skill bundle (x402_compose_skill), publish it to the marketplace, and manage visibility (promote_skill: public, unlisted, archived). Trigger on: turn this API/host/endpoint into a skill; compose a skill; make me a skill from X; publish my skill; put my skill on the marketplace; make my skill public or unlisted; archive/hide my skill; claim a handle; x402gle skills. Distinct from calling an endpoint once (that is x402_fetch in the x402 skill). Publishing and every visibility change are external writes that happen only on an explicit user request, with the resulting URL and visibility reported exactly as returned."
---

# OpenDexter composed-skill marketplace

A composed skill is a reusable skill bundle generated from an x402 host: instead of paying
to call an endpoint once, the user adopts the host as an installable capability, optionally
published for others at x402gle.com. Four verbs, four escalation levels — never jump a
level without the user asking for it:

| Verb | Tool | Persists anything? |
|---|---|---|
| Call an endpoint now | `x402_fetch` (x402 skill, not this one) | No — one paid call |
| Compose a skill locally | `x402_compose_skill` (no `publish`) | No — bundle returned inline only |
| Publish a composed skill | `x402_compose_skill { publish: true }` | Yes — external write to x402gle + a public GitHub monorepo |
| Change published visibility | `promote_skill` | Yes — changes who can find/install it |

## Compose vs call — the intent test

"Get me the data / call it / how much" → the x402 skill (`x402_fetch` route). "Turn this
into a skill / I keep using this / make it reusable / adopt this host" →
`x402_compose_skill`. When a user who repeatedly calls the same host might be better served
by a skill, you may *suggest* composing — but suggesting is the ceiling; never compose-and-
publish as a favor.

## Composing (safe, inline)

`x402_compose_skill` takes exactly one host slug (e.g. `"blockrun.ai"`) in `hosts`, plus an
optional `skill_name`. Without `publish`, the result is the bundle returned inline for the
user to install ad-hoc — nothing is persisted, listed, or visible to anyone. This is the
default and requires no confirmation.

## Publishing (external write)

`publish: true` persists the composition as a permanent installable skill at
`https://x402gle.com/skills/<handle>/<slug>`, committed to the public
Dexter-DAO/composed-skills GitHub monorepo and listed in the x402gle marketplace. The
`visibility` parameter at publish time accepts `"unlisted"` (default) or `"public"`;
`archived` exists only as a later `promote_skill` change.

Requirements, in order:

1. **An explicit user request to publish.** "Compose a skill" alone is not it. Confirm the
   act and the visibility before calling: "Publish this to x402gle as unlisted (link-only) —
   or public?"
2. **A claimed handle.** Publishing is identity-bound. A `no_claimed_handle` error carries a
   `claim_url` — relay it (the one-time claim page at dexter.cash/wallet/claim-handle), then
   retry once. An `auth_required_to_publish` error means no wallet is bound to the session
   at all — wallet setup comes first. The handle is resolved server-side from the session —
   never ask the user to type a handle into the tool call, and never attempt to publish
   under any other handle.
3. **Report exactly what came back:** the real URL and the real visibility from the tool
   result. Never pre-announce a URL before the tool confirms it, and never round "unlisted"
   up to "live on the marketplace".

## Visibility: `promote_skill`

Three levels, changed only by the skill's owner:

- `public` — listed on x402gle.com/skills, the public marketplace.
- `unlisted` — hidden from discovery; anyone with the direct URL can still install.
- `archived` — hidden from discovery AND direct install.

Every change is consequential: confirm the direction in plain consequences ("public means
anyone browsing x402gle can find and install it") before calling, then report the resulting
visibility exactly. Going public deserves one extra beat of clarity since it exposes the
skill to the world; archiving deserves a note that existing install links stop working.
Ownership is enforced server-side — a failure on someone else's slug is expected behavior,
not an error to retry.

## Boundaries

- This marketplace deals in Dexter's composed skills. It does not publish to ChatGPT,
  Claude, or any other platform's skill/app store, and does not modify the user's local
  agent skills.
- Composing reads public catalog data; it never spends from the wallet.
- Nothing in this skill auto-escalates: compose output that "looks great" is not a reason
  to publish, and a published skill getting traffic is not a reason to promote it public.
  The user drives every level.
