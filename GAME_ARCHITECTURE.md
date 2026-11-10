# Salvage Shift — Game Architecture

Salvage Shift is a cooperative first-person horror extraction game. A crew of 1–4 salvage
contractors enters procedurally assembled abandoned facilities, physically hauls valuables back
to an extraction lift, and decides when the haul is worth the risk.

This document describes how the game is built. It is the reference for anyone changing it.

## 1. Technology

| Layer | Choice | Why |
|---|---|---|
| Rendering | Three.js r187 (WebGL2) | Mature, fast, full PBR + post-processing, runs on any desktop browser |
| Language | TypeScript 5.9 (strict) | One language for client, server and shared simulation code |
| Physics | Rapier 3D 0.21 (`rapier3d-compat`, WASM) | Deterministic-enough, fast, identical API in browser and Node |
| Server | Node 22 + `ws` | Authoritative simulation, lobby, persistence in one process |
| Persistence | `node:sqlite` (SQLite, WAL mode) | Real transactional database, no native build step |
| Build | Vite 7 (client), esbuild (server) | Fast dev loop, single deployable bundle |
| Tests | Vitest (unit + multi-client integration), Playwright (browser E2E) | |
| Assets | Poly Haven CC0 models + textures (pipeline in `tools/`), original SDF-modelled creatures, procedural audio | Legally clean, high quality, consistent |

A desktop engine (Unity/Godot/Unreal) was considered. The browser stack was chosen because
it was the preferred stack, the game needs no install for friends to join (they open a URL),
and nothing in the design needs native-only features. Graphics are scaled with presets so
mid-range GPUs hold 60 fps.

## 2. Repository layout

```
client/            Browser game (Vite root)
  index.html
  src/
    main.ts        Boot + app state machine (menu ⇄ lobby ⇄ mission ⇄ results)
    core/          Engine loop, input/keybinds, settings, events, asset loading
    render/        Materials, post-processing, light pool, portal culling, particles, sky/fog
    world/         Level visual builder (rooms, walls, trims, fixtures, decor), interactable visuals
    models/        Creature/character meshes (SDF-built), skeleton + procedural animation
    game/          Local player controller, camera rig, interaction, grab physics, equipment,
                   remote players, props, enemies, spectator, mission HUD logic
    net/           WebSocket client, clock sync, snapshot interpolation, voice chat
    audio/         Audio engine, procedural sound synthesis, ambience, music director
    ui/            DOM UI screens (menus, lobby, HUD, pause, results, shop, settings…)
    dev/           Developer overlay (?dev=1)
  public/assets/   Processed models (.glb), textures (.webp), creature meshes (.bin)
server/src/
  index.ts         HTTP static server + WebSocket endpoint + graceful shutdown
  net/             Connection/session handling, rate limiting, protocol dispatch
  db/              SQLite schema, profile repository, transactions
  lobby/           Room registry, room codes, membership, host migration, persistence
  sim/             Mission simulation: physics world, players, props, doors, interactables,
                   extraction, hazards, director (random events), rewards
  sim/ai/          Navigation grid + A*, perception, monster behaviours (8 types)
shared/            Code used by both sides (pure, deterministic, no DOM / no Node APIs)
  rng.ts           Seeded PRNG (sfc32) + hashing
  protocol.ts      Message types + binary codecs
  levelgen/        Deterministic facility generator → LevelData
  physics/         Collider list built from LevelData (same on both sides)
  catalog/         Valuables, shop items, monsters, maps, difficulties, achievements
  assets/          models.json / textures.json manifests produced by the asset pipeline
tools/             Asset pipeline, creature mesh builder, dev runner, server bundler
tests/             unit/, integration/ (multi-client bots), e2e/ (Playwright)
```

## 3. Runtime topology

```
 Browser A ──┐  WebSocket (JSON control + binary state)   ┌──────────────────────────┐
 Browser B ──┼───────────────────────────────────────────▶│ Node server              │
 Browser C ──┘                                             │  • static file server    │
     ▲  ▲                                                  │  • lobby / room registry │
     │  └──── WebRTC audio (P2P mesh, signalled via WS) ───│  • per-room simulation   │
     └─────── voice relay fallback (ADPCM over WS) ───────▶│  • SQLite persistence    │
                                                           └──────────────────────────┘
```

