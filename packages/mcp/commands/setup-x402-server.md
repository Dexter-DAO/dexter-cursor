---
name: setup-x402-server
description: Add an x402 paywall to an Express API endpoint using @dexterai/x402.
---

# Add x402 Paywall to Your Server

Protect any Express endpoint with x402 payments. Users pay USDC to access your API.

The test client below is an independent `@dexterai/x402` SDK integration. It
is not the OpenDexter MCP runtime and does not inherit OpenDexter identity,
authority, limits, or receipts. Never substitute it for a blocked OpenDexter
account-bound operation.

## Steps

1. Install the SDK:

```bash
npm install @dexterai/x402@6.0.0-rc.0 @dexterai/vault@0.43.1
```

2. Add the middleware to any Express route:

```typescript
import express from 'express';
import { x402Middleware } from '@dexterai/x402/server';

const app = express();

app.get('/api/premium-data',
  x402Middleware({
    payTo: 'YOUR_SOLANA_ADDRESS', // Replace with your wallet address
    amount: '0.01',               // $0.01 per request
  }),
  (req, res) => {
    // This only runs after successful payment
    res.json({
      data: 'premium content',
      payer: req.x402?.payer,
      transaction: req.x402?.transaction,
    });
  }
);

app.listen(3000);
```

3. Test with curl — first request gets a 402:

```bash
curl -i http://localhost:3000/api/premium-data
# HTTP/1.1 402 Payment Required
# PAYMENT-REQUIRED: eyJ4NDAy...
```

4. Test with a funded x402 client:

```typescript
import { createKeypairWallet, payAndFetch } from '@dexterai/x402/client';

const solana = await createKeypairWallet(process.env.SOLANA_PRIVATE_KEY!);

const paid = await payAndFetch(
  'http://localhost:3000/api/premium-data',
  { method: 'GET' },
  { solana },
  { maxAmountAtomic: '10000', solanaRpcUrl: process.env.SOLANA_RPC_URL },
);
if (!paid.ok) throw new Error(`${paid.reason}: ${paid.detail ?? ''}`);
if (!paid.response) throw new Error('Payment settled without a merchant response');
const res = paid.response;
console.log(await res.json());
// { data: "premium content", payer: "2SB3V...", transaction: "5xK9..." }
```

## Options

- **Dynamic pricing**: Use `getAmount: (req) => calculatePrice(req.body)` for request-dependent pricing.
- **EVM chains**: Set `network: 'eip155:8453'` for Base instead of Solana.
- **Multi-chain**: Pass a network array and a per-network `payTo` map.

## List on Marketplace

Endpoints paid through Dexter's facilitator are discovered and quality-tested
for the Dexter marketplace. Add `bazaarExtension()` plus a matching discovery
declaration when you want to publish richer route metadata.
