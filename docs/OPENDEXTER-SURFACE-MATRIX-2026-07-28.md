# OpenDexter surface matrix

Snapshot date: 2026-07-28 UTC.

This records current live/public state separately from the local npm
publication candidate. Matching operation names do not imply matching wallet
custody.

## Heads and distribution state

| Surface | Source or release identity | Distribution state |
|---|---|---|
| Hosted MCP runtime | `dexter-mcp` source `ebaac45` | Running at `https://open.dexter.cash/mcp`; PM2 restarted and probed |
| Public plugin repository | `opendexter-ide` `b607865` | Public `main`; tag `opendexter--v2.0.0` |
| Codex hosted plugin | `opendexter@dexter` `0.4.0` | Fresh public install proved |
| Claude hosted plugin | `opendexter@opendexter` `2.0.0` | Fresh public install proved |
| Local npm package currently in registry | `@dexterai/opendexter@1.21.0` | Published legacy version; not the six-tool candidate |
| Local npm convergence candidate | `@dexterai/opendexter@1.23.0-rc.1` | Source/pack candidate only; do not call published |

The hosted source checkout is ahead of its Git remote. The running process and
live protocol probe, not the stale remote head, establish current hosted
runtime state.

## Model-facing operation contract

Both current hosted product guidance and the local candidate use exactly:

| Tool | Hosted authority | Local candidate authority |
|---|---|---|
| `x402_search` | Public hosted catalog | Public hosted catalog |
| `x402_check` | Hosted request and session capabilities | Request plus actual local signer/Tab capabilities |
| `x402_fetch` | Authenticated Dexter Wallet policy and protected hosted execution | Local file/environment signer and local attempt ledger |
| `x402_access` | Hosted wallet-proof adapter | Local file/environment signer |
| `x402_wallet` | Authenticated Dexter Wallet session | Local file/environment payment signer |
| `dexter_portfolio` | Same authenticated Dexter Wallet session | Separate read-only hosted account linked by `opendexter connect` |

`dexter_portfolio` accepts no caller-selected wallet, user, agent, grant, or
authority on either surface.

The local linked portfolio does not replace the local signer. Portfolio value
is not local spendable cash, and a linked portfolio response is not permission
to pay from the Dexter Wallet.

## Compatibility and non-tool controls

| Name or control | Hosted live | Local candidate | Product guidance |
|---|---|---|---|
| historical payment alias | Raw app-only compatibility endpoint | Not registered as an MCP tool | Never suggested |
| compose/promote compatibility | Raw app-only compatibility endpoints | Not present | Never suggested |
| passkey status/probe compatibility | Raw app-only compatibility endpoints | Not present | Native host connection only |
| local spending settings | Not an MCP tool | `opendexter settings` CLI | Explicit human terminal action |
| CLI payment alias | Not applicable | Historical CLI compatibility on the same `cliFetch` implementation | Not a model tool or primary command |

Hosted `tools/list` currently contains eleven raw registrations: six
model-facing tools and five app-only compatibility endpoints. Local candidate
`tools/list` must contain exactly six registrations.

### Hosted raw-compatibility retirement

The five raw app-only registrations are a dated migration surface, not a
second product roster:

1. Move every current app binding and widget bridge from the historical
   payment alias to `x402_fetch`, then prove ChatGPT, Claude, and Codex against
   the canonical name.
2. Replace the compose/promote and passkey probe/setup MCP registrations with
   their purpose-built app or native-host flows wherever those flows are still
   needed.
3. Confirm the compatibility registrations have no remaining production
   caller during the bounded migration window.
4. Delete the five registrations together, rerun the hosted contract and live
   client proofs, and reduce raw hosted `tools/list` from eleven to six.

Until that migration is proved, the five remain app-only, absent from model
visibility, and absent from every active first-party product instruction,
skill, README, rule, and command. The shared SDK compatibility README may name
the opt-out alias for registrar consumers. The local candidate does not ship
the compatibility registrations at all.

## Skills and runtime packaging

| Surface | Runtime | Skills and packaged guidance |
|---|---|---|
| Codex hosted plugin | Remote HTTP MCP | `opendexter`, `x402-debugging`, `x402-protocol` |
| Claude hosted plugin | Remote HTTP MCP | `opendexter`, `x402-debugging`, `x402-protocol` |
| Local npm candidate | Node 20+ stdio MCP plus CLI | Skills: `instinct-advertiser`, `opendexter`, `x402-client`, `x402-debugging`, `x402-discoverable`, `x402-protocol`, `x402-react`, `x402-server`; rules: `x402-coding`, `x402-protocol`; agent: `x402-engineer`; commands: `setup-opendexter`, `setup-x402-client`, `setup-x402-server` |

All local model-facing workflow, agent, rule, command, README, and served
resource guidance must name only the canonical six operations. Developer SDK
guidance may describe SDK APIs; it may not resurrect retired MCP routes.

## Local publication train

The candidate must be published and verified in this order:

1. `@dexterai/mcp-instructions@2.4.0`
2. `@dexterai/x402-mcp-tools@0.8.0`
3. `@dexterai/opendexter@1.23.0-rc.1`

The local package pins the first two exact versions. Publishing the local
package against current registry versions `2.3.0` and `0.7.1` would be unsafe:
the old tool package would restore the payment alias and the old instructions
could make startup fail the roster-parity guard.

Publication, real client installation, OAuth linking, signing, payment, and
wallet mutation remain separate captain gates.
