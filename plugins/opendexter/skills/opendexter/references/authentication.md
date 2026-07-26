# Authentication and wallet state

Keep three states separate:

1. **Connector OAuth**: whether this client may invoke protected OpenDexter
   tools.
2. **MCP session binding**: whether the authenticated MCP session is durably
   linked to a stored Dexter Wallet identity.
3. **Wallet enrollment and readiness**: whether the user has completed their
   passkey ceremony and the wallet can perform the requested operation.

Success in one state does not prove either of the others. In particular, OAuth
success does not mean the wallet is enrolled, bound, funded, active, or ready.

## OAuth identity

- MCP resource and audience: `https://open.dexter.cash/mcp`
- Protected-resource metadata:
  `https://open.dexter.cash/.well-known/oauth-protected-resource/mcp`
- Authorization-server issuer: `https://mcp.dexter.cash/mcp`
- Authorization-server metadata:
  `https://mcp.dexter.cash/.well-known/oauth-authorization-server/mcp`
- Access-token issuer: `https://dexter.cash`
- Protected scope: `vault`

The authorization-server issuer and access-token issuer are deliberately
different identities. Do not rewrite either one.

Each protected tool advertises canonical `securitySchemes` and the
back-compatibility `_meta.securitySchemes` mirror. A runtime challenge is an
error result with `isError: true` and `_meta["mcp/www_authenticate"]`; the
Bearer challenge includes `resource_metadata`, `scope`, `error`, and
`error_description`.

## Native client action

Use the client action already surfaced for the configured MCP:

- ChatGPT or Codex Desktop: **Connect**.
- Codex CLI: `codex mcp login opendexter`.
- Claude Code: `/mcp` or `claude mcp login opendexter`.

Never relay a personalized MCP URL, pairing URL, enrollment link, bearer token,
or one-time credential through the conversation.

After the user completes native OAuth, retry the blocked protected tool once.
If it still challenges, stop and report connector OAuth as the failed layer.
Do not switch to enrollment or create a second connector.

For a valid OAuth session whose wallet is not ready, use `x402_wallet` and the
hosted wallet UI. The user completes the passkey ceremony on Dexter's secure
surface; the model never handles passkey material.
