# OpenDexter ChatGPT app binding

This directory records an existing owner-account OpenAI developer binding:

```text
dev-6a615ae3385c8191b05cc4c420514022
  -> asdk_app_6a615ae3385c8191b05cc4c420514022
  -> https://open.dexter.cash/mcp
```

It is a publisher-side `.app.json` artifact, not a portable Codex or Claude
plugin component and not proof that the owner-account registration is current.
The Codex package at `plugins/opendexter/` deliberately does not reference it; the
Codex and Claude packages each register the endpoint once through their own
portable `.mcp.json`. Loading both the account binding and a package connection
in the same client can expose duplicate namespaces with independent OAuth and
session state.

OpenAI Apps Management remains authoritative for the live registration state.
The hosted release contract exposes exactly six raw tools and no compatibility
or card controls. Protected tools—including the session-bound, read-only
`dexter_portfolio`—use native OAuth.

Do not add this file to `plugins/opendexter/.codex-plugin/plugin.json`, do not publish
it as a universal app identity, and do not edit generated copies under
`~/.codex/plugins/cache/`.
