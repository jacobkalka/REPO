// Shared tuning constants. Values used by both the client prediction and the server
// validation must live here so they never drift apart.

export const PROTOCOL_VERSION = 7;
export const GAME_VERSION = '1.0.0';

export const NET = {
  /** server simulation tick rate (Hz) */
  TICK_HZ: 30,
  /** physics sub-steps per tick (physics runs at 60 Hz) */
  PHYSICS_SUBSTEPS: 2,
  /** client → server state rate (Hz) */
  CLIENT_SEND_HZ: 30,
  /** base interpolation delay (s); adapts to jitter */
  INTERP_DELAY: 0.1,
  INTERP_DELAY_MIN: 0.07,
  INTERP_DELAY_MAX: 0.25,
  /** how long a disconnected player keeps their slot (s) */
  RECONNECT_GRACE: 90,
  /** empty lobbies are removed after this many seconds */
  LOBBY_IDLE_TIMEOUT: 30 * 60,
  MAX_PLAYERS: 4,
  HEARTBEAT_MS: 5000,
  /** connection considered dead after this long without data (ms) */
  TIMEOUT_MS: 15000,
} as const;

export const PLAYER = {
  RADIUS: 0.34,
  HEIGHT: 1.75,
  CROUCH_HEIGHT: 1.1,
  EYE_HEIGHT: 1.62,
  CROUCH_EYE_HEIGHT: 0.98,
  WALK_SPEED: 3.0,
  RUN_SPEED: 4.2,
  SPRINT_SPEED: 6.4,
  CROUCH_SPEED: 1.7,
  DOWNED_SPEED: 0.7,
  ACCEL_GROUND: 42,
  ACCEL_AIR: 9,
  FRICTION: 11,
  JUMP_VELOCITY: 5.4,
  GRAVITY: 19,
  MAX_FALL_SPEED: 40,
  STEP_HEIGHT: 0.42,
  MAX_SLOPE_DEG: 50,
  STAMINA_MAX: 100,
  STAMINA_DRAIN: 22,
  STAMINA_REGEN: 16,
  STAMINA_JUMP_COST: 8,
  MAX_HEALTH: 100,
  /** downed players bleed out after this many seconds */
  BLEEDOUT_TIME: 45,
  REVIVE_TIME: 3,
  REVIVE_HEALTH: 30,
  REVIVE_RANGE: 1.9,
  /** fall height (m) above which landing causes damage */
  SAFE_FALL: 4.2,
  FALL_DAMAGE_PER_M: 11,
  /** interaction / grab reach from the eye (m) */
  REACH: 3.2,
  /** base grab strength (newtons-ish budget of the spring) */
  STRENGTH: 420,
  BASE_CARRY_KG: 32,
  THROW_IMPULSE: 9.5,
} as const;

export const GRAB = {
  /** spring stiffness (1/s^2) and damping ratio of the hold spring */
  STIFFNESS: 95,
  DAMPING: 1.0,
  ANG_STIFFNESS: 55,
  ANG_DAMPING: 1.0,
  MIN_DIST: 1.0,
  MAX_DIST: 3.0,
  DEFAULT_DIST: 1.7,
  /** objects lighter than this don't block the local character (they get pushed server-side) */
  LIGHT_PROP_KG: 4,
  /** the server revokes ownership after this many consecutive invalid poses */
  MAX_INVALID_POSES: 8,
  MAX_HELPERS: 3,
  /** max linear speed a held prop may report (m/s) */
  MAX_HELD_SPEED: 22,
  MAX_THROW_SPEED: 20,
} as const;

export const WORLD = {
  TILE: 4,
  FLOOR_SPACING: 6,
  WALL_THICKNESS: 0.3,
  DOOR_WIDTH: 1.7,
  DOOR_HEIGHT: 2.45,
  GRAVITY: 9.81,
  NAV_CELL: 0.5,
} as const;

export const MISSION = {
  /** seconds before overtime starts, per difficulty index */
  CONTRACT_WINDOW: [1200, 1080, 960, 840],
  DEPARTURE_COUNTDOWN: 12,
  TUBE_MAX_KG: 12,
  TUBE_CYCLE_TIME: 4,
  /** physics settle time at mission start before players can act (s) */
  SETTLE_TIME: 1.2,
  /** below this fraction of base value a fragile prop shatters */
  BREAK_FRACTION: 0.12,
  /** minimum impact speed (m/s) that damages a valuable */
  DAMAGE_SPEED: 2.2,
} as const;

export const COLLISION = {
  // Rapier interaction groups: membership in high 16 bits, filter in low 16 bits.
  STATIC: 1 << 0,
  PROP: 1 << 1,
  PLAYER: 1 << 2,
  ENEMY: 1 << 3,
  DOOR: 1 << 4,
  HELD: 1 << 5,
  SENSOR: 1 << 6,
  DEBRIS: 1 << 7,
} as const;

export function groups(membership: number, filter: number): number {
  return ((membership & 0xffff) << 16) | (filter & 0xffff);
}

/** XP needed to go from level L to L+1 */
export function xpForLevel(level: number): number {
  return Math.round(400 + 220 * (level - 1) + 18 * (level - 1) ** 2);
}

export const MAX_LEVEL = 50;
