import type { Appearance, Loadout } from './catalog/items';
import type { MapId } from './catalog/maps';

export interface ProfileStats {
  missions: number;
  successes: number;
  failures: number;
  extractions: number;        // times personally aboard at departure
  objectsCollected: number;   // valuables delivered
  valueRecovered: number;
  playtime: number;           // seconds in missions
  enemiesEncountered: number;
  teammatesRescued: number;
  downs: number;
  deaths: number;
  documentsRead: number;
  powerRestored: number;
  tubesSent: number;
  stuns: number;
  bestHaul: number;
  bestStreak: number;
  heaviestItem: number;
  highestDifficulty: number;
  fastestSuccess: number;     // seconds (0 = none)
  longestMission: number;
  mapsCompleted: Partial<Record<MapId, number>>;
}

export interface MissionLogEntry { id: string; map: MapId; difficulty: number; success: boolean; value: number; earned: number; xp: number; at: number; crew: number }

export interface Profile {
  version: number;
  id: string;
  name: string;
  level: number;
  xp: number;
  currency: number;
  /** consumable counts */
  inventory: Record<string, number>;
  /** owned non-consumables (lights, tools, gear, cosmetics) */
  owned: string[];
  loadout: Loadout;
  appearance: Appearance;
  achievements: Record<string, number>;
  stats: ProfileStats;
  missionLog: MissionLogEntry[];
  created: number;
  updated: number;
}

export function emptyStats(): ProfileStats {
  return {
    missions: 0, successes: 0, failures: 0, extractions: 0, objectsCollected: 0, valueRecovered: 0, playtime: 0,
    enemiesEncountered: 0, teammatesRescued: 0, downs: 0, deaths: 0, documentsRead: 0, powerRestored: 0, tubesSent: 0,
    stuns: 0, bestHaul: 0, bestStreak: 0, heaviestItem: 0, highestDifficulty: -1, fastestSuccess: 0, longestMission: 0, mapsCompleted: {},
  };
}

export const PROFILE_VERSION = 2;
