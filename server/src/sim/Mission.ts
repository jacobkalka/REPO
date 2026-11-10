// Authoritative mission simulation for one room.

import type RAPIER from '@dimforge/rapier3d-compat';
import crypto from 'node:crypto';
import { COLLISION, GRAB, groups, MISSION, NET, PLAYER } from '../../../shared/constants';
import { DIFFICULTIES } from '../../../shared/catalog/difficulty';
import { ITEM_BY_ID, type LoadoutSlot } from '../../../shared/catalog/items';
import { MATERIAL_PHYS, VALUABLE_BY_ID } from '../../../shared/catalog/valuables';
import { FURNITURE, MODELS, modelSize } from '../../../shared/catalog/furniture';
import { MONSTERS, MONSTER_INDEX, type MonsterId } from '../../../shared/catalog/monsters';
import { MAPS, type MapId } from '../../../shared/catalog/maps';
import { doorLeaves, doorOpenTarget, leafPose, stepDoorValue, swingAway } from '../../../shared/doors';
import { generateLevel } from '../../../shared/levelgen/generate';
import { buildPracticeLevel } from '../../../shared/levelgen/practice';
import { rotQ } from '../../../shared/levelgen/furnish';
import type { InteractableData, LevelData, Vec3 } from '../../../shared/levelgen/types';
import { NavGrid } from '../../../shared/nav/NavGrid';
import { buildStaticColliders } from '../../../shared/physics/colliders';
import { propColliderDesc, yawQuat } from '../../../shared/physics/rapierBuild';
import {
  BIN, BinReader, BinWriter, decodeClientState, encodeSnapshot, PF, SPF,
  type C2S, type GameEvent, type LiftState, type MissionInfo, type MissionResults, type MissionStateFull, type PlacedLight,
  type PropState, type QuotaState, type Q4, type SnapProp, type V3,
} from '../../../shared/protocol';
import { Rng } from '../../../shared/rng';
import type { Member, Room } from '../lobby/Room';
import { log } from '../log';
import { AIManager } from './ai/AIManager';
import { Director } from './Director';
import { MDoor, MPlayer, MProp } from './entities';
import { PhysicsWorld, R } from './Physics';
import type { MissionSummary } from '../economy/Economy';

const DT = 1 / NET.TICK_HZ;
const dist = (a: V3 | Vec3Like, b: V3 | Vec3Like) => { const A = toV(a), B = toV(b); return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]); };
type Vec3Like = { x: number; y: number; z: number };
const toV = (a: V3 | Vec3Like): V3 => (Array.isArray(a) ? a : [a.x, a.y, a.z]);
const vlen = (v: V3) => Math.hypot(v[0], v[1], v[2]);

export class Mission {
  readonly id = 'm' + crypto.randomBytes(6).toString('base64url');
  readonly level: LevelData;
  readonly physics: PhysicsWorld;
  readonly nav: NavGrid;
  readonly rng: Rng;
  readonly players = new Map<number, MPlayer>();
  readonly props = new Map<number, MProp>();
  readonly doors: MDoor[] = [];
  readonly inters: { data: InteractableData; state: number; until: number }[] = [];
  readonly sectors = new Map<number, boolean>();
  readonly roomLights = new Map<number, boolean>();   // room id → switched on
  readonly ai: AIManager;
  readonly director: Director;
  readonly seed: string;
  readonly practice: boolean;
  readonly difficulty: number;
  readonly diff = DIFFICULTIES[1];
  private events: GameEvent[] = [];
  private writer = new BinWriter(8192);
  private propByCollider = new Map<number, MProp>();
  tick_ = 0;
  time = 0;              // mission seconds since begin
  startAt = 0;           // seconds when control is released
  overtimeAt = 0;
  overtime = false;
  quota: QuotaState;
  lift: LiftState = { state: 'locked', until: 0, aboard: [] };
  keys = new Set<number>();
  placed = new Map<number, PlacedLight & { by: number }>();
  hazardsOff = new Map<number, number>();  // hazard id → until
  mapUntil = 0;
  docsRead = new Set<string>();
  private nextPropId = 0;
  private nextPlacedId = 1;
  ended = false;
  private endAt = 0;
  private endSuccess = false;
  private endReason = '';
  private wipeSince = 0;
  unknownAppeared = false;
  lostValue = 0;
  objectives: { id: string; label: string; bonus: number; done: boolean; data?: number }[] = [];
  private liftGate = 0; // 0 closed .. 1 open
  private crusherState = new Map<number, number>();
  readonly startedAt = Date.now();

  constructor(readonly room: Room, readonly map: MapId, difficulty: number, readonly streak: number) {
    this.difficulty = difficulty;
    this.diff = DIFFICULTIES[Math.max(0, Math.min(3, difficulty))];
    this.practice = map === 'practice';
    this.seed = crypto.randomBytes(6).toString('hex');
    this.rng = new Rng('mission:' + this.seed);
    const crew = Math.max(1, room.connectedCount);
    this.level = this.practice ? buildPracticeLevel() : generateLevel({ map, seed: this.seed, difficulty, crew, streak });
    const colliders = buildStaticColliders(this.level);
    this.physics = new PhysicsWorld(colliders);
    this.nav = NavGrid.build(this.level, colliders);
    this.quota = { quota: this.practice ? 0 : this.level.quota, inZone: 0, tubed: 0, banked: 0 };
    for (const s of this.level.sectors) this.sectors.set(s.id, s.powered);
    for (const r of this.level.rooms) this.roomLights.set(r.id, true);
    for (const d of this.level.doors) this.doors.push(this.createDoor(d));
    for (const it of this.level.interactables) this.inters.push({ data: it, state: this.initialInterState(it), until: 0 });
    for (const p of this.level.props) this.spawnProp(p.def, p.kind === 'valuable' ? 'valuable' : 'furniture', [p.x, p.y, p.z], yawQ(p.rotY), p.value, p.room);
    this.ai = new AIManager(this);
    this.director = new Director(this);
    // let physics settle so loot rests naturally on shelves before anyone sees it
    for (let i = 0; i < Math.round(MISSION.SETTLE_TIME * 60); i++) this.physics.step();
    for (const p of this.props.values()) { const v = p.body.linvel(); p.lastVel = [v.x, v.y, v.z]; p.forceSend = true; }
    let i = 0;
    for (const m of room.members.values()) this.addPlayer(m, i++);
    this.setupObjectives();
    room.manager.db.recordMissionStart({ id: this.id, room: room.code, map, difficulty, seed: this.seed, crew });
    log.info(`mission ${this.id} (${map}, d${difficulty}) generated: ${this.level.rooms.length} rooms, ${this.props.size} props, quota ${this.quota.quota}`);
  }

  // =================================================================== setup
  private initialInterState(it: InteractableData): number {
    if (it.kind === 'breaker') return this.sectors.get(it.target) ? 1 : 0;
    if (it.kind === 'lightSwitch') return 1;
    return 0;
  }

