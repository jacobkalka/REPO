// The eight monster behaviours.

import { PF } from '../../../../shared/protocol';
import type { Vec3 } from '../../../../shared/levelgen/types';
import type { MDoor, MPlayer } from '../entities';
import type { Noise } from './AIManager';
import { angleDiff, d3, Enemy, flat, pv, v3, yawTo } from './Enemy';

const rand = (a: number, b: number) => a + Math.random() * (b - a);

// =============================================================================== Stalker
/** Patrols room to room; once it has a target it follows through rooms, remembers the last
 *  known position, searches nearby, and backs off briefly after landing a hit. */
export class Stalker extends Enemy {
  private patrolUntil = 0;
  private searchPoints: Vec3[] = [];
  private backoffUntil = 0;

  think(dt: number) {
    const seen = this.findVisible();
    if (seen) {
      this.noticePlayer(seen);
      const d = flat(this.pos, pv(seen.pos));
      this.suspicion = Math.min(1.5, this.suspicion + dt * (d < 6 ? 3 : 1.2));
      if (this.suspicion >= 1 && this.state !== 'chase' && this.state !== 'attack') { this.setState('chase'); this.vocalize('scream'); }
      if (this.state === 'chase' || this.state === 'attack') { this.target = seen; this.lastKnown = pv(seen.pos); this.lastSeenAt = this.time; }
      else { this.lastKnown = pv(seen.pos); if (this.state !== 'investigate') this.setState('investigate'); }
    } else this.suspicion = Math.max(0, this.suspicion - dt * 0.2);
    switch (this.state) {
      case 'idle':
        this.stop();
        if (this.stateTime > rand(2, 4)) this.setState('patrol');
        break;
      case 'patrol': {
        if (!this.path || this.arrived() || this.time > this.patrolUntil) {
          const p = this.ai.randomPatrolPoint(this, 14);
          if (p) this.goTo(p, this.def.walkSpeed * this.aggression, true);
          this.patrolUntil = this.time + 25;
          if (this.stateTime > 4 && Math.random() < 0.35) this.setState('idle');
        }
        if (Math.random() < dt * 0.05) this.vocalize('groan', 0.6);
        break;
      }
      case 'investigate': {
        if (!this.lastKnown) { this.setState('patrol'); break; }
        this.goTo(this.lastKnown, this.def.walkSpeed * 1.7 * this.aggression);
        if (this.arrived(1.0)) { this.stop(); if (this.stateTime > 3) this.beginSearch(this.lastKnown); }
        if (this.stateTime > 18) this.setState('patrol');
        break;
      }
      case 'chase': {
        if (!this.target || this.target.life !== 'alive') { this.target = null; this.beginSearch(this.lastKnown ?? this.pos); break; }
        const tp = pv(this.target.pos);
        const d = flat(this.pos, tp);
        if (this.time < this.backoffUntil) { this.stop(); this.face(tp, dt); break; }
        if (d < this.def.attackRange && Math.abs(tp.y - this.pos.y) < 2 && this.time >= this.attackReadyAt) { this.setState('attack'); break; }
        const goal = this.time - this.lastSeenAt < 0.4 ? tp : this.lastKnown ?? tp;
        this.goTo(goal, this.def.chaseSpeed * this.aggression);
        if (this.time - this.lastSeenAt > 2.5 && this.arrived(1.2)) this.beginSearch(this.lastKnown ?? this.pos);
        if (this.time - this.lastSeenAt > 10) this.beginSearch(this.lastKnown ?? this.pos);
        break;
      }
      case 'attack': {
        this.stop();
        if (this.meleeTick(dt, 0.42, (pl) => { this.m.damagePlayer(pl, this.def.damage, 'stalker', [this.pos.x, this.pos.y, this.pos.z], 4); this.backoffUntil = this.time + 1.2; })) this.setState('chase');
        break;
      }
      case 'search': {
        if (!this.path || this.arrived(1.0)) {
          const next = this.searchPoints.shift();
          if (!next) { this.setState('patrol'); break; }
          this.goTo(next, this.def.walkSpeed * 1.4 * this.aggression, true);
        }
        if (this.stateTime > 14) this.setState('patrol');
        break;
      }
      default: this.setState('patrol');
    }
  }

