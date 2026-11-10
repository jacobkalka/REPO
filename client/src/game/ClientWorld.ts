// Client-side Rapier world: static level colliders, door leaves, props (kinematic proxies or
// locally simulated when owned), and the local player's character collider.
import RAPIER from '@dimforge/rapier3d-compat';
import { COLLISION, groups, GRAB, PLAYER } from '../../../shared/constants';
import { MODELS, FURNITURE } from '../../../shared/catalog/furniture';
import { MATERIAL_PHYS, VALUABLE_BY_ID } from '../../../shared/catalog/valuables';
import type { ColliderSpec } from '../../../shared/physics/colliders';
import { buildStatics, propColliderDesc, yawQuat } from '../../../shared/physics/rapierBuild';
import type { DoorData } from '../../../shared/levelgen/types';
import { doorLeaves, leafPose } from '../../../shared/doors';

let ready: Promise<void> | null = null;
export function initClientPhysics() { if (!ready) ready = RAPIER.init(); return ready; }
export { RAPIER };

export interface PhysProp { id: number; body: RAPIER.RigidBody; collider: RAPIER.Collider; mass: number; dynamic: boolean; light: boolean; mat: string }
export interface Hit { kind: 'prop' | 'door' | 'static' | 'player'; id: number; toi: number; point: { x: number; y: number; z: number }; normal: { x: number; y: number; z: number }; collider: RAPIER.Collider }

export class ClientWorld {
  readonly world: RAPIER.World;
  readonly props = new Map<number, PhysProp>();
  readonly doors = new Map<number, RAPIER.RigidBody[]>();
  private tags = new Map<number, { kind: Hit['kind']; id: number }>();
  readonly playerBody: RAPIER.RigidBody;
  playerCollider: RAPIER.Collider;
  readonly kcc: RAPIER.KinematicCharacterController;
  private ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
  private acc = 0;
  heldId = -1;

