# OpenDexter authentication: the three states

OpenDexter has three independent auth layers. Each has its own symptom, its own fix, and its
own retry path. **Diagnose which layer you are in before saying anything to the user** —
misattributing one layer's failure to another is the product's worst historical failure mode.

```
State 1: app/connector auth      "Is this chat host connected to the OpenDexter app at all,
                                  with credentials the server accepts?"
State 2: MCP session binding     "Is THIS session durably linked to a specific wallet?"
State 3: passkey enrollment      "Does the user have a passkey wallet in the first place?"
```

A failure in state 1 or 2 says NOTHING about state 3. A user can have a perfectly good wallet
and still hit a connection error. Only `dexter_passkey`'s `vault_status` field speaks to
whether a wallet exists.

## State 1 — App/connector authentication

**What it is:** the host platform's connection to the OpenDexter MCP app. Browse-class tools
(`x402_search`, `x402_check`, listing) work anonymously; **spend-class tools** (`x402_pay`,
`x402_fetch`, `dexter_passkey`) are challenged at the app level when the session has no
accepted credential and no existing binding. The call is blocked *before the tool runs*.

**Symptom:** the tool call fails with "authentication required" (the platform may render its
own Connect/sign-in card or link for the OpenDexter app), or the platform reports the app as
needing reconnection. No tool result is produced at all.

**Fix:** the user completes the host's connect flow for OpenDexter. That flow lands on a
dexter.cash authorization page that asks for their passkey (Face ID / Touch ID). Tell the
user: "Approve with your passkey on the dexter.cash page that opens." If they have no passkey
wallet yet, don't rely on the connect flow to create one — route them through
`dexter_passkey`'s setup link instead (state 3).

**Retry path:** after the user says they finished, retry the *same* tool call exactly once.
Success → continue the original task. Blocked again → STOP. Report: "The OpenDexter app still
isn't authorized on this chat session" and suggest reconnecting the app from the platform's
app/connector settings. **Never call the tool a third time on stale credentials, and never
alternate between two failing calls.** There is no loop in which repetition helps.

**Forbidden:** describing this state as "you don't have a passkey/wallet". You have zero
evidence about enrollment here — the tool never ran.

## State 2 — MCP session binding

**What it is:** a durable server-side link between this MCP session and a specific wallet.
Binding is what lets the wallet pay without re-auth on every call. It is created when the
user completes a pairing link (or the state-1 connect flow).

**Symptom:** tools RUN but return an instruction payload instead of results:

- `x402_fetch`/`x402_pay`/`x402_wallet` return `mode: "vault_required"` with
  `next_action: "call_dexter_passkey"`, an `enroll_url`/`pairing_url`, and a `retry` object
  preserving your exact original call.
- `dexter_passkey` returns `vault_status: "not_enrolled"` with a `pairing_url`
  (time-limited: `pairing_ttl_seconds`) — or `user_bound: false`.

**Fix:** relay the `enroll_url`/`pairing_url` to the user with the message the payload
provides (it is written to be relayed verbatim). The user opens it, approves with their
passkey, and the page binds the wallet to this session server-side.

**Retry path:** poll `dexter_passkey` to watch for `vault_status: "ready"` (the widget also
polls automatically). Once ready, re-run the original call **from the `retry` envelope** —
same tool, same URL, same body — so nothing about the intended purchase is lost. If the
pairing TTL expires before the user finishes, calling `dexter_passkey` again mints a fresh
link; do this at most once without asking, then hand control back to the user.

**Nuance:** an `awaiting_ceremony: true` flag means a pairing already exists and the user is
mid-ceremony — do NOT treat it as "not started" and do not push a second link; just wait and
poll.

## State 3 — Passkey/WebAuthn enrollment

**What it is:** whether the user has ever created their passkey wallet. Enrollment is a
WebAuthn ceremony that **always runs top-level on dexter.cash in a separate tab/popout** —
the chat's embedded widget cannot run WebAuthn, by platform design. The widget's button opens
the page; the ceremony happens there; the widget and `dexter_passkey` poll until done.

**States:** `not_enrolled` (no passkey, no wallet) → `provisioning` (passkey created, wallet
still being set up — show "almost done", offer the resume link if present) → `ready` (wallet
live: report the address and Solscan link). `error` means the backend could not be read —
that is a state-1/infrastructure problem, NOT a missing wallet.

**Activation nuance:** after enrollment, `x402_wallet` or a pay call can still return
`mode: "vault_not_activated"` (`vault_status: "initialized_not_active"`). The wallet exists
but needs one first-use activation tap: send the user to the `activate_url`
(https://dexter.cash/wallet) — one passkey tap, no new funds needed. **Never give out a
deposit address while the wallet is unactivated** — there isn't a valid one yet.

**What to tell the user at `not_enrolled`:** setup takes about 20 seconds — open the link, a
dexter.cash page opens, approve with face/fingerprint, done; only they can ever spend from
the wallet because the key lives on their passkey. Never promise to "create the wallet for
them" — you cannot; the ceremony is theirs.

**Retry path:** poll `dexter_passkey`; on `ready`, resume whatever the user originally wanted.

## The global no-loop rule

Across all three states: one user-completed auth step earns exactly one retry of the blocked
call. Two consecutive failures of the same call in the same state means the state is not what
you think it is — stop, report precisely what happened (which tool, which state, which
response), and give the user one concrete manual action. Never burn a third call, and never
silently switch to a different auth flow hoping it works.
