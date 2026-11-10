// Server-authoritative economy: profiles, purchases, loadouts, rewards, achievements.
// Clients only send intents; every amount is computed here.

import { ACHIEVEMENT_BY_ID, ACHIEVEMENTS } from '../../../shared/catalog/achievements';
import { DIFFICULTIES, streakRewardMult } from '../../../shared/catalog/difficulty';
import { COSMETIC_BY_ID, DEFAULT_APPEARANCE, DEFAULT_LOADOUT, FREE_COSMETICS, ITEM_BY_ID, SLOT_TYPES, type Appearance, type Loadout, type LoadoutSlot } from '../../../shared/catalog/items';
import type { MapId } from '../../../shared/catalog/maps';
import { MAX_LEVEL, xpForLevel } from '../../../shared/constants';
import { emptyStats, PROFILE_VERSION, type Profile } from '../../../shared/profile';
import { sanitizeName } from '../../../shared/protocol';
import type { GameDatabase, LedgerEntry } from '../db/Database';
import { log } from '../log';

export class EconomyError extends Error {
  constructor(public code: string, msg: string) { super(msg); }
}

export function newProfile(id: string, name: string): Profile {
  return {
    version: PROFILE_VERSION, id, name: sanitizeName(name), level: 1, xp: 0, currency: 1500,
    inventory: { medkit: 2, flare: 3, battery: 1, glowstick: 4 },
    owned: ['light_t1', ...FREE_COSMETICS],
    loadout: { ...DEFAULT_LOADOUT }, appearance: { ...DEFAULT_APPEARANCE },
    achievements: {}, stats: emptyStats(), missionLog: [], created: Date.now(), updated: Date.now(),
  };
}

/** bring old profiles up to date */
export function migrateProfile(p: Profile): Profile {
  if (!p.stats) p.stats = emptyStats();
  p.stats = { ...emptyStats(), ...p.stats };
  if (!p.inventory) p.inventory = {};
  if (!p.owned) p.owned = ['light_t1'];
  for (const c of FREE_COSMETICS) if (!p.owned.includes(c)) p.owned.push(c);
  if (!p.loadout) p.loadout = { ...DEFAULT_LOADOUT };
  p.loadout = { ...DEFAULT_LOADOUT, ...p.loadout };
  if (!p.appearance) p.appearance = { ...DEFAULT_APPEARANCE };
  if (!p.achievements) p.achievements = {};
  if (!p.missionLog) p.missionLog = [];
  p.version = PROFILE_VERSION;
  return p;
}

export interface MissionSummaryPlayer {
  playerId: string;
  state: 'alive' | 'downed' | 'dead' | 'extracted' | 'left';
  delivered: number;
  items: number;
  revives: number;
  downs: number;
  died: boolean;
  documents: number;
  powerRestored: number;
  tubesSent: number;
  stuns: number;
  heaviest: number;
  spotted: boolean;
  hpAtEnd: number;
  coCarry3: boolean;
  pristineFragile: boolean;
  enemiesSeen: number;
  damageTaken: number;
  aloneSurvivor: boolean;
}

export interface MissionSummary {
  mid: string;
  map: MapId;
  difficulty: number;
  crew: number;
  streak: number;
  success: boolean;
  extracted: number;
  tubed: number;
  duration: number;
  unknownAppeared: boolean;
  players: MissionSummaryPlayer[];
}

export interface RewardResult { earned: number; xp: number; levelBefore: number; levelAfter: number; newAchievements: string[]; profile: Profile }

export class Economy {
  /** profiles of connected players, the canonical in-memory copy */
  private cache = new Map<string, Profile>();
  private pendingSaves = new Map<string, { profile: Profile; ledger: LedgerEntry[] }>();

  constructor(readonly db: GameDatabase) {
    setInterval(() => this.flushPending(), 5000).unref?.();
  }

  get(id: string): Profile | null {
    let p = this.cache.get(id);
    if (!p) {
      const loaded = this.db.loadProfile(id);
      if (!loaded) return null;
      p = migrateProfile(loaded);
      this.cache.set(id, p);
    }
    return p;
  }

  remember(p: Profile) { this.cache.set(p.id, migrateProfile(p)); }
  forget(id: string) { if (!this.pendingSaves.has(id)) this.cache.delete(id); }

