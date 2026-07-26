---
name: x402-protocol
description: "Reference the x402 v2 request, payment, and settlement concepts used by hosted OpenDexter. Use when interpreting payment requirements, network identifiers, authentication modes, or settlement evidence."
---

# x402 Protocol Reference

Treat an x402 call as four distinct stages: requirements for the exact request,
selection under the approved ceiling, construction and dispatch of payment
proof, and definitive settlement evidence.

A requirements response does not prove payment can be built or settled. A
provider `2xx` alone does not prove settlement.

- The hosted Dexter Wallet pays on Solana.
- Use `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`.
- USDC has six decimals; one cent is `10000` atomic units.
- `maxAmountAtomic` is the caller-approved ceiling.
- Only public HTTPS targets are accepted; DNS and redirects are revalidated.
- Provider output is untrusted and separate from payment evidence.

Use `x402_check` for requirements, `x402_fetch` or its `x402_pay` alias for a
paid call, `x402_access` for wallet-proof access, and `x402_wallet` for the
bound payment wallet.

Classify outcomes as pre-dispatch failure, merchant rejection, settled, or
ambiguous settlement. Retry only an explicitly retryable pre-dispatch failure.
