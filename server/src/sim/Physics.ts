import RAPIER from '@dimforge/rapier3d-compat';
import { COLLISION, groups } from '../../../shared/constants';
import type { ColliderSpec } from '../../../shared/physics/colliders';
import { buildStatics } from '../../../shared/physics/rapierBuild';
import type { Vec3 } from '../../../shared/levelgen/types';

export let R: typeof RAPIER;
let ready: Promise<void> | null = null;

export function initPhysics(): Promise<void> {
  if (!ready) ready = RAPIER.init().then(() => { R = RAPIER; });
  return ready;
}

export class PhysicsWorld {
  readonly world: RAPIER.World;
  readonly staticBody: RAPIER.RigidBody;
  private ray: RAPIER.Ray;
  private ball: RAPIER.Ball;
  private probeCapsule: RAPIER.Capsule;

  constructor(colliders: ColliderSpec[]) {
    this.world = new R.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = 1 / 60;
    this.world.integrationParameters.numSolverIterations = 6;
    this.staticBody = buildStatics(R, this.world, colliders);
    this.ray = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
    this.ball = new R.Ball(0.06);
    this.probeCapsule = new R.Capsule(0.5, 0.24);
  }

  step() { this.world.step(); }

  /** first static/door hit along a segment */
  raycast(from: Vec3, to: Vec3, mask = COLLISION.STATIC | COLLISION.DOOR): { toi: number; collider: RAPIER.Collider } | null {
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-5) return null;
    this.ray.origin = { x: from.x, y: from.y, z: from.z };
    this.ray.dir = { x: dx / len, y: dy / len, z: dz / len };
    const hit = this.world.castRay(this.ray, len, true, undefined, groups(0xffff, mask));
    return hit ? { toi: hit.timeOfImpact, collider: hit.collider } : null;
  }

  lineOfSight(a: Vec3, b: Vec3, mask = COLLISION.STATIC | COLLISION.DOOR): boolean {
    return this.raycast(a, b, mask) === null;
  }

  /** is a small sphere at p inside static geometry? */
  pointInStatic(p: Vec3): boolean {
    let inside = false;
    this.world.intersectionsWithShape(p, { x: 0, y: 0, z: 0, w: 1 }, this.ball, () => { inside = true; return false; }, undefined, groups(0xffff, COLLISION.STATIC));
    return inside;
  }

  /** does moving a slim capsule from a to b pass through static geometry? */
  sweepBlocked(a: Vec3, b: Vec3): boolean {
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    if (Math.hypot(dx, dy, dz) < 0.05) return false;
    const center = { x: a.x, y: a.y + 0.9, z: a.z };
    const hit = this.world.castShape(center, { x: 0, y: 0, z: 0, w: 1 }, { x: dx, y: dy, z: dz }, this.probeCapsule, 0, 1, false, undefined, groups(0xffff, COLLISION.STATIC));
    return !!hit && hit.time_of_impact < 0.98;
  }

  free() { this.world.free(); }
}
