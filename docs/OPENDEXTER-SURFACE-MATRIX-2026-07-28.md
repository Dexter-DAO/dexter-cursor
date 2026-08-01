# OpenDexter surface matrix

Snapshot date: 2026-07-28 UTC.

This records the exact hosted release contract, current registry state, and
local npm publication candidate separately. Matching operation names do not
imply matching wallet custody.

## Heads and distribution state

| Surface | Source or release identity | Distribution state |
|---|---|---|
| Hosted MCP | Final successor still moving | Must materialize a complete source-owned descriptor before this repository pins its exact commit/tree; deployment and live raw-wire proof remain separate |
| Public plugin repository | `opendexter-ide` `b607865` | Public `main`; tag `opendexter--v2.0.0` |
| Codex hosted plugin | `opendexter@dexter` `0.4.0` | Fresh public install proved |
| Claude hosted plugin | `opendexter@opendexter` `2.0.0` | Fresh public install proved |
| Stable local npm package | `@dexterai/opendexter@1.21.0` | Published on `latest` |
| Existing immutable local prerelease | `@dexterai/opendexter@1.23.0-rc.2` | Published bytes exist and cannot be replaced by the different local candidate |
| Local release-control successor | `@dexterai/opendexter@1.23.0-rc.3` | Source candidate; unpublished until exact attested pack and registry proof |

The hosted candidate source is not deployment proof. Its final commit must
first commit `release/open-tool-descriptors.json` with full titles,
descriptions, input schemas, output schemas, auth, annotations, visibility, and
widget access. This repository then pins that exact commit/tree; it does not
pin whichever moving checkout happened to be present during this edit.

## Model-facing operation contract

The six names shared by hosted and local are:

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

Hosted adds `x402_status`, `dexter_prepare_asset_action`,
`dexter_execute_asset_action`, `dexter_asset_action_status`,
`dexter_reconcile_asset_action`, and `dexter_wallet_history`. Five tools are
visible anonymously; OAuth promotes seven, producing twelve connected tools.
The local package remains exactly six.

The local linked portfolio does not replace the local signer. Portfolio value
is not local spendable cash, and a linked portfolio response is not permission
to pay from the Dexter Wallet.

## Compatibility and non-tool controls

| Name or control | Hosted 5 anonymous / 12 connected | Local six | Product guidance |
|---|---|---|---|
| historical payment alias | Not registered | Not registered as an MCP tool | Never suggested |
| compose/promote compatibility | Not registered | Not present | Never suggested |
| passkey status/probe compatibility | Not registered | Not present | Native host connection only |
| local spending settings | Not an MCP tool | `opendexter settings` CLI | Explicit human terminal action |
| CLI payment alias | Not applicable | Historical CLI compatibility on the same `cliFetch` implementation | Not a model tool or primary command |

The local candidate contains exactly six raw MCP registrations. Hosted has
five anonymous entry tools and twelve after OAuth. The hosted post-deploy
raw-wire check remains a release proof; this source fixture does not claim that
a process was restarted.

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
3. `@dexterai/opendexter@1.23.0-rc.3`

The first two exact versions are already published and the local package pins
them. RC.3 changes only `@dexterai/opendexter`; neither shared dependency is
republished. RC.3 still requires the exact lock, tarball attestation, explicit
prerelease tag, and registry-integrity proof.

Publication, real client installation, OAuth linking, signing, payment, and
wallet mutation remain separate captain gates.
