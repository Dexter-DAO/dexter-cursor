---
name: x402-client
description: "Integrate one-shot x402 payments into a Node.js or browser application with @dexterai/x402/client. Trigger when the user wants to call a paid API, use payAndFetch, create application-owned wallets, set spending limits, inspect receipts, or handle sponsored recommendations."
---

# @dexterai/x402 Client SDK

Use the V6 one-shot client to probe an endpoint once, detect its x402 version,
sign an accepted USDC payment, and send the paid request.

This is an independent application-owned executor. It is not the OpenDexter
MCP runtime, does not inherit an OpenDexter OAuth bearer or governed grant, and
must never become a fallback for a blocked OpenDexter operation. Keep private
keys out of prompts, logs, tool output, and source control.

## Install the tested V6 pair

Use Node 22 or newer and install the exact Vault peer with the SDK:

```bash
npm install @dexterai/x402@6.0.0-rc.2 @dexterai/vault@0.43.2
```

## Canonical one-shot payment

```typescript
import {
  createEvmKeypairWallet,
  createKeypairWallet,
  payAndFetch,
} from '@dexterai/x402/client';

const wallets = {
  solana: await createKeypairWallet(process.env.SOLANA_PRIVATE_KEY!),
  evm: await createEvmKeypairWallet(process.env.EVM_PRIVATE_KEY!),
};

const result = await payAndFetch(
  'https://api.example.com/paid/data',
  { method: 'GET' },
  wallets,
  {
    maxAmountAtomic: '100000', // at most $0.10 USDC for this call
    solanaRpcUrl: process.env.SOLANA_RPC_URL,
  },
);

if (!result.ok) {
  if (result.reason === 'payment_unconfirmed') {
    throw new Error(`Payment may have settled; reconcile before retrying: ${result.detail}`);
  }
  throw new Error(`Payment failed before delivery: ${result.reason}: ${result.detail ?? ''}`);
}

if (!result.response) {
  // paid:true with no response means settlement was confirmed but the
  // merchant did not answer. Never turn this into an automatic second pay.
  throw new Error('Payment settled, but the merchant returned no response');
}

const data = await result.response.json();
console.log(data);
```

`payAndFetch` handles x402 V1 and V2. It returns a discriminated `PayResult`
instead of throwing for expected payment failures:

- `ok: true, paid: false`: the endpoint returned without requiring payment.
- `ok: true, paid: true`: payment settled; `response` can still be absent if
  the merchant never answered after settlement.
- `ok: false, reason: 'timeout'`: no authorization was sent; a retry can be
  safe after reviewing the request.
- `ok: false, reason: 'payment_unconfirmed'`: authorization was sent and may
  have settled. Do not blindly retry.

### `PayAndFetchOptions`

| Option | Meaning |
|---|---|
| `maxAmountAtomic` | Maximum atomic USDC allowed for this call |
| `timeoutMs` | Deadline before payment dispatch; timeout here means no payment was sent |
| `responseTimeoutMs` | Deadline after dispatch; uncertainty here must be reconciled, not retried |
| `solanaRpcUrl` | RPC used to build or confirm a Solana one-shot payment |
| `tab` | Existing compatible `Tab`; only use one created through the V6 reservation contract |

There is no `preferredNetwork` option. The SDK selects a payable option from
the merchant challenge and the wallets you supply.

## Application-owned fetch helper

If the application wants fetch-like ergonomics, own the wrapper explicitly:

```typescript
import { createKeypairWallet, payAndFetch } from '@dexterai/x402/client';

const solana = await createKeypairWallet(process.env.SOLANA_PRIVATE_KEY!);

export async function x402Fetch(url: string, init: RequestInit = {}) {
  const result = await payAndFetch(url, init, { solana }, {
    maxAmountAtomic: '1000000',
    solanaRpcUrl: process.env.SOLANA_RPC_URL,
  });
  if (!result.ok) throw new Error(`${result.reason}: ${result.detail ?? ''}`);
  if (!result.response) throw new Error('payment settled without a merchant response');
  return result.response;
}
```

Do not import `wrapFetch` or `createX402Client`; both were removed. V6's
canonical one-shot entry point is `payAndFetch`.

## Browser wallets

Pass compatible Solana and EVM wallet adapters directly in the `WalletSet`.
Browser code must not read server private-key environment variables.

```typescript
const result = await payAndFetch(url, init, {
  solana: solanaWalletAdapter,
  evm: evmWalletAdapter,
}, { maxAmountAtomic: '100000' });
```

## Budget accounts

`createBudgetAccount` remains available for an independent application-owned
agent. It maintains an in-memory ledger and enforces total, per-request,
hourly, and domain limits.

```typescript
import { createBudgetAccount } from '@dexterai/x402/client';

const agent = createBudgetAccount({
  walletPrivateKey: process.env.SOLANA_PRIVATE_KEY!,
  budget: {
    total: '50.00',
    perRequest: '1.00',
    perHour: '10.00',
  },
  allowedDomains: ['api.example.com'],
});

const response = await agent.fetch('https://api.example.com/data');
console.log(agent.spent, agent.remaining, agent.ledger);
```

This local budget is not a Dexter Wallet grant and does not prove continuing
OpenDexter authority.

## Receipts and sponsored recommendations

```typescript
import {
  fireImpressionBeacon,
  getPaymentReceipt,
  getSponsoredRecommendations,
} from '@dexterai/x402/client';

const receipt = getPaymentReceipt(response);
if (receipt) console.log(receipt.transaction, receipt.network, receipt.payer);

const recommendations = getSponsoredRecommendations(response);
if (recommendations) await fireImpressionBeacon(response);
```

## Discovery

```typescript
import { capabilitySearch } from '@dexterai/x402/client';

const result = await capabilitySearch({ query: 'get ETH spot price' });
for (const api of result.strongResults) {
  console.log(`${api.name}: ${api.price} (${api.why})`);
}
```

## Native Tabs

Native Tabs live under `@dexterai/x402/tab`, not the one-shot client. V6 buyer
tabs require all of the following:

- a context-bound high-bit V2 session grant;
- `Tab.voucherVersion === 2`;
- a `reserveFinalVoucherV2` backend that returns a complete receipt at
  `confirmed` or stronger commitment;
- the SDK adapter's independent transaction and post-state check at least at
  `confirmed`, without waiting for `finalized` on the interactive path;
- serialized access to one live tab per buyer/seller pair.

Never return a boolean acknowledgement from the reservation callback, never
reconstruct a historical low-bit grant, and never fall through to another
payment rail after V2 issuance may have started.

## Current exports

| Export | Purpose |
|---|---|
| `payAndFetch` | Canonical V1/V2 one-shot payment dispatcher |
| `createKeypairWallet` | Application-owned Solana wallet |
| `createEvmKeypairWallet` | Application-owned EVM wallet |
| `buildV1PaymentHeader` | Build one V1 header without sending; for callers that own the HTTP flow |
| `createBudgetAccount` | In-memory application budget wrapper |
| `getPaymentReceipt` | Read a typed receipt from a response |
| `capabilitySearch` | Search the x402 marketplace |
| `getSponsoredRecommendations` | Read sponsored recommendations |
| `getSponsoredAccessInfo` | Read sponsored-access metadata |
| `fireImpressionBeacon` | Confirm recommendation delivery |
| `DEXTER_FACILITATOR_URL` | Default Dexter facilitator URL |
| `SOLANA_MAINNET`, `BASE_MAINNET`, `USDC_MINT` | Canonical network/asset constants |
