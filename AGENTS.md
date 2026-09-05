# Restore Notice

A standalone Herdr plugin. Read [README](README.md) and [coding standards](CODING_STANDARDS.md).

## Structure
- `src/notice.ts`: native resume arguments, validation, compact text and OSC links.
- `src/runtime.ts`: authoritative Herdr CLI reads, PTY output, link tickets and clicked launch.
- `herdr-plugin.toml`: startup, action and link-handler contract.
- `test/`: unit, real PTY and explicitly enabled isolated Herdr tests.
- `scripts/`: public binary installation, packaging and release support.

## Invariants
Startup never starts an agent or sends shell input. Only an explicit Resume click may call `agent start`. Revalidate pane, session, cwd and process identity, and atomically claim the ticket. Old history links must not target replacement panes or processes. Never parse Herdr's config; the plugin owns only its own optional config.json. Do not store credentials, environments or executable command text in links.

## Checks
`mise install --locked`, `bun install --frozen-lockfile`, then `mise run verify` and `mise run build`. Opt-in live test: `HERDR_TEST_BIN=/absolute/path/to/herdr mise run test`. Tests own private temporary sessions; never stop or modify an existing user session for verification.

## Releases
GitHub Releases distribute native binaries; this is not an npm package. Changesets owns versions and changelogs. Author patch fragments, never bump versions locally. Version Packages CI synchronizes the manifest. Publish only exact version commits after both platform jobs succeed, verify checksums before tagging, and verify the remote tag before publishing. First public bootstrap is 0.0.0. No private monorepo dependencies or machine-specific paths.
