# Restore Notice

A standalone Herdr plugin. Read [README](README.md) and [coding standards](CODING_STANDARDS.md).

## Structure
- `src/notice.ts`: native resume arguments, validation, compact text and OSC links.
- `src/runtime.ts`: authoritative Herdr CLI reads, PTY output, link tickets, kept launch flags and requested launch.
- `herdr-plugin.toml`: startup, agent-exit event, actions and link-handler contract.
- `test/`: unit, real PTY and explicitly enabled isolated Herdr tests.
- `scripts/`: public binary installation, packaging and release support.

## Invariants
Startup, agent-exit and on-request notices never start an agent or send shell input. Only an explicit Resume request may call `agent start`: a link click, or a JSON API `plugin.action.invoke` that names the pane's directory and agent kind. Revalidate pane, session, cwd and process identity, and atomically claim the ticket. Old history links must not target replacement panes or processes. The `agent start` routing name may be a unique ticket hash; the sidebar label is `display_agent` (Pi session name, otherwise the agent kind). Launch flags come only from a caller of the `notice` action, are kept per conversation, and are judged against the agent's `--help` before they are shown or applied; a recorded prompt is never sent again. Launch flags come only from a caller of the `notice` action, are kept per conversation, and are judged against the agent's `--help` before they are shown or applied; a recorded prompt is never sent again. Never parse Herdr's config; the plugin owns only its own optional config.json. Do not store credentials, environments or executable command text in links.

## Checks
`mise install --locked`, `bun install --frozen-lockfile`, then `mise run verify` and `mise run build`. Opt-in live test: `HERDR_TEST_BIN=/absolute/path/to/herdr mise run test`. Tests own private temporary sessions; never stop or modify an existing user session for verification.

## Releases
GitHub Releases distribute native binaries; this is not an npm package. Changesets owns versions and changelogs. Author patch fragments, never bump versions locally. Version Packages CI synchronizes the manifest. Publish only exact version commits after both platform jobs succeed, verify checksums before tagging, and verify the remote tag before publishing. First public bootstrap is 0.0.0. No private monorepo dependencies or machine-specific paths.