  private beginSearch(around: Vec3) {
    this.setState('search');
    this.searchPoints = [];
    for (let i = 0; i < 3; i++) { const p = this.ai.randomPointNear(around, 9); if (p) this.searchPoints.push(p); }
  }

  override onNoise(n: Noise) {
    if (this.state === 'chase' && this.target && n.by === this.target.netId) { this.lastKnown = { ...n.p }; return; }
    super.onNoise(n);
  }
}

// =============================================================================== Mimic
/** Lures players with fake sounds. Shrieks for every creature and flees when lit; ambushes from behind. */
export class Mimic extends Enemy {
  private nextLure = 0;
  private litTime = 0;
  private fleeUntil = 0;
  private home: Vec3 | null = null;
  private static FAKES = ['step_concrete', 'step_metal', 'impact_brass', 'impact_glass', 'ping', 'door_open_metal', 'door_close_wood', 'impact_ceramic', 'cough', 'tube_send', 'valuable_chime'];

  think(dt: number) {
    if (!this.home) this.home = { ...this.pos };
    // being lit by a torch reveals it
    let lit = false;
    for (const pl of this.m.players.values()) {
      if (pl.life !== 'alive') continue;
      const d = d3(pv(pl.eye), this.eye);
      if (d > 9) continue;
      const torchOn = (pl.flags & PF.LIGHT) !== 0;
      const look = this.ai.inViewCone(pl, this.eye, 0.42);
      if ((torchOn && look) || d < 2.2) {
        if (this.m.physics.lineOfSight(pv(pl.eye), this.eye)) { lit = true; this.noticePlayer(pl); }
      }
    }
    this.litTime = lit ? this.litTime + dt : Math.max(0, this.litTime - dt * 0.5);
    switch (this.state) {
      case 'idle':
      case 'lure': {
        this.setState('lure');
        this.stop();
        if (this.time > this.nextLure) {
          this.nextLure = this.time + rand(6, 13);
          const s = Mimic.FAKES[Math.floor(Math.random() * Mimic.FAKES.length)];
          const off = v3(this.pos.x + rand(-2, 2), this.pos.y + rand(0.2, 1.4), this.pos.z + rand(-2, 2));
          this.m.emit({ k: 'sfx', s, p: [off.x, off.y, off.z], v: rand(0.6, 1), r: rand(0.6, 8) });
          this.aux = 3;
        } else this.aux = 0;
        if (this.litTime > 0.7) { this.shriek(); break; }
        // ambush someone who turns their back
        for (const pl of this.m.players.values()) {
          if (pl.life !== 'alive') continue;
          const d = flat(this.pos, pv(pl.pos));
          if (d < 2.6 && !this.ai.inViewCone(pl, this.eye, 1.4) && this.time >= this.attackReadyAt) { this.target = pl; this.setState('attack'); break; }
        }
        // slowly reposition near sound sources
        if (this.stateTime > 40) { const p = this.ai.randomPatrolPoint(this, 10); if (p) { this.home = p; this.goTo(p, this.def.walkSpeed); } this.stateTime = 0; }
        break;
      }
      case 'attack': {
        this.goTo(pv(this.target!.pos), this.def.chaseSpeed);
        if (flat(this.pos, pv(this.target!.pos)) < this.def.attackRange + 0.3) {
          if (this.meleeTick(dt, 0.25, (pl) => this.m.damagePlayer(pl, this.def.damage, 'mimic', [this.pos.x, this.pos.y, this.pos.z], 2))) this.flee();
        }
        if (this.stateTime > 2.5) this.flee();
        break;
      }
      case 'flee': {
        if (this.arrived(1.0) || this.time > this.fleeUntil) { this.setState('lure'); this.litTime = 0; }
        break;
      }
      default: this.setState('lure');
    }
  }

  private shriek() {
    this.vocalize('shriek', 1);
    this.ai.alertAll(this.pos, 35, this);
    this.flee();
  }

  private flee() {
    this.setState('flee');
    const p = this.ai.farPoint(this.pos, 18);
    if (p) this.goTo(p, this.def.chaseSpeed, true);
    this.fleeUntil = this.time + 8;
    this.attackReadyAt = this.time + 6;
  }

  override onNoise() { /* mimics ignore noise */ }
}

