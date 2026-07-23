# OpenDexter — Codex plugin package

The hybrid OpenDexter package for OpenAI surfaces: the remote MCP-backed app
(open.dexter.cash/mcp) plus the skill layer, in the Codex plugin format.
One source tree serves three storefronts:

- **Codex plugin marketplace** — installable review-free (`codex plugin marketplace add`).
- **ChatGPT plugin submission** — the same package submitted through OpenAI's
  plugin submission portal (apps are published *as* plugins).
- **ChatGPT workspace Skills** — the `skills/` tree follows the open Agent
  Skills standard and uploads/shares directly in Business/Enterprise workspaces.

## Layout

```
codex-plugin/
├── .codex-plugin/plugin.json   # manifest (name, skills + apps pointers, interface)
├── .app.json                   # app binding — DEV variant (see below)
├── skills/                     # umbrella router + specialist skills (Agent Skills standard)
├── evals/                      # routing + safety cases, release gates, runner
└── assets/                     # logo / composer icon — pending the approved mark
```

## App binding

`.app.json` currently carries the DEVELOPER-MODE binding
(`dev-6a615ae3…` → `asdk_app_6a615ae3…`) — the owner's private test harness.
That id is **not portable** to other accounts. After directory approval,
swap in the published app id; do not distribute the dev binding.

## Provenance

Built under board item **#94** (dexter-thesis). Requisition:
`dexter-thesis/REQ-opendexter-chatgpt-codex-productization-2026-07-23.md`.
Fact base: `dexter-thesis/FACTMAP-opendexter-surface-truth-2026-07-23.json`.
Card tools are deliberately absent (owner ruling Jul 23: the card folds into
the wallet surface — board #71/#94; no card tools on MCP).
