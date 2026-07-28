# Changelog

## 2026-07-28 — hosted plugins

- Released Codex `0.4.0` and Claude Code `2.0.0` for the hosted OpenDexter
  contract, including the authenticated, session-bound `dexter_portfolio`
  read.
- Reduced the public model-facing product to six tools. Five dated
  compatibility endpoints remain raw app-only so existing clients do not
  break, but they are absent from product routing and agent instructions.
- Replaced the Claude Code npm-latest launcher with the remote HTTP MCP at
  `https://open.dexter.cash/mcp`.
- Materialized Claude Code skills inside the package; removed escaping
  symlinks to the older local SDK/tooling lineage.
- Removed hosted card and local settings routes from active package guidance.
- Kept the published Claude installer on the local seven-tool stdio MCP instead
  of silently installing the separate hosted package.
- Added release-pinned OAuth/tool drift tests and disposable marketplace
  discovery validation.
- Retired the v0.3.0 sixteen-tool model reports from active release evidence.
- Prepared `@dexterai/mcp-instructions@2.3.0`,
  `@dexterai/x402-mcp-tools@0.7.1`, and
  `@dexterai/opendexter@1.22.2-rc.1` as one ordered local release candidate.
- Made the local package rebuild its four declared widgets from an explicitly
  pinned source and validate the exact packed tarball without a registry,
  client install, network request, or live wallet.

## 1.4.0

- Moved `@dexterai/opendexter` and `@dexterai/x402-discovery` npm package source into this repo
- Added npm workspaces monorepo structure (`packages/mcp/`, `packages/x402-discovery/`)
- Skills, rules, agents, and commands are now a single source of truth in `packages/mcp/`
- Plugin directories (`opendexter-plugin/`) symlink to `packages/mcp/` — no more manual sync
- Widget HTML files committed as static assets with sibling-repo auto-detection fallback
- Updated all docs for new repo structure

## 1.1.0

- Bumped plugin version for CC update propagation
- Skills audit: all 6 skills synced against SDK v3.0.1 source
- Merged x402-marketplace skill content into opendexter skill (6 skills total)
- Added MCP server instructions and 3 skill resources to hosted server
- Fixed CC installer to use CC CLI instead of raw JSON manipulation
- Added full Cursor plugin installer (skills + rules + agents + commands)

## 1.0.0

- Initial release
- 6 skills: opendexter, x402-client, x402-server, x402-react, x402-protocol, x402-debugging
- 2 always-on rules: x402-protocol, x402-coding
- 1 agent: x402-engineer
- 3 commands: setup-opendexter, setup-x402-client, setup-x402-server
- Ships with @dexterai/opendexter MCP server (x402_search, x402_fetch, x402_check, x402_wallet, x402_pay, x402_access, x402_settings)