// =============================================================================== Brute
/** Slow hulk: smashes doors (even locked), scatters props, ground-slam with knockback. */
export class Brute extends Enemy {
  private smashing: MDoor | null = null;
  private smashT = 0;

  override canSmash() { return true; }
  override clearance() { return 1; }

  protected override onSmashDoor(door: MDoor) {
    if (this.smashing === door) return;
    this.smashing = door;
    this.smashT = 0;
    this.setState('smash');
    this.vocalize('roar', 1);
  }

  think(dt: number) {
    const seen = this.findVisible();
    if (seen) { this.noticePlayer(seen); this.target = seen; this.lastKnown = pv(seen.pos); this.lastSeenAt = this.time; if (this.state !== 'chase' && this.state !== 'attack' && this.state !== 'smash') { this.setState('chase'); this.vocalize('roar'); } }
    // shove props out of the way
    if (this.speed > 0.4) this.ai.shoveProps(this, 1.5, this.state === 'chase' ? 7 : 3.5);
    switch (this.state) {
      case 'idle': this.stop(); if (this.stateTime > rand(3, 6)) this.setState('patrol'); break;
      case 'patrol':
        if (!this.path || this.arrived()) { const p = this.ai.randomPatrolPoint(this, 16); if (p) this.goTo(p, this.def.walkSpeed * this.aggression, true); }
        if (Math.random() < dt * 0.06) this.vocalize('grunt', 0.7);
        break;
      case 'investigate':
        if (!this.lastKnown) { this.setState('patrol'); break; }
        this.goTo(this.lastKnown, this.def.walkSpeed * 1.5 * this.aggression);
        if (this.arrived(1.5) || this.stateTime > 20) this.setState('patrol');
        break;
      case 'chase': {
        if (!this.target || this.target.life !== 'alive') { this.target = null; this.setState('investigate'); break; }
        const tp = pv(this.target.pos);
        const d = flat(this.pos, tp);
        if (d < this.def.attackRange && this.time >= this.attackReadyAt) { this.setState('attack'); break; }
        this.goTo(this.time - this.lastSeenAt < 1 ? tp : this.lastKnown ?? tp, this.def.chaseSpeed * this.aggression);
        if (this.time - this.lastSeenAt > 9) this.setState('investigate');
        break;
      }
      case 'attack':
        this.stop();
        this.windup += dt;
        this.aux = 1;
        if (this.target) this.face(pv(this.target.pos), dt, 4);
        if (this.windup > 0.85) {
          this.vocalize('slam', 1);
          this.m.emit({ k: 'boom', p: [this.pos.x, this.pos.y, this.pos.z], r: 0 });
          for (const pl of this.m.players.values()) {
            if (pl.life !== 'alive') continue;
            const d = flat(this.pos, pv(pl.pos));
            if (d < 3.4 && Math.abs(pl.pos[1] - this.pos.y) < 2) this.m.damagePlayer(pl, Math.round(this.def.damage * (1 - d / 4.5)), 'brute', [this.pos.x, this.pos.y, this.pos.z], 9 * (1 - d / 4.5));
          }
          this.ai.shoveProps(this, 3.4, 9, true);
          this.m.noise([this.pos.x, this.pos.y, this.pos.z], 0.9, 'slam', -1);
          this.attackReadyAt = this.time + this.def.attackCooldown;
          this.setState('chase');
        }
        break;
      case 'smash': {
        this.stop();
        const door = this.smashing;
        if (!door) { this.setState('chase'); break; }
        this.face(v3(door.data.x, 0, door.data.z), dt, 6);
        this.smashT += dt;
        this.aux = 1;
        if (this.smashT > 1.1) { this.m.smashDoor(door, [this.pos.x, this.pos.z]); this.smashing = null; this.repathAt = 0; this.setState(this.target ? 'chase' : 'investigate'); }
        break;
      }
      default: this.setState('patrol');
    }
  }

  override stun(seconds: number) { super.stun(seconds * 0.45); }
}

// =============================================================================== Lurker
/** Nests on the ceilings of dark rooms, drops onto isolated players, pins them; light drives it away. */
export class Lurker extends Enemy {
  private nest: Vec3 | null = null;
  private litTime = 0;
  private pinned: MPlayer | null = null;
  private pinTick = 0;
  private relocateAt = 0;

