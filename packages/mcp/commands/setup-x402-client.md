---
name: setup-x402-client
description: Add x402 payment handling to a Node.js project using @dexterai/x402.
---

# Add x402 Client to Your Project

Set up automatic x402 payment handling so your application can call paid APIs.

This command builds an independent `@dexterai/x402` SDK client. It is not the
OpenDexter MCP runtime, does not inherit an OpenDexter OAuth bearer or grant,
and must never be used as a fallback for a disconnected or unavailable
OpenDexter account-bound tool.

## Steps

1. Install the SDK:

```bash
npm install @dexterai/x402@6.0.0-rc.2 @dexterai/vault@0.43.2
```

2. Create an application-owned payment helper. Add this file to your project:

```typescript
// lib/x402.ts
import { createKeypairWallet, payAndFetch } from '@dexterai/x402/client';

const solana = await createKeypairWallet(process.env.SOLANA_PRIVATE_KEY!);

export async function x402Fetch(url: string, init: RequestInit = {}) {
  const result = await payAndFetch(url, init, { solana }, {
    maxAmountAtomic: '1000000', // Safety limit: max $1.00 per request
    solanaRpcUrl: process.env.SOLANA_RPC_URL,
  });
  if (!result.ok) {
    throw new Error(`${result.reason}: ${result.detail ?? ''}`);
  }
  if (!result.response) {
    throw new Error('Payment settled, but the merchant returned no response');
  }
  return result.response;
}
```

3. Add your private key to `.env`:

```
SOLANA_PRIVATE_KEY=your-base58-private-key-here
```

4. Use it anywhere in your application:

```typescript
import { x402Fetch } from './lib/x402';

const response = await x402Fetch('https://x402-api.example.com/data');
const data = await response.json();
```

5. For dual-chain support (Solana + EVM), add `viem` and an EVM wallet:

```bash
npm install viem
```

```typescript
import { createEvmKeypairWallet } from '@dexterai/x402/client';

const wallets = {
  solana,
  evm: await createEvmKeypairWallet(process.env.EVM_PRIVATE_KEY!),
};
```

V6 has no `wrapFetch` or `createX402Client` export. Use `payAndFetch`, and do
not automatically retry `payment_unconfirmed`: the first payment may already
have settled.

## Verify

Test with the Dexter test endpoint:

```typescript
const res = await x402Fetch('https://x402.dexter.cash/api/v2-test', { method: 'POST' });
console.log(await res.json()); // Should return test data + payment receipt
```
