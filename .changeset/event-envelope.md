---
"herdr-restore-notice": patch
---

Recognize agent start and exit events. The hook's event JSON names the event `pane_agent_detected`, not `pane.agent_detected`, so 0.0.3 still ignored every one: no launch flags were recorded at start and no notice followed an agent's exit.
