# Restore Notice for Herdr

Restore your workspace without waking every agent. Resume the conversation you want with **Ctrl-click**.

```text
pi · paused · Restore notice polish
[Resume] · [Transcript] · [Directory] · Ctrl-click Resume
```

An explicit Pi session name appears when its retained transcript contains
`session_info` metadata. Unnamed sessions show just `pi · paused`; no title is
inferred from messages, IDs or filenames. The latest name wins, including an
empty name that clears it. Names are capped at 64 characters; unsafe or
unavailable names are omitted without preventing resume. Other agents retain
the same compact `<agent> · paused` heading.

A small [Herdr plugin](https://herdr.dev/docs/plugins/) that writes a colored,
compact notice into restored shell scrollback. Nothing starts until you click
**Resume**. No prefilled commands, prompt manipulation, background daemon or
browser callback server.

## Install

```sh
herdr plugin install victor-software-house/herdr-restore-notice
```

Prebuilt binaries support **Apple Silicon macOS** and **x86_64 Linux**.
Installation needs `curl`, `tar`, and the platform SHA-256 utility; no GitHub
login, Bun, Node or compiler. Herdr itself uses Git to download the repository.
Other platforms are not currently packaged.

Requires Herdr **0.8.2+** with plugin startup and custom OSC-link handling, a
local PTY, `ps`, and a foreground POSIX-style shell (`sh`, `bash`, `zsh`, `dash`,
`ksh`). Tested against `0.8.2-preview.2026-08-31-b1ff4582e968`.

Keep automatic agent restore disabled in **Herdr's configuration**:

```toml
[session]
resume_agents_on_restore = false

[experimental]
pane_history = true
```

`pane_history` is optional: it also restores the previous screen. Screen history
and plugin tickets can contain session paths; protect the Herdr state directory.
Install current [official agent integrations](https://herdr.dev/docs/session-state/)
so Herdr retains native session references.

## Click behavior

- **Resume**: Ctrl-click, including on macOS. Herdr handles the custom OSC 8 URI
  locally through the plugin's declared link handler. It starts the retained
  conversation in that same pane through `herdr agent start`. The live routing
  name is an opaque ticket hash so it stays unique; the sidebar `agent` token
  uses `display_agent` (the Pi session name when present, otherwise `pi`).
- **Transcript**: a percent-encoded `file://` link, shown when the integration
  retained a file path rather than an ID. Open it using your outer terminal's
  normal hyperlink gesture.
- **Directory**: a `file://` link to the restored directory.

File-link opening depends on your outer terminal and OS. Remote file paths are
not translated to local paths. No OS custom-protocol registration is required
for Resume. The link contains an opaque ticket, not a shell command.

Before launching, the plugin verifies the clicked pane, native session,
directory, shell PID/start time and PTY. Busy panes, missing transcripts, stale
history links and reused tickets are rejected. An exclusive claim prevents two
clicks from starting two agents. A readiness timeout does not trigger a retry:
an agent may already have started, so inspect the pane and plugin log.

## Resume from another client

A client of Herdr's JSON API, such as a phone client that asked its user first,
can request the same resume without a click. It invokes the `resume` action with
the pane and the directory and agent kind it showed:

```json
{"method": "plugin.action.invoke", "params": {"plugin_id": "vsh.restore-notice", "action_id": "resume",
  "context": {"focused_pane_id": "w1:p2", "focused_pane_cwd": "/home/me/project", "focused_pane_agent": "claude"}}}
```

The plugin runs the same checks as for a click, against the pane as it is now.
The directory and agent kind must match, so a request confirmed against an older
view of the pane is rejected. It needs no notice ticket and works with links off, and applies the kept
[launch flags](#launch-flags).
Other invocations, such as the command palette or `herdr plugin action`, are
rejected.

## When the notice appears

Herdr runs the startup hook after restoring a stopped server and opening its API.
This covers both `session stop` → `session attach` and crash recovery. The plugin
also prints a notice when a live agent exits and the native session is still
retained (`pane.agent_detected` with `released: true`). That is `/exit` and
process death, not Pi `/new` and not `herdr session stop`. Merely attaching to
an already running server, linking/enabling the plugin, or reloading
configuration does **not** rerun startup. Do not restart a busy server to preview
it; the next normal restore will use the installed plugin.

A pane can also become paused while the server runs, for example when
[Stash](https://github.com/victor-software-house/herdr-plugins/tree/main/packages/stash)
restores a workspace and reports each agent's conversation without starting it.
The `notice` action runs the startup scan on request, and Stash invokes it after
a restore. Panes that already carry a notice get no second one:

```sh
herdr plugin action invoke vsh.restore-notice.notice
```

Active agents and native deferred launches are excluded using Herdr's live
snapshot. A foreground startup job gets up to 15 seconds to finish. Unsupported
shells or native session sources are skipped. Live handoff deduplicates notices
for surviving shells. Agent-exit notices are not skipped merely because a
startup notice already used the same shell. Asynchronous output may appear below
an existing prompt; the plugin never sends input to redraw it.

Retained sessions leave the agents sidebar when the process exits: Herdr has no
paused or hibernated agent state. List them with:

```sh
herdr plugin action invoke vsh.restore-notice.list
```

## Launch flags

Herdr keeps a paused pane's conversation, not the flags its agent was started
with. The plugin records them itself when an agent starts in a pane
(`pane.agent_detected`): it waits for the pane's conversation, then reads the
agent's own process, not a wrapper that launched it, so Herdr's own restart
resumes the agent with them. pi rewrites its process title and gives none.

A caller that recorded them elsewhere, such as Stash, hands them to the `notice`
action, one launch line per pane without the program name, as JSON in the
context's `selected_text`, the only free-text field an invocation carries:

```json
{"method": "plugin.action.invoke", "params": {"plugin_id": "vsh.restore-notice", "action_id": "notice",
  "context": {"selected_text": "{\"launch\": [{\"pane_id\": \"w1:p2\", \"argv\": [\"--model\", \"opus\"]}]}"}}}
```

The plugin keeps each line with the pane's conversation, so it survives server
restarts, and deletes it once no pane holds that conversation. Each time it
prints a notice it reads the agent's `--help` (`codex resume --help` for Codex)
and sorts the recorded words:

| Recorded | On Resume |
|:--|:--|
| An option `--help` still lists, with its values | Shown in the notice and applied |
| `--resume`, `--continue`, `--session-id`, `--fork-session` | Replaced by the paused conversation |
| An option `--help` no longer lists | Named in the notice and left out |
| A prompt or subcommand | Named in the notice and never sent again |

When `--help` cannot be read, nothing is applied and the notice says so, because
a value cannot be told from a prompt. A click applies exactly the flags its
notice showed. An API resume judges them again at that moment. Model names are
not checked; the agent reports an unknown one itself.

## Plain-text mode

OSC links are enabled by default. Herdr preserves them; guessing outer-terminal
capabilities from a server's environment is unreliable, especially before any
client attaches. Use an explicit setting instead:

```sh
herdr plugin config-dir vsh.restore-notice
```

Create `config.json` in the directory printed by that command:

```json
{"links": false}
```

This prints the literal, copyable native resume command instead of clickable
links. Set `true`, or remove the file, to restore links. Only this optional
plugin-owned file is parsed; **Herdr's config is never parsed by the plugin**.
Settings take effect on the next startup hook.

## Native resume and safety boundaries

The official integrations report session identity. Herdr's installed API does
not expose its internal native resume planner, so the plugin maintains a small
allowlisted argument table checked against
[Herdr's planner](https://github.com/herdrdev/herdr/blob/b1ff4582e968/src/agent_resume.rs).
Only resume arguments are supplied; **Herdr owns the actual agent launch**, shell
eligibility checks, canonical executable and interactive-readiness detection.
Unknown sources are never treated as executable instructions.

The restored pane already has Herdr's native environment and cwd:
`TERM=xterm-256color`, `COLORTERM=truecolor`, current Herdr socket/binary and
workspace/tab/pane IDs; inherited `WT_SESSION` and `CODEX_THREAD_ID` are removed.
The command inherits the restored shell's environment. Herdr does not
reconstruct original flags, model settings or custom launch variables. This
plugin applies flags only when a caller handed them over (see
[Launch flags](#launch-flags)) and never invents them; launch variables are not
restored. If cwd changed, the click is rejected rather than silently changing
directories.

Herdr has no output-only history append API. Startup therefore writes to a
verified, owned **PTY slave**: output bytes, never shell input. It checks device
identity, rejects symlinks/non-terminal files, and rechecks the pane before
writing. A process starting after the final output check can interleave output,
but receives no input from the notice. Only an explicit Resume request invokes
`agent start`, which performs its own server-side shell-availability check.

Inspect errors with:

```sh
herdr plugin log list --plugin vsh.restore-notice
```

## Development

```sh
mise install --locked
bun install --frozen-lockfile
mise run verify
mise run build
herdr plugin link .
HERDR_TEST_BIN="$(command -v herdr)" mise run test
```

The live test owns temporary homes, registries, sockets and fake agents. It
proves real Ctrl-click dispatch, native resume arguments, double-click rejection,
wrong-pane/stale-link rejection, output-only startup, and stop/crash recovery.
It never touches an existing user session. Set `HERDR_TEST_CONFIG` to test a
**copy** of a full config; test-only shell/update/history overrides affect only
the copy. The binary must be built before running live tests.

Versions and changelogs use Changesets. GitHub Releases publish checked native
archives after verification; nothing is published to npm. See
[contributor guidance](AGENTS.md).

MIT licensed. Independent community plugin, not an official Herdr project.
