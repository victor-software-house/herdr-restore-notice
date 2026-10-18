# herdr-restore-notice

## 0.0.4

### Patch Changes

- e6d1b7e: Recognize agent start and exit events. The hook's event JSON names the event `pane_agent_detected`, not `pane.agent_detected`, so 0.0.3 still ignored every one: no launch flags were recorded at start and no notice followed an agent's exit.

## 0.0.3

### Patch Changes

- fa8c4f2: Record launch flags when an agent starts. Herdr leaves `released` out of a start event, so 0.0.2 never recognized one and recorded nothing.

## 0.0.2

### Patch Changes

- 9414324: Record an agent's launch flags when it starts in a pane, from the agent's own process, so Herdr's own restart resumes it with them too.

## 0.0.1

### Patch Changes

- 6da65e7: Accept a Resume request from a JSON API client that names the pane's directory and agent kind, with the same pane, session, shell and claim checks as a link click.
- 2decaa8: Use compact `<agent> · paused` headings and show explicit Pi session names when available from retained transcripts. Omit unnamed or unsafe metadata without changing resume behavior.
- da076e0: Hide resume ticket hashes behind `display_agent`, print the same notice when a live agent exits with a retained native session, and add a workspace action that lists those retained sessions.
- 7487aac: Resume applies the launch flags another plugin, such as Stash, hands to the `notice` action. The notice shows them, a click applies exactly what it showed, and a flag the agent's `--help` no longer lists, or a first prompt, is named and left out.
- 9085d19: Add a `notice` action that runs the startup scan on request, so panes paused while the server runs, such as by a Stash restore, get their Resume link.