  think(dt: number) {
    // torches shining on it
    let lit = 0;
    for (const pl of this.m.players.values()) {
      if (pl.life !== 'alive' || !(pl.flags & PF.LIGHT)) continue;
      if (d3(pv(pl.eye), this.eye) > 11) continue;
      if (this.ai.inViewCone(pl, this.eye, 0.45) && this.m.physics.lineOfSight(pv(pl.eye), this.eye)) lit += this.ai.lightStrength(pl);
    }
    for (const l of this.m.placed.values()) if (l.kind === 'flare' && Math.hypot(l.p[0] - this.pos.x, l.p[2] - this.pos.z) < 6) lit += 1.5;
    this.litTime = lit > 0 ? this.litTime + dt * lit : Math.max(0, this.litTime - dt * 0.6);
    switch (this.state) {
      case 'idle':
      case 'patrol': {
        // travel to a dark nest
        if (!this.nest || !this.ai.roomDark(this.m.nav.roomAt(this.nest))) this.nest = this.ai.darkNest(this);
        if (!this.nest) { this.lift = 0; if (!this.path || this.arrived()) { const p = this.ai.randomPatrolPoint(this, 10); if (p) this.goTo(p, this.def.walkSpeed); } break; }
        this.lift = 0;
        this.goTo(this.nest, this.def.chaseSpeed * 0.8);
        if (this.arrived(0.8)) { this.setState('ambush'); this.relocateAt = this.time + rand(70, 120); }
        break;
      }
      case 'ambush': {
        this.stop();
        const ceil = this.ai.ceilingAt(this.pos);
        this.lift = Math.max(0, ceil - this.pos.y - 0.6);
        if (this.litTime > 1.0) { this.retreat(); break; }
        if (!this.ai.roomDark(this.m.nav.roomAt(this.pos)) || this.time > this.relocateAt) { this.setState('patrol'); this.nest = null; break; }
        for (const pl of this.m.players.values()) {
          if (pl.life !== 'alive') continue;
          if (flat(this.pos, pv(pl.pos)) > 3.0 || Math.abs(pl.pos[1] - this.pos.y) > 2) continue;
          if (this.ai.isolation(pl) < 8 && this.m.players.size > 1) continue;
          if ((pl.flags & PF.LIGHT) && this.ai.inViewCone(pl, this.eye, 0.5)) continue;
          this.target = pl; this.noticePlayer(pl); this.setState('drop'); this.vocalize('drop', 1); break;
        }
        break;
      }
      case 'drop': {
        this.lift = Math.max(0, this.lift - dt * 9);
        if (this.target) this.goTo(pv(this.target.pos), this.def.chaseSpeed * 1.4, true);
        if (this.lift <= 0.05 && this.target && flat(this.pos, pv(this.target.pos)) < 1.6 && this.target.life === 'alive') {
          this.pinned = this.target;
          this.target.pinnedBy = this.id;
          this.m.emit({ k: 'pin', id: this.target.netId, by: this.id });
          this.setState('pin');
        } else if (this.stateTime > 1.6) this.retreat();
        break;
      }
      case 'pin': {
        this.stop();
        const v = this.pinned;
        if (!v || v.life !== 'alive' || v.pinnedBy !== this.id) { this.release(); this.retreat(); break; }
        this.teleport(v3(v.pos[0], v.pos[1], v.pos[2]));
        this.pinTick += dt;
        this.aux = 1;
        if (this.pinTick > 0.55) { this.pinTick = 0; this.m.damagePlayer(v, this.def.damage, 'lurker'); this.vocalize('chitter', 0.8); }
        if (this.litTime > 1.4 || this.stateTime > 9) { this.release(); this.retreat(); }
        break;
      }
      case 'retreat':
        this.lift = 0;
        if (this.arrived(1) || this.stateTime > 7) { this.setState('patrol'); this.nest = null; this.litTime = 0; }
        break;
      default: this.setState('patrol');
    }
  }

  private release() {
    if (this.pinned && this.pinned.pinnedBy === this.id) { this.pinned.pinnedBy = -1; this.m.emit({ k: 'pin', id: this.pinned.netId, by: -1 }); }
    this.pinned = null;
  }

