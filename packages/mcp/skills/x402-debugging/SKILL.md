---
name: x402-debugging
description: "Diagnose x402 payment failures: facilitator health, PayResult failures, balance issues, settlement uncertainty, Native Tab V2 reservation errors, and protocol mismatches. Trigger when a payment fails, a 402 response is unexpected, settlement times out, or the user reports an x402 error."
---

# x402 Debugging Guide

This is generic `@dexterai/x402` SDK and protocol guidance. An SDK wallet is
independent from OpenDexter: it is not the OpenDexter MCP runtime and must
never become that runtime's local payment fallback. For OpenDexter, never add
a local signer or retry an uncertain `x402_fetch`; use the connected authority
view and query `x402_status` with the same opaque intent.

## First checks

1. Confirm Node 22 or newer.
2. Confirm the tested pair is installed together:
   `@dexterai/x402@6.0.0-rc.2` and `@dexterai/vault@0.43.2`.
3. Check facilitator health: `curl https://x402.dexter.cash/healthz`.
4. Check advertised networks: `curl https://x402.dexter.cash/supported`.
5. Inspect the merchant's original `402`, including `PAYMENT-REQUIRED` and its
   raw `accepts` entries.
6. Confirm the application uses `payAndFetch`; V6 does not export `wrapFetch`
   or `createX402Client`.
7. Confirm the application-owned wallet supports an accepted chain and holds
   enough USDC.

## Common failures

| Symptom | Meaning | Action |
|---|---|---|
| Raw 402 comes back unchanged | The application never used the V6 payment dispatcher | Call `payAndFetch()` with a compatible wallet set |
| `unsupported_network` | No supplied wallet supports the accepted network | Supply the correct Solana or EVM wallet |
| `insufficient_funds` | The application wallet cannot cover the quoted payment | Fund or switch the reviewed wallet |
| `no_payment_options` | The challenge has no option payable by this client | Do not manufacture a different scheme or destination |
| `budget_exceeded` | `maxAmountAtomic` rejected the quote | Increase only after explicit review |
| `merchant_rejected` | Merchant rejected the authorization or request | Inspect `detail` and the merchant response; do not loop |
| `settlement_failed` | Merchant-side facilitator failed after accepting the payment shape | Reconcile with the merchant/facilitator |
| `timeout` | The pre-dispatch deadline elapsed; no payment authorization was sent | Check RPC/transport health; review before retrying |
| `payment_unconfirmed` | Authorization was sent and payment may have settled | Never blind-retry; inspect chain and merchant state |
| `error` | Unexpected parsing, wallet, RPC, or transport error | Use `detail` and determine whether dispatch occurred |

## Inspect `PayResult`

```typescript
import { createKeypairWallet, payAndFetch } from '@dexterai/x402/client';

const solana = await createKeypairWallet(process.env.SOLANA_PRIVATE_KEY!);
const result = await payAndFetch(
  url,
  { method: 'GET' },
  { solana },
  {
    maxAmountAtomic: '100000',
    timeoutMs: 15_000,
    responseTimeoutMs: 120_000,
    solanaRpcUrl: process.env.SOLANA_RPC_URL,
  },
);

if (!result.ok) {
  console.error({ reason: result.reason, detail: result.detail });
} else if (result.paid) {
  console.log({
    amountAtomic: result.amountPaid,
    network: result.network.caip2,
    transaction: result.txSignature,
    merchantResponded: Boolean(result.response),
  });
} else {
  console.log('endpoint returned without payment');
}
```

Do not log private keys or full signed payment payloads. There is no V6
`verbose`, `maxRetries`, or `retryDelayMs` one-shot option. Own observability
and recovery in the application.

## Two timeout phases

`timeoutMs` covers the unpaid probe and build/sign phase. A `timeout` result
means the dispatcher did not send a payment authorization.

`responseTimeoutMs` starts after dispatch. If the merchant does not answer,
the SDK attempts an on-chain confirmation. It returns a confirmed paid result
when proof is available; otherwise it returns `payment_unconfirmed`. A second
call can create a second authorization, so uncertainty must be reconciled.

## Solana one-shot checks

- V2 challenges use a CAIP-2 identifier such as
  `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`.
- V1 Solana exact offers must include `extra.feePayer`.
- The fee payer pays transaction fees only. It must not be the token transfer
  authority, source, or destination.
- Pass a reliable `solanaRpcUrl` for blockhash, token-account, and settlement
  confirmation reads.
- Verify the accepted asset, amount, and `payTo`; never rewrite them from a
  different offer.

## Native Tab V2 checks

V6 buyer tabs are a separate contract under `@dexterai/x402/tab`:

- A low-bit grant must throw `native_tab_v1_migration_required`. Settle or
  revoke it through the deployment that opened it, then explicitly approve a
  new context-bound V2 grant.
- `Tab.voucherVersion` is required. Missing or invalid values fail closed.
- `reserveFinalVoucherV2` must receive the exact signed claim and return a
  complete voucher-bound receipt at Solana `confirmed` or stronger commitment.
- The SDK then independently reads the transaction and coherent post-state at
  least at `confirmed` through its own connection. A provider receipt alone is
  not proof, and the interactive request does not wait for `finalized`.
- Once V2 issuance may have started, signing, provider, merchant-timeout, and
  merchant-402 failures are terminal for that call. Do not roll back the claim
  or fall through to exact.
- Serialize one live tab per buyer/seller pair. The V6 runtime rejects
  concurrent sign and close operations.

Useful failure prefixes include:

| Prefix | Meaning |
|---|---|
| `native_tab_v2_reservation_fence_required` | Reservation callback or independent verifier is absent |
| `native_tab_v2_reservation_receipt_invalid` | Receipt does not match the exact claim/session/economic identity |
| `native_tab_v2_solana_reservation_invalid:*` | Confirmed transaction does not prove the required Vault instruction and binding memo |
| `native_tab_v2_reservation_post_state_*` | Confirmed Vault/Session state does not prove the exact reservation |
| `native_tab_v1_migration_required` | Historical buyer grant cannot be reconstructed in V6 |
| `tab_operation_in_flight` | The application used one tab concurrently |

## Raw facilitator diagnostics

Use manual endpoints only for diagnosis; do not mutate or settle on behalf of
a user without the exact authorization and request in scope.

```bash
curl https://x402.dexter.cash/healthz
curl https://x402.dexter.cash/supported

curl -X POST https://x402.dexter.cash/verify \
  -H 'content-type: application/json' \
  -d '{"paymentPayload": {...}, "paymentRequirements": {...}}'
```

Preserve the original challenge, signed payload digest, merchant response,
transaction signature, and timestamps. A health response proves service
availability, not that a particular payment settled.