* One process serves the built client and the `/ws` endpoint on the same port, so a single
  deployment is all that's needed. Players only need the URL.
* Every mode — including solo and practice — runs through the server. There is one code
  path, so solo play exercises exactly the same systems as multiplayer.

## 4. Authority model

| State | Authority | Notes |
|---|---|---|
| Lobby membership, host, ready flags | Server | host migrates to the longest-connected member |
| Level layout | Shared deterministic generator | server sends `{map, seed, difficulty}`; both sides generate identical `LevelData` |
| Local player movement | Client-predicted, server-validated | server checks speed, penetration and teleports, sends corrections (reconciliation) |
| Player health, downed/dead state | Server | damage is only ever applied by the server |
| Free (unheld) props | Server physics | Rapier on server; snapshots to clients |
| Held props | Owning client (network ownership) | owner simulates the grab spring locally for zero-latency carrying; server validates the reported pose (reach, speed, penetration) and drives a kinematic proxy so other bodies and monsters react |
| Co-carrying | Owner simulates, helpers' hold targets relayed | each helper's spring force is applied in the owner's simulation |
| Prop value and damage | Server | impacts detected by whichever side simulates; client impact reports are validated and rate-limited |
| Monsters | Server | AI, navigation, perception, attacks |
| Doors, switches, power, elevators, tubes, lift | Server | clients send interaction requests |
| Mission state, quota, extraction, rewards | Server | rewards written to SQLite in one transaction, idempotent per (mission, player) |
| Currency, purchases, unlocks | Server | client never sends amounts, only intents |

### Ownership rules for props
1. A grab request is validated: the prop exists, isn't destroyed or sold, is within reach
   (≤ 3.2 m from the eye), and has line of sight.
2. If the prop is unowned, the requester becomes **owner**. If it already has an owner, the
   requester becomes a **helper** (max 3 helpers). At most one owner exists at any time.
3. The owner streams the prop pose at 30 Hz. The server rejects poses farther than reach + slack
   from the owner, or implying speeds over the cap; after repeated rejections ownership is revoked.
4. Release (drop/throw) carries the final pose and velocity; the server converts the body back
   to dynamic with that velocity (throw speed is capped by mass and strength).
5. If the owner disconnects or goes down, the prop reverts to server simulation and the
   longest-holding helper (if any) is promoted to owner.

## 5. Networking

* Transport: one WebSocket per client. **Text frames** carry JSON control messages (reliable,
  rare). **Binary frames** carry high-frequency state (`shared/protocol.ts`).
* Rates: server tick 30 Hz (physics 60 Hz, 2 sub-steps), snapshots 30 Hz; client state 30 Hz.
* Snapshot content: all players; enemies (pos, yaw, anim state, speed); **props only while
  awake or when their state changed** (a prop that falls asleep is sent once at rest, then
  omitted). Positions are float32, rotations are quantised quaternions (int16 ×4).
* Clock sync: NTP-style ping/pong, smoothed offset. Remote entities render at
  `serverTime − interpDelay` (adaptive 80–200 ms based on measured jitter) using
  buffered Hermite/slerp interpolation, with capped extrapolation when packets are late.
* Ownership hand-offs use error smoothing (the visual offset decays over ~150 ms) so props
  never visibly snap.
* Reliability: control messages carry a sequence number; interaction requests carry a client
  request id so duplicates are ignored (prevents duplicated pickups and double purchases).
* Reconnection: a dropped client keeps its slot for 90 s. Its avatar freezes and shows
  "connection lost". Rejoining with the same identity restores health, inventory and
  position, and the client receives a full state snapshot.
* Server restart: lobbies (code, members, host, settings) are persisted to SQLite and restored
  on boot. Clients reconnect automatically with exponential backoff and rejoin their lobby.
  A mission that was running when the server died is reported as aborted, and no progress
  is lost, because profile changes only happen in transactions at mission end or purchase.

## 6. Level generation (`shared/levelgen`)

Facilities are assembled from curated **room modules** on a 4 m tile grid, per floor
(floors are 6 m apart).

