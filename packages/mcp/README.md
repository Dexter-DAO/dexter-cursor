<p align="center">
  <img src="./assets/dexter-wordmark.svg" alt="Dexter" width="360">
</p>

<h1 align="center">@dexterai/opendexter</h1>

<p align="center">
  <strong>Your agent can find an API, see what it costs, and call it through governed authority.</strong><br>
  The local CLI and MCP proxy for OpenDexter's hosted x402 runtime.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@dexterai/opendexter"><img src="https://img.shields.io/npm/v/@dexterai/opendexter.svg" alt="npm version"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D22-339933" alt="Node 22 or newer"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-111111" alt="MIT license"></a>
</p>

This package runs locally, but x402 authority and account-bound execution do
not. The local process proxies the canonical hosted runtime at
`https://open.dexter.cash/mcp` and never derives or enables a local private key
as an OpenDexter payer.

It provides:

- anonymous hosted capability search and price/requirements checks;
- a connected OAuth path for wallet and portfolio reads, exact governed
  purchase intents, and intent-status recovery;
- a separate anonymous, fresh one-call legacy SIWX wallet-proof path with no
  OAuth/governed-authority binding or cross-call continuity;
- truthful live bounded-authority status from Dexter's bearer-authenticated
  authority endpoint;
- an explicitly labeled, read-only recovery view for public addresses and
  balances in an existing legacy wallet file.

There is no automatic or opt-in local payment fallback. A disconnected or
incomplete hosted authority fails closed.

## Start

This guide belongs to `@dexterai/opendexter@1.24.0-rc.0`. Its executable examples
are pinned to those exact package bytes.

Install the local MCP into detected clients:

```bash
npx @dexterai/opendexter@1.24.0-rc.0 setup
```

Setup checks existing registrations before editing a client. It does not
create, migrate, repair, or fund a wallet. After installation, connect the
local proxy to the hosted governed runtime:

```bash
npx @dexterai/opendexter@1.24.0-rc.0 connect
npx @dexterai/opendexter@1.24.0-rc.0 connect status
```

The device flow stores an OAuth bearer locally. Account-bound tools send that
bearer only to `https://open.dexter.cash/mcp`. The connector requests exact
OAuth scope `vault`; Dexter's signed top-level dexter_surface token claim is
separate authority evidence, not a requested scope. Connection alone is not proof of spend authority:
`connect status` reads `GET /api/connector/oauth/authority`, and authority stays
unavailable unless the exact live grant, principal, limits, remaining capacity,
expiry, scopes, active role, and revocation evidence is complete.

For side-effect-free installation diagnosis:

```bash
npx @dexterai/opendexter@1.24.0-rc.0 doctor --client codex
```

Doctor does not create a wallet, read a private key, check a balance, edit
configuration, or pay.

## Install into an AI client

Target one supported client:

```bash
npx @dexterai/opendexter@1.24.0-rc.0 install --client cursor
```

Valid client names are `cursor`, `claude-code`, `codex`, `vscode`, `windsurf`,
and `gemini-cli`. Use `--all` to process every supported client detected on the
machine.

For Claude Code:

```bash
claude mcp add --scope user opendexter -- npx -y @dexterai/opendexter@1.24.0-rc.0
```

JSON-based clients can use:

```json
{
  "mcpServers": {
    "opendexter": {
      "command": "npx",
      "args": ["-y", "@dexterai/opendexter@1.24.0-rc.0"]
    }
  }
}
```

Codex uses TOML:

```toml
[mcp_servers.opendexter]
command = "npx"
args = ["-y", "@dexterai/opendexter@1.24.0-rc.0"]
```

Keep one OpenDexter registration in a client. An alias does not make two
registrations safe unless that client has proven tool namespacing and isolated
authentication state.

## Seven MCP tools

| Tool | Purpose | Connection |
|---|---|---|
| `x402_search` | Search the canonical hosted catalog by job | Optional |
| `x402_check` | Read exact current terms; when connected, receive one opaque server-owned intent | Optional |
| `x402_fetch` | Execute exactly one server-owned intent under governed authority | Required |
| `x402_status` | Read the same intent after an uncertain or completed fetch; never dispatch payment | Required |
| `x402_access` | Use one fresh anonymous legacy SIWX wallet-proof context, separate from governed authority and without cross-call continuity | No |
| `x402_wallet` | Read the hosted wallet and exact runtime-authority evidence | Required |
| `dexter_portfolio` | Read the governed portfolio bound to the connected principal | Required |

The server's `tools/list` result is the runtime authority. There are no card,
settings, payment-alias, or local-executor MCP tools in this package.

## Exact payment path

Discovery, inspection, approval, execution, and recovery are separate steps:

1. Use `x402_search` for the user's actual job. A catalog result and advertised
   price are not payment authorization.
2. While connected, use `x402_check` for the exact URL, method, and body. A paid
   result returns one opaque `intentId` owned by the hosted server.
3. Show the exact current terms and obtain approval for a separate atomic-unit
   ceiling.
4. Call `x402_fetch` exactly once with only `intentId` and
   `maxAmountAtomic`.
5. If the result is uncertain, use `x402_status` with the same `intentId`.
   Never repeat the fetch merely because a timeout, transport error, or bearer
   rejection hid its outcome.

