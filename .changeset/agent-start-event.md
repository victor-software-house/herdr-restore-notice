---
"herdr-restore-notice": patch
---

Record launch flags when an agent starts. Herdr leaves `released` out of a start event, so 0.0.2 never recognized one and recorded nothing.
