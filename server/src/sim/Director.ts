// Pacing director: monster spawning budget, random events, overtime and the Visitor.

import { MAPS, type MapTheme } from '../../../shared/catalog/maps';
import { MONSTERS, type MonsterId } from '../../../shared/catalog/monsters';
import { CREW_MONSTERS } from '../../../shared/catalog/difficulty';
import { VALUABLE_BY_ID } from '../../../shared/catalog/valuables';
import { modelSize } from '../../../shared/catalog/furniture';
import type { SnapMover, V3 } from '../../../shared/protocol';
import type { MPlayer } from './entities';
import type { Mission } from './Mission';
import { fmt } from './Mission';

type EventName = 'blackout' | 'surge' | 'lockdown' | 'loot' | 'ambush' | 'equipment' | 'sounds' | 'blackbox';

export class Director {
  tension = 0;
  private nextSpawnAt = 0;
  private nextEventAt = 0;
  private lockdowns = new Map<number, number>(); // door id → until
  private surgeUntil = 0;
  private alarmCooldown = new Map<number, number>();
  private cooldowns = new Map<EventName, number>();
  private unknownScheduledAt = 0;
  private unknownRoll = 0;
  private cursedBy: MPlayer | null = null;
  private blackoutRooms = new Set<number>();
  readonly theme: MapTheme | null;
  readonly maxThreat: number;

  constructor(readonly m: Mission) {
    this.theme = m.practice ? null : MAPS[m.map as keyof typeof MAPS] ?? null;
    const crew = Math.max(1, Math.min(4, m.players.size || m.level.crew));
    this.maxThreat = m.practice ? 0 : Math.max(4, Math.round((6 + 2.2 * m.difficulty) * m.diff.monsterBudget * CREW_MONSTERS[crew]));
  }

  get time() { return this.m.time; }

  begin() {
    if (this.m.practice) return;
    // initial population: ~45% of the budget, spread far from the lift
    let budget = this.maxThreat * 0.45;
    let guard = 0;
    while (budget > 0 && guard++ < 10) {
      const t = this.pickMonster();
      if (!t) break;
      if (this.m.ai.spawn(t) === null) break;
      budget -= MONSTERS[t].threat;
    }
    this.nextSpawnAt = this.time + this.jitter(75);
    this.nextEventAt = this.time + this.jitter(110) / this.m.diff.eventRate;
  }

  private jitter(base: number) { return base * (0.7 + Math.random() * 0.6); }

  private pickMonster(): MonsterId | null {
    const weights = this.theme?.monsterWeights ?? {};
    const options = (Object.keys(weights) as MonsterId[]).filter((t) => {
      const d = MONSTERS[t];
      if (d.minDifficulty > this.m.difficulty) return false;
      if (this.m.ai.countOf(t) >= d.maxCount + (this.m.difficulty >= 3 ? 1 : 0)) return false;
      return this.m.ai.threat() + d.threat <= this.maxThreat + 0.5;
    });
    if (!options.length) return null;
    return this.m.rng.weighted(options, (t) => weights[t] ?? 1);
  }

  onDamage(_pl: MPlayer, dmg: number) { this.tension = Math.min(100, this.tension + dmg * 0.6); }

  onOvertime() {
    this.m.emit({ k: 'sfx', s: 'overtime_bell', p: [this.m.level.extraction.lever.x, this.m.level.extraction.lever.y + 2, this.m.level.extraction.lever.z], v: 1, e: 1 });
    this.nextSpawnAt = Math.min(this.nextSpawnAt, this.time + 20);
  }

  cursedTaken(pl: MPlayer) {
    if (this.m.practice) return;
    this.cursedBy = pl;
    if (!this.unknownScheduledAt) this.unknownScheduledAt = this.time + 18;
    this.m.emit({ k: 'sfx', s: 'cursed', p: pl.eye, v: 1, e: 1 });
    this.m.emit({ k: 'msg', text: 'The temperature drops. Something noticed that.', kind: 'warn' });
  }

  summonUnknown(target?: MPlayer) {
    if ([...this.m.ai.enemies.values()].some((e) => e.type === 'unknown')) return;
    const p = this.m.ai.spawnPoint('unknown', 30) ?? this.m.ai.spawnPoint('unknown', 12);
    if (!p) return;
    const id = this.m.ai.spawn('unknown', p);
    if (id === null) return;
    const e = this.m.ai.enemies.get(id) as unknown as { forced: MPlayer | null };
    if (target) e.forced = target;
    this.m.unknownAppeared = true;
    this.m.emit({ k: 'director', name: 'unknown', on: true });
    this.m.emit({ k: 'msg', text: 'Dispatch: we are reading something on your floor that is not on the manifest. Leave. Now.', kind: 'dispatch' });
  }

