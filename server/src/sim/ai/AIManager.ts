import type RAPIER from '@dimforge/rapier3d-compat';
import { MONSTERS, type MonsterId } from '../../../../shared/catalog/monsters';
import type { HazardData, Vec3 } from '../../../../shared/levelgen/types';
import { PF, type SnapEnemy, type V3 } from '../../../../shared/protocol';
import { ITEM_BY_ID } from '../../../../shared/catalog/items';
import type { MPlayer, MProp } from '../entities';
import type { Mission } from '../Mission';
import { R } from '../Physics';
import { d3, type Enemy, flat, pv, v3 } from './Enemy';
import { Brute, Hunter, Lurker, Mimic, Stalker, SwarmGroup, SwarmMember, Unknown, Watcher } from './monsters';

export interface Noise { p: Vec3; loudness: number; kind: string; by: number; at: number }

export class AIManager {
  readonly enemies = new Map<number, Enemy>();
  readonly colliderToEnemy = new Map<number, Enemy>();
  readonly kcc: RAPIER.KinematicCharacterController;
  private nextId = 1;
  private noises: Noise[] = [];

  constructor(readonly mission: Mission) {
    this.kcc = mission.physics.world.createCharacterController(0.05);
    this.kcc.enableAutostep(0.45, 0.2, false);
    this.kcc.enableSnapToGround(0.6);
    this.kcc.setMaxSlopeClimbAngle((52 * Math.PI) / 180);
    this.kcc.setSlideEnabled(true);
    this.kcc.setApplyImpulsesToDynamicBodies(false);
  }

  get time() { return this.mission.time; }

  // ------------------------------------------------------------------ spawning
  spawn(type: MonsterId, at?: Vec3): number | null {
    const pos = at ? this.mission.nav.nearestCell(at, 1, 6) : null;
    let p: Vec3 | null = null;
    if (pos) { const g = this.mission.nav.grid(pos.floor)!; p = this.mission.nav.cellCenter(g, pos.idx); }
    else if (!at) p = this.spawnPoint(type);
    if (!p) return null;
    if (type === 'swarm') {
      const group = new SwarmGroup(p);
      const n = MONSTERS.swarm.group ?? 7;
      let first = -1;
      for (let i = 0; i < n; i++) {
        const id = this.nextId++;
        const m = new SwarmMember(this, id, 'swarm', v3(p.x + (Math.random() - 0.5) * 1.2, p.y, p.z + (Math.random() - 0.5) * 1.2), false);
        m.group = group;
        m.index = i;
        group.members.push(m);
        this.enemies.set(id, m);
        this.mission.emit({ k: 'enemy+', id, type: 'swarm' });
        if (first < 0) first = id;
      }
      return first;
    }
    const id = this.nextId++;
    let e: Enemy;
    switch (type) {
      case 'stalker': e = new Stalker(this, id, type, p); break;
      case 'mimic': e = new Mimic(this, id, type, p); break;
      case 'brute': e = new Brute(this, id, type, p); break;
      case 'lurker': e = new Lurker(this, id, type, p); break;
      case 'watcher': {
        const room = at ? p : this.watcherRoomPos() ?? p;
        e = new Watcher(this, id, type, room, false);
        break;
      }
      case 'hunter': e = new Hunter(this, id, type, p); break;
      case 'unknown': e = new Unknown(this, id, type, p, false); break;
      default: return null;
    }
    e.yaw = Math.random() * Math.PI * 2;
    e.setState(type === 'mimic' ? 'lure' : 'patrol');
    this.enemies.set(id, e);
    this.mission.emit({ k: 'enemy+', id, type });
    return id;
  }

