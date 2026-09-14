# Coding standards

## 1. Runtime safety
1.1 Startup and agent-exit notices are output-only. Never send keys or commands to redraw a prompt.
1.2 Only an explicit link click may launch an agent; reject stale, busy, changed and consumed targets.
1.3 Validate external JSON and URLs. Use argv arrays; never execute URL text.
1.4 Use Herdr's public CLI through HERDR_BIN_PATH. Document unavoidable OS integrations.

## 2. Scope and verification
2.1 Keep runtime dependencies absent unless a concrete requirement warrants one.
2.2 Test real PTY and Herdr behavior in isolated temporary sessions. Unit tests alone do not prove click dispatch.
2.3 Update README, manifest and tests with behavior changes. Keep startup output short.
2.4 Preserve unrelated work and never restart user sessions for tests.

## 3. Distribution
3.1 Keep public install independent of authentication and build toolchains.
3.2 Pin tools and actions; verify native assets and their checksums before release.
3.3 Changesets owns versions. Publish only verified release commits; never overwrite release tags.