  isLockedDown(doorId: number) { const u = this.lockdowns.get(doorId); return !!u && u > this.time; }
  blackoutRoom(room: number) { return this.blackoutRooms.has(room); }
  hazardBoost(kind: string) { return this.time < this.surgeUntil && (kind === 'sparks' || kind === 'water') ? 1.8 : 1; }

  alarmReady(hazardId: number) {
    const t = this.alarmCooldown.get(hazardId) ?? 0;
    if (this.time < t) return false;
    this.alarmCooldown.set(hazardId, this.time + 10);
    return true;
  }

  /** security lockdown: close and lock nearby doors temporarily */
  lockdown(room: number, duration = 28) {
    const r = this.m.level.rooms[room];
    if (!r) return;
    const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
    const near = this.m.doors.filter((d) => d.data.leaf && !d.broken && d.revealed && !d.locked && Math.hypot(d.data.x - cx, d.data.z - cz) < 22 && d.data.floor === r.floor);
    for (const d of near.slice(0, 5)) {
      this.lockdowns.set(d.data.id, this.time + duration);
      if (d.open) this.m.toggleDoor(d, [cx, cz], false, -1, true);
      this.m.emit({ k: 'door', id: d.data.id, open: false, locked: true, broken: false, by: -1 });
    }
    this.m.emit({ k: 'director', name: 'lockdown', on: true, until: this.time + duration, data: room });
  }

  private endLockdowns() {
    for (const [id, until] of [...this.lockdowns]) {
      if (this.time < until) continue;
      this.lockdowns.delete(id);
      const d = this.m.doors[id];
      if (d) this.m.emit({ k: 'door', id, open: d.open, locked: d.locked, broken: d.broken, by: -1 });
    }
  }

  movers(): SnapMover[] { return []; }

  trigger(name: string) { this.runEvent(name as EventName, true); }

  private runEvent(name: EventName, force = false): boolean {
    const m = this.m;
    if (!force && (this.cooldowns.get(name) ?? 0) > this.time) return false;
    const alive = [...m.players.values()].filter((p) => p.life === 'alive');
    if (!alive.length) return false;
    switch (name) {
      case 'blackout': {
        const powered = [...m.sectors].filter(([id, on]) => on && id !== 0).map(([id]) => id);
        if (!powered.length) return false;
        const s = m.rng.pick(powered);
        m.setPower(s, false, -1);
        m.emit({ k: 'msg', text: 'Power failure! A sector has gone dark. Find its breaker.', kind: 'warn' });
        this.cooldowns.set(name, this.time + 150);
        return true;
      }
      case 'surge':
        this.surgeUntil = this.time + 18;
        m.emit({ k: 'director', name: 'surge', on: true, until: this.surgeUntil });
        m.emit({ k: 'msg', text: 'Power surge. Stay away from live electrics.', kind: 'warn' });
        this.cooldowns.set(name, this.time + 120);
        return true;
      case 'lockdown': {
        const pl = m.rng.pick(alive);
        const room = m.nav.roomAt({ x: pl.pos[0], y: pl.pos[1], z: pl.pos[2] });
        if (room < 0) return false;
        this.lockdown(room, 26);
        m.emit({ k: 'msg', text: 'Security lockdown in progress. Doors sealed.', kind: 'warn' });
        m.emit({ k: 'sfx', s: 'alarm', p: pl.eye, v: 0.7, e: 1 });
        this.cooldowns.set(name, this.time + 160);
        return true;
      }
      case 'loot':
      case 'blackbox': {
        const theme = m.map === 'practice' ? 'industrial' : m.map;
        const def = name === 'blackbox' ? VALUABLE_BY_ID.black_box : m.rng.pick(Object.values(VALUABLE_BY_ID).filter((v) => v.themes.includes(theme as never) && (v.rarity === 'rare' || v.rarity === 'legendary') && v.mass < 60 && !v.cursed));
        if (!def) return false;
        const far = m.level.rooms.filter((r) => !r.corridor && !r.stair && r.type !== 'lift' && r.depth >= 3 && !r.locked);
        const room = far.length ? m.rng.pick(far) : null;
        if (!room) return false;
        const p = m.nav.randomPointInRoom(room.id, m.rng, 1);
        if (!p) return false;
        const value = Math.round(m.rng.range(def.value[0], def.value[1]) * 1.25 / 10) * 10;
        const prop = m.spawnProp(def.id, 'valuable', [p.x, p.y + modelSize(def.model)[1] / 2 + 0.1, p.z], [0, 0, 0, 1], value, room.id);
        if (!prop) return false;
        m.emit({ k: 'prop+', p: m.propState(prop) });
        m.emit({ k: 'sfx', s: 'valuable_chime', p: [p.x, p.y + 1, p.z], v: 1 });
        if (name === 'blackbox') {
          m.objectives.push({ id: 'blackbox', label: 'Recover the flight recorder', bonus: Math.round(2500 * m.diff.rewardMult), done: false, data: prop.id });
          m.emit({ k: 'msg', text: `New optional objective: recover the flight recorder from the ${room.name} (+${fmt(Math.round(2500 * m.diff.rewardMult))}).`, kind: 'dispatch' });
        } else m.emit({ k: 'msg', text: `Dispatch: high-value signal detected in the ${room.name}. ${def.name}, est. ${fmt(value)}.`, kind: 'dispatch' });
        this.cooldowns.set(name, this.time + 9999);
        return true;
      }
      case 'ambush': {
        const pl = alive.sort((a, b) => m.ai.isolation(b) - m.ai.isolation(a))[0];
        if (m.ai.isolation(pl) < 8 && alive.length > 1) return false;
        const t = this.pickMonster();
        if (!t) return false;
        const p = m.ai.randomPointNear({ x: pl.pos[0], y: pl.pos[1], z: pl.pos[2] }, 14);
        if (!p || m.physics.lineOfSight({ x: pl.eye[0], y: pl.eye[1], z: pl.eye[2] }, { x: p.x, y: p.y + 1.2, z: p.z })) return false;
        if (Math.hypot(p.x - pl.pos[0], p.z - pl.pos[2]) < 8) return false;
        if (m.ai.spawn(t, p) === null) return false;
        m.emit({ k: 'sfx', s: 'stinger', p: pl.eye, v: 0.8 });
        this.cooldowns.set(name, this.time + 140);
        return true;
      }
      case 'equipment': {
        const pl = m.rng.pick(alive);
        pl.battery = Math.max(0, pl.battery - pl.batteryMax * 0.35);
        m.sendItems(pl);
        m.emit({ k: 'director', name: 'torch', on: true, until: this.time + 4, data: pl.netId });
        pl.member.session?.send({ t: 'ev', e: [{ k: 'msg', text: 'Your torch sputters. The cell is draining fast.', kind: 'warn' }] });
        this.cooldowns.set(name, this.time + 100);
        return true;
      }
      case 'sounds': {
        const rooms = m.level.rooms.filter((r) => !r.stair && r.depth >= 2);
        const r = m.rng.pick(rooms);
        const p: V3 = [(r.x0 + r.x1) / 2, r.y + 1.5, (r.z0 + r.z1) / 2];
        const s = m.rng.pick(['distant_scream', 'distant_bang', 'distant_crash', 'metal_groan']);
        m.emit({ k: 'sfx', s, p, v: 1, r: 1 });
        m.noise(p, 0.9, 'event', -1);
        this.cooldowns.set(name, this.time + 45);
        return true;
      }
    }
    return false;
  }