  private createDoor(d: LevelData['doors'][number]): MDoor {
    const door = new MDoor(d);
    for (const spec of doorLeaves(d)) {
      const pose = leafPose(d, spec, 0);
      const body = this.physics.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(pose.x, pose.y, pose.z).setRotation(yawQuat(pose.yaw)));
      const g = groups(COLLISION.DOOR, COLLISION.PROP | COLLISION.PLAYER | COLLISION.ENEMY);
      this.physics.world.createCollider(R.ColliderDesc.cuboid(spec.half[0], spec.half[1], spec.half[2]).setCollisionGroups(g).setSolverGroups(g), body);
      door.leaves.push({ spec, body });
    }
    if (d.startOpen && d.leaf) { door.open = true; door.target = doorOpenTarget(d, 1); door.value = door.target; this.applyDoorPose(door); }
    return door;
  }

  private applyDoorPose(door: MDoor) {
    for (const l of door.leaves) {
      const p = leafPose(door.data, l.spec, door.value);
      l.body.setNextKinematicTranslation({ x: p.x, y: p.y, z: p.z });
      l.body.setNextKinematicRotation(yawQuat(p.yaw));
    }
  }

  private addPlayer(m: Member, index: number) {
    const profile = this.room.manager.economy.get(m.id);
    const loadout = profile?.loadout ?? { light: 'light_t1', tool1: null, tool2: null, quick1: null, quick2: null, quick3: null, body: null, utility: null };
    const pl = new MPlayer(m, loadout);
    const sp = this.level.playerSpawns[index % this.level.playerSpawns.length];
    pl.pos = [sp.x, sp.y, sp.z];
    pl.accepted = [...pl.pos];
    pl.airTop = sp.y;
    pl.yaw = sp.rotY;
    pl.connected = m.connected;
    // persistent consumables that are equipped come with the player
    if (this.practice) {
      // trainee kit: free mission-only supplies and every tool to try out
      pl.loadout = { ...loadout, tool1: 'scanner', tool2: 'prod', quick1: 'medkit', quick2: 'flare', quick3: 'decoy' };
      pl.found = { medkit: 5, flare: 6, decoy: 4, battery: 3, glowstick: 10, stim: 2 };
    } else if (profile) for (const slot of ['quick1', 'quick2', 'quick3'] as LoadoutSlot[]) { const id = loadout[slot]; if (id) pl.items[id] = profile.inventory[id] ?? 0; }
    this.applyGear(pl);
    const body = this.physics.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(pl.pos[0], pl.pos[1] + 0.875, pl.pos[2]));
    const g = groups(COLLISION.PLAYER, COLLISION.PROP | COLLISION.ENEMY | COLLISION.SENSOR);
    this.physics.world.createCollider(R.ColliderDesc.capsule(0.53, PLAYER.RADIUS).setCollisionGroups(g).setSolverGroups(g), body);
    pl.body = body;
    this.players.set(pl.netId, pl);
  }

  private applyGear(pl: MPlayer) {
    const g = { resist: 0, speed: 1, noise: 1, strength: 1, reach: 0, stamina: 1, battery: 1 };
    for (const slot of ['body', 'utility'] as LoadoutSlot[]) {
      const it = pl.loadout[slot] ? ITEM_BY_ID[pl.loadout[slot]!] : null;
      if (!it) continue;
      if (it.stats.resist) g.resist = Math.max(g.resist, it.stats.resist);
      if (it.stats.speed) g.speed *= it.stats.speed;
      if (it.stats.noise) g.noise *= it.stats.noise;
      if (it.stats.strength) g.strength *= it.stats.strength;
      if (it.stats.reach) g.reach += it.stats.reach;
      if (it.stats.stamina) g.stamina *= it.stats.stamina;
      if (it.stats.battery) g.battery *= it.stats.battery;
    }
    pl.gear = g;
    const light = ITEM_BY_ID[pl.loadout.light ?? 'light_t1'] ?? ITEM_BY_ID.light_t1;
    pl.batteryMax = light.stats.battery * g.battery;
    pl.battery = pl.batteryMax;
    const prod = pl.loadout.tool1 === 'prod' || pl.loadout.tool2 === 'prod';
    pl.prodCharges = prod ? ITEM_BY_ID.prod.stats.charges : 0;
  }

  private setupObjectives() {
    if (this.practice) return;
    const dark = this.level.sectors.filter((s) => !s.powered);
    const opts: Mission['objectives'] = [];
    if (dark.length) opts.push({ id: 'power', label: 'Restore power to every sector', bonus: Math.round(1500 * this.diff.rewardMult), done: false });
    opts.push({ id: 'nolosses', label: 'Bring the whole crew home', bonus: Math.round(2000 * this.diff.rewardMult), done: false });
    opts.push({ id: 'docs', label: 'Recover 3 documents', bonus: Math.round(800 * this.diff.rewardMult), done: false, data: 3 });
    opts.push({ id: 'pristine', label: 'Extract 3 items without a scratch', bonus: Math.round(1200 * this.diff.rewardMult), done: false, data: 3 });
    this.rng.shuffle(opts);
    this.objectives = opts.slice(0, 2);
  }

  // =================================================================== props
  spawnProp(def: string, kind: MProp['kind'], p: V3, q: Q4, value: number, room: number, vel?: V3): MProp | null {
    const val = VALUABLE_BY_ID[def];
    const model = val ? val.model : def;
    const info = MODELS[model];
    if (!info) { log.warn('unknown prop model', model); return null; }
    const furn = FURNITURE[model];
    const mass = val ? val.mass : furn?.mass ?? (kind === 'thrown' ? 0.4 : 8);
    const mat = val ? val.mat : furn?.mat ?? 'plastic';
    const phys = MATERIAL_PHYS[mat];
    const size = info.size;
    const bd = R.RigidBodyDesc.dynamic().setTranslation(p[0], p[1], p[2]).setRotation({ x: q[0], y: q[1], z: q[2], w: q[3] })
      .setLinearDamping(0.06).setAngularDamping(0.35).setCcdEnabled(Math.max(...size) < 0.35 || mass < 3).setCanSleep(true);
    if (vel) bd.setLinvel(vel[0], vel[1], vel[2]);
    const body = this.physics.world.createRigidBody(bd);
    const g = groups(COLLISION.PROP, 0xffff & ~COLLISION.HELD);
    const cd = propColliderDesc(R, info.hull, size).setMass(mass).setFriction(furn?.friction ?? phys.friction).setRestitution(phys.restitution).setCollisionGroups(g).setSolverGroups(g);
    const collider = this.physics.world.createCollider(cd, body);
    const id = this.nextPropId++;
    const prop = new MProp({ id, def, kind, body, collider, mass, base: value, value, fragility: val?.fragility ?? 0, mat, volatile: !!val?.volatile, cursed: !!val?.cursed, radius: Math.max(size[0], size[2]) / 2, halfHeight: size[1] / 2, spawn: [...p], room });
    this.props.set(id, prop);
    this.propByCollider.set(collider.handle, prop);
    return prop;
  }

  propState(p: MProp): PropState {
    const t = p.body.translation(), r = p.body.rotation();
    const lp: PropState['helpers'] = [...p.helpers.keys()];
    return { id: p.id, def: p.def, kind: p.kind, p: [t.x, t.y, t.z], q: [r.x, r.y, r.z, r.w], value: Math.round(p.value), base: p.base, owner: p.owner, helpers: lp, mass: p.mass };
  }

  removeProp(p: MProp, why: Extract<GameEvent, { k: 'prop-' }>['why']) {
    if (p.removed) return;
    p.removed = true;
    if (p.owner >= 0) { const o = this.players.get(p.owner); if (o) o.owned = -1; }
    for (const h of p.helpers.keys()) { const pl = this.players.get(h); if (pl) pl.helping = -1; }
    this.propByCollider.delete(p.collider.handle);
    this.physics.world.removeRigidBody(p.body);
    this.props.delete(p.id);
    if (p.lightId >= 0) { this.placed.delete(p.lightId); this.emit({ k: 'placed-', id: p.lightId }); }
    this.emit({ k: 'prop-', id: p.id, why });
  }

  propAt(collider: RAPIER.Collider): MProp | undefined { return this.propByCollider.get(collider.handle); }

  private emitOwn(p: MProp) {
    const lp: Record<number, V3> = {};
    for (const [k, v] of p.lps) lp[k] = v;
    this.emit({ k: 'own', id: p.id, owner: p.owner, helpers: [...p.helpers.keys()], lp });
  }

  private grab(pl: MPlayer, msg: Extract<C2S, { t: 'grab' }>) {
    const reply = (ok: boolean, role: 'owner' | 'helper' | 'none') => pl.member.session?.send({ t: 'grabRes', prop: msg.prop, ok, role, req: msg.req });
    const p = this.props.get(msg.prop);
    if (!p || p.removed || !pl.alive || pl.pinnedBy >= 0 || this.time < this.startAt - 0.5) return reply(false, 'none');
    if (pl.owned >= 0 || pl.helping >= 0) this.releaseAll(pl);
    const eye = pl.eye;
    const reach = PLAYER.REACH + pl.gear.reach;
    const c = p.position();
    if (dist(eye, c) > reach + p.radius + 0.9) return reply(false, 'none');
    if (!this.physics.lineOfSight({ x: eye[0], y: eye[1], z: eye[2] }, { x: c[0], y: c[1], z: c[2] }, COLLISION.STATIC)) {
      // allow if the grab point is on the near side (large objects)
      if (dist(eye, c) > p.radius + 0.6) return reply(false, 'none');
    }
    const lp: V3 = [clamp(msg.lp?.[0] ?? 0, -2, 2), clamp(msg.lp?.[1] ?? 0, -2, 2), clamp(msg.lp?.[2] ?? 0, -2, 2)];
    p.lps.set(pl.netId, lp);
    if (p.owner < 0) {
      p.owner = pl.netId;
      p.ownerSince = this.time;
      p.invalidPoses = 0;
      p.body.setBodyType(R.RigidBodyType.KinematicPositionBased, true);
      p.collider.setCollisionGroups(groups(COLLISION.HELD, COLLISION.STATIC | COLLISION.PROP | COLLISION.ENEMY | COLLISION.DOOR));
      pl.owned = p.id;
      reply(true, 'owner');
    } else if (p.helpers.size < GRAB.MAX_HELPERS && p.owner !== pl.netId) {
      p.helpers.set(pl.netId, { netId: pl.netId, lp, target: null, since: this.time });
      pl.helping = p.id;
      reply(true, 'helper');
    } else return reply(false, 'none');
    p.lastHolder = pl.netId;
    p.maxHolders = Math.max(p.maxHolders, 1 + p.helpers.size);
    if (p.maxHolders >= 3) for (const n of [p.owner, ...p.helpers.keys()]) { const x = this.players.get(n); if (x) x.coCarry3 = true; }
    if (p.cursed && !p.cursedTriggered) { p.cursedTriggered = true; this.director.cursedTaken(pl); }
    this.emitOwn(p);
  }

  /** release / drop; validated pose and clamped throw velocity */
  private release(pl: MPlayer, msg: Extract<C2S, { t: 'release' }>) {
    const p = this.props.get(msg.prop);
    if (!p || p.removed) return;
    if (p.owner === pl.netId) {
      const pose = this.validPose(pl, p, msg.p) ? msg.p : p.position();
      let v: V3 = [num(msg.v?.[0]), num(msg.v?.[1]), num(msg.v?.[2])];
      const vmax = Math.min(GRAB.MAX_THROW_SPEED, 4 + (60 * pl.gear.strength) / Math.max(1, p.mass));
      const sp = vlen(v);
      if (sp > vmax) v = [v[0] / sp * vmax, v[1] / sp * vmax, v[2] / sp * vmax];
      const w: V3 = [clamp(num(msg.w?.[0]), -30, 30), clamp(num(msg.w?.[1]), -30, 30), clamp(num(msg.w?.[2]), -30, 30)];
      this.dropOwnership(pl, p, pose, normQ(msg.q), v, w);
      if (msg.thrown && p.mass > 0) this.noise(pose, Math.min(0.5, 0.15 + p.mass * 0.01), 'throw', pl.netId);
    } else if (p.helpers.has(pl.netId)) {
      p.helpers.delete(pl.netId);
      p.lps.delete(pl.netId);
      pl.helping = -1;
      this.emitOwn(p);
    }
  }

  private dropOwnership(pl: MPlayer, p: MProp, pose: V3, q: Q4, v: V3, w: V3) {
    pl.owned = -1;
    p.lps.delete(pl.netId);
    // promote a helper to owner if one is still holding on
    const next = [...p.helpers.values()].sort((a, b) => a.since - b.since)[0];
    if (next) {
      p.helpers.delete(next.netId);
      p.owner = next.netId;
      p.ownerSince = this.time;
      const np = this.players.get(next.netId);
      if (np) { np.helping = -1; np.owned = p.id; }
      p.body.setNextKinematicTranslation({ x: pose[0], y: pose[1], z: pose[2] });
    } else {
      p.owner = -1;
      p.body.setBodyType(R.RigidBodyType.Dynamic, true);
      p.collider.setCollisionGroups(groups(COLLISION.PROP, 0xffff & ~COLLISION.HELD));
      p.body.setTranslation({ x: pose[0], y: pose[1], z: pose[2] }, true);
      p.body.setRotation({ x: q[0], y: q[1], z: q[2], w: q[3] }, true);
      p.body.setLinvel({ x: v[0], y: v[1], z: v[2] }, true);
      p.body.setAngvel({ x: w[0], y: w[1], z: w[2] }, true);
      p.lastVel = [...v];
      p.skipImpact = 3;
    }
    p.forceSend = true;
    this.emitOwn(p);
  }

  releaseAll(pl: MPlayer) {
    if (pl.owned >= 0) {
      const p = this.props.get(pl.owned);
      if (p && p.owner === pl.netId) { const r = p.body.rotation(); this.dropOwnership(pl, p, p.position(), [r.x, r.y, r.z, r.w], p.pose?.v ?? [0, 0, 0], [0, 0, 0]); }
      pl.owned = -1;
    }
    if (pl.helping >= 0) {
      const p = this.props.get(pl.helping);
      if (p) { p.helpers.delete(pl.netId); p.lps.delete(pl.netId); this.emitOwn(p); }
      pl.helping = -1;
    }
  }

  private validPose(pl: MPlayer, p: MProp, pos: V3): boolean {
    if (!pos.every(Number.isFinite)) return false;
    const reach = PLAYER.REACH + pl.gear.reach + 2.6 + (p.helpers.size ? 2.5 : 0) + p.radius;
    if (dist(pl.eye, pos) > reach) return false;
    if (this.physics.pointInStatic({ x: pos[0], y: pos[1], z: pos[2] })) return false;
    return true;
  }

  private ownedPose(pl: MPlayer, o: { id: number; p: V3; q: Q4; v: V3; w: V3 }) {
    const p = this.props.get(o.id);
    if (!p || p.owner !== pl.netId) return;
    const sp = vlen(o.v);
    if (!this.validPose(pl, p, o.p) || sp > GRAB.MAX_HELD_SPEED) {
      if (++p.invalidPoses > GRAB.MAX_INVALID_POSES) { this.releaseAll(pl); log.debug('ownership revoked (invalid poses)', pl.name, p.id); }
      return;
    }
    p.invalidPoses = 0;
    p.pose = { p: o.p, q: o.q, v: o.v, w: o.w };
    p.body.setNextKinematicTranslation({ x: o.p[0], y: o.p[1], z: o.p[2] });
    p.body.setNextKinematicRotation({ x: o.q[0], y: o.q[1], z: o.q[2], w: o.q[3] });
  }

  /** apply impact damage to a valuable */
  impact(p: MProp, speed: number, by = -1) {
    if (p.removed || p.kind !== 'valuable' || this.time < this.startAt) return;
    if (this.time - p.lastImpactAt < 0.12) return;
    p.lastImpactAt = this.time;
    const over = speed - MISSION.DAMAGE_SPEED;
    if (over <= 0) return;
    const frac = Math.min(0.72, p.fragility * 0.06 * over ** 1.35);
    if (frac < 0.004) return;
    const lost = Math.min(p.value, Math.round(p.value * frac));
    if (lost <= 0) return;
    p.value -= lost;
    p.damaged = true;
    this.lostValue += lost;
    const pos = p.position();
    this.emit({ k: 'val', id: p.id, v: Math.round(p.value), dmg: lost, p: pos });
    if (p.volatile && speed > 6 && p.value < p.base * 0.45) { this.explode(pos, 4.8, p); return; }
    if (p.fragility >= 0.5 && p.value < p.base * MISSION.BREAK_FRACTION) {
      this.emit({ k: 'sfx', s: 'shatter_' + p.mat, p: pos, v: 1 });
      this.noise(pos, 0.75, 'break', by);
      this.removeProp(p, 'broken');
    }
  }

  explode(pos: V3, radius: number, source?: MProp) {
    if (source) this.removeProp(source, 'exploded');
    this.emit({ k: 'boom', p: pos, r: radius });
    this.noise(pos, 1.0, 'explosion', -1);
    for (const pl of this.players.values()) {
      const d = dist(pl.eye, pos);
      if (d < radius) this.damagePlayer(pl, Math.round(70 * (1 - d / radius)) + 8, 'explosion', pos, 7 * (1 - d / radius));
    }
    for (const q of [...this.props.values()]) {
      const c = q.position();
      const d = dist(c, pos);
      if (d < radius && !q.held) {
        const k = (1 - d / radius) * 9 * Math.min(1, 20 / Math.max(q.mass, 1));
        const dir = [(c[0] - pos[0]) / (d || 1), (c[1] - pos[1]) / (d || 1) + 0.4, (c[2] - pos[2]) / (d || 1)];
        q.body.applyImpulse({ x: dir[0] * k * q.mass, y: dir[1] * k * q.mass, z: dir[2] * k * q.mass }, true);
      }
    }
    this.ai.explosion(pos, radius);
  }

  // =================================================================== doors
  toggleDoor(door: MDoor, from: [number, number], open: boolean, by: number, fast = false) {
    if (door.broken || !door.data.leaf) return;
    if (open === door.open) return;
    door.open = open;
    door.fast = fast;
    door.target = open ? doorOpenTarget(door.data, swingAway(door.data, from)) : 0;
    door.lastToggle = this.time;
    this.emit({ k: 'door', id: door.data.id, open, locked: door.locked, broken: door.broken, by });
    const pos: V3 = [door.data.x, door.data.y + 1.2, door.data.z];
    this.emit({ k: 'sfx', s: (open ? 'door_open_' : 'door_close_') + door.data.style, p: pos, v: fast ? 1 : 0.8 });
    this.noise(pos, fast ? 0.55 : 0.3, 'door', by);
  }

  smashDoor(door: MDoor, from: [number, number]) {
    if (door.broken) return;
    door.broken = true;
    door.open = true;
    door.locked = false;
    door.revealed = true;
    for (const l of door.leaves) this.physics.world.removeRigidBody(l.body);
    door.leaves = [];
    const pos: V3 = [door.data.x, door.data.y + 1.2, door.data.z];
    this.emit({ k: 'door', id: door.data.id, open: true, locked: false, broken: true, by: -1, smash: true });
    this.emit({ k: 'sfx', s: 'door_smash', p: pos, v: 1 });
    this.noise(pos, 0.95, 'smash', -1);
    void from;
  }

  private stepDoors(dt: number) {
    for (const d of this.doors) {
      if (!d.leaves.length || d.value === d.target) continue;
      d.value = stepDoorValue(d.data, d.value, d.target, dt, d.fast);
      this.applyDoorPose(d);
    }
  }

  // =================================================================== players
  onBinary(m: Member, data: Uint8Array) {
    const pl = this.players.get(m.netId);
    if (!pl || this.ended) return;
    const r = new BinReader(data);
    const type = r.u8();
    if (type !== BIN.STATE) return;
    let s;
    try { s = decodeClientState(r); } catch { m.session?.violation('bad state packet'); return; }
    if (s.epoch !== (pl.epoch & 0xff)) return; // stale packet from before a correction
    const now = this.time;
    const dtReal = clamp(now - pl.lastStateAt, 0, 0.5);
    pl.lastStateAt = now;
    pl.yaw = s.yaw; pl.pitch = clamp(s.pitch, -1.6, 1.6); pl.anim = s.anim;
    const keepFlags = pl.flags & (PF.DOWNED | PF.DEAD | PF.PINNED | PF.MARKED | PF.EXTRACTED | PF.STUNNED);
    let flags = (s.flags & (PF.CROUCH | PF.SPRINT | PF.GROUNDED | PF.LIGHT | PF.TALKING | PF.HOLDING | PF.RADIO | PF.TRACKER)) | keepFlags;
    if (pl.battery <= 0) flags &= ~(PF.LIGHT | PF.TRACKER);
    pl.flags = flags;
    pl.hold = s.hold;
    if (pl.life === 'dead' || pl.life === 'extracted' || pl.life === 'left') return;
    if (this.validateMove(pl, s.p, dtReal, (s.flags & PF.GROUNDED) !== 0)) {
      pl.vel = s.v;
    }
    for (const o of s.owned) this.ownedPose(pl, o);
    if (s.help && pl.helping === s.help.prop) {
      const p = this.props.get(s.help.prop);
      const h = p?.helpers.get(pl.netId);
      if (h && s.help.t.every(Number.isFinite) && dist(pl.eye, s.help.t) < PLAYER.REACH + 3) h.target = s.help.t;
    }
  }

  private validateMove(pl: MPlayer, np: V3, dt: number, grounded: boolean): boolean {
    const a = pl.accepted;
    const downed = pl.life === 'downed';
    const stim = this.time < pl.stimUntil ? 1.15 : 1;
    const maxSpeed = (downed ? PLAYER.DOWNED_SPEED * 1.4 : PLAYER.SPRINT_SPEED * pl.gear.speed * stim) * 1.3 + 0.6;
    pl.moveBudget = Math.min(pl.moveBudget + maxSpeed * dt, 4.5);
    pl.upBudget = Math.min(pl.upBudget + 8 * dt, 3.2);
    const dx = np[0] - a[0], dz = np[2] - a[2], dy = np[1] - a[1];
    const h = Math.hypot(dx, dz);
    let bad = '';
    if (!np.every(Number.isFinite)) bad = 'nan';
    else if (pl.pinnedBy >= 0 || this.time < pl.stunnedUntil || this.time < this.startAt - 0.25) { if (h > 0.35 || Math.abs(dy) > 0.6) bad = 'immobile'; }
    else if (h > 10 || dy > 4) bad = 'teleport';
    else if (h > pl.moveBudget + 0.3) bad = 'speed';
    else if (dy > pl.upBudget + 0.35) bad = 'vertical';
    if (!bad && (h > 0.05 || Math.abs(dy) > 0.05) && this.physics.sweepBlocked({ x: a[0], y: a[1], z: a[2] }, { x: np[0], y: np[1], z: np[2] })) bad = 'wall';
    if (bad) {
      pl.violations++;
      pl.epoch = (pl.epoch + 1) & 0xff;
      pl.moveBudget = 1;
      pl.member.session?.send({ t: 'correct', p: [...a], v: [0, 0, 0], epoch: pl.epoch });
      if (pl.violations % 10 === 1) log.debug(`movement correction for ${pl.name}: ${bad}`);
      return false;
    }
    pl.moveBudget -= h;
    if (dy > 0) pl.upBudget -= dy;
    // fall tracking
    if (!grounded) pl.airTop = Math.max(pl.airTop, np[1]);
    else {
      if (!pl.wasGrounded) {
        const drop = pl.airTop - np[1];
        if (drop > PLAYER.SAFE_FALL) {
          this.damagePlayer(pl, Math.round((drop - PLAYER.SAFE_FALL) * PLAYER.FALL_DAMAGE_PER_M), 'fall');
          this.noise(np, 0.6, 'land', pl.netId);
        } else if (drop > 1.2) this.noise(np, 0.35 * pl.gear.noise, 'land', pl.netId);
      }
      pl.airTop = np[1];
    }
    pl.wasGrounded = grounded;
    pl.accepted = [...np];
    pl.pos = [...np];
    pl.body?.setNextKinematicTranslation({ x: np[0], y: np[1] + 0.875, z: np[2] });
    // footstep noise for the AI
    const speed = h / Math.max(dt, 1e-3);
    if (grounded && speed > 1.2 && this.time - pl.lastNoiseAt > 0.42) {
      pl.lastNoiseAt = this.time;
      const crouch = (pl.flags & PF.CROUCH) !== 0;
      const loud = crouch ? 0.08 : speed > 5.2 ? 0.62 : speed > 3.5 ? 0.38 : 0.22;
      this.noise(np, loud * pl.gear.noise, 'step', pl.netId);
    }
    return true;
  }

  damagePlayer(pl: MPlayer, amount: number, src: string, from?: V3, knock = 0) {
    if (this.ended || pl.life === 'dead' || pl.life === 'extracted' || pl.life === 'left') return;
    if (pl.god || this.time < pl.invulnUntil || this.time < this.startAt) return;
    if (pl.life === 'downed') {
      // hits while downed shorten the bleed-out
      pl.bleedUntil -= Math.min(12, amount * 0.4);
      this.emit({ k: 'dmg', target: pl.netId, amount: 0, hp: 0, src, from });
      return;
    }
    const resist = pl.gear.resist + (this.time < pl.stimUntil ? 0.25 : 0);
    const dmg = Math.max(1, Math.round(amount * (1 - Math.min(0.7, resist))));
    pl.hp = Math.max(0, pl.hp - dmg);
    pl.damageTaken += dmg;
    let kb: V3 | undefined;
    if (from && knock > 0) {
      const d = [pl.pos[0] - from[0], pl.pos[2] - from[2]];
      const l = Math.hypot(d[0], d[1]) || 1;
      kb = [d[0] / l * knock, Math.min(4, knock * 0.4), d[1] / l * knock];
    }
    this.emit({ k: 'dmg', target: pl.netId, amount: dmg, hp: pl.hp, src, from, kb });
    this.director.onDamage(pl, dmg);
    if (pl.hp <= 0) this.downPlayer(pl, src);
  }

  private downPlayer(pl: MPlayer, src: string) {
    if (src === 'unknown') { this.killPlayer(pl); return; }
    pl.life = 'downed';
    pl.downs++;
    pl.bleedUntil = this.time + PLAYER.BLEEDOUT_TIME;
    pl.flags |= PF.DOWNED;
    pl.pinnedBy = -1;
    this.releaseAll(pl);
    this.emit({ k: 'life', id: pl.netId, state: 'downed', hp: 0 });
    this.emit({ k: 'msg', text: `${pl.name} is down!`, kind: 'warn' });
    this.ai.onPlayerDowned(pl);
  }

  killPlayer(pl: MPlayer) {
    if (pl.life === 'dead') return;
    pl.life = 'dead';
    pl.hp = 0;
    pl.died = true;
    pl.deathPos = [...pl.pos];
    pl.flags = (pl.flags | PF.DEAD) & ~(PF.DOWNED | PF.LIGHT | PF.PINNED);
    this.releaseAll(pl);
    this.emit({ k: 'life', id: pl.netId, state: 'dead', hp: 0 });
    this.emit({ k: 'msg', text: `${pl.name} didn't make it.`, kind: 'warn' });
  }

  revivePlayer(pl: MPlayer, hp: number, by: number) {
    pl.life = 'alive';
    pl.hp = hp;
    pl.flags &= ~(PF.DOWNED | PF.DEAD);
    pl.invulnUntil = this.time + 2.5;
    if (pl.deathPos) { pl.pos = [...pl.deathPos]; pl.accepted = [...pl.deathPos]; pl.deathPos = null; }
    this.emit({ k: 'life', id: pl.netId, state: 'alive', hp, by });
    const reviver = this.players.get(by);
    if (reviver) { reviver.revives++; this.emit({ k: 'msg', text: `${reviver.name} revived ${pl.name}.`, kind: 'good' }); }
  }

  heal(pl: MPlayer, amount: number) {
    if (pl.life !== 'alive') return;
    pl.hp = Math.min(PLAYER.MAX_HEALTH, pl.hp + amount);
    this.emit({ k: 'heal', id: pl.netId, hp: Math.round(pl.hp) });
  }

  private tickPlayers(dt: number) {
    let anyAlive = false;
    for (const pl of this.players.values()) {
      if (pl.life === 'alive') anyAlive = true;
      if (pl.life === 'downed' && this.time > pl.bleedUntil) this.killPlayer(pl);
      // healing over time
      if (pl.healUntil > this.time && pl.life === 'alive') { pl.hp = Math.min(100, pl.hp + pl.healPerSec * dt); if (Math.floor(this.time * 4) !== Math.floor((this.time - dt) * 4)) this.emit({ k: 'heal', id: pl.netId, hp: Math.round(pl.hp) }); }
      // battery drain
      if ((pl.flags & PF.LIGHT) && pl.battery > 0) pl.battery = Math.max(0, pl.battery - dt);
      if ((pl.flags & PF.TRACKER) && pl.battery > 0) pl.battery = Math.max(0, pl.battery - dt * ITEM_BY_ID.tracker.stats.drain);
      if (pl.battery <= 0 && (pl.flags & PF.LIGHT) && Math.floor(this.time) !== Math.floor(this.time - dt)) this.sendItems(pl);
      // prod recharge
      if (pl.prodRecharge.length && this.time >= pl.prodRecharge[0]) { pl.prodRecharge.shift(); pl.prodCharges++; this.sendItems(pl); }
      if (pl.markedUntil && this.time > pl.markedUntil) { pl.markedUntil = 0; pl.flags &= ~PF.MARKED; }
      if (this.time < pl.stunnedUntil) pl.flags |= PF.STUNNED; else pl.flags &= ~PF.STUNNED;
      if (pl.pinnedBy >= 0) pl.flags |= PF.PINNED; else pl.flags &= ~PF.PINNED;
      // revive progress decays if not refreshed
      for (const [k, v] of [...pl.reviveProgress]) if (this.time - v.at > 0.6) pl.reviveProgress.delete(k);
      // disconnected players drop what they hold
      if (!pl.connected && (pl.owned >= 0 || pl.helping >= 0)) this.releaseAll(pl);
    }
    // team wipe
    const active = [...this.players.values()].filter((p) => p.life !== 'left' && p.life !== 'extracted');
    if (!this.practice && active.length && !anyAlive && this.lift.state !== 'departing' && this.lift.state !== 'gone') {
      if (!this.wipeSince) this.wipeSince = this.time;
      if (this.time - this.wipeSince > 4) this.finish(false, 'The crew was lost.');
    } else this.wipeSince = 0;
  }

  sendItems(pl: MPlayer) {
    const items: Record<string, number> = {};
    for (const k of new Set([...Object.keys(pl.items), ...Object.keys(pl.found)])) items[k] = pl.countOf(k);
    items.__prod = pl.prodCharges;
    items.__scanner = Math.max(0, Math.ceil(pl.scannerReadyAt - this.time));
    this.emit({ k: 'items', id: pl.netId, items, battery: pl.battery / Math.max(1, pl.batteryMax) });
  }

  // =================================================================== interaction
  handle(m: Member, msg: C2S) {
    const pl = this.players.get(m.netId);
    if (!pl || this.ended) return;
    switch (msg.t) {
      case 'grab': return this.grab(pl, msg);
      case 'release': return this.release(pl, msg);
      case 'interact': return this.interact(pl, msg);
      case 'use': return this.use(pl, msg);
      case 'impact': return this.reportedImpact(pl, msg);
      case 'voice': {
        if (!this.room.settings.voiceNoise || this.time - pl.lastVoiceAt < 0.25 || pl.life !== 'alive') return;
        pl.lastVoiceAt = this.time;
        const lvl = clamp(num(msg.level), 0, 1);
        if (lvl > 0.15) this.noise(pl.eye, 0.25 + lvl * 0.5, 'voice', pl.netId);
        return;
      }
      case 'mark': {
        if (this.time - (pl.lastPingAt ?? -9) < 1.2 || !msg.p?.every(Number.isFinite)) return;
        pl.lastPingAt = this.time;
        if (dist(pl.eye, msg.p) > 40) return;
        this.emit({ k: 'ping', by: pl.netId, p: msg.p });
        return;
      }
      case 'abandon':
        if (m.id === this.room.hostId) this.finish(false, 'The contract was abandoned.');
        return;
      case 'dev': return this.dev(pl, msg);
      default:
    }
  }

  private reportedImpact(pl: MPlayer, msg: Extract<C2S, { t: 'impact' }>) {
    const p = this.props.get(msg.prop);
    if (!p || p.owner !== pl.netId) return;
    const last = pl.lastImpactReport.get(p.id) ?? -1;
    if (this.time - last < 0.15) return;
    pl.lastImpactReport.set(p.id, this.time);
    const reportedV = p.pose ? vlen(p.pose.v) : 0;
    const speed = clamp(num(msg.speed), 0, Math.min(25, reportedV + 4.5));
    if (msg.enemy !== undefined && msg.enemy >= 0) this.ai.hitByProp(msg.enemy, p, speed, pl);
    this.impact(p, speed, pl.netId);
    if (speed > 3) this.emit({ k: 'sfx', s: 'impact_' + p.mat, p: p.position(), v: Math.min(1, speed / 9), r: p.mass });
    if (speed > 2.5) this.noise(p.position(), Math.min(0.8, 0.1 + speed * 0.04 + p.mass * 0.004), 'impact', pl.netId);
  }

  private interact(pl: MPlayer, msg: Extract<C2S, { t: 'interact' }>) {
    if (pl.life !== 'alive' || pl.pinnedBy >= 0) return;
    const eye = pl.eye;
    if (msg.kind === 'door') {
      const d = this.doors[msg.target];
      if (!d || !d.data.leaf || d.broken) return;
      if (dist(eye, [d.data.x, d.data.y + 1.2, d.data.z]) > 3.2) return;
      if (!d.revealed) return;
      if (this.time - d.lastToggle < 0.35) return;
      if (d.locked) {
        if (this.keys.has(d.data.lockedBy)) {
          d.locked = false;
          this.emit({ k: 'sfx', s: 'keycard_ok', p: [d.data.x, d.data.y + 1.2, d.data.z], v: 0.9 });
          this.emit({ k: 'msg', text: 'Security door unlocked.', kind: 'good' });
        } else {
          this.emit({ k: 'sfx', s: 'keycard_denied', p: [d.data.x, d.data.y + 1.2, d.data.z], v: 0.8 });
          pl.member.session?.send({ t: 'ev', e: [{ k: 'msg', text: 'Locked. A keycard is needed.', kind: 'info' }] });
          return;
        }
      }
      this.toggleDoor(d, [pl.pos[0], pl.pos[2]], !d.open, pl.netId);
      return;
    }
    if (msg.kind === 'player') {
      const t = this.players.get(msg.target);
      if (!t || t === pl || t.life !== 'downed') return;
      if (dist(pl.pos, t.pos) > PLAYER.REVIVE_RANGE + 0.4) return;
      const prog = t.reviveProgress.get(pl.netId) ?? { t: 0, at: this.time };
      prog.t += Math.min(0.5, this.time - prog.at + 0.0001);
      prog.at = this.time;
      t.reviveProgress.set(pl.netId, prog);
      this.emit({ k: 'revive', id: t.netId, by: pl.netId, progress: Math.min(1, prog.t / PLAYER.REVIVE_TIME) });
      if (prog.t >= PLAYER.REVIVE_TIME) { t.reviveProgress.clear(); this.revivePlayer(t, PLAYER.REVIVE_HEALTH, pl.netId); }
      return;
    }
    const it = this.inters[msg.target];
    if (!it) return;
    const d = it.data;
    if (dist(eye, [d.x, d.y, d.z]) > 2.8) return;
    const pos: V3 = [d.x, d.y, d.z];
    switch (d.kind) {
      case 'breaker': {
        const on = !this.sectors.get(d.target);
        this.setPower(d.target, on, pl.netId);
        if (on) pl.power++;
        return;
      }
      case 'lightSwitch': {
        const on = !this.roomLights.get(d.target);
        this.roomLights.set(d.target, on);
        it.state = on ? 1 : 0;
        this.emit({ k: 'light', room: d.target, on });
        this.emit({ k: 'inter', id: d.id, state: it.state, by: pl.netId });
        this.emit({ k: 'sfx', s: 'switch', p: pos, v: 0.6 });
        return;
      }
      case 'tube': return this.useTube(pl, it);
      case 'keycard': {
        if (it.state) return;
        it.state = 1;
        this.keys.add(Number(d.data));
        this.emit({ k: 'inter', id: d.id, state: 1, by: pl.netId });
        this.emit({ k: 'keys', keys: [...this.keys] });
        this.emit({ k: 'msg', text: `${pl.name} found a security keycard.`, kind: 'good' });
        this.emit({ k: 'sfx', s: 'pickup', p: pos, v: 0.7 });
        return;
      }
      case 'document': {
        if (!this.docsRead.has(d.data)) { this.docsRead.add(d.data); pl.docs++; }
        it.state = 1;
        this.emit({ k: 'doc', doc: d.data, by: pl.netId });
        this.emit({ k: 'inter', id: d.id, state: 1, by: pl.netId });
        this.checkObjectives();
        return;
      }
      case 'terminal': {
        if (it.until > this.time) return;
        it.until = this.time + 90;
        this.mapUntil = this.time + 75;
        this.emit({ k: 'map', until: this.mapUntil });
        this.emit({ k: 'inter', id: d.id, state: 1, by: pl.netId });
        this.emit({ k: 'msg', text: 'Facility schematic downloaded to crew HUDs.', kind: 'good' });
        this.emit({ k: 'sfx', s: 'terminal', p: pos, v: 0.8 });
        return;
      }
      case 'hiddenTrigger': {
        const door = this.doors[d.target];
        if (!door || it.state) return;
        it.state = 1;
        door.revealed = true;
        this.toggleDoor(door, [pl.pos[0], pl.pos[2]], true, pl.netId);
        this.emit({ k: 'inter', id: d.id, state: 1, by: pl.netId });
        this.emit({ k: 'sfx', s: 'secret', p: [door.data.x, door.data.y + 1, door.data.z], v: 1 });
        this.emit({ k: 'msg', text: 'Something shifted behind the wall...', kind: 'info' });
        return;
      }
      case 'supply': {
        if (it.state) return;
        it.state = 1;
        pl.found[d.data] = (pl.found[d.data] ?? 0) + 1;
        this.emit({ k: 'inter', id: d.id, state: 1, by: pl.netId });
        this.emit({ k: 'sfx', s: 'crate_open', p: pos, v: 0.7 });
        pl.member.session?.send({ t: 'ev', e: [{ k: 'msg', text: `Found: ${ITEM_BY_ID[d.data]?.name ?? d.data}`, kind: 'good' }] });
        this.sendItems(pl);
        return;
      }
      case 'valveWheel': {
        const h = this.level.hazards[d.target];
        if (!h) return;
        const off = !this.hazardsOff.has(h.id);
        if (off) this.hazardsOff.set(h.id, this.time + 120); else this.hazardsOff.delete(h.id);
        it.state = off ? 1 : 0;
        this.emit({ k: 'hazard', id: h.id, on: !off });
        this.emit({ k: 'inter', id: d.id, state: it.state, by: pl.netId });
        this.emit({ k: 'sfx', s: 'valve', p: pos, v: 0.8 });
        return;
      }
      case 'liftLever': return this.pullLever(pl);
      default:
    }
  }

  setPower(sector: number, on: boolean, by: number) {
    if (this.sectors.get(sector) === on) return;
    this.sectors.set(sector, on);
    for (const it of this.inters) if (it.data.kind === 'breaker' && it.data.target === sector) { it.state = on ? 1 : 0; this.emit({ k: 'inter', id: it.data.id, state: it.state, by }); }
    this.emit({ k: 'power', sector, on, by });
    const br = this.level.sectors.find((s) => s.id === sector);
    const bi = br && br.breaker >= 0 ? this.level.interactables[br.breaker] : null;
    if (bi) this.emit({ k: 'sfx', s: on ? 'power_on' : 'power_off', p: [bi.x, bi.y, bi.z], v: 1, e: 1 });
    if (on && by >= 0) this.emit({ k: 'msg', text: 'Power restored to a sector.', kind: 'good' });
    this.checkObjectives();
  }

  private useTube(pl: MPlayer, it: Mission['inters'][number]) {
    const d = it.data;
    const pos: V3 = [d.x, d.y, d.z];
    if (!this.sectors.get(d.sector)) { pl.member.session?.send({ t: 'ev', e: [{ k: 'msg', text: 'The cargo tube has no power. Find the breaker for this sector.', kind: 'info' }] }); this.emit({ k: 'sfx', s: 'denied', p: pos, v: 0.6 }); return; }
    if (it.until > this.time) return;
    const proc = this.level.procs[d.target];
    if (!proc) return;
    // intake box in front of the tube
    const [fx, fz] = rotQ(0, proc.d / 2 + 0.55, proc.rotY);
    const cx = proc.x + fx, cz = proc.z + fz;
    let sent = 0, value = 0, tooHeavy = false;
    for (const p of [...this.props.values()]) {
      if (p.held || p.kind !== 'valuable') continue;
      const c = p.position();
      if (Math.abs(c[0] - cx) > 0.75 || Math.abs(c[2] - cz) > 0.75 || c[1] < proc.y - 0.2 || c[1] > proc.y + 2.2) continue;
      if (p.mass > MISSION.TUBE_MAX_KG) { tooHeavy = true; continue; }
      value += p.value;
      sent++;
      this.creditDelivery(p);
      for (const n of [p.lastHolder]) { const x = this.players.get(n); if (x) x.tubes++; }
      this.removeProp(p, 'tube');
    }
    it.until = this.time + MISSION.TUBE_CYCLE_TIME;
    this.emit({ k: 'inter', id: d.id, state: 1, by: pl.netId });
    this.emit({ k: 'sfx', s: sent ? 'tube_send' : 'tube_empty', p: pos, v: 1 });
    this.noise(pos, sent ? 0.5 : 0.25, 'machine', pl.netId);
    if (sent) {
      this.quota.tubed += value;
      this.emit({ k: 'tube', id: d.id, sent, value });
      this.updateQuota(true);
    } else this.emit({ k: 'msg', text: tooHeavy ? `Too heavy for the tube (max ${MISSION.TUBE_MAX_KG} kg). Haul it to the lift.` : 'Place small valuables in the tube intake first.', kind: 'info' });
  }

  private creditDelivery(p: MProp) {
    const x = this.players.get(p.lastHolder);
    if (!x) return;
    x.delivered += p.value;
    x.itemsDelivered++;
    x.heaviest = Math.max(x.heaviest, p.mass);
  }

  // =================================================================== equipment
  private use(pl: MPlayer, msg: Extract<C2S, { t: 'use' }>) {
    if (pl.life !== 'alive' && !(msg.slot === 'light')) return;
    const itemId = pl.loadout[msg.slot] ?? (msg.slot.startsWith('quick') ? null : null);
    const item = itemId ? ITEM_BY_ID[itemId] : null;
    if (!item) return;
    const aim = msg.aim && msg.aim.every(Number.isFinite) ? msg.aim : null;
    const eye = pl.eye;
    const consume = () => {
      if ((pl.found[item.id] ?? 0) > 0) { pl.found[item.id]--; return true; }
      if (!this.practice && (pl.items[item.id] ?? 0) > 0) {
        pl.items[item.id]--;
        this.room.manager.economy.consume(pl.id, item.id, this.id, ++pl.useCounter);
        return true;
      }
      return false;
    };
    switch (item.id) {
      case 'scanner': {
        if (this.time < pl.scannerReadyAt || pl.battery < 2) return;
        pl.scannerReadyAt = this.time + item.stats.cooldown;
        pl.battery = Math.max(0, pl.battery - pl.batteryMax * item.stats.battery / 100);
        this.emit({ k: 'scan', by: pl.netId, p: eye, r: item.stats.radius, until: this.time + item.stats.duration });
        this.emit({ k: 'sfx', s: 'scanner', p: eye, v: 0.8 });
        break;
      }
      case 'prod': {
        if (pl.prodCharges <= 0 || !aim) return;
        pl.prodCharges--;
        pl.prodRecharge.push(this.time + item.stats.recharge);
        const hit = this.ai.prodStrike(pl, aim, item.stats.range, item.stats.stun);
        this.emit({ k: 'sfx', s: hit ? 'prod_hit' : 'prod_miss', p: eye, v: 1 });
        this.noise(eye, 0.45, 'prod', pl.netId);
        if (hit) pl.stuns++;
        break;
      }
      case 'medkit': {
        let target = pl;
        if (msg.target !== undefined && msg.target !== pl.netId) {
          const t = this.players.get(msg.target);
          if (!t || t.life !== 'alive' || dist(t.pos, pl.pos) > 2.6) return;
          target = t;
        }
        if (target.hp >= 100) return;
        if (!consume()) return;
        target.healUntil = this.time + item.stats.time;
        target.healPerSec = item.stats.heal / item.stats.time;
        this.emit({ k: 'use', id: pl.netId, item: item.id, target: target.netId });
        break;
      }
      case 'battery': {
        if (pl.battery >= pl.batteryMax * 0.98 || !consume()) return;
        pl.battery = pl.batteryMax;
        this.emit({ k: 'use', id: pl.netId, item: item.id });
        break;
      }
      case 'stim': {
        if (!consume()) return;
        pl.stimUntil = this.time + item.stats.duration;
        pl.crashUntil = pl.stimUntil + item.stats.crash;
        this.emit({ k: 'use', id: pl.netId, item: item.id });
        break;
      }
      case 'defib': {
        const t = msg.target !== undefined ? this.players.get(msg.target) : null;
        if (!t || t.life !== 'dead' || !t.deathPos || dist(t.deathPos, pl.pos) > item.stats.range + 0.5) return;
        if (!consume()) return;
        this.revivePlayer(t, item.stats.health, pl.netId);
        this.emit({ k: 'use', id: pl.netId, item: item.id, target: t.netId });
        this.emit({ k: 'sfx', s: 'defib', p: t.pos, v: 1 });
        break;
      }
      case 'flare': case 'glowstick': case 'decoy': {
        if (!aim || !consume()) return;
        const speed = item.id === 'glowstick' ? 4 : 9;
        const start: V3 = [eye[0] + aim[3] * 0.4, eye[1] + aim[4] * 0.4 - 0.1, eye[2] + aim[5] * 0.4];
        const model = item.id === 'decoy' ? 'alarm_clock_01' : item.id === 'flare' ? 'signal_flashlight' : 'lightbulb_01';
        const prop = this.spawnProp(model, 'thrown', start, [0, 0, 0, 1], 0, -1, [aim[3] * speed, aim[4] * speed + 1.5, aim[5] * speed]);
        if (!prop) return;
        prop.thrownItem = item.id;
        prop.thrownBy = pl.netId;
        prop.activeAt = this.time + (item.id === 'decoy' ? 1.0 : 0.2);
        prop.expireAt = this.time + (item.id === 'flare' ? item.stats.duration : item.id === 'decoy' ? item.stats.duration + 1 : 99999);
        const lid = this.nextPlacedId++;
        prop.lightId = lid;
        const pl2: PlacedLight & { by: number } = { id: lid, kind: item.id as PlacedLight['kind'], p: start, until: prop.expireAt, by: pl.netId };
        this.placed.set(lid, pl2);
        this.emit({ k: 'prop+', p: this.propState(prop) });
        this.emit({ k: 'placed', l: { id: lid, kind: pl2.kind, p: pl2.p, until: pl2.until } });
        this.emit({ k: 'use', id: pl.netId, item: item.id });
        break;
      }
      default: return;
    }
    this.sendItems(pl);
  }

  private tickThrown() {
    for (const p of [...this.props.values()]) {
      if (p.kind !== 'thrown') continue;
      const l = this.placed.get(p.lightId);
      if (l) { const c = p.position(); l.p = c; }
      if (this.time > p.expireAt) { this.removeProp(p, 'despawn'); continue; }
      if (p.thrownItem === 'decoy' && this.time > p.activeAt && Math.floor(this.time * 2) !== Math.floor((this.time - DT) * 2)) {
        const c = p.position();
        this.noise(c, 0.85, 'decoy', p.thrownBy);
        this.emit({ k: 'sfx', s: 'decoy_beep', p: c, v: 1 });
      }
    }
  }

  // =================================================================== extraction
  private pullLever(pl: MPlayer) {
    const e = this.level.extraction;
    if (this.practice) { this.finish(true, 'Practice complete.'); return; }
    const pos: V3 = [e.lever.x, e.lever.y, e.lever.z];
    this.emit({ k: 'sfx', s: 'lever', p: pos, v: 1 });
    if (this.lift.state === 'locked') {
      pl.member.session?.send({ t: 'ev', e: [{ k: 'msg', text: `Quota not met. ${fmt(this.quota.quota - this.quota.banked)} more needed.`, kind: 'info' }] });
      return;
    }
    if (this.lift.state === 'ready') {
      this.lift = { state: 'countdown', until: this.time + MISSION.DEPARTURE_COUNTDOWN, aboard: [] };
      this.emit({ k: 'lift', l: this.lift });
      this.emit({ k: 'msg', text: `Lift departing in ${MISSION.DEPARTURE_COUNTDOWN} seconds. Get aboard!`, kind: 'dispatch' });
      this.emit({ k: 'sfx', s: 'lift_alarm', p: pos, v: 1, e: 1 });
      this.noise(pos, 0.8, 'alarm', -1);
    } else if (this.lift.state === 'countdown') {
      this.lift = { state: 'ready', until: 0, aboard: [] };
      this.emit({ k: 'lift', l: this.lift });
      this.emit({ k: 'msg', text: 'Departure cancelled.', kind: 'info' });
    }
  }

  private insideAboard(p: V3): boolean {
    const a = this.level.extraction.aboard;
    return p[0] > a.x0 && p[0] < a.x1 && p[2] > a.z0 && p[2] < a.z1 && p[1] > a.y - 0.5 && p[1] < a.y + 3;
  }

  private insideZone(p: V3): boolean {
    const z = this.level.extraction.zone;
    return p[0] > z.x0 && p[0] < z.x1 && p[2] > z.z0 && p[2] < z.z1 && p[1] > z.y - 0.5 && p[1] < z.y + 3.2;
  }

  private updateQuota(force = false) {
    let inZone = 0;
    for (const p of this.props.values()) if (p.kind === 'valuable' && !p.held && this.insideZone(p.position())) inZone += p.value;
    const banked = inZone + this.quota.tubed;
    if (force || Math.round(inZone) !== Math.round(this.quota.inZone) || Math.round(banked) !== Math.round(this.quota.banked)) {
      this.quota = { ...this.quota, inZone: Math.round(inZone), banked: Math.round(banked) };
      this.emit({ k: 'quota', q: this.quota });
    }
    const met = this.quota.banked >= this.quota.quota;
    if (this.lift.state === 'locked' && met && this.time > this.startAt) {
      this.lift = { state: 'ready', until: 0, aboard: [] };
      this.emit({ k: 'lift', l: this.lift });
      this.emit({ k: 'msg', text: 'Quota met. Pull the lift lever when the crew is ready to leave.', kind: 'dispatch' });
    } else if ((this.lift.state === 'ready' || this.lift.state === 'countdown') && !met) {
      this.lift = { state: 'locked', until: 0, aboard: [] };
      this.emit({ k: 'lift', l: this.lift });
      this.emit({ k: 'msg', text: 'Quota no longer met. Departure locked.', kind: 'warn' });
    }
  }

  private tickLift() {
    if (this.lift.state === 'countdown') {
      const aboard = [...this.players.values()].filter((p) => p.life === 'alive' && this.insideAboard(p.pos)).map((p) => p.netId);
      if (aboard.join() !== this.lift.aboard.join()) { this.lift = { ...this.lift, aboard }; this.emit({ k: 'lift', l: this.lift }); }
      if (this.time >= this.lift.until) {
        this.lift = { state: 'departing', until: this.time + 4, aboard };
        this.emit({ k: 'lift', l: this.lift });
        for (const n of aboard) { const pl = this.players.get(n)!; pl.life = 'extracted'; pl.flags |= PF.EXTRACTED; this.releaseAll(pl); }
        let extracted = 0;
        for (const p of [...this.props.values()]) {
          if (p.kind !== 'valuable' || !this.insideZone(p.position())) continue;
          extracted += p.value;
          this.creditDelivery(p);
          this.pristine.push(p);
          this.removeProp(p, 'extracted');
        }
        this.extractedValue = extracted;
        this.emit({ k: 'sfx', s: 'lift_depart', p: [this.level.extraction.lever.x, this.level.extraction.lever.y, this.level.extraction.lever.z], v: 1, e: 1 });
      }
    } else if (this.lift.state === 'departing' && this.time >= this.lift.until) {
      this.lift = { state: 'gone', until: 0, aboard: this.lift.aboard };
      this.emit({ k: 'lift', l: this.lift });
      this.finish(true, 'The lift reached the surface.');
    }
    // lift gate opens when the mission starts and closes on departure
    const target = this.lift.state === 'departing' || this.lift.state === 'gone' || this.time < this.startAt ? 0 : 1;
    this.liftGate += clamp(target - this.liftGate, -DT * 0.8, DT * 0.8);
  }
  private pristine: MProp[] = [];
  private extractedValue = 0;

  // =================================================================== hazards
  private hazardActive(h: LevelData['hazards'][number]): boolean {
    if (this.hazardsOff.has(h.id)) {
      if (this.time > this.hazardsOff.get(h.id)!) { this.hazardsOff.delete(h.id); this.emit({ k: 'hazard', id: h.id, on: true }); }
      else return false;
    }
    if ((h.kind === 'water' || h.kind === 'laser' || h.kind === 'sparks' || h.kind === 'crusher') && !this.sectors.get(h.sector)) return false;
    const t = ((this.time + h.phase) % h.period) / h.period;
    return t < h.duty * this.director.hazardBoost(h.kind);
  }

  private tickHazards(dt: number) {
    for (const h of this.level.hazards) {
      const active = this.hazardActive(h);
      const inside = (p: V3) => Math.abs(p[0] - h.x) < h.hx && Math.abs(p[2] - h.z) < h.hz && p[1] + 1 > h.y - h.hy && p[1] < h.y + h.hy;
      if (h.kind === 'crusher') {
        const prev = this.crusherState.get(h.id) ?? 0;
        const now = active ? 1 : 0;
        this.crusherState.set(h.id, now);
        if (now && !prev) {
          this.emit({ k: 'sfx', s: 'crusher', p: [h.x, h.y + 2, h.z], v: 1 });
          this.noise([h.x, h.y, h.z], 0.6, 'machine', -1);
          for (const pl of this.players.values()) if (pl.life === 'alive' && inside(pl.pos)) this.damagePlayer(pl, h.damage, 'crusher', [h.x, h.y, h.z], 6);
          for (const p of [...this.props.values()]) if (!p.held && inside(p.position())) { if (p.kind === 'valuable') { this.lostValue += p.value; this.emit({ k: 'sfx', s: 'shatter_' + p.mat, p: p.position(), v: 1 }); } this.removeProp(p, 'crushed'); }
          this.ai.hazardHit(h, inside);
        }
        continue;
      }
      if (!active) continue;
      if (h.kind === 'laser') {
        for (const pl of this.players.values()) if (pl.life === 'alive' && inside(pl.pos) && this.director.alarmReady(h.id)) {
          this.emit({ k: 'sfx', s: 'alarm', p: [h.x, h.y + 1.5, h.z], v: 1, e: 1 });
          this.emit({ k: 'msg', text: 'Tripwire! Security alarm triggered.', kind: 'warn' });
          this.noise([h.x, h.y, h.z], 1.0, 'alarm', pl.netId);
          this.director.lockdown(h.room);
        }
        continue;
      }
      for (const pl of this.players.values()) if (pl.life === 'alive' && inside(pl.pos)) {
        const acc = (this.hazAcc.get(pl.netId * 1000 + h.id) ?? 0) + h.damage * dt;
        if (acc >= 4) { this.damagePlayer(pl, Math.floor(acc), h.kind); this.hazAcc.set(pl.netId * 1000 + h.id, acc - Math.floor(acc)); }
        else this.hazAcc.set(pl.netId * 1000 + h.id, acc);
      }
    }
  }
  private hazAcc = new Map<number, number>();

  // =================================================================== noise
  noise(p: V3, loudness: number, kind: string, by: number) {
    this.ai.noise(p, loudness, kind, by);
  }

  // =================================================================== events / net
  emit(e: GameEvent) { this.events.push(e); }

  info(): MissionInfo {
    return {
      mid: this.id, map: this.map, seed: this.seed, difficulty: this.difficulty, crew: this.level.crew, streak: this.streak,
      quota: this.quota.quota, players: [...this.players.values()].map((p) => ({ netId: p.netId, id: p.id, name: p.name, appearance: p.member.appearance, level: p.member.level })),
      startAt: this.startAt, window: this.overtimeAt - this.startAt, practice: this.practice,
    };
  }

  fullState(): MissionStateFull {
    return {
      props: [...this.props.values()].map((p) => this.propState(p)),
      doors: this.doors.map((d) => ({ id: d.data.id, open: d.open, locked: d.locked, broken: d.broken })),
      inters: this.inters.map((i) => ({ id: i.data.id, state: i.state })),
      sectors: [...this.sectors].map(([id, on]) => ({ id, on })),
      lightsOff: [...this.roomLights].filter(([, on]) => !on).map(([id]) => id),
      players: [...this.players.values()].map((p) => ({ netId: p.netId, hp: Math.round(p.hp), state: p.life, items: {}, battery: p.battery / Math.max(1, p.batteryMax) })),
      keys: [...this.keys],
      quota: this.quota,
      lift: this.lift,
      enemies: this.ai.list(),
      placed: [...this.placed.values()].map((l) => ({ id: l.id, kind: l.kind, p: l.p, until: l.until })),
      hazardsOff: [...this.hazardsOff.keys()],
      now: this.time,
      overtimeAt: this.overtimeAt,
      mapUntil: this.mapUntil,
      docsRead: [...this.docsRead],
    };
  }

  begin() {
    this.time = 0;
    this.startAt = 3.5;
    const win = MISSION.CONTRACT_WINDOW[Math.max(0, Math.min(3, this.difficulty))];
    this.overtimeAt = this.startAt + (this.practice ? 99999 : win);
    this.room.broadcast({ t: 'mission', info: this.info() });
    this.room.broadcast({ t: 'mstate', state: this.fullState() });
    for (const pl of this.players.values()) this.sendItems(pl);
    this.director.begin();
    this.emit({ k: 'msg', text: this.practice ? 'Practice facility. Pull the lift lever to finish.' : `Contract: ${MAPS[this.map as Exclude<MapId, 'practice'>]?.name ?? this.map}. Quota ${fmt(this.quota.quota)}.`, kind: 'dispatch' });
    for (const o of this.objectives) this.emit({ k: 'msg', text: `Optional: ${o.label} (+${fmt(o.bonus)})`, kind: 'info' });
  }

  onDisconnect(m: Member) {
    const pl = this.players.get(m.netId);
    if (!pl) return;
    pl.connected = false;
    pl.flags |= PF.DISCONNECTED;
    this.releaseAll(pl);
  }

  onReconnect(m: Member) {
    const pl = this.players.get(m.netId);
    if (!pl) return;
    pl.connected = true;
    pl.member = m;
    pl.flags &= ~PF.DISCONNECTED;
    pl.epoch = (pl.epoch + 1) & 0xff;
    const s = m.session!;
    s.send({ t: 'mission', info: this.info() });
    s.send({ t: 'mstate', state: this.fullState() });
    s.send({ t: 'correct', p: [...pl.accepted], v: [0, 0, 0], epoch: pl.epoch });
    this.sendItems(pl);
    for (const p of this.props.values()) if (p.owner >= 0 || p.helpers.size) this.emitOwn(p);
  }

  onLeave(m: Member) {
    const pl = this.players.get(m.netId);
    if (!pl) return;
    this.releaseAll(pl);
    pl.life = 'left';
    pl.connected = false;
    if (pl.body) { this.physics.world.removeRigidBody(pl.body); pl.body = null; }
    this.emit({ k: 'life', id: pl.netId, state: 'left', hp: 0 });
    if ([...this.players.values()].every((p) => p.life === 'left')) this.finish(false, 'Everyone left the mission.');
  }

  tick(now: number, dt: number) {
    if (this.ended) return;
    void now;
    this.time += DT;
    this.tick_++;
    // pre-physics
    this.stepDoors(DT);
    this.ai.tick(DT);
    for (const p of this.props.values()) {
      if (p.owner >= 0 || p.helpers.size === 0 || p.removed) continue;
    }
    // physics
    for (let i = 0; i < NET.PHYSICS_SUBSTEPS; i++) this.physics.step();
    // post-physics: impacts on free props
    for (const p of this.props.values()) {
      if (p.held || p.removed || p.body.isSleeping()) continue;
      const v = p.body.linvel();
      const nv: V3 = [v.x, v.y, v.z];
      if (p.skipImpact > 0) p.skipImpact--;
      else {
        const dv = Math.hypot(nv[0] - p.lastVel[0], nv[1] - p.lastVel[1], nv[2] - p.lastVel[2]);
        if (dv > 1.6) {
          const pos = p.position();
          this.emit({ k: 'sfx', s: 'impact_' + p.mat, p: pos, v: Math.min(1, dv / 9), r: p.mass });
          if (dv > 2.0) this.noise(pos, Math.min(0.85, 0.08 + dv * 0.045 + p.mass * 0.004), 'impact', p.lastHolder);
          this.impact(p, dv, p.lastHolder);
          if (dv > 3) this.ai.propImpact(p, dv);
        }
      }
      p.lastVel = nv;
      if (p.position()[1] < this.level.bounds.y0 - 20) this.removeProp(p, 'despawn');
    }
    this.tickPlayers(DT);
    this.tickHazards(DT);
    this.tickThrown();
    this.updateQuota();
    this.tickLift();
    this.director.tick(DT);
    if (!this.overtime && this.time > this.overtimeAt) { this.overtime = true; this.emit({ k: 'overtime' }); this.emit({ k: 'msg', text: 'Contract window expired. You are on overtime. Leave soon.', kind: 'warn' }); this.director.onOvertime(); }
    if (this.endAt && this.time >= this.endAt) this.complete();
    this.flush();
  }

  private flush() {
    if (this.events.length) {
      this.room.broadcast({ t: 'ev', e: this.events });
      this.events = [];
    }
    const snapPlayers = [...this.players.values()].filter((p) => p.life !== 'left').map((p) => ({ netId: p.netId, p: p.pos, yaw: p.yaw, pitch: p.pitch, v: p.vel, flags: p.flags, hp: p.hp, anim: p.anim, hold: p.hold }));
    const props: SnapProp[] = [];
    for (const p of this.props.values()) {
      const asleep = !p.held && p.body.isSleeping();
      if (asleep && p.sentAsleep && !p.forceSend) continue;
      const t = p.body.translation(), r = p.body.rotation(), v = p.held && p.pose ? { x: p.pose.v[0], y: p.pose.v[1], z: p.pose.v[2] } : p.body.linvel();
      props.push({ id: p.id, flags: (asleep ? SPF.ASLEEP : 0) | (p.held ? SPF.OWNED : 0), p: [t.x, t.y, t.z], q: [r.x, r.y, r.z, r.w], v: [v.x, v.y, v.z] });
      p.sentAsleep = asleep;
      p.forceSend = false;
    }
    const helpers = [];
    for (const p of this.props.values()) for (const h of p.helpers.values()) if (h.target) helpers.push({ prop: p.id, netId: h.netId, t: h.target });
    const movers = [{ id: 60000, value: this.liftGate }, ...this.director.movers()];
    for (const h of this.level.hazards) if (h.kind === 'crusher') movers.push({ id: 61000 + h.id, value: this.hazardActive(h) ? 1 : 0 });
    const buf = encodeSnapshot(this.writer, { tick: this.tick_, time: this.time, players: snapPlayers, props, enemies: this.ai.snapshot(), movers, helpers });
    for (const pl of this.players.values()) if (pl.connected) pl.member.session?.sendBin(buf);
  }

  // =================================================================== end
  private checkObjectives() {
    for (const o of this.objectives) {
      if (o.done) continue;
      if (o.id === 'power' && [...this.sectors.values()].every(Boolean)) { o.done = true; this.emit({ k: 'msg', text: `Objective complete: ${o.label}`, kind: 'good' }); }
      if (o.id === 'docs' && this.docsRead.size >= (o.data ?? 3)) { o.done = true; this.emit({ k: 'msg', text: `Objective complete: ${o.label}`, kind: 'good' }); }
    }
  }

  finish(success: boolean, reason: string) {
    if (this.endAt) return;
    this.endSuccess = success;
    this.endReason = reason;
    this.endAt = this.time + 0.5;
  }

  abort(reason: string) {
    if (this.ended) return;
    this.endSuccess = false;
    this.endReason = reason;
    this.complete();
  }

  private complete() {
    if (this.ended) return;
    this.ended = true;
    const success = this.endSuccess && !this.practice;
    const bonus: { label: string; amount: number }[] = [];
    if (success) {
      const pristineCount = this.pristine.filter((p) => !p.damaged).length;
      for (const o of this.objectives) {
        if (o.id === 'nolosses') o.done = [...this.players.values()].every((p) => p.life === 'extracted' || p.life === 'left');
        if (o.id === 'pristine') o.done = pristineCount >= (o.data ?? 3);
        if (o.done) bonus.push({ label: o.label, amount: o.bonus });
      }
    }
    const bonusTotal = bonus.reduce((s, b) => s + b.amount, 0);
    const extracted = this.extractedValue + (success ? bonusTotal : 0);
    const players = [...this.players.values()];
    const alive = players.filter((p) => p.life === 'extracted');
    const summary: MissionSummary = {
      mid: this.id, map: this.map, difficulty: this.difficulty, crew: players.length, streak: this.streak, success,
      extracted, tubed: this.quota.tubed, duration: Math.max(0, this.time - this.startAt), unknownAppeared: this.unknownAppeared,
      players: players.map((p) => ({
        playerId: p.id, state: p.life, delivered: p.delivered, items: p.itemsDelivered, revives: p.revives, downs: p.downs, died: p.died,
        documents: p.docs, powerRestored: p.power, tubesSent: p.tubes, stuns: p.stuns, heaviest: p.heaviest, spotted: p.spotted, hpAtEnd: p.hp,
        coCarry3: p.coCarry3, pristineFragile: this.pristine.some((x) => !x.damaged && x.fragility >= 0.95 && x.lastHolder === p.netId),
        enemiesSeen: p.seen.size, damageTaken: p.damageTaken, aloneSurvivor: alive.length === 1 && alive[0] === p && players.length > 1,
      })),
    };
    let rewards = new Map<string, import('../economy/Economy').RewardResult>();
    if (!this.practice) {
      try { rewards = this.room.manager.economy.applyMission(summary); }
      catch (e) { log.error('applyMission failed', e); }
    }
    const results: MissionResults = {
      mid: this.id, success, reason: this.endReason, map: this.map, difficulty: this.difficulty, quota: this.quota.quota,
      extracted: this.extractedValue, tubed: this.quota.tubed, lostValue: this.lostValue, duration: summary.duration,
      streak: success ? this.streak + 1 : 0, bonus,
      players: players.map((p) => {
        const r = rewards.get(p.id);
        return { id: p.id, name: p.name, netId: p.netId, state: p.life, delivered: Math.round(p.delivered), items: p.itemsDelivered, earned: r?.earned ?? 0, xp: r?.xp ?? 0, levelBefore: r?.levelBefore ?? p.member.level, levelAfter: r?.levelAfter ?? p.member.level, newAchievements: r?.newAchievements ?? [], revives: p.revives, damageTaken: p.damageTaken };
      }),
    };
    try { this.room.manager.db.recordMissionEnd(this.id, success, extracted + this.quota.tubed, { results }); } catch (e) { log.warn('recordMissionEnd failed', e); }
    for (const [pid, r] of rewards) {
      const m = this.room.members.get(pid);
      if (m) { m.level = r.profile.level; m.session?.send({ t: 'profile', profile: r.profile, reason: 'mission' }); }
    }
    this.physics.free();
    log.info(`mission ${this.id} ended: ${success ? 'SUCCESS' : 'FAIL'} (${this.endReason}) value=${extracted + this.quota.tubed}`);
    this.room.missionEnded(results);
  }

  // =================================================================== dev tools
  private dev(pl: MPlayer, msg: Extract<C2S, { t: 'dev' }>) {
    if (!this.room.manager.devMode) return;
    const reply = (text: string) => pl.member.session?.send({ t: 'dev', text });
    const a = msg.args ?? [];
    switch (msg.cmd) {
      case 'spawn': {
        const def = a[0] ?? 'brass_vase_01';
        const val = VALUABLE_BY_ID[def];
        const f: V3 = [pl.eye[0] - Math.sin(pl.yaw) * 1.5, pl.eye[1], pl.eye[2] - Math.cos(pl.yaw) * 1.5];
        const p = this.spawnProp(def, val ? 'valuable' : 'furniture', f, [0, 0, 0, 1], val ? Math.round((val.value[0] + val.value[1]) / 2) : 0, -1);
        if (p) { this.emit({ k: 'prop+', p: this.propState(p) }); reply(`spawned ${def} #${p.id}`); } else reply('unknown model');
        return;
      }
      case 'enemy': {
        const type = (a[0] ?? 'stalker') as MonsterId;
        if (!MONSTERS[type]) return reply('unknown monster: ' + MONSTER_INDEX.join(', '));
        const f = { x: pl.pos[0] - Math.sin(pl.yaw) * 4, y: pl.pos[1], z: pl.pos[2] - Math.cos(pl.yaw) * 4 };
        const e = this.ai.spawn(type, f);
        return reply(e ? `spawned ${type} #${e}` : 'spawn failed (no walkable cell)');
      }
      case 'quota': this.quota.tubed += this.quota.quota; this.updateQuota(true); return reply('quota met');
      case 'god': pl.god = !pl.god; return reply('god ' + pl.god);
      case 'heal': pl.hp = 100; this.emit({ k: 'heal', id: pl.netId, hp: 100 }); return;
      case 'hurt': this.damagePlayer(pl, Number(a[0] ?? 30), 'dev'); return;
      case 'kill': this.killPlayer(pl); return;
      case 'power': for (const s of this.sectors.keys()) this.setPower(s, a[0] !== 'off', pl.netId); return;
      case 'event': this.director.trigger(a[0] ?? 'blackout'); return reply('event ' + (a[0] ?? 'blackout'));
      case 'unknown': this.director.summonUnknown(pl); return;
      case 'tp': { const t = this.players.get(Number(a[0])); if (t) { pl.epoch = (pl.epoch + 1) & 0xff; pl.accepted = [...t.pos]; pl.member.session?.send({ t: 'correct', p: [...t.pos], v: [0, 0, 0], epoch: pl.epoch }); } return; }
      case 'goto': {
        const p: V3 = [Number(a[0]), Number(a[1]), Number(a[2])];
        if (!p.every(Number.isFinite)) return reply('goto x y z');
        pl.epoch = (pl.epoch + 1) & 0xff; pl.accepted = [...p]; pl.pos = [...p]; pl.airTop = p[1];
        pl.member.session?.send({ t: 'correct', p, v: [0, 0, 0], epoch: pl.epoch });
        return;
      }
      case 'clear': this.ai.clear(); return reply('enemies cleared');
      case 'end': this.finish(a[0] === 'win', 'Ended from the developer console.'); return;
      case 'overtime': this.overtimeAt = this.time; return;
      default: reply('commands: spawn <id>, enemy <type>, quota, god, heal, hurt <n>, kill, power [off], event <name>, unknown, tp <netId>, clear, end [win], overtime');
    }
  }
}

function yawQ(yaw: number): Q4 { return [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)]; }
function normQ(q: Q4 | undefined): Q4 {
  if (!q || !q.every(Number.isFinite)) return [0, 0, 0, 1];
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}
function clamp(v: number, a: number, b: number) { return v < a ? a : v > b ? b : v; }
function num(v: unknown): number { const n = Number(v); return Number.isFinite(n) ? n : 0; }
export function fmt(n: number) { return '$' + Math.round(n).toLocaleString('en-US'); }
void modelSize;
