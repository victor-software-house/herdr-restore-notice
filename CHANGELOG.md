# herdr-restore-notice

## 0.0.1

### Patch Changes

- 2decaa8: Use compact `<agent> · paused` headings and show explicit Pi session names when available from retained transcripts. Omit unnamed or unsafe metadata without changing resume behavior.
- da076e0: Hide resume ticket hashes behind `display_agent`, print the same notice when a live agent exits with a retained native session, and add a workspace action that lists those retained sessions.
