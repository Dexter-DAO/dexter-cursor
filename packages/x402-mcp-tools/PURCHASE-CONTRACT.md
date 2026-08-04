# OpenDexter purchase contract v1

`opendexter.purchase.v1` makes the selected seller offer and buyer mode explicit
between `x402_check` and `x402_fetch`.

The four modes are:

- `direct_exact`: pay the selected seller Exact offer directly.
- `native_tab`: issue only the selected seller Tab voucher.
- `gateway_cash`: use Gateway cash while preserving the selected downstream
  seller Exact offer.
- `gateway_credit`: use Gateway credit while preserving that seller offer and
  reporting the buyer obligation separately.

`x402_check` returns `purchaseOptions`. Each option contains:

- an availability state;
- one `preparedPurchase`;
- one exact route with URL, method, request-body digest, seller-offer identity,
  x402 version, network, asset, atomic amount, recipient, facilitator, and
  expiry.

Atomic amounts stay decimal strings. A non-GET purchase is execution-ready only
when the exact request body was priced.

An explicit execution passes the chosen `preparedPurchase` as `purchase` and
the atomic ceiling authorized by the user's instruction or delegated policy as
`maxAmountAtomic`. The implementation
rejects changes to the URL, method, body digest, route, seller offer, mode, or
ceiling before dispatch. It dispatches only the selected adapter:

- Direct Exact never invokes Native Tab.
- Native Tab never falls through to Exact when setup, approval, policy,
  signing, or lane execution is unavailable.
- Gateway modes use only a matching provider-neutral adapter that reports
  fresh readiness. Without one, they fail before probing or dispatch.

Every explicit purchase attempt must first claim the
`preparedId` in a durable attempt store. All aliases share that identity. A
completed receipt is replayed without dispatch; an in-flight, interrupted, or
uncertain attempt is reconciliation-only. A Native Tab approval can resume
only the same prepared identity and fingerprint. This package exposes the
`PurchaseAttemptStoreV1` contract; the local MCP implementation stores its
claims under `~/.dexterai-mcp/purchase-attempts-v1`.

For x402 v2 Direct Exact, the adapter builds the payment against the one raw
accepted offer preserved by the prepared purchase and sends that exact offer in
the payment header. It does not ask the SDK to re-probe or select another offer
by network. The paid seller request is dispatched once.

Calls that omit `purchase` keep the prior local compatibility behavior. New
integrations must use the explicit contract.

Gateway adapters receive the validated purchase, its exact request, and the
fresh hash-verified seller accept/requirements; they must not reselect an
offer. The validated purchase carries the authorized atomic ceiling. The
shared layer rechecks the seller's exact offer, claims and marks the durable
attempt, strictly projects the adapter's public result, and produces the
canonical mode-specific receipt. Arbitrary provider errors and fields are not
returned. Adapter names and providers are deliberately outside this contract.

Every explicit result includes a mode-specific `purchaseReceipt`:

- Direct reports seller settlement.
- Native Tab reports voucher state separately from seller cash settlement.
- Gateway cash reports buyer cash separately from seller settlement.
- Gateway credit reports exposure, buyer obligation, and seller settlement
  separately.

Once a consequential request was dispatched or its dispatch is uncertain, the
receipt is reconciliation-only. It never authorizes an automatic retry.
