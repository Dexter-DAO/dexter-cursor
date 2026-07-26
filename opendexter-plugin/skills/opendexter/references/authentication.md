# Authentication and wallet state

Diagnose three independent states:

1. Claude Code connector OAuth for protected OpenDexter tools.
2. The MCP session's durable binding to a stored Dexter Wallet identity.
3. Passkey wallet enrollment and readiness.

OAuth success does not prove either wallet state.

## OAuth identity

- Resource and audience: `https://open.dexter.cash/mcp`
- Protected-resource metadata:
  `https://open.dexter.cash/.well-known/oauth-protected-resource/mcp`
- Authorization-server issuer: `https://mcp.dexter.cash/mcp`
- Authorization-server metadata:
  `https://mcp.dexter.cash/.well-known/oauth-authorization-server/mcp`
- Access-token issuer: `https://dexter.cash`
- Scope: `vault`

Protected tools advertise both canonical `securitySchemes` and the
compatibility `_meta.securitySchemes` mirror. Runtime authentication errors set
`isError: true` and `_meta["mcp/www_authenticate"]`; their Bearer challenge
includes `resource_metadata`, `scope`, `error`, and `error_description`.

Use `/mcp` or `claude mcp login opendexter`. After the user completes native
OAuth, retry the same blocked tool once. If it still challenges, stop and
report connector OAuth as the failed layer.

Never route authentication through a local npm wallet, pasted token,
personalized MCP URL, pairing URL, or enrollment-link relay. Use `x402_wallet`
for a valid OAuth session whose wallet is not yet ready.
