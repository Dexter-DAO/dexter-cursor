<p align="center">
  <img src="https://raw.githubusercontent.com/Dexter-DAO/dexter-x402-sdk/main/assets/dexter-wordmark.svg" alt="Dexter" width="360">
</p>

<h1 align="center">@dexterai/x402-mcp-tools</h1>

<p align="center">
  <strong>Composable MCP registrations for finding, pricing, and calling x402 services.</strong>
</p>

This is the shared registration library used by the local
[`@dexterai/opendexter`](https://www.npmjs.com/package/@dexterai/opendexter)
CLI/MCP package. It provides tool schemas and adapters; it does not provide a
wallet, durable store, or hosted account by itself.

The hosted OpenDexter connector has its own reviewed server lineage. Sharing a
wire contract does not mean the local and hosted runtimes have identical wallet
or execution capabilities.

## Install

Use Node.js 22 or newer. For this V6 release candidate, pin the coordinated
package and its exact SDK/Vault pair:

```bash
npm install @dexterai/x402-mcp-tools@0.9.0-rc.0 \
  @dexterai/x402@6.0.0-rc.0 @dexterai/vault@0.43.1
```

The RC is `next`-only; it is not a `latest` release until separate publication
and registry verification complete.

## Register the x402 tools

```ts
import {
  buildToolMetas,
  composeAllTools,
} from "@dexterai/x402-mcp-tools";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const server = new McpServer({
  name: "my-opendexter-server",
  version: "1.0.0",
});

composeAllTools(server, {
  apiBaseUrl: "https://x402.dexter.cash",
  metas: buildToolMetas(widgetUris),
  wallet,
  getTabLane,
  getPurchaseAttemptStore,
  getMaxAmountUsdc,
  getBudgetRuntime,
});
```

`composeAllTools` installs five registrar families. For backward compatibility,
the fetch registrar exposes both `x402_fetch` and its exact alias `x402_pay` by
default. New product surfaces should set `registerPayAlias: false` and expose
only the canonical fetch name:

```ts
composeAllTools(server, {
  // ...
  registerPayAlias: false,
});
```

The compatibility-default roster is:

| Tool | What it does | Can move money |
|---|---|---|
| `x402_search` | Finds services by capability | No |
| `x402_check` | Reads current terms and prepares explicit purchase choices | No payment |
| `x402_access` | Presents a wallet-control proof to SIWX services | No payment |
| `x402_fetch` | Executes one approved prepared purchase | Yes |
| `x402_pay` | Exact alias of `x402_fetch` | Yes |
| `x402_wallet` | Reads the injected wallet view | No |

There are no Dextercard MCP registrars. Card operations retained in this
package support non-tool wallet/card surfaces and legacy consumers only.

## The purchase contract

`x402_check` returns `purchaseOptions`. Each option uses one explicit mode:

- `direct_exact`
- `native_tab`
- `gateway_cash`
- `gateway_credit`

The option preserves:

- the original and resolved public HTTPS URL;
- method and request-body digest;
- the complete seller accept through `rawAcceptSha256`;
- network, asset, atomic amount, recipient, and expiry;
- route, offer, mode, and prepared identities.

Amounts and ceilings are positive decimal strings. They are never reconstructed
from display prices.

A mode is `ready` only when its concrete wallet/adapter exists and its prepared
identity has been written to the injected durable store. Missing capabilities
produce `integration_required` or `unavailable`; a caller must not silently
switch modes.

After explicit approval, pass the selected option's `preparedPurchase`
unchanged to `x402_fetch.purchase` and pass the approved atomic ceiling as
`maxAmountAtomic`. MCP consumers normally call `composeAllTools` and inject the
same durable store into check and fetch.

## Required adapters

### Wallet

`WalletAdapter` supplies verified balances and the signers that actually exist
on the current surface. Passing `null` makes money execution unavailable.

### Durable purchase store

The preparation/attempt store must:

1. persist a prepared identity before check reports it as ready;
2. atomically claim that same identity before execution;
3. mark dispatching before sending a proof or voucher;
4. preserve terminal and reconciliation receipts;
5. reject caller-synthesized or mismatched identities.

There is intentionally no in-memory fallback for explicit purchases.

### Native Tab

`getTabLane` supplies the local Native Tab executor. If it is absent,
`native_tab` is not ready. Native Tab never falls through to Direct Exact after
selection or consequential dispatch.

V6 grant tabs require a context-bound high-bit grant and a
`reserveFinalVoucherV2` provider. Server consumers can construct that provider
with `createManagedFinalVoucherV2Reservation`, using the facilitator's internal
actuator credential only on the server. The helper obtains the provider
receipt; `tabFromGrant` then validates it and independently reads the finalized
Solana transaction and coherent post-state before releasing the signed claim.
A provider receipt by itself is not proof.

Historical low-bit grants require explicit owner reapproval. V2 reservation,
signing, response-loss, and seller-refusal outcomes are terminal for the call:
preserve the exact claim and reconcile it instead of rolling back or selecting
another payment rail.

## Receipts and retries

Receipts keep four different facts separate:

- Direct Exact seller settlement;
- Native Tab voucher acceptance and seller cash settlement;
- Gateway cash commitment and seller settlement;
- Gateway credit exposure, buyer obligation, and seller settlement.

An unknown or post-dispatch outcome is reconciliation-only. Do not
automatically send the request again. A new prepared identity is not permission
to duplicate an uncertain prior attempt.

See [PURCHASE-CONTRACT.md](./PURCHASE-CONTRACT.md) for the typed integration
contract.

## Widget metadata

`buildToolMetas` creates the dual metadata used by MCP Apps hosts and ChatGPT
Apps SDK hosts. Each consumer supplies its own content-hashed `ui://` resource
URIs.

## Package boundary

This package contains registrars and contracts. It does not:

- create or migrate wallets;
- choose a user's funding mode;
- implement Gateway/CrossPay;
- provide the hosted OpenDexter OAuth connector;
- deploy, publish, or mutate a running MCP server.

## Links

- [OpenDexter local package](https://www.npmjs.com/package/@dexterai/opendexter)
- [Dexter](https://dexter.cash)
- [x402](https://x402.org)

## License

MIT