The intent binds the URL, body, seller, route, asset, and amount on the server.
The client must not parse, reconstruct, replace, or widen it. The ceiling does
not authorize a different action.

CLI example:

```bash
npx @dexterai/opendexter@1.24.0-rc.0 check \
  "https://service.example/x402/route" \
  --method POST \
  --body '{"document_url":"https://example.com/report.pdf"}'

npx @dexterai/opendexter@1.24.0-rc.0 fetch \
  --intent-id "<opaque-intent-id-from-the-connected-check>" \
  --max-amount-atomic "<user-approved-ceiling>"

npx @dexterai/opendexter@1.24.0-rc.0 status \
  --intent-id "<same-opaque-intent-id>"
```

Inspect the returned terms and ceiling before the fetch. The final command can
move real USDC through hosted governed authority. The CLI also accepts `pay` as
an alias of this same intent-only fetch; it is not a second executor.

When a CLI fetch is ambiguous, its output preserves the exact `intentId`, marks
the action `noRetry`, and prints the pinned `status --intent-id` recovery
command. Run that read-only status command; never repeat the fetch merely
because its outcome was hidden.

## Search, check, and access

`x402_search` takes a natural-language job. Search results can include match
evidence, quality and verification state, advertised prices, supported
networks, and structured input/output evidence. A degraded ranking is a live
fallback, not an empty catalog and not proof that the first result is best.

`x402_check` probes the exact URL without making an x402 payment. A non-GET
probe can still mutate provider state, so obtain separate approval for that
exact probe; probe approval is not payment approval. After dispatch, a non-GET
probe is never auth-refreshed and retried automatically. Anonymous checks can
inspect terms; only a connected check can prepare an account-bound intent for
execution.

`x402_access` is a separate anonymous legacy wallet-proof surface for an
SIWX-protected resource. Every call starts one fresh hosted context. It is not
Dexter OAuth, not the connected governed payment wallet, and does not preserve
continuity across calls; the proxy accepts and persists no access-session
credentials. A non-GET access request needs separate approval for that exact
one-call request and is never automatically retried after possible dispatch.

## Wallet and authority truth

Use the connected wallet view by default:

```bash
npx @dexterai/opendexter@1.24.0-rc.0 wallet
```

The result includes hosted wallet data and `runtimeAuthority`. A bearer, wallet
address, balance, or portfolio does not by itself prove an active grant. Missing
or incomplete evidence is reported as unavailable, never inferred.

An existing legacy wallet file can be inspected only through this explicit
non-payment recovery command:

```bash
npx @dexterai/opendexter@1.24.0-rc.0 wallet --legacy-recovery
```

That view parses the existing JSON file, validates its public addresses, and
returns only those addresses and balance reads. It never derives, returns,
exports, or enables private-key fields as a signer. It cannot execute
`x402_fetch`, `x402_access`, or any other payment or proof action.

Legacy local settings data, if present, has no effect on the hosted runtime. Manage
the real grant, limits, and revocation at `https://dexter.cash/wallet` and
verify their live projection with `connect status`.

## CLI map

Hosted runtime commands:

```text
search <query>          Search the hosted catalog anonymously
check <url>             Inspect hosted terms; connected checks can return an intent
fetch                   Execute one connected intent with an atomic ceiling
pay                     Alias of the same connected intent execution
status                  Read the same intent after an uncertain/completed fetch
access <url>            Use one fresh anonymous legacy wallet-proof context
wallet                  Read hosted wallet and authority status
connect                 Connect, inspect status, or disconnect OAuth
```

Installation and separate maintenance commands:

```text
setup                   Install clients and show the hosted connection path
install                 Configure one or more AI clients
doctor                  Read-only installation and authority-path diagnosis
wallet --legacy-recovery
                        Read only safe public legacy wallet data
settings                Inspect/update a legacy local record; no hosted effect
audition <url>          Request the server-side merchant audition workflow
dextercard              Manage a separate local card account session
```

`audition` can trigger provider calls and catalog changes on the server. It
does not use a local signer or the connected user's governed x402 authority;
obtain explicit approval before invoking it.

## Building an independent x402 client or server

The package also ships developer guidance for `@dexterai/x402`. That SDK can
be used to build a separate application-owned signer or wallet-adapter client.
It is not the OpenDexter MCP executor, does not inherit an OpenDexter connection
or grant, and must never be used as a hidden fallback when an OpenDexter
account-bound tool is disconnected or unavailable.

## Release verification

The repository has one release workflow and one approval boundary. Pushing an
exact `opendexter-v<package.version>` tag on `main` starts
`.github/workflows/publish-opendexter.yml`. Its build job verifies the pinned
public hosted contract, tests, typechecks, builds, and packs once from a clean
Git archive. The publish job waits for the `opendexter-npm-production`
environment approval, verifies artifact and receipt hashes, publishes through
npm trusted-publisher OIDC, and reconciles registry integrity and provenance.

The tarball gate rejects source maps, environment or credential files,
symlinks, hardlinks, special files, undeclared files, and undeclared
executables. A plain `npm publish` fails closed.

To inspect an already-produced candidate without installing it or contacting
the registry:

```bash
npm run inspect:tarball -- /absolute/path/to/dexterai-opendexter-VERSION.tgz
```

After an exact version is published, prove a new-user install from registry
bytes:

```bash
npm run test:fresh-install -- VERSION /absolute/path/to/release.json
```

## License

MIT