  /** a spawn point far from (and hidden from) every player */
  spawnPoint(type: MonsterId, minDist = 24): Vec3 | null {
    const pts = this.mission.level.enemySpawns;
    const players = [...this.mission.players.values()].filter((p) => p.life === 'alive' || p.life === 'downed');
    const cands = pts.filter((s) => {
      for (const pl of players) {
        const d = Math.hypot(s.x - pl.pos[0], s.z - pl.pos[2]) + Math.abs(s.y - pl.pos[1]) * 2;
        if (d < minDist) return false;
        if (d < 40 && this.mission.physics.lineOfSight(pv(pl.eye), v3(s.x, s.y + 1.2, s.z))) return false;
      }
      return true;
    });
    if (!cands.length) return minDist > 10 ? this.spawnPoint(type, minDist * 0.6) : null;
    let pool = cands;
    if (type === 'lurker') { const dark = cands.filter((c) => this.roomDark(c.room)); if (dark.length) pool = dark; }
    if (type === 'brute') { const big = cands.filter((c) => { const r = this.mission.level.rooms[c.room]; return (r.x1 - r.x0) * (r.z1 - r.z0) >= 64; }); if (big.length) pool = big; }
    const s = pool[Math.floor(Math.random() * pool.length)];
    return v3(s.x, s.y, s.z);
  }

  remove(e: Enemy, why: string) {
    if (e.removed) return;
    e.removed = true;
    e.destroyBody();
    this.enemies.delete(e.id);
    for (const pl of this.mission.players.values()) if (pl.pinnedBy === e.id) { pl.pinnedBy = -1; this.mission.emit({ k: 'pin', id: pl.netId, by: -1 }); }
    this.mission.emit({ k: 'enemy-', id: e.id, why });
  }

  clear() { for (const e of [...this.enemies.values()]) this.remove(e, 'cleared'); }

  list() { return [...this.enemies.values()].map((e) => ({ id: e.id, type: e.type })); }

  threat(): number {
    let t = 0;
    const counted = new Set<SwarmGroup>();
    for (const e of this.enemies.values()) {
      if (e instanceof SwarmMember) { if (counted.has(e.group)) continue; counted.add(e.group); }
      t += e.def.threat;
    }
    return t;
  }

  countOf(type: MonsterId): number {
    const groups = new Set<SwarmGroup>();
    let n = 0;
    for (const e of this.enemies.values()) {
      if (e.type !== type) continue;
      if (e instanceof SwarmMember) { if (!groups.has(e.group)) { groups.add(e.group); n++; } }
      else n++;
    }
    return n;
  }

  // ------------------------------------------------------------------ world queries
  roomLit(room: number): boolean {
    const m = this.mission;
    const r = m.level.rooms[room];
    if (!r) return false;
    if (!m.sectors.get(r.sector) || !m.roomLights.get(room)) return false;
    if (m.director.blackoutRoom(room)) return false;
    return r.lights.some((id) => !m.level.lights[id].broken);
  }

  roomDark(room: number): boolean { return room >= 0 && !this.roomLit(room); }

  ceilingAt(p: Vec3): number {
    const room = this.mission.nav.roomAt(p);
    const r = this.mission.level.rooms[room];
    return r ? r.y + Math.min(r.height, 6) : p.y + 3;
  }

  randomPatrolPoint(e: Enemy, minDist: number): Vec3 | null {
    const rooms = this.mission.level.rooms.filter((r) => !r.stair && r.type !== 'lift' && !r.hidden);
    for (let i = 0; i < 8; i++) {
      const r = rooms[Math.floor(Math.random() * rooms.length)];
      const p = this.mission.nav.randomPointInRoom(r.id, this.mission.rng, 1);
      if (p && d3(p, e.pos) >= minDist) return p;
    }
    return null;
  }

  randomPointNear(c: Vec3, radius: number): Vec3 | null {
    for (let i = 0; i < 10; i++) {
      const p = v3(c.x + (Math.random() - 0.5) * 2 * radius, c.y, c.z + (Math.random() - 0.5) * 2 * radius);
      if (this.mission.nav.isWalkable(p, 1)) return p;
    }
    return null;
  }

  farPoint(from: Vec3, minDist: number): Vec3 | null {
    for (let i = 0; i < 12; i++) {
      const s = this.mission.level.enemySpawns[Math.floor(Math.random() * this.mission.level.enemySpawns.length)];
      if (s && Math.hypot(s.x - from.x, s.z - from.z) > minDist && Math.abs(s.y - from.y) < 3) return v3(s.x, s.y, s.z);
    }
    return this.randomPointNear(from, minDist);
  }

