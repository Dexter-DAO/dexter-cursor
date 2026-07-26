# OpenDexter Claude Code plugin

This is the developer-distributed Claude Code package for the hosted OpenDexter MCP at
`https://open.dexter.cash/mcp`.

Version `2.0.0-rc.2` targets the eleven-tool hosted manifest `0.3.0`. It
replaces the old `npx @dexterai/opendexter@latest` launcher with an exact
remote HTTP MCP connection so package behavior cannot drift with an npm latest
tag.

The package includes the same three hosted-contract skills as the Codex
package. Claude Code discovers them from `skills/`, connects through
`.mcp.json`, and uses its native MCP OAuth flow for protected tools. Anonymous
search and checks remain available without forcing connection-wide OAuth.

This is pre-release source and is not currently offered in a public plugin
marketplace.

The older hosted card-tool roster is superseded. Card controls remain outside
the hosted MCP on Dexter's secure wallet surface.

`dexter_portfolio` reads only the governed portfolio bound to the authenticated
MCP session. It accepts no caller-selected wallet, handle, actor, grant, or
authority, and an unavailable read must not be presented as zero assets.

The paid contract is search, fresh check, choose one `purchaseOptions` entry,
approve its exact request/mode/seller offer/atomic ceiling, and pass its
`preparedPurchase` unchanged to one `x402_fetch` or `x402_pay` call. The modes
are `direct_exact`, `native_tab`, `gateway_cash`, and `gateway_credit`; a
non-ready mode never falls through to another. This candidate reports every
explicit hosted mode as `integration_required` until the common durable backend
is connected.

## Developer discovery

The non-installing source check is:

```bash
claude --plugin-dir ./opendexter-plugin plugin details opendexter
```

For an authorized developer install, use a disposable Claude configuration or
run the following from the repository root:

```bash
claude plugin marketplace add "$PWD" --scope user
claude plugin install opendexter@opendexter --scope user
claude plugin details opendexter@opendexter
```

Restart Claude Code or start a fresh session after installation. Do not also
configure the same hosted endpoint manually.

Protected tools use three distinct OAuth identities:

- MCP resource and connector: `https://open.dexter.cash/mcp`
- authorization-server issuer: `https://mcp.dexter.cash/mcp`
- access-token issuer: `https://dexter.cash`

`claude mcp login opendexter` proves only native connector authentication. It
does not prove MCP session binding, passkey wallet enrollment, wallet
readiness, or permission to pay.
