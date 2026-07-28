# @dexterai/mcp-instructions

Capability-aware operating instructions for OpenDexter's hosted connector and
local npm/stdio server.

This package exists to eliminate drift between the two MCP server
implementations in the Dexter stack:

1. **Hosted remote server** at `open.dexter.cash/mcp`
   (source: `~/websites/dexter-mcp/open-mcp-server.mjs`)
2. **Local npm-installable server** `@dexterai/opendexter`
   (source: `~/websites/opendexter-ide/packages/mcp/src/server/index.ts`)

Both servers build their `initialize` response from this package. Their
model-facing vocabulary is the same six tools, while the wallet authority is
deliberately different: hosted operations use the authenticated Dexter Wallet
session; local wallet-proof and payment operations use the file or environment
signer, and only the local portfolio read uses the separately linked hosted
account. A parity guard refuses to serve instructions that name an
unregistered tool.

The instructions string is written as a **prescriptive operating
procedure**: explicit intent-to-tool routing, native hosted OAuth and
wallet-readiness boundaries, exact prepared-purchase handling, mode-specific
receipts, failure recipes, and post-dispatch retry safety. It is deliberately
not a generic feature list.

## Usage

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  buildServerInstructions,
  LOCAL_CAPS,
} from '@dexterai/mcp-instructions';

const server = new McpServer(
  { name: 'OpenDexter', version: VERSION },
  { instructions: buildServerInstructions(LOCAL_CAPS) },
);
```

Hosted OpenDexter uses `HOSTED_CAPS`. Both shipped renderings name exactly:

```text
x402_search  x402_fetch  x402_check
x402_access  x402_wallet  dexter_portfolio
```

The hosted runtime may retain additional raw app-only compatibility endpoints
during a dated migration, but this package never routes a model to them. Local
spending policy remains an explicit `opendexter settings` CLI action rather
than an MCP tool.

## Updating the instructions

1. Edit `src/index.ts`.
2. Update the focused rendering and roster-parity tests.
3. Bump the version in `package.json`.
4. Validate each consumer against the candidate package before any publish or
   deployment decision.

## Why a whole package instead of a constant in one of the MCPs?

The hosted server is a single `.mjs` file deployed separately from the
npm package repo. Without a published package, the constant would have
to be hand-copied between repos on every change — exactly the drift the
Apr 16 unification sprint tried to fix.

## License

MIT
