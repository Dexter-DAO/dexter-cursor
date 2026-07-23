---
name: opendexter-passkey-wallet
description: "Check, set up, or resume the user's Dexter passkey wallet — a non-custodial Solana wallet secured by their own passkey (Face ID / Touch ID / security key). Trigger on: check my OpenDexter passkey; do I (already) have a Dexter wallet; set up my Dexter/passkey wallet; what is my Dexter wallet address; my USDC balance; where do I deposit; link my wallet to this chat; and whenever another OpenDexter tool returns vault_required or not_enrolled. Uses dexter_passkey for enrollment/status/setup and x402_wallet for address + balance reads. Never selects dexter_passkey_probe, and never claims to reveal passkey credential material."
---

# OpenDexter passkey wallet

The Dexter wallet is non-custodial: a Solana vault controlled solely by the user's passkey.
Dexter holds no keys and cannot spend, recover, or inspect the wallet. Your job here is
routing reads and walking the user through a ~20-second browser ceremony when setup is
needed — never anything more.

## Two tools, split by intent

| The user wants | Tool | Why |
|---|---|---|
| To know whether a wallet exists; to set one up; to resume setup; to link the wallet to this chat session | `dexter_passkey` | Returns `vault_status` (`not_enrolled` / `provisioning` / `ready`), addresses when ready, and a setup/pairing link when needed |
| The wallet address, the USDC balance, a deposit target | `x402_wallet` | Direct read: Solana address + USDC balance when a wallet is bound; a one-time setup link when not |

Both are read-only and free. When in doubt between them: existence/setup questions →
`dexter_passkey`; number/address questions → `x402_wallet`.

**Never** call `dexter_passkey_probe` for any of this. It is an engineering diagnostic
(WebAuthn iframe capability test) that answers no user question. The only legitimate trigger
is a user explicitly naming the probe.

## Handling each `dexter_passkey` state

**`ready`** — report the wallet address (`vault_address`) with its Solscan link
(`https://solscan.io/account/<address>`). If the user wanted balance too, follow with
`x402_wallet`.

**`not_enrolled`** — no wallet exists yet. The result carries `enroll_url` / `pairing_url`.
Tell the user, in substance: setting up takes about 20 seconds — open this link, a
dexter.cash page opens in a new tab, approve with your face or fingerprint, and the wallet is
created and linked to this chat. Only they can ever spend from it, because the key lives on
their passkey. Then poll `dexter_passkey` for progress (the widget polls on its own too).
The link is time-limited (`pairing_ttl_seconds`); if it lapses, one fresh `dexter_passkey`
call mints a new one.

**`provisioning`** — passkey created, wallet finishing setup. Say it's almost done; poll. If
it stalls and a resume link is present, offer it.

**`awaiting_ceremony: true`** — the user is mid-ceremony on the dexter.cash page right now.
Wait and poll. Do not send another link; duplicate links are what used to wedge this flow.

**`error`** — the wallet backend could not be read. This is a service problem, **not** a
missing wallet. Never translate an `error` state (or any app-connection failure) into "you
have no passkey." Report a temporary problem and retry once later.

## Not activated yet: a wallet can exist and still need one tap

`x402_wallet` (and pay calls) can return `mode: "vault_not_activated"` with
`vault_status: "initialized_not_active"`. The wallet exists but its first-use activation
hasn't happened. Send the user to the result's `activate_url` (https://dexter.cash/wallet) —
activation is one passkey tap with the passkey they already set up, and needs no new funds.
**Never give out a deposit address while the wallet is unactivated** — there isn't a valid
one yet, and funds sent early can strand. If the result shows a balance already waiting,
say so and lead with the activation step.

## The ceremony always pops out

WebAuthn cannot run inside the chat's embedded widget — by platform design. The passkey
ceremony always happens top-level on dexter.cash in its own tab. So the correct mental model
to give the user: "a Dexter page will open; approve there; come back here." After they
return, `dexter_passkey` (polled) confirms the result. Never tell the user to expect a
biometric prompt inside the chat itself.

Note that `dexter_passkey` is also an app-level authenticated call: on a session that has
never connected, the platform may show its own connect affordance before the tool runs. That
is app/connector auth (state 1), not wallet state — see the umbrella skill's
`references/authentication.md`. Complete it, retry once.

## What a "passkey check" can and cannot say

Can: whether a wallet exists, its setup progress, its public Solana address, its USDC
balance (via `x402_wallet`), whether this chat session is linked to it.

Cannot, ever: the passkey credential itself, private keys, seeds, or any secret material.
There is no tool that reveals these and no circumstance to claim otherwise. If a user asks to
"see" their passkey, explain that the credential lives in their device's authenticator and
only its public wallet is visible here.

## After the wallet is ready

If the wallet was set up as a detour from a payment (`vault_required` had a `retry`
envelope), resume that exact call now — same tool, URL, and body — without making the user
re-state the task. If the balance is zero and the user intends to pay for things, surface
the deposit address (`x402_wallet`) and note the wallet needs USDC on Solana before it can
pay.
