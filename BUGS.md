# Known Bugs and Issues

Format: **ID** · area · severity · status. Severity: critical / major / minor / cosmetic.

## Open

_None recorded yet._

## Fixed

| ID | Area | Severity | Description | Fix |
|---|---|---|---|---|
| B-001 | levelgen | minor | Wall pieces touching wall ends extended both ends by half a thickness and were not re-centred, leaving small corner gaps | extend only the touching end and recompute the centre |
| B-002 | levelgen | minor | Many dead-end corridor stubs made layouts feel artificial | loop connections first, then prune ~75% of leaf corridors with id compaction |
| B-003 | net | major | In-flight client states sent before a server correction were rejected and caused correction loops | correction epoch in every client state packet; stale epochs are ignored |