  darkNest(e: Enemy): Vec3 | null {
    const rooms = this.mission.level.rooms.filter((r) => !r.corridor && !r.stair && r.type !== 'lift' && this.roomDark(r.id) && r.height < 6);
    rooms.sort((a, b) => flat(v3((a.x0 + a.x1) / 2, 0, (a.z0 + a.z1) / 2), e.pos) - flat(v3((b.x0 + b.x1) / 2, 0, (b.z0 + b.z1) / 2), e.pos));
    for (const r of rooms.slice(0, 4)) { const p = this.mission.nav.randomPointInRoom(r.id, this.mission.rng, 1); if (p) return p; }
    return null;
  }

  watcherRoomPos(): Vec3 | null {
    const rooms = this.mission.level.rooms.filter((r) => !r.corridor && !r.stair && r.type !== 'lift' && !r.hidden && r.depth >= 2);
    const players = [...this.mission.players.values()];
    for (let i = 0; i < 12; i++) {
      const r = rooms[Math.floor(Math.random() * rooms.length)];
      if (!r) return null;
      const c = v3((r.x0 + r.x1) / 2, r.y, (r.z0 + r.z1) / 2);
      if (players.some((p) => Math.hypot(p.pos[0] - c.x, p.pos[2] - c.z) < 10)) continue;
      return c;
    }
    return null;
  }

  watcherRoom(_w: Enemy) { return this.watcherRoomPos(); }

  /** is the point inside the player's view cone (half angle in radians) */
  inViewCone(pl: MPlayer, p: Vec3, half: number): boolean {
    const eye = pl.eye;
    const dx = p.x - eye[0], dy = p.y - eye[1], dz = p.z - eye[2];
    const l = Math.hypot(dx, dy, dz) || 1;
    const fx = -Math.sin(pl.yaw) * Math.cos(pl.pitch), fy = Math.sin(pl.pitch), fz = -Math.cos(pl.yaw) * Math.cos(pl.pitch);
    return (dx * fx + dy * fy + dz * fz) / l > Math.cos(half);
  }

  lightStrength(pl: MPlayer): number {
    const it = ITEM_BY_ID[pl.loadout.light ?? 'light_t1'];
    return it?.stats.repel ?? 1;
  }

  isolation(pl: MPlayer): number {
    let best = 30;
    for (const o of this.mission.players.values()) {
      if (o === pl || o.life !== 'alive') continue;
      best = Math.min(best, Math.hypot(o.pos[0] - pl.pos[0], o.pos[2] - pl.pos[2]) + Math.abs(o.pos[1] - pl.pos[1]) * 2);
    }
    return best;
  }

  isLockedDown(doorId: number): boolean { return this.mission.director.isLockedDown(doorId); }

  // ------------------------------------------------------------------ events from the world
  noise(p: V3, loudness: number, kind: string, by: number) {
    this.noises.push({ p: v3(p[0], p[1], p[2]), loudness: Math.min(1.2, loudness), kind, by, at: this.time });
  }

  alertAll(pos: Vec3, radius: number, source: Enemy) {
    for (const e of this.enemies.values()) {
      if (e === source || d3(e.pos, pos) > radius) continue;
      e.onNoise({ p: { ...pos }, loudness: 1, kind: 'shriek', by: -1, at: this.time });
    }
  }

  markPlayer(pl: MPlayer) { for (const e of this.enemies.values()) if (e.type !== 'watcher') e.onMarked(pl); }

  onPlayerDowned(pl: MPlayer) {
    for (const e of this.enemies.values()) if (e.target === pl) { e.target = null; if (e.state === 'chase' || e.state === 'attack') e.setState('search'); }
  }