  tick(dt: number) {
    const m = this.m;
    this.tension = Math.max(0, this.tension - dt * 2.2);
    this.endLockdowns();
    if (m.practice || m.time < m.startAt) return;
    // spawning
    if (this.time > this.nextSpawnAt) {
      const interval = (m.overtime ? 38 : 85) / m.diff.eventRate;
      this.nextSpawnAt = this.time + this.jitter(interval);
      if (this.tension < 55) {
        const t = this.pickMonster();
        if (t) m.ai.spawn(t);
      }
    }
    // random events
    if (this.time > this.nextEventAt) {
      this.nextEventAt = this.time + this.jitter(m.overtime ? 55 : 95) / m.diff.eventRate;
      if (this.tension < 70) {
        const options: [EventName, number][] = [['blackout', 2], ['surge', 1.2], ['lockdown', 1], ['loot', 1], ['ambush', 1.4 * m.diff.aggression], ['equipment', 1], ['sounds', 1.6], ['blackbox', m.time > 300 ? 0.8 : 0]];
        for (let i = 0; i < 3; i++) if (this.runEvent(m.rng.weighted(options, (o) => o[1])[0])) break;
      }
    }
    // the Visitor
    if (this.unknownScheduledAt && this.time > this.unknownScheduledAt) { this.unknownScheduledAt = 0; this.summonUnknown(this.cursedBy ?? undefined); }
    if (Math.floor(this.time / 60) !== this.unknownRoll) {
      this.unknownRoll = Math.floor(this.time / 60);
      const overtimeMin = m.overtime ? (this.time - m.overtimeAt) / 60 : -1;
      let p = 0;
      if (overtimeMin >= 0) p = 0.15 + overtimeMin * 0.12;
      if (m.difficulty >= 3 && this.time > 480) p = Math.max(p, 0.06);
      if (overtimeMin > 6) p = 1;
      if (p > 0 && Math.random() < p) this.summonUnknown();
    }
    // blackout rooms: rooms in unpowered sectors
    this.blackoutRooms.clear();
    for (const r of m.level.rooms) if (!m.sectors.get(r.sector)) this.blackoutRooms.add(r.id);
  }
}
