# Progress

Living status of Salvage Shift. Updated as work lands.

## Done
- Phase 0: project scaffold, CC0 asset pipeline (149 models, 42 PBR texture sets processed to meshopt GLB / WebP), architecture docs.
- Phase 1: deterministic facility generator (4 themes, multi-floor with switchback stairwells, loops, dead-end pruning, vaults + keycards, hidden rooms, sectors, lights), furnisher (per-room-type recipes with doorway-connectivity repair), shared colliders, nav grid with clearance + stair links. 48 generated levels across all maps verified fully navigable.
- Phase 2 (core): server with identity tokens, SQLite persistence, economy (purchases, loadouts, rewards, achievements), lobby (room codes, ready, host migration, kick, reconnect grace, restart persistence), authoritative mission sim (players w/ movement validation, props with ownership + co-carry, doors, interactables, power, tubes, hazards, extraction lift, equipment, director events, 8 monster behaviours). Bot smoke test passes end to end.

## In progress
- Phase 3: browser client.

## Next
- Client engine, visuals, UI, audio, voice; integration + E2E tests; deployment docs.