  /** persist; on failure keep it queued and retry (no progression is lost) */
  private persist(p: Profile, ledger: LedgerEntry[] = []): boolean {
    try {
      const ok = this.db.saveProfile(p, ledger);
      if (!ok) throw new EconomyError('duplicate', 'This transaction was already processed.');
      return true;
    } catch (e) {
      if (e instanceof EconomyError) throw e;
      log.error('profile save failed, queued for retry', p.id, e);
      this.pendingSaves.set(p.id, { profile: p, ledger });
      return false;
    }
  }

  private flushPending() {
    for (const [id, s] of [...this.pendingSaves]) {
      try {
        this.db.saveProfile(s.profile, s.ledger.filter((l) => !this.db.ledgerHas(l.key)));
        this.pendingSaves.delete(id);
        log.info('queued profile save succeeded', id);
      } catch (e) { log.warn('retry save failed', id, e); }
    }
  }

  setName(id: string, name: string): Profile {
    const p = this.mustGet(id);
    p.name = sanitizeName(name);
    this.persist(p);
    return p;
  }

  private mustGet(id: string): Profile {
    const p = this.get(id);
    if (!p) throw new EconomyError('no_profile', 'Profile not found');
    return p;
  }

  owns(p: Profile, item: string): boolean {
    return p.owned.includes(item);
  }

  purchase(id: string, itemId: string, req: number): Profile {
    const p = this.mustGet(id);
    const key = `buy:${id}:${req}:${itemId}`;
    if (this.db.ledgerHas(key)) return p; // duplicate request (e.g. resend after reconnect)
    const item = ITEM_BY_ID[itemId];
    const cos = COSMETIC_BY_ID[itemId];
    if (!item && !cos) throw new EconomyError('unknown_item', 'Unknown item');
    const price = item ? item.price : cos!.price;
    const unlock = item ? item.unlockLevel : cos!.unlockLevel;
    if (p.level < unlock) throw new EconomyError('locked', `Requires level ${unlock}`);
    if (cos?.achievement) throw new EconomyError('achievement_only', 'Unlocked through an achievement');
    if (p.currency < price) throw new EconomyError('funds', 'Not enough credits');
    if (item && item.type === 'consumable') {
      const have = p.inventory[itemId] ?? 0;
      if (have >= (item.maxStack ?? 1)) throw new EconomyError('stack', 'You are carrying the maximum');
      p.inventory[itemId] = have + 1;
    } else {
      if (this.owns(p, itemId)) throw new EconomyError('owned', 'Already owned');
      p.owned.push(itemId);
    }
    p.currency -= price;
    this.persist(p, [{ key, kind: 'purchase', amount: -price, detail: itemId }]);
    return p;
  }

  setLoadout(id: string, loadout: Loadout): Profile {
    const p = this.mustGet(id);
    const clean: Loadout = { ...DEFAULT_LOADOUT };
    const used = new Set<string>();
    for (const slot of Object.keys(SLOT_TYPES) as LoadoutSlot[]) {
      const v = loadout?.[slot];
      if (v === null || v === undefined || v === '') { clean[slot] = null; continue; }
      const item = ITEM_BY_ID[v];
      if (!item || item.type !== SLOT_TYPES[slot]) throw new EconomyError('bad_slot', `${v} cannot go in ${slot}`);
      if (item.type === 'consumable') { if (!((p.inventory[v] ?? 0) > 0)) throw new EconomyError('none_left', `You have no ${item.name}`); }
      else if (!this.owns(p, v)) throw new EconomyError('not_owned', `You don't own ${item.name}`);
      if (used.has(v)) throw new EconomyError('duplicate', `${item.name} is already equipped`);
      used.add(v);
      clean[slot] = v;
    }
    if (!clean.light) clean.light = 'light_t1';
    p.loadout = clean;
    this.persist(p);
    return p;
  }