  constructor(colliders: ColliderSpec[]) {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = 1 / 60;
    const sb = buildStatics(RAPIER, this.world, colliders);
    for (let i = 0; i < sb.numColliders(); i++) this.tags.set(sb.collider(i).handle, { kind: 'static', id: -1 });
    this.playerBody = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 2, 0));
    const g = groups(COLLISION.PLAYER, COLLISION.STATIC | COLLISION.DOOR | COLLISION.PROP);
    this.playerCollider = this.world.createCollider(RAPIER.ColliderDesc.capsule((PLAYER.HEIGHT - 2 * PLAYER.RADIUS) / 2, PLAYER.RADIUS).setCollisionGroups(g).setSolverGroups(groups(COLLISION.PLAYER, 0)), this.playerBody);
    this.tags.set(this.playerCollider.handle, { kind: 'player', id: -1 });
    this.kcc = this.world.createCharacterController(0.02);
    this.kcc.setUp({ x: 0, y: 1, z: 0 });
    this.kcc.setMaxSlopeClimbAngle((PLAYER.MAX_SLOPE_DEG * Math.PI) / 180);
    this.kcc.setMinSlopeSlideAngle(((PLAYER.MAX_SLOPE_DEG + 6) * Math.PI) / 180);
    this.kcc.enableAutostep(PLAYER.STEP_HEIGHT, 0.12, false);
    this.kcc.enableSnapToGround(0.35);
    this.kcc.setSlideEnabled(true);
    this.kcc.setApplyImpulsesToDynamicBodies(true);
    this.kcc.setCharacterMass(80);
    // scene queries are only valid after a step: build them before the first controller query
    this.world.step();
  }

  addDoor(d: DoorData) {
    const bodies: RAPIER.RigidBody[] = [];
    for (const spec of doorLeaves(d)) {
      const pose = leafPose(d, spec, 0);
      const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(pose.x, pose.y, pose.z).setRotation(yawQuat(pose.yaw)));
      const g = groups(COLLISION.DOOR, COLLISION.PROP | COLLISION.PLAYER | COLLISION.HELD);
      const c = this.world.createCollider(RAPIER.ColliderDesc.cuboid(spec.half[0], spec.half[1], spec.half[2]).setCollisionGroups(g).setSolverGroups(g), body);
      this.tags.set(c.handle, { kind: 'door', id: d.id });
      bodies.push(body);
    }
    this.doors.set(d.id, bodies);
  }

  setDoor(d: DoorData, value: number) {
    const bodies = this.doors.get(d.id);
    if (!bodies) return;
    doorLeaves(d).forEach((spec, i) => {
      const b = bodies[i];
      if (!b) return;
      const p = leafPose(d, spec, value);
      b.setNextKinematicTranslation({ x: p.x, y: p.y, z: p.z });
      b.setNextKinematicRotation(yawQuat(p.yaw));
    });
  }

  removeDoor(id: number) {
    for (const b of this.doors.get(id) ?? []) this.world.removeRigidBody(b);
    this.doors.delete(id);
  }

  addProp(id: number, def: string, p: [number, number, number], q: [number, number, number, number]): PhysProp | null {
    const val = VALUABLE_BY_ID[def];
    const model = val ? val.model : def;
    const info = MODELS[model];
    if (!info) return null;
    const furn = FURNITURE[model];
    const mass = val ? val.mass : furn?.mass ?? 1;
    const mat = val ? val.mat : furn?.mat ?? 'plastic';
    const phys = MATERIAL_PHYS[mat];
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(p[0], p[1], p[2]).setRotation({ x: q[0], y: q[1], z: q[2], w: q[3] }).setLinearDamping(0.06).setAngularDamping(0.35).setCcdEnabled(true));
    const g = groups(COLLISION.PROP, COLLISION.STATIC | COLLISION.PROP | COLLISION.DOOR | COLLISION.PLAYER | COLLISION.HELD);
    const collider = this.world.createCollider(propColliderDesc(RAPIER, info.hull, info.size).setMass(mass).setFriction(furn?.friction ?? phys.friction).setRestitution(phys.restitution).setCollisionGroups(g).setSolverGroups(g).setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS), body);
    const pp: PhysProp = { id, body, collider, mass, dynamic: false, light: mass < GRAB.LIGHT_PROP_KG, mat };
    this.props.set(id, pp);
    this.tags.set(collider.handle, { kind: 'prop', id });
    return pp;
  }

  removeProp(id: number) {
    const p = this.props.get(id);
    if (!p) return;
    this.tags.delete(p.collider.handle);
    this.world.removeRigidBody(p.body);
    this.props.delete(id);
  }

  /** owned props are simulated locally */
  setDynamic(id: number, dynamic: boolean) {
    const p = this.props.get(id);
    if (!p || p.dynamic === dynamic) return;
    p.dynamic = dynamic;
    p.body.setBodyType(dynamic ? RAPIER.RigidBodyType.Dynamic : RAPIER.RigidBodyType.KinematicPositionBased, true);
    const g = dynamic ? groups(COLLISION.HELD, COLLISION.STATIC | COLLISION.PROP | COLLISION.DOOR) : groups(COLLISION.PROP, COLLISION.STATIC | COLLISION.PROP | COLLISION.DOOR | COLLISION.PLAYER | COLLISION.HELD);
    p.collider.setCollisionGroups(g);
    p.collider.setSolverGroups(g);
  }

  setKinematicPose(id: number, x: number, y: number, z: number, q: { x: number; y: number; z: number; w: number }) {
    const p = this.props.get(id);
    if (!p || p.dynamic) return;
    p.body.setNextKinematicTranslation({ x, y, z });
    p.body.setNextKinematicRotation(q);
  }

  /** fixed-step physics for locally simulated props; returns number of steps */
  step(dt: number, pre?: (h: number) => void): number {
    this.acc = Math.min(this.acc + dt, 0.1);
    let n = 0;
    const h = this.world.timestep;
    while (this.acc >= h) { pre?.(h); this.world.step(); this.acc -= h; n++; }
    return n;
  }

  /** predicate for the character controller: light props don't block the player */
  blocksPlayer = (c: RAPIER.Collider): boolean => {
    const t = this.tags.get(c.handle);
    if (!t) return true;
    if (t.kind === 'prop') { const p = this.props.get(t.id); return !!p && !p.light && t.id !== this.heldId && !p.dynamic; }
    return t.kind !== 'player';
  };

  raycast(o: { x: number; y: number; z: number }, d: { x: number; y: number; z: number }, max: number, excludeProp = -1): Hit | null {
    this.ray.origin = o;
    this.ray.dir = d;
    const hit = this.world.castRayAndGetNormal(this.ray, max, true, undefined, groups(0xffff, COLLISION.STATIC | COLLISION.DOOR | COLLISION.PROP | COLLISION.HELD), undefined, undefined, (c) => {
      const t = this.tags.get(c.handle);
      return !(t?.kind === 'player') && !(t?.kind === 'prop' && t.id === excludeProp);
    });
    if (!hit) return null;
    const t = this.tags.get(hit.collider.handle) ?? { kind: 'static' as const, id: -1 };
    const toi = hit.timeOfImpact;
    return { kind: t.kind, id: t.id, toi, point: { x: o.x + d.x * toi, y: o.y + d.y * toi, z: o.z + d.z * toi }, normal: hit.normal, collider: hit.collider };
  }

  tagOf(c: RAPIER.Collider) { return this.tags.get(c.handle); }

  free() { this.world.free(); }
}