1. Place the extraction **Lift Bay** module.
2. Grow outward by attaching modules to open doorway sockets, with weighted picks from the
   map theme's module pool and overlap checks against occupied tiles.
3. Add stairwells/elevator shafts and grow the extra floor(s) from them.
4. Add loop connections between adjacent rooms (extra doors) so layouts aren't pure trees.
5. Lock 1–2 leaf rooms (security doors). Place their keycards in rooms reachable without
   passing through any locked door (verified by BFS).
6. Mark one or two **hidden rooms** reachable only through a secret passage (breakable panel
   or sliding bookcase).
7. Furnish each room from its type's placement rules (static furniture colliders, dynamic
   furniture, valuable spawn slots, light fixtures, hazards, documents).
8. Distribute valuables with a value budget scaled by difficulty and quota.

`LevelData` holds rooms, tiles, walls with openings, doors, static colliders (boxes and ramps),
light sources, interactables, hazard volumes, spawn points and props. Validation (in unit tests
and at runtime in dev mode) checks that every room is reachable, every keycard is obtainable,
every valuable sits in a reachable room, and the nav grid connects all floors.

## 7. Physics

* Server world: static level colliders, dynamic props (convex hulls from the asset manifest),
  kinematic player capsules (pushing light props), kinematic monster capsules (moved by a
  Rapier character controller), kinematic doors and elevator platforms.
* Client world: the same static colliders; props as kinematic bodies following interpolated
  snapshots, except props the local player owns, which are dynamic and simulated locally.
* The player uses Rapier's kinematic character controller (autostep, snap-to-ground,
  slope limits) with custom acceleration, friction, jump and gravity for responsive movement.
* Grab: a critically-damped spring (force and torque) pulls the prop to the hold point. The
  force is clamped by the carrier's strength, so objects heavier than the carrier can lift
  drag on the floor, and two carriers can lift what one cannot.
* Light props (< 4 kg) don't block the player locally. The server's kinematic capsule
  pushes them, so you can kick junk around while heavy furniture still blocks you.

## 8. AI

* **Navigation**: per-floor 0.5 m occupancy grid built from `LevelData` (floors minus static
  colliders, door cells tagged), clearance via distance transform, stair/elevator links between
  floors. A* with octile heuristic, a binary heap and a node budget; paths are smoothed by
  line-of-sight string pulling. Doors: unlocked doors are opened by monsters (audible), locked
  doors block everything except the Brute (breaks them) and the Unknown (phases through walls).
* **Perception**: sight (cone + range + raycast, modulated by light level, flashlight, crouch)
  and hearing (noise events with loudness from footsteps, impacts, doors, voice activity,
  decoys; attenuated through walls). Each monster keeps memory (last known position,
  suspicion meter).
* **Behaviour**: hierarchical state machine per monster (idle, patrol, investigate, chase,
  attack, search, retreat, stunned + type-specific states). See `shared/catalog/monsters.ts`.

| Monster | Signature behaviour |
|---|---|
| Stalker ("Hollow Man") | patrols, follows targets room to room, persistent memory, searches last known position |
| Mimic ("Echo") | emits fake sounds (footsteps, item clinks, door creaks, crew chirps) to lure players; shrieks and flees when lit; ambushes from behind |
| Brute ("Bulwark") | slow, breaks doors, shoves props (damaging valuables), ground-slam knockback |
| Lurker ("Hanger") | nests on ceilings in dark rooms, drops on isolated players and pins them; repelled by light |
| Watcher ("Iris") | ceiling sentinel with a visible gaze cone; moving inside it fills a lock meter; a full lock marks you for every monster |
| Swarm ("Mites") | coordinated pack of small fast creatures (boids), scatter from loud noise, can be killed by thrown objects |
| Hunter ("Hound") | blind, hunts by sound; prioritises isolated players; standing still and quiet near it is survivable |
| Unknown ("The Visitor") | rare; appears in overtime or after taking a cursed artifact; drifts through walls toward the richest carrier; can only be escaped |

## 9. Mission loop

`LOBBY → BRIEFING (load + generate) → IN_MISSION → EXTRACTING → RESULTS → LOBBY`