  private retreat() {
    this.release();
    this.vocalize('hiss', 1);
    this.setState('retreat');
    const p = this.ai.farPoint(this.pos, 14);
    if (p) this.goTo(p, this.def.chaseSpeed, true);
  }

  protected override onStunned() { this.release(); this.retreat(); }
  override damage(amount: number, src: string) { super.damage(amount, src); if (!this.removed) { this.release(); this.retreat(); } }
  override onNoise() { /* ambush predator: ignores noise */ }
  override die() { this.release(); super.die(); }
}

// =============================================================================== Watcher
/** Ceiling sentinel with a sweeping gaze cone. Motion inside the cone fills a lock meter;
 *  a full lock marks the player for every creature. Relocates periodically. */
export class Watcher extends Enemy {
  private baseYaw = 0;
  private lock = new Map<number, number>();
  private relocateAt = 0;
  private phaseUntil = 0;
  pitch = -0.55;

  think(dt: number) {
    if (!this.relocateAt) { this.relocateAt = this.time + rand(60, 95); this.baseYaw = this.yaw; }
    const ceil = this.ai.ceilingAt(this.pos);
    this.lift = Math.max(0, ceil - this.pos.y - this.def.height);
    if (this.state === 'phase') {
      this.visible = false;
      if (this.time > this.phaseUntil) {
        const room = this.ai.watcherRoom(this);
        if (room) { this.teleport(room); this.baseYaw = Math.random() * Math.PI * 2; }
        this.visible = true;
        this.setState('patrol');
        this.relocateAt = this.time + rand(60, 95);
      }
      return;
    }
    // sweep
    this.yaw = this.baseYaw + Math.sin(this.time * 0.42 + this.id) * 1.25;
    this.aux = 0;
    let maxLock = 0;
    for (const pl of this.m.players.values()) {
      if (pl.life !== 'alive') { this.lock.delete(pl.netId); continue; }
      const eye = this.eye;
      const tp = v3(pl.pos[0], pl.pos[1] + 1.0, pl.pos[2]);
      const d = d3(eye, tp);
      let l = this.lock.get(pl.netId) ?? 0;
      const inCone = d < this.def.sightRange * this.aggression && Math.abs(angleDiff(yawTo(this.pos, tp), this.yaw)) < (this.def.sightFov * Math.PI) / 360 * 1.1 && this.m.physics.lineOfSight(eye, tp);
      const speed = Math.hypot(pl.vel[0], pl.vel[2]);
      if (inCone && speed > 1.85) { l += dt * (pl.flags & PF.LIGHT ? 1.3 : 1) * (d < 6 ? 1.6 : 1); this.noticePlayer(pl); }
      else l = Math.max(0, l - dt * 0.35);
      this.lock.set(pl.netId, l);
      maxLock = Math.max(maxLock, l);
      if (l >= 1.6) {
        this.lock.set(pl.netId, 0);
        this.vocalize('shriek', 1);
        pl.markedUntil = this.time + 18;
        pl.flags |= PF.MARKED;
        this.m.emit({ k: 'mark', id: pl.netId, until: pl.markedUntil });
        this.m.emit({ k: 'msg', text: `${pl.name} has been marked!`, kind: 'warn' });
        this.ai.markPlayer(pl);
        this.relocateAt = Math.min(this.relocateAt, this.time + 12);
      }
    }
    this.aux = Math.min(255, Math.round(maxLock * 150));
    this.state = maxLock > 0.2 ? 'mark' : 'patrol';
    if (this.time > this.relocateAt) { this.setState('phase'); this.phaseUntil = this.time + rand(6, 12); this.vocalize('phase', 0.6); }
  }

  protected override move() { this.speed = 0; }
  protected override onStunned() { this.lock.clear(); }
  override onNoise() { /* it only watches */ }
}

// =============================================================================== Swarm
/** A coordinated pack of small scavengers (boids). Each member is its own enemy entity
 *  for rendering; the group holds the shared state. */
export class SwarmGroup {
  members: SwarmMember[] = [];
  state: 'idle' | 'chase' | 'scatter' | 'investigate' = 'idle';
  target: MPlayer | null = null;
  goal: Vec3 | null = null;
  until = 0;
  leaderPath: Vec3[] | null = null;
  pathIdx = 0;
  repathAt = 0;
  center: Vec3;
  constructor(public home: Vec3) { this.center = { ...home }; }
}