  setAppearance(id: string, a: Appearance): Profile {
    const p = this.mustGet(id);
    const out = { ...p.appearance };
    for (const slot of ['suit', 'helmet', 'visor', 'patch'] as const) {
      const v = a?.[slot];
      if (!v) continue;
      const c = COSMETIC_BY_ID[v];
      if (!c || c.slot !== slot) throw new EconomyError('bad_cosmetic', 'Invalid cosmetic');
      const unlocked = this.owns(p, v) || (c.achievement && p.achievements[c.achievement]);
      if (!unlocked) throw new EconomyError('not_owned', `${c.name} is locked`);
      out[slot] = v;
    }
    p.appearance = out;
    this.persist(p);
    return p;
  }

  /** consume a consumable immediately when used in a mission (crash-safe) */
  consume(id: string, itemId: string, missionId: string, n: number): boolean {
    const p = this.get(id);
    if (!p) return false;
    const have = p.inventory[itemId] ?? 0;
    if (have <= 0) return false;
    p.inventory[itemId] = have - 1;
    if (p.inventory[itemId] <= 0) {
      delete p.inventory[itemId];
      for (const s of Object.keys(p.loadout) as LoadoutSlot[]) if (p.loadout[s] === itemId) p.loadout[s] = null;
    }
    try { this.persist(p, [{ key: `use:${missionId}:${id}:${itemId}:${n}`, kind: 'consume', amount: 0, detail: itemId }]); }
    catch (e) { if (!(e instanceof EconomyError)) throw e; }
    return true;
  }

  /** compute and apply mission rewards for every player; idempotent per (mission, player) */
  applyMission(summary: MissionSummary): Map<string, RewardResult> {
    const out = new Map<string, RewardResult>();
    const d = DIFFICULTIES[Math.max(0, Math.min(3, summary.difficulty))];
    const streakMult = streakRewardMult(summary.streak);
    const pool = summary.success
      ? (summary.extracted + summary.tubed) * d.rewardMult * streakMult
      : summary.tubed * 0.5 * d.rewardMult;
    const share = pool / Math.max(1, summary.crew);
    for (const sp of summary.players) {
      const p = this.get(sp.playerId);
      if (!p) continue;
      const key = `reward:${summary.mid}:${sp.playerId}`;
      if (this.db.ledgerHas(key)) continue;
      let earned = 0;
      if (sp.state !== 'left') {
        const factor = sp.state === 'extracted' || (summary.success && sp.state === 'alive') ? 1 : 0.5;
        earned = Math.round(share * factor + sp.delivered * 0.05 * (summary.success ? 1 : 0.5));
      }
      let xp = 0;
      if (sp.state !== 'left') {
        xp = 120 + (summary.success ? 300 : 0) + Math.floor((summary.extracted + summary.tubed) / Math.max(1, summary.crew) / 45) + sp.revives * 60 + sp.documents * 25 + sp.powerRestored * 20 + sp.items * 6;
        xp = Math.round(xp * d.xpMult);
      }
      const st = p.stats;
      st.missions++;
      if (summary.success) st.successes++; else st.failures++;
      if (sp.state === 'extracted') st.extractions++;
      st.objectsCollected += sp.items;
      st.valueRecovered += Math.round(sp.delivered);
      st.playtime += Math.round(summary.duration);
      st.enemiesEncountered += sp.enemiesSeen;
      st.teammatesRescued += sp.revives;
      st.downs += sp.downs;
      st.deaths += sp.died ? 1 : 0;
      st.documentsRead += sp.documents;
      st.powerRestored += sp.powerRestored;
      st.tubesSent += sp.tubesSent;
      st.stuns += sp.stuns;
      st.heaviestItem = Math.max(st.heaviestItem, sp.heaviest);
      st.longestMission = Math.max(st.longestMission, Math.round(summary.duration));
      if (summary.success) {
        st.bestHaul = Math.max(st.bestHaul, Math.round(summary.extracted + summary.tubed));
        st.bestStreak = Math.max(st.bestStreak, summary.streak + 1);
        st.highestDifficulty = Math.max(st.highestDifficulty, summary.difficulty);
        st.mapsCompleted[summary.map] = (st.mapsCompleted[summary.map] ?? 0) + 1;
        if (!st.fastestSuccess || summary.duration < st.fastestSuccess) st.fastestSuccess = Math.round(summary.duration);
      }
      const levelBefore = p.level;
      p.currency += earned;
      const ledger: LedgerEntry[] = [{ key, kind: 'reward', amount: earned, detail: summary.mid }];
      const newAch = this.evaluateAchievements(p, summary, sp);
      for (const a of newAch) {
        const def = ACHIEVEMENT_BY_ID[a];
        p.achievements[a] = Date.now();
        p.currency += def.reward;
        xp += def.xp;
        ledger.push({ key: `ach:${p.id}:${a}`, kind: 'achievement', amount: def.reward, detail: a });
      }
      this.addXp(p, xp, ledger, summary.mid);
      // achievements that depend on level
      for (const [a, lvl] of [['seasoned', 10], ['veteran', 25]] as const) {
        if (!p.achievements[a] && p.level >= lvl) { p.achievements[a] = Date.now(); p.currency += ACHIEVEMENT_BY_ID[a].reward; newAch.push(a); ledger.push({ key: `ach:${p.id}:${a}`, kind: 'achievement', amount: ACHIEVEMENT_BY_ID[a].reward, detail: a }); }
      }
      p.missionLog.unshift({ id: summary.mid, map: summary.map, difficulty: summary.difficulty, success: summary.success, value: Math.round(summary.extracted + summary.tubed), earned, xp, at: Date.now(), crew: summary.crew });
      p.missionLog = p.missionLog.slice(0, 25);
      try { this.persist(p, ledger); } catch (e) { if (e instanceof EconomyError) continue; throw e; }
      out.set(p.id, { earned, xp, levelBefore, levelAfter: p.level, newAchievements: newAch, profile: p });
    }
    return out;
  }

