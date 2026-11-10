// Base monster: perception, memory, navigation, door handling, movement (Rapier KCC).

import type RAPIER from '@dimforge/rapier3d-compat';
import { COLLISION, groups } from '../../../../shared/constants';
import { AI_STATE_INDEX, MONSTER_INDEX, MONSTERS, type AIState, type MonsterDef, type MonsterId } from '../../../../shared/catalog/monsters';
import type { Vec3 } from '../../../../shared/levelgen/types';
import { PF, type SnapEnemy, type V3 } from '../../../../shared/protocol';
import type { MPlayer } from '../entities';
import { R } from '../Physics';
import type { AIManager, Noise } from './AIManager';

export const v3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
export const flat = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);
export const d3 = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export const pv = (p: V3): Vec3 => ({ x: p[0], y: p[1], z: p[2] });
export function angleDiff(a: number, b: number) { let d = (a - b) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; }
/** yaw that faces from a to b (three.js: forward = (-sin yaw, -cos yaw)) */
export function yawTo(a: Vec3, b: Vec3) { return Math.atan2(-(b.x - a.x), -(b.z - a.z)); }

export abstract class Enemy {
  readonly def: MonsterDef;
  pos: Vec3;
  yaw = 0;
  speed = 0;
  state: AIState = 'idle';
  stateTime = 0;
  aux = 0;
  hp: number;
  target: MPlayer | null = null;
  lastKnown: Vec3 | null = null;
  lastSeenAt = -99;
  suspicion = 0;
  stunnedUntil = 0;
  attackReadyAt = 0;
  path: Vec3[] | null = null;
  pathIdx = 0;
  pathGoal: Vec3 | null = null;
  repathAt = 0;
  moveSpeed = 0;
  stuckTime = 0;
  doorWaitUntil = 0;
  body: RAPIER.RigidBody | null = null;
  collider: RAPIER.Collider | null = null;
  removed = false;
  visible = true;
  vy = 0;
  room = -1;
  windup = 0;
  /** extra vertical offset for rendering (ceiling dwellers) */
  lift = 0;

  constructor(readonly ai: AIManager, readonly id: number, readonly type: MonsterId, pos: Vec3, physical = true) {
    this.def = MONSTERS[type];
    this.pos = { ...pos };
    this.hp = this.def.health;
    if (physical) this.createBody();
  }

  get m() { return this.ai.mission; }
  get time() { return this.ai.mission.time; }
  get aggression() { return this.ai.mission.diff.aggression; }