  /** brute (or explosion) pushes props aside */
  shoveProps(e: Enemy, radius: number, strength: number, radial = false) {
    const fx = -Math.sin(e.yaw), fz = -Math.cos(e.yaw);
    for (const p of this.mission.props.values()) {
      if (p.held) continue;
      const c = p.position();
      const dx = c[0] - e.pos.x, dz = c[2] - e.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > radius + p.radius || Math.abs(c[1] - e.pos.y - 0.8) > 2) continue;
      if (!radial && dx * fx + dz * fz < 0) continue;
      const nx = dx / (d || 1), nz = dz / (d || 1);
      const k = strength * Math.min(1, 25 / Math.max(5, p.mass)) * (1 - d / (radius + p.radius + 0.01));
      p.body.applyImpulse({ x: (nx * 0.8 + (radial ? 0 : fx * 0.5)) * k * p.mass, y: k * p.mass * 0.35, z: (nz * 0.8 + (radial ? 0 : fz * 0.5)) * k * p.mass }, true);
      p.lastHolder = -1;
    }
  }

  hitByProp(enemyId: number, p: MProp, speed: number, by: MPlayer | null) {
    const e = this.enemies.get(enemyId);
    if (!e) return;
    const energy = p.mass * speed;
    if (energy < 12) return;
    if (e.def.killable) e.damage(energy * 0.9, 'prop');
    if (!e.removed && energy > 45) e.stun(Math.min(4, energy / 40));
    if (!e.removed) { e.vocalize('hurt', 0.9); if (by && e.state !== 'chase') { e.lastKnown = pv(by.pos); e.onNoise({ p: pv(by.pos), loudness: 0.8, kind: 'hit', by: by.netId, at: this.time }); } }
    if (by) by.stuns += energy > 45 ? 1 : 0;
  }

  /** free prop impact: did it hit a creature? */
  propImpact(p: MProp, dv: number) {
    const c = p.position();
    for (const e of [...this.enemies.values()]) {
      const reach = e.def.radius + p.radius + 0.25;
      if (Math.hypot(e.pos.x - c[0], e.pos.z - c[2]) > reach) continue;
      if (c[1] < e.pos.y - 0.3 || c[1] > e.pos.y + e.def.height + e.lift + 0.3) continue;
      this.hitByProp(e.id, p, dv, p.lastHolder >= 0 ? this.mission.players.get(p.lastHolder) ?? null : null);
    }
  }

  prodStrike(pl: MPlayer, aim: number[], range: number, stun: number): boolean {
    const eye = pl.eye;
    let hit = false;
    for (const e of [...this.enemies.values()]) {
      const c = v3(e.pos.x, e.pos.y + e.lift + e.def.height * 0.5, e.pos.z);
      const dx = c.x - eye[0], dy = c.y - eye[1], dz = c.z - eye[2];
      const d = Math.hypot(dx, dy, dz);
      if (d > range + e.def.radius) continue;
      const dot = (dx * aim[3] + dy * aim[4] + dz * aim[5]) / (d || 1);
      if (dot < 0.72 && d > 1) continue;
      if (e.def.killable && e.type === 'swarm') e.damage(100, 'prod'); else { e.stun(stun); e.damage(35, 'prod'); }
      if (!e.removed) e.vocalize('hurt', 1);
      hit = true;
    }
    return hit;
  }

  explosion(pos: V3, r: number) {
    for (const e of [...this.enemies.values()]) {
      const d = Math.hypot(e.pos.x - pos[0], e.pos.z - pos[2]);
      if (d > r) continue;
      e.damage(160 * (1 - d / r), 'explosion');
      if (!e.removed) e.stun(3 * (1 - d / r));
    }
  }

  hazardHit(h: HazardData, inside: (p: V3) => boolean) {
    for (const e of [...this.enemies.values()]) if (inside([e.pos.x, e.pos.y, e.pos.z])) { e.damage(h.damage * 2, 'hazard'); if (!e.removed) e.stun(2.5); }
  }

  // ------------------------------------------------------------------ tick
  tick(dt: number) {
    // deliver noises
    if (this.noises.length) {
      const ns = this.noises;
      this.noises = [];
      for (const n of ns) for (const e of this.enemies.values()) if (!e.removed && e.hears(n)) e.onNoise(n);
    }
    for (const e of [...this.enemies.values()]) { if (!e.removed) e.tick(dt); }
    // keep downed players' pins and marks consistent
    for (const pl of this.mission.players.values()) if (pl.pinnedBy >= 0 && !this.enemies.has(pl.pinnedBy)) pl.pinnedBy = -1;
    void R;
    void PF;
  }

  snapshot(): SnapEnemy[] {
    const out: SnapEnemy[] = [];
    for (const e of this.enemies.values()) if (e.visible) out.push(e.snap());
    return out;
  }
}
