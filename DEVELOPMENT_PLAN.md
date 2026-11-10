# Development Plan

Technical plan for Salvage Shift. See `GAME_ARCHITECTURE.md` for the system design and
`PROGRESS.md` for status.

## Initial inspection (start of project)

* Repository: empty (no commits, no files). No existing engine, dependencies or infrastructure.
* Tooling available: Node 22.23, npm 10, Python 3.13, 4 CPU cores, 15 GB RAM, no GPU
  (headless Chromium renders through SwiftShader, so visual tests work but frame rates in CI
  are not representative of real hardware).
* Network: npm registry and CC0 asset hosts (Poly Haven, ambientCG) reachable.
* Decision: browser client (Three.js + TypeScript + Vite + Rapier) with an authoritative
  Node server (`ws` + Rapier + `node:sqlite`). Rationale in `GAME_ARCHITECTURE.md` §1.

## Phases

| Phase | Scope | Exit criteria |
|---|---|---|
| 0 Foundation | scaffold, asset pipeline, docs | assets processed, project builds |
| 1 Shared core | RNG, protocol, level generator, colliders, nav, catalogs | 48-level generator sweep fully navigable |
| 2 Server | sessions, identity, SQLite, lobby, authoritative mission sim, economy | bot smoke test: create → start → move → quota → lift |
| 3 Client engine | renderer, PBR materials, light pool, portal culling, level visuals, FPS controller, grab physics, interpolation | walk a generated facility, carry/throw props in a browser |
| 4 Enemy AI | nav grid, perception, 8 monsters, creature models + procedural animation | each monster demonstrably performs its signature behaviour |
| 5 Content | 4 facility themes, interactables, hazards, random events, practice map | all maps playable end to end |
| 6 Progression | shop, loadout, consumables, XP/levels, achievements, statistics | purchases and rewards persist across restarts |
| 7 Presentation | menus, lobby UI, HUD, pause, results, settings, keybinds, accessibility, audio, voice chat, dev tools | every button functional |
| 8 Hardening | unit + multi-client integration + browser E2E tests, latency simulation, performance, deployment docs | all tests green, documented deployment |

## Key technical risks and mitigations

| Risk | Mitigation |
|---|---|
| Held-object latency in online play | network ownership: the holder simulates its prop locally; the server validates |
| Physics divergence between server and client | server is authoritative for free props; clients interpolate, with error smoothing on hand-off |
| Procedural levels that can't be navigated | generator validates door-reachability; furnisher repairs blocked rooms; tests sweep many seeds |
| Too many dynamic lights for forward rendering | fixed-size light pool + portal culling; light count never changes (no shader recompiles) |
| Asset weight / VRAM | meshopt + WebP, textures sized per object, per-map loading |
| WebRTC failing behind strict NATs | optional TURN config + WebSocket voice relay fallback |
| Server restart mid-session | lobby persistence + auto-reconnect; profile changes are transactional |
