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

`x402_check.purchaseOptions` binds the original and resolved URL, method,
request digest, complete seller accept witness, network, asset, amount,
recipient, expiry, offer ID, route ID, explicit mode, and prepared ID. The
modes are `direct_exact`, `native_tab`, `gateway_cash`, and `gateway_credit`.
Direct and Gateway preserve the selected seller Exact offer; Native Tab
requires the selected seller Tab offer.

Pass one `preparedPurchase` unchanged as `purchase`, with the separately
approved atomic ceiling. Never switch offer, route, or mode.
`integration_required`, `request_required`, and `unavailable` stop before
dispatch. Treat only `availability.state: "ready"` as executable.

Use `x402_check` for requirements, `x402_fetch` for one approved paid call,
`x402_access` for wallet-proof access, and `x402_wallet` for the bound payment
wallet.

Classify outcomes as pre-dispatch failure, merchant rejection, settled, or
ambiguous settlement. Retry only an explicitly retryable pre-dispatch failure.
Read the mode-specific receipt: Direct seller settlement, Native Tab voucher
and cash settlement, Gateway cash, and Gateway credit obligation are separate.