export class SwarmMember extends Enemy {
  group!: SwarmGroup;
  index = 0;
  vx = 0;
  vz = 0;

  think(dt: number) {
    const g = this.group;
    if (this.index === 0) this.groupThink(dt);
    const c = g.center;
    let ax = 0, az = 0;
    // goal seeking
    let goal: Vec3 | null = null;
    if (g.state === 'chase' && g.target) {
      const ang = (this.index / g.members.length) * Math.PI * 2 + this.time * 0.6;
      const tp = pv(g.target.pos);
      const r = flat(this.pos, tp) < 3 ? 0.55 : 1.4;
      goal = v3(tp.x + Math.cos(ang) * r, tp.y, tp.z + Math.sin(ang) * r);
    } else if (g.state === 'scatter') {
      goal = v3(this.pos.x + (this.pos.x - c.x) * 3, this.pos.y, this.pos.z + (this.pos.z - c.z) * 3);
    } else {
      const wp = g.leaderPath && g.leaderPath[Math.min(g.pathIdx, g.leaderPath.length - 1)];
      goal = wp ?? g.goal ?? g.home;
    }
    const maxSp = g.state === 'chase' || g.state === 'scatter' ? this.def.chaseSpeed * this.aggression : this.def.walkSpeed;
    if (goal) { const ex = goal.x - this.pos.x, ez = goal.z - this.pos.z, l = Math.hypot(ex, ez) || 1; ax += (ex / l) * maxSp * 2.5; az += (ez / l) * maxSp * 2.5; }
    // cohesion / separation
    ax += (c.x - this.pos.x) * (g.state === 'scatter' ? -0.5 : 0.6);
    az += (c.z - this.pos.z) * (g.state === 'scatter' ? -0.5 : 0.6);
    for (const o of g.members) {
      if (o === this) continue;
      const dx = this.pos.x - o.pos.x, dz = this.pos.z - o.pos.z, d = Math.hypot(dx, dz);
      if (d < 0.5 && d > 0.001) { ax += (dx / d) * (0.5 - d) * 22; az += (dz / d) * (0.5 - d) * 22; }
    }
    this.vx += ax * dt; this.vz += az * dt;
    const sp = Math.hypot(this.vx, this.vz);
    if (sp > maxSp) { this.vx *= maxSp / sp; this.vz *= maxSp / sp; }
    this.vx *= 0.92; this.vz *= 0.92;
    // bite
    if (g.state === 'chase' && g.target && g.target.life === 'alive' && flat(this.pos, pv(g.target.pos)) < this.def.attackRange && this.time >= this.attackReadyAt) {
      this.target = g.target;
      this.m.damagePlayer(g.target, this.def.damage, 'swarm');
      this.vocalize('bite', 0.5);
      this.attackReadyAt = this.time + this.def.attackCooldown + Math.random() * 0.4;
      this.aux = 1;
    } else this.aux = 0;
    this.state = g.state === 'chase' ? 'chase' : g.state === 'scatter' ? 'flee' : 'patrol';
  }

  private groupThink(dt: number) {
    const g = this.group;
    let cx = 0, cz = 0, cy = 0;
    for (const m of g.members) { cx += m.pos.x; cz += m.pos.z; cy += m.pos.y; }
    const n = g.members.length || 1;
    g.center = v3(cx / n, cy / n, cz / n);
    // perception from the group centre
    let seen: MPlayer | null = null, bd = Infinity;
    for (const m of g.members) { const s = m.findVisible(); if (s) { const d = flat(m.pos, pv(s.pos)); if (d < bd) { bd = d; seen = s; } } }
    if (g.state === 'scatter' && this.time < g.until) return;
    if (seen) { if (g.state !== 'chase') this.vocalize('chitter', 0.9); g.state = 'chase'; g.target = seen; g.until = this.time + 6; for (const m of g.members) m.noticePlayer(seen); }
    else if (g.state === 'chase' && this.time > g.until) { g.state = 'investigate'; g.goal = g.target ? pv(g.target.pos) : g.home; g.target = null; g.until = this.time + 10; }
    if (g.state === 'chase' && g.target && g.target.life !== 'alive') { g.state = 'idle'; g.target = null; }
    if ((g.state === 'investigate' && this.time > g.until) || g.state === 'idle') {
      if (!g.goal || flat(g.center, g.goal) < 1.5 || this.time > g.until) { g.goal = this.ai.randomPointNear(g.home, 12) ?? g.home; g.until = this.time + 20; g.state = 'idle'; g.leaderPath = null; }
    }
    if (g.goal && this.time > g.repathAt && g.state !== 'chase') {
      g.repathAt = this.time + 1.5;
      g.leaderPath = this.m.nav.findPath(g.center, g.goal, { clearance: 0, maxNodes: 4000, doorCost: this.doorCost });
      g.pathIdx = 0;
    }
    if (g.leaderPath) { while (g.pathIdx < g.leaderPath.length - 1 && flat(g.center, g.leaderPath[g.pathIdx]) < 1.0) g.pathIdx++; }
    void dt;
  }