  protected createBody() {
    const w = this.ai.mission.physics.world;
    const r = this.def.radius;
    const hh = Math.max(0.05, this.def.height / 2 - r);
    this.body = w.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(this.pos.x, this.pos.y + this.def.height / 2, this.pos.z));
    const g = groups(COLLISION.ENEMY, COLLISION.STATIC | COLLISION.PROP | COLLISION.DOOR | COLLISION.HELD);
    this.collider = w.createCollider(R.ColliderDesc.capsule(hh, r).setCollisionGroups(g).setSolverGroups(g), this.body);
    (this.collider as unknown as { userData: unknown }).userData = { kind: 'enemy', id: this.id };
    this.ai.colliderToEnemy.set(this.collider.handle, this);
  }

  destroyBody() {
    if (this.body) { this.ai.colliderToEnemy.delete(this.collider!.handle); this.ai.mission.physics.world.removeRigidBody(this.body); this.body = null; this.collider = null; }
  }

  setState(s: AIState) { if (this.state !== s) { this.state = s; this.stateTime = 0; this.windup = 0; } }

  get eye(): Vec3 { return v3(this.pos.x, this.pos.y + this.def.height * 0.85, this.pos.z); }

  // ------------------------------------------------------------------ perception
  /** player is lit if their torch is on, they're in a lit room, or near a flare */
  playerLit(pl: MPlayer): boolean {
    if (pl.flags & PF.LIGHT) return true;
    const room = this.m.nav.roomAt(pv(pl.pos));
    if (room >= 0 && this.ai.roomLit(room)) return true;
    for (const l of this.m.placed.values()) if (l.kind !== 'decoy' && Math.hypot(l.p[0] - pl.pos[0], l.p[2] - pl.pos[2]) < 6) return true;
    return false;
  }

  canSee(pl: MPlayer, rangeMult = 1): boolean {
    if (!this.def.sightRange || pl.life === 'dead' || pl.life === 'extracted' || pl.life === 'left' || !pl.connected) return false;
    const chest = v3(pl.pos[0], pl.pos[1] + (pl.flags & PF.CROUCH ? 0.7 : 1.2), pl.pos[2]);
    const eye = this.eye;
    const d = d3(eye, chest);
    let range = this.def.sightRange * this.aggression * rangeMult;
    if (!this.playerLit(pl)) range *= 0.42;
    if (pl.flags & PF.CROUCH) range *= 0.7;
    if (d > range) return false;
    if (this.def.sightFov < 360 && d > 1.5) {
      const a = Math.abs(angleDiff(yawTo(this.pos, chest), this.yaw));
      if (a > (this.def.sightFov * Math.PI) / 360) return false;
    }
    return this.m.physics.lineOfSight(eye, chest);
  }

  /** best visible player (closest) */
  findVisible(): MPlayer | null {
    let best: MPlayer | null = null, bd = Infinity;
    for (const pl of this.m.players.values()) {
      if (pl.life !== 'alive' && !(pl.life === 'downed' && this.targetsDowned())) continue;
      if (!this.canSee(pl)) continue;
      const d = flat(this.pos, pv(pl.pos));
      if (d < bd) { bd = d; best = pl; }
    }
    return best;
  }

  protected targetsDowned() { return false; }

  /** audible radius for a noise */
  hears(n: Noise): boolean {
    if (!this.def.hearing) return false;
    let r = n.loudness * 28 * this.def.hearing * this.aggression;
    const d = d3(this.pos, n.p);
    if (d > r) return false;
    if (d > 4 && !this.m.physics.lineOfSight(this.eye, v3(n.p.x, n.p.y + 0.3, n.p.z))) r *= 0.6;
    return d <= r;
  }

  noticePlayer(pl: MPlayer) {
    pl.spotted = true;
    pl.seen.add(this.id);
  }

  // ------------------------------------------------------------------ navigation
  doorCost = (doorId: number): number => {
    const d = this.m.doors[doorId];
    if (!d || d.broken || !d.data.leaf) return 1;
    if (!d.revealed) return Infinity;
    if (d.locked || this.ai.isLockedDown(doorId)) return this.canSmash() ? 4 : Infinity;
    return d.open ? 1 : 1.6;
  };

  canSmash() { return false; }

  goTo(goal: Vec3, speed: number, force = false): boolean {
    this.moveSpeed = speed;
    if (!force && this.pathGoal && flat(this.pathGoal, goal) < 0.8 && Math.abs(this.pathGoal.y - goal.y) < 2 && this.path && this.time < this.repathAt) return true;
    const path = this.m.nav.findPath(this.pos, goal, { clearance: this.clearance(), doorCost: this.doorCost, maxNodes: 9000 });
    this.repathAt = this.time + 0.6 + Math.random() * 0.4;
    if (!path || path.length === 0) { this.path = null; this.pathGoal = null; return false; }
    this.path = path;
    this.pathIdx = path.length > 1 ? 1 : 0;
    this.pathGoal = { ...goal };
    return true;
  }

  clearance() { return 1; }

  stop() { this.path = null; this.pathGoal = null; this.moveSpeed = 0; }

  arrived(tol = 0.6): boolean { return !this.path || (this.pathIdx >= this.path.length - 1 && !!this.path.length && flat(this.pos, this.path[this.path.length - 1]) < tol); }

  /** door between us and the next waypoint */
  private handleDoors(): boolean {
    if (!this.path) return true;
    const next = this.path[this.pathIdx];
    const g = this.m.nav.grid(this.m.nav.floorOf(this.pos.y));
    if (!g) return true;
    const steps = 6;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const x = this.pos.x + (next.x - this.pos.x) * t * 0.6, z = this.pos.z + (next.z - this.pos.z) * t * 0.6;
      const k = this.m.nav.cellIndex(g, x, z);
      if (k < 0) continue;
      const did = g.door[k];
      if (did < 0) continue;
      const door = this.m.doors[did];
      if (!door || door.passable) continue;
      if (flat(this.pos, v3(door.data.x, 0, door.data.z)) > 2.4) return true;
      if (door.locked || this.ai.isLockedDown(did) || !door.revealed) {
        if (this.canSmash()) { this.onSmashDoor(door); return false; }
        this.repathAt = 0; // re-plan around it
        this.path = null;
        return false;
      }
      if (!door.open) {
        this.m.toggleDoor(door, [this.pos.x, this.pos.z], true, -1, this.state === 'chase');
        this.doorWaitUntil = this.time + (this.state === 'chase' ? 0.2 : 0.45);
      }
      return this.time >= this.doorWaitUntil;
    }
    return true;
  }

  protected onSmashDoor(_door: import('../entities').MDoor) {}

  /** follow the path with the shared character controller */
  protected move(dt: number) {
    if (this.time < this.stunnedUntil) { this.speed = 0; return; }
    let dx = 0, dz = 0;
    if (this.path && this.moveSpeed > 0) {
      while (this.pathIdx < this.path.length - 1 && flat(this.pos, this.path[this.pathIdx]) < 0.45) this.pathIdx++;
      const wp = this.path[this.pathIdx];
      const ex = wp.x - this.pos.x, ez = wp.z - this.pos.z;
      const l = Math.hypot(ex, ez);
      if (l > 0.05 && this.handleDoors()) {
        const sp = Math.min(this.moveSpeed, l / dt);
        dx = (ex / l) * sp * dt; dz = (ez / l) * sp * dt;
        const desiredYaw = Math.atan2(-ex, -ez);
        this.yaw += angleDiff(desiredYaw, this.yaw) * Math.min(1, dt * 7);
      }
    }
    this.vy = Math.max(-20, this.vy - 18 * dt);
    const desired = { x: dx, y: this.vy * dt, z: dz };
    let moved = desired;
    if (this.body && this.collider) {
      const kcc = this.ai.kcc;
      kcc.computeColliderMovement(this.collider, desired, R.QueryFilterFlags.EXCLUDE_SENSORS, groups(0xffff, COLLISION.STATIC | COLLISION.DOOR));
      const c = kcc.computedMovement();
      moved = { x: c.x, y: c.y, z: c.z };
      if (kcc.computedGrounded()) this.vy = 0;
      const t = this.body.translation();
      this.body.setNextKinematicTranslation({ x: t.x + moved.x, y: t.y + moved.y, z: t.z + moved.z });
      this.pos = v3(t.x + moved.x, t.y + moved.y - this.def.height / 2, t.z + moved.z);
    } else {
      this.pos = v3(this.pos.x + moved.x, this.pos.y, this.pos.z + moved.z);
      this.vy = 0;
    }
    const want = Math.hypot(dx, dz), got = Math.hypot(moved.x, moved.z);
    this.speed = got / dt;
    if (want > 0.002 && got < want * 0.25 && this.time >= this.doorWaitUntil) {
      this.stuckTime += dt;
      if (this.stuckTime > 1.2) { this.stuckTime = 0; this.unstick(); }
    } else this.stuckTime = Math.max(0, this.stuckTime - dt);
    // falling out of the world: snap back to the nav grid
    if (this.pos.y < this.m.level.bounds.y0 - 5) this.unstick(true);
  }

  protected unstick(hard = false) {
    const c = this.m.nav.nearestCell(this.pos, 1, 6);
    this.repathAt = 0;
    if (!c) return;
    const g = this.m.nav.grid(c.floor)!;
    const p = this.m.nav.cellCenter(g, c.idx);
    const anyoneLooking = [...this.m.players.values()].some((pl) => pl.life === 'alive' && this.m.physics.lineOfSight(pv(pl.eye), this.eye) && flat(pv(pl.pos), this.pos) < 25);
    if (hard || !anyoneLooking || flat(p, this.pos) < 1.0) this.teleport(p);
    else if (this.path && this.pathGoal) this.goTo(this.pathGoal, this.moveSpeed, true);
  }

  teleport(p: Vec3) {
    this.pos = { ...p };
    this.vy = 0;
    this.body?.setTranslation({ x: p.x, y: p.y + this.def.height / 2 + 0.05, z: p.z }, true);
    this.body?.setNextKinematicTranslation({ x: p.x, y: p.y + this.def.height / 2 + 0.05, z: p.z });
  }

  face(p: Vec3, dt: number, rate = 8) { this.yaw += angleDiff(yawTo(this.pos, p), this.yaw) * Math.min(1, dt * rate); }

  // ------------------------------------------------------------------ combat
  /** melee: wind-up then hit if the target is still in range */
  meleeTick(dt: number, windup: number, onHit: (pl: MPlayer) => void): boolean {
    if (!this.target) return false;
    this.windup += dt;
    this.aux = 1;
    this.face(pv(this.target.pos), dt, 12);
    if (this.windup >= windup) {
      const d = flat(this.pos, pv(this.target.pos));
      if (d < this.def.attackRange + 0.45 && Math.abs(this.target.pos[1] - this.pos.y) < 2.2) onHit(this.target);
      this.m.emit({ k: 'eatk', id: this.id, target: this.target.netId, kind: this.type });
      this.attackReadyAt = this.time + this.def.attackCooldown;
      this.windup = 0;
      this.aux = 0;
      return true;
    }
    return false;
  }

  stun(seconds: number) {
    if (!this.def.stunnable) return;
    this.stunnedUntil = Math.max(this.stunnedUntil, this.time + seconds);
    this.m.emit({ k: 'stun', id: this.id, until: this.stunnedUntil });
    this.onStunned();
  }

  protected onStunned() {}

  damage(amount: number, _src: string) {
    if (!this.def.killable) return;
    this.hp -= amount;
    if (this.hp <= 0) this.die();
  }

  die() {
    if (this.removed) return;
    this.state = 'dead';
    this.m.emit({ k: 'sfx', s: this.type + '_death', p: [this.pos.x, this.pos.y + 0.5, this.pos.z], v: 1 });
    this.ai.remove(this, 'killed');
  }

  vocalize(kind: string, vol = 1) { this.m.emit({ k: 'sfx', s: `${this.type}_${kind}`, p: [this.pos.x, this.pos.y + this.def.height * 0.8, this.pos.z], v: vol }); }

  /** react to a noise (default: investigate if not busy) */
  onNoise(n: Noise) {
    if (this.state === 'chase' || this.state === 'attack' || this.time < this.stunnedUntil) return;
    this.lastKnown = { ...n.p };
    this.suspicion = Math.min(1, this.suspicion + n.loudness * 0.6);
    this.setState('investigate');
  }

  onMarked(pl: MPlayer) {
    if (this.state === 'attack') return;
    this.lastKnown = pv(pl.pos);
    if (this.state !== 'chase') this.setState('investigate');
  }

  abstract think(dt: number): void;

  tick(dt: number) {
    this.stateTime += dt;
    if (this.time < this.stunnedUntil) { this.state = this.state === 'dead' ? 'dead' : this.state; this.speed = 0; this.aux = 2; this.move(dt); return; }
    this.think(dt);
    this.move(dt);
    this.room = this.m.nav.roomAt(this.pos);
  }

  snap(): SnapEnemy {
    const state = this.time < this.stunnedUntil ? AI_STATE_INDEX.stunned : AI_STATE_INDEX[this.state] ?? 0;
    return { id: this.id, type: MONSTER_INDEX.indexOf(this.type), state, p: [this.pos.x, this.pos.y + this.lift, this.pos.z], yaw: this.yaw, speed: this.speed, aux: this.aux, target: this.target?.netId ?? -1 };
  }
}