  private addXp(p: Profile, xp: number, ledger: LedgerEntry[], mid: string) {
    p.xp += Math.max(0, Math.round(xp));
    while (p.level < MAX_LEVEL && p.xp >= xpForLevel(p.level)) {
      p.xp -= xpForLevel(p.level);
      p.level++;
      const bonus = 200 + 50 * p.level;
      p.currency += bonus;
      ledger.push({ key: `level:${p.id}:${p.level}:${mid}`, kind: 'levelup', amount: bonus, detail: String(p.level) });
    }
    if (p.level >= MAX_LEVEL) p.xp = Math.min(p.xp, xpForLevel(MAX_LEVEL));
  }

  private evaluateAchievements(p: Profile, s: MissionSummary, sp: MissionSummaryPlayer): string[] {
    const has = (a: string) => !!p.achievements[a];
    const got: string[] = [];
    const award = (a: string, cond: boolean) => { if (cond && !has(a) && ACHIEVEMENT_BY_ID[a]) got.push(a); };
    const st = p.stats;
    const aboard = sp.state === 'extracted';
    award('first_haul', s.success && aboard);
    award('heavy_lifter', s.success && sp.heaviest >= 60);
    award('many_hands', sp.coCarry3);
    award('medic', st.teammatesRescued >= 5);
    award('close_call', s.success && aboard && sp.hpAtEnd < 15);
    award('ghost', s.success && aboard && !sp.spotted);
    award('big_score', s.success && s.extracted + s.tubed >= 50000);
    award('millionaire', st.valueRecovered >= 1_000_000);
    award('black_contract', s.success && s.difficulty >= 3);
    award('tour', ['research', 'industrial', 'underground', 'luxury'].every((m) => (st.mapsCompleted[m as MapId] ?? 0) > 0));
    award('archivist', st.documentsRead >= 25);
    award('steady_hands', s.success && sp.pristineFragile);
    award('unknown', s.unknownAppeared && aboard);
    award('streak5', s.success && s.streak + 1 >= 5);
    award('lights_on', st.powerRestored >= 10);
    award('pneumatic', st.tubesSent >= 50);
    award('not_today', st.stuns >= 20);
    award('last_standing', s.success && aboard && sp.aloneSurvivor);
    return got;
  }

  /** dev-mode only */
  grant(id: string, credits: number, xp: number): Profile {
    const p = this.mustGet(id);
    p.currency += credits;
    const ledger: LedgerEntry[] = [{ key: `dev:${id}:${Date.now()}:${Math.random()}`, kind: 'dev', amount: credits }];
    this.addXp(p, xp, ledger, 'dev' + Date.now());
    this.persist(p, ledger);
    return p;
  }

  static achievementList() { return ACHIEVEMENTS; }
}