  protected override move(dt: number) {
    if (this.time < this.stunnedUntil) { this.speed = 0; return; }
    const nx = this.pos.x + this.vx * dt, nz = this.pos.z + this.vz * dt;
    const np = v3(nx, this.pos.y, nz);
    if (this.m.nav.isWalkable(np, 0)) this.pos = np;
    else if (this.m.nav.isWalkable(v3(nx, this.pos.y, this.pos.z), 0)) { this.pos = v3(nx, this.pos.y, this.pos.z); this.vz *= -0.3; }
    else if (this.m.nav.isWalkable(v3(this.pos.x, this.pos.y, nz), 0)) { this.pos = v3(this.pos.x, this.pos.y, nz); this.vx *= -0.3; }
    else { this.vx *= -0.5; this.vz *= -0.5; }
    // follow floor height (nav floor)
    const fl = this.m.nav.grid(this.m.nav.floorOf(this.pos.y));
    if (fl) this.pos.y += (fl.y - this.pos.y) * Math.min(1, dt * 10);
    const sp = Math.hypot(this.vx, this.vz);
    this.speed = sp;
    if (sp > 0.2) this.yaw = Math.atan2(-this.vx, -this.vz);
  }

  override onNoise(n: Noise) {
    const g = this.group;
    const d = flat(g.center, n.p);
    if (n.loudness > 0.7 && d < 9) { g.state = 'scatter'; g.until = this.time + 4; this.vocalize('scatter', 0.8); return; }
    if (g.state !== 'chase') { g.state = 'investigate'; g.goal = { ...n.p }; g.until = this.time + 12; g.repathAt = 0; }
  }

  override die() {
    this.group.members = this.group.members.filter((m) => m !== this);
    this.group.members.forEach((m, i) => (m.index = i));
    super.die();
  }
}

// =============================================================================== Hunter
/** Blind. Hunts by sound, prefers isolated prey, charges noise sources; stillness is safety. */
export class Hunter extends Enemy {
  private heardAt = -99;
  private quarry: MPlayer | null = null;

  think(dt: number) {
    switch (this.state) {
      case 'idle': this.stop(); if (this.stateTime > rand(3, 7)) this.setState('patrol'); break;
      case 'patrol':
        if (!this.path || this.arrived()) { const p = this.ai.randomPatrolPoint(this, 14); if (p) this.goTo(p, this.def.walkSpeed * this.aggression, true); }
        if (Math.random() < dt * 0.15) { this.vocalize('sniff', 0.5); this.aux = 2; } else this.aux = 0;
        break;
      case 'investigate':
      case 'chase': {
        if (!this.lastKnown) { this.setState('patrol'); break; }
        const sp = this.state === 'chase' ? this.def.chaseSpeed : this.def.walkSpeed * 2;
        this.goTo(this.lastKnown, sp * this.aggression);
        // touch / close-range detection
        for (const pl of this.m.players.values()) {
          if (pl.life !== 'alive') continue;
          const d = flat(this.pos, pv(pl.pos));
          const moving = Math.hypot(pl.vel[0], pl.vel[2]) > 2.2;
          if (d < 1.05 || (d < this.def.attackRange + 0.4 && (moving || this.time - this.heardAt < 1.2) && this.quarry === pl)) {
            if (this.time >= this.attackReadyAt) { this.target = pl; this.noticePlayer(pl); this.setState('attack'); }
          }
        }
        if (this.arrived(1.0)) { this.setState('sniff'); this.vocalize('sniff', 0.9); }
        if (this.stateTime > 15) this.setState('patrol');
        break;
      }
      case 'sniff':
        this.stop();
        this.aux = 2;
        this.yaw += dt * 1.2;
        if (this.stateTime > 4.5) { this.quarry = null; this.setState('patrol'); }
        break;
      case 'attack': {
        if (!this.target) { this.setState('sniff'); break; }
        this.goTo(pv(this.target.pos), this.def.chaseSpeed);
        if (this.meleeTick(dt, 0.3, (pl) => this.m.damagePlayer(pl, this.def.damage, 'hunter', [this.pos.x, this.pos.y, this.pos.z], 5))) { this.lastKnown = pv(this.target.pos); this.setState('sniff'); }
        break;
      }
      default: this.setState('patrol');
    }
  }