* **Quota**: the team must bank at least the quota value to succeed.
* **Freight Lift** at spawn: valuables inside its cargo zone count toward the quota (live LED
  board). When the quota is met, anyone can pull the departure lever: a 12 s countdown starts,
  doors close, and anyone outside is left behind (MIA, reduced share).
* **Pneumatic cargo tubes** around the facility send small items (≤ 12 kg) up immediately
  (value is secured even if the team later wipes) but need power restored first.
* **Overtime**: after the contract window, events intensify and the Unknown may manifest.
* Rewards are computed on the server only: `payout = Σ extracted × difficulty × streak bonus +
  objectives`, split evenly plus a 5% personal-delivery bonus; XP from value, objectives,
  revives, discoveries. Written transactionally and idempotently.

## 10. Progression and persistence

* Identity: on first connect the server issues a player id plus a 256-bit secret token
  (stored hashed). The client keeps the token in `localStorage` and can export it as a
  recovery code (Settings → Profile).
* Profile JSON (versioned) in SQLite: level, XP, currency, inventory, unlocks, cosmetics,
  loadout, statistics, achievements. Purchases and rewards run in `BEGIN IMMEDIATE`
  transactions; a `ledger` table records every economy change with a unique key for idempotency.
* Shop items all have gameplay functions (see `shared/catalog/items.ts`).

## 11. Rendering

* Linear workflow, ACES filmic tone mapping, sRGB output.
* PBR materials from CC0 texture sets (albedo / normal / packed AO-rough-metal) with world-space
  UVs for architecture so tiling is seamless across modules.
* **Light pool**: a fixed set of N spot/point lights (N by quality preset) is assigned each
  frame to the most relevant level light sources (distance, visibility, intensity). The light
  count never changes, so shaders never recompile. Assignments fade to avoid popping. The
  nearest K lights cast shadows (PCF soft).
* **Portal culling**: rooms are visible only if reachable from the camera's room through
  doorway portals inside the view frustum (depth-limited BFS). This is the game's occlusion
  culling, and it also feeds the light pool.
* Post stack (quality-scaled): SSAO (GTAO), bloom (high threshold), filmic pass (vignette,
  grain, chromatic aberration on damage, colour grade), SMAA/FXAA, render-scale resolution.
* Atmosphere: exponential fog, additive volumetric light cones on fixtures and flashlights,
  dust motes in light, sparks, steam, dripping water.
* Static architecture is merged per room per material; repeated props are instanced; models
  carry two LODs.

## 12. Audio

Web Audio graph: sources → per-category gain (SFX / ambience / music / voice / UI) → master.
3D sounds use HRTF `PannerNode`s with distance attenuation and occlusion low-pass (raycast).
Every sound effect is **synthesised procedurally at load time** (modal synthesis for impacts
by material and mass, filtered noise for footsteps by surface, FM creaks for doors, formant
synthesis for monster vocalisations). That makes all audio original. Convolution reverb uses
generated impulse responses per map. A music director layers tension and chase stems
according to threat level.

**Voice chat**: WebRTC audio mesh (STUN, optional TURN from server config) signalled over the
game socket; each remote voice goes through a panner at the speaker's head (proximity) with
per-player mute and volume. If a peer connection can't be established, voice falls back to a
server relay (16 kHz IMA-ADPCM over WebSocket). Talking makes noise that monsters can hear,
if the host enables it.

## 13. Security / validation summary

Server-side checks: token authentication; room membership on every message; per-message-type
rate limits; movement speed/teleport/penetration validation; grab reach + line of sight;
single ownership per prop; held-pose validation; interaction distance + state checks; damage
and rewards only from server logic; purchases validated against price, level, stack limits;
idempotent rewards (unique ledger keys); dev commands only when the server runs with
`DEV_MODE=1`.

## 14. Developer mode

Open the client with `?dev=1` and press **F1**. The overlay shows FPS/frame time, ping/jitter,
bandwidth, player count, physics collider wireframes, nav grid, monster states and paths,
prop ids/owners/values, and mission state. Commands (`spawn`, `enemy`, `event`, `quota`,
`tp`, `god`, `heal`, `kill`, `power`) are executed by the server only if it runs with
`DEV_MODE=1`.
