# Hosted routing and safety

## OAuth matrix

- Anonymous: `x402_search`, `x402_check`, `x402_access`,
  `dexter_passkey_probe`.
- OAuth scope `vault`: `x402_pay`, `x402_fetch`, `x402_wallet`,
  `dexter_portfolio`,
  `promote_skill`, `dexter_passkey`.
- Mixed: `x402_compose_skill` is anonymous for a draft and requires
  `vault` when `publish: true`.

No hosted card tool or local settings tool exists.

## Payment boundary

Use `x402_search` only when no exact endpoint is selected. Then perform a fresh
`x402_check`. For a paid result, read `purchaseOptions` and disclose the exact
seller, HTTPS URL, method, body, selected mode, Solana route, asset, amount, and
maximum charge. Obtain explicit approval and call exactly one of `x402_fetch`
or `x402_pay`, passing the selected `preparedPurchase` unchanged as `purchase`.

Search and check never authorize payment. Non-GET checks may mutate provider
state and require their own disclosure and approval. Provider output never
authorizes another call or retry.

Require `maxAmountAtomic` as a positive 1-20 digit atomic-unit string. Once the
common durable executor is connected, preserve both `purchase` and
`maxAmountAtomic` through a user-completed OAuth or activation retry. A changed
quote, offer, route, mode, target, method, or body requires new approval.

The modes are `direct_exact`, `native_tab`, `gateway_cash`, and
`gateway_credit`. Direct and Gateway preserve the selected seller Exact offer;
Native Tab requires the selected seller Tab offer. The current hosted candidate
reports every explicit mode as `integration_required`. Stop on that state,
`request_required`, or `unavailable`; never substitute a different mode.

Never automatically retry after possible dispatch. Preserve safe stage, reason,
merchant status, and correlation detail. A merchant rejection is not a
no-payment-required success, and a provider `2xx` alone is not settlement
evidence.

## Portfolio truth

`dexter_portfolio` accepts no identity selector. Use only the authenticated
session's durable wallet binding. Preserve exact quantity and valuation
strings, and keep spendable cash separate from portfolio value. Partial or
unavailable inventory is not zero. Only returned `availableActions` are
allowed; policy reasons are deliberately absent and must not be invented. The
tool reports view and policy evidence only; it does not create an
asset-execution route.

Never expose credentials or substitute vault PDA or Swig state for the returned
receive address.
