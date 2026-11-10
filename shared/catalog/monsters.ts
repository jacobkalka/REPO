// Monster definitions. Behaviour lives in server/src/sim/ai/monsters/*, visuals in
// client/src/models/creatures/*. Speeds in m/s, ranges in m.

export type MonsterId = 'stalker' | 'mimic' | 'brute' | 'lurker' | 'watcher' | 'swarm' | 'hunter' | 'unknown';

export interface MonsterDef {
  id: MonsterId;
  name: string;
  codename: string;
  description: string;
  health: number;
  radius: number;
  height: number;
  walkSpeed: number;
  chaseSpeed: number;
  damage: number;
  attackRange: number;
  attackCooldown: number;
  sightRange: number;
  sightFov: number;     // degrees, full cone
  hearing: number;      // multiplier on noise loudness
  threat: number;       // director budget cost
  minDifficulty: number;
  maxCount: number;
  stunnable: boolean;
  /** can be killed by impacts / prods */
  killable: boolean;
  /** members per spawn (swarm) */
  group?: number;
}

export const MONSTERS: Record<MonsterId, MonsterDef> = {
  stalker: {
    id: 'stalker', name: 'Hollow Man', codename: 'STALKER',
    description: 'A tall, emaciated figure that walks the halls on long patrols. Once it has your scent it follows you room to room, and it does not forget where it last saw you.',
    health: 260, radius: 0.42, height: 2.55, walkSpeed: 1.45, chaseSpeed: 4.6, damage: 34, attackRange: 1.7, attackCooldown: 1.6,
    sightRange: 22, sightFov: 110, hearing: 1.0, threat: 3, minDifficulty: 0, maxCount: 2, stunnable: true, killable: false,
  },
  mimic: {
    id: 'mimic', name: 'Echo', codename: 'MIMIC',
    description: 'A crouched thing with a swollen throat. It copies the sounds of the facility: footsteps, falling valuables, a crewmate\'s chirp. Shine a light on it and it screams for every creature nearby.',
    health: 80, radius: 0.36, height: 0.95, walkSpeed: 1.6, chaseSpeed: 5.4, damage: 18, attackRange: 1.3, attackCooldown: 1.2,
    sightRange: 12, sightFov: 150, hearing: 1.2, threat: 2, minDifficulty: 0, maxCount: 2, stunnable: true, killable: true,
  },
  brute: {
    id: 'brute', name: 'Bulwark', codename: 'BRUTE',
    description: 'A hulking, armoured knuckle-walker. Slow, but it smashes through locked doors, scatters anything in its path and slams the floor hard enough to throw you off your feet.',
    health: 900, radius: 0.85, height: 2.6, walkSpeed: 1.3, chaseSpeed: 3.5, damage: 55, attackRange: 2.4, attackCooldown: 2.4,
    sightRange: 18, sightFov: 100, hearing: 0.9, threat: 4, minDifficulty: 0, maxCount: 1, stunnable: true, killable: false,
  },
  lurker: {
    id: 'lurker', name: 'Hanger', codename: 'LURKER',
    description: 'A many-limbed shape that nests on the ceilings of dark rooms. It drops onto anyone who wanders off alone and pins them until a teammate drives it off. Light makes it flee.',
    health: 140, radius: 0.5, height: 1.0, walkSpeed: 2.2, chaseSpeed: 5.0, damage: 9, attackRange: 1.2, attackCooldown: 0.5,
    sightRange: 8, sightFov: 360, hearing: 1.1, threat: 3, minDifficulty: 0, maxCount: 2, stunnable: true, killable: true,
  },
  watcher: {
    id: 'watcher', name: 'Iris', codename: 'WATCHER',
    description: 'A cluster of lenses hanging from the ceiling, sweeping a pale gaze across the room. It cannot see you if you keep still. Move inside its gaze too long and it marks you for every hunter in the building.',
    health: 999, radius: 0.5, height: 1.4, walkSpeed: 0.9, chaseSpeed: 0.9, damage: 0, attackRange: 0, attackCooldown: 99,
    sightRange: 17, sightFov: 46, hearing: 0, threat: 2, minDifficulty: 0, maxCount: 2, stunnable: true, killable: false,
  },
  swarm: {
    id: 'swarm', name: 'Mites', codename: 'SWARM',
    description: 'Fist-sized skittering scavengers that hunt in packs. Each bite is small; there are many of them. Loud noises scatter them, and a well-thrown object crushes one.',
    health: 12, radius: 0.18, height: 0.3, walkSpeed: 2.6, chaseSpeed: 6.0, damage: 4, attackRange: 0.85, attackCooldown: 0.7,
    sightRange: 11, sightFov: 220, hearing: 1.3, threat: 3, minDifficulty: 0, maxCount: 1, stunnable: true, killable: true, group: 7,
  },
  hunter: {
    id: 'hunter', name: 'Hound', codename: 'HUNTER',
    description: 'Blind, fast and relentless. It hunts by sound alone and prefers prey that has strayed from the group. Freeze and it may pass you by.',
    health: 320, radius: 0.48, height: 1.25, walkSpeed: 1.9, chaseSpeed: 6.9, damage: 30, attackRange: 1.6, attackCooldown: 1.3,
    sightRange: 0, sightFov: 0, hearing: 1.6, threat: 4, minDifficulty: 1, maxCount: 1, stunnable: true, killable: false,
  },
  unknown: {
    id: 'unknown', name: 'The Visitor', codename: 'UNKNOWN',
    description: 'Not on any manifest. It appears when a crew stays too long or takes something it should not have. It drifts through walls toward whoever carries the most, and nothing stops it.',
    health: 99999, radius: 0.5, height: 2.9, walkSpeed: 1.15, chaseSpeed: 1.6, damage: 999, attackRange: 1.3, attackCooldown: 3,
    sightRange: 999, sightFov: 360, hearing: 0, threat: 0, minDifficulty: 0, maxCount: 1, stunnable: false, killable: false,
  },
};

export const MONSTER_LIST = Object.values(MONSTERS);
export const MONSTER_INDEX: MonsterId[] = ['stalker', 'mimic', 'brute', 'lurker', 'watcher', 'swarm', 'hunter', 'unknown'];

/** AI state ids shared with the client for animation and the debug overlay */
export const AI_STATES = ['idle', 'patrol', 'investigate', 'chase', 'attack', 'search', 'retreat', 'stunned', 'ambush', 'drop', 'pin', 'mark', 'flee', 'lure', 'phase', 'dead', 'smash', 'sniff'] as const;
export type AIState = (typeof AI_STATES)[number];
export const AI_STATE_INDEX: Record<AIState, number> = Object.fromEntries(AI_STATES.map((s, i) => [s, i])) as Record<AIState, number>;