  override onNoise(n: Noise) {
    if (this.state === 'attack') return;
    const pl = n.by >= 0 ? this.m.players.get(n.by) : undefined;
    const iso = pl ? this.ai.isolation(pl) : 0;
    const score = n.loudness * (1 + Math.min(20, iso) / 10);
    const d = d3(this.pos, n.p);
    this.lastKnown = { ...n.p };
    this.heardAt = this.time;
    if (pl) this.quarry = pl;
    if (score > 0.42 || d < 9) {
      if (this.state !== 'chase') { this.vocalize('howl', 1); }
      this.setState('chase');
    } else if (this.state !== 'chase') this.setState('investigate');
  }

  override canSee() { return false; }
}

// =============================================================================== Unknown
/** The Visitor: drifts through walls toward whoever carries the most; contact is death. */
export class Unknown extends Enemy {
  forced: MPlayer | null = null;
  private leaveAt = 0;

  think(dt: number) {
    const pick = this.pickTarget();
    this.target = pick;
    if (!pick) { if (!this.leaveAt) this.leaveAt = this.time + 6; if (this.time > this.leaveAt) this.ai.remove(this, 'gone'); return; }
    this.leaveAt = 0;
    const tp = v3(pick.pos[0], pick.pos[1], pick.pos[2]);
    const d = d3(this.pos, tp);
    const sp = (this.m.overtime ? this.def.chaseSpeed : this.def.walkSpeed) * (d > 30 ? 2.2 : 1);
    const ex = tp.x - this.pos.x, ey = tp.y - this.pos.y, ez = tp.z - this.pos.z;
    const l = Math.hypot(ex, ey, ez) || 1;
    this.pos = v3(this.pos.x + (ex / l) * sp * dt, this.pos.y + (ey / l) * sp * dt, this.pos.z + (ez / l) * sp * dt);
    this.speed = sp;
    this.yaw = yawTo(this.pos, tp);
    this.state = 'phase';
    if (d < this.def.attackRange && pick.life === 'alive') { this.m.damagePlayer(pick, 999, 'unknown'); if (pick.life === 'alive' || pick.life === 'downed') this.m.killPlayer(pick); this.vocalize('take', 1); }
    if (Math.random() < dt * 0.2) this.vocalize('drone', 0.8);
    for (const pl of this.m.players.values()) if (pl.life === 'alive' && this.canSeeRaw(pl)) pl.seen.add(this.id);
  }

  private canSeeRaw(pl: MPlayer) { return d3(this.pos, pv(pl.pos)) < 20; }

  private pickTarget(): MPlayer | null {
    const alive = [...this.m.players.values()].filter((p) => p.life === 'alive');
    if (!alive.length) return null;
    // whoever holds the cursed artifact
    for (const p of this.m.props.values()) if (p.cursed && p.owner >= 0) { const pl = this.m.players.get(p.owner); if (pl?.life === 'alive') return pl; }
    if (this.forced?.life === 'alive') return this.forced;
    let best: MPlayer | null = null, bv = -1;
    for (const pl of alive) {
      const held = pl.owned >= 0 ? this.m.props.get(pl.owned)?.value ?? 0 : 0;
      const v = held + pl.delivered * 0.2;
      if (v > bv) { bv = v; best = pl; }
    }
    return best;
  }

  protected override move() { /* moves itself through walls in think() */ }
  override onNoise() {}
  override stun() {}
  override damage() {}
}

void angleDiff;
