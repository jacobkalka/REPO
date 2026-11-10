// Builds Rapier colliders from ColliderSpecs. The Rapier module is passed in so the same code
// runs on the server (Node) and in the browser.
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import { COLLISION, groups } from '../constants';
import type { ColliderSpec } from './colliders';

type R = typeof RAPIER_NS;

export function yawQuat(yaw: number): { x: number; y: number; z: number; w: number } {
  return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
}

export function buildStatics(R: R, world: RAPIER_NS.World, specs: ColliderSpec[], friction = 0.8): RAPIER_NS.RigidBody {
  const body = world.createRigidBody(R.RigidBodyDesc.fixed());
  const g = groups(COLLISION.STATIC, 0xffff);
  for (const c of specs) {
    let desc: RAPIER_NS.ColliderDesc | null = null;
    if (c.t === 'box') {
      desc = R.ColliderDesc.cuboid(Math.max(0.005, c.hx), Math.max(0.005, c.hy), Math.max(0.005, c.hz)).setTranslation(c.x, c.y, c.z);
      if (c.rotY) desc.setRotation(yawQuat(c.rotY));
    } else if (c.t === 'cyl') {
      desc = R.ColliderDesc.cylinder(c.hh, c.r).setTranslation(c.x, c.y, c.z);
    } else {
      desc = R.ColliderDesc.convexHull(new Float32Array(c.points));
      if (!desc) {
        let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
        for (let i = 0; i < c.points.length; i += 3) {
          x0 = Math.min(x0, c.points[i]); x1 = Math.max(x1, c.points[i]);
          y0 = Math.min(y0, c.points[i + 1]); y1 = Math.max(y1, c.points[i + 1]);
          z0 = Math.min(z0, c.points[i + 2]); z1 = Math.max(z1, c.points[i + 2]);
        }
        desc = R.ColliderDesc.cuboid(Math.max(0.01, (x1 - x0) / 2), Math.max(0.01, (y1 - y0) / 2), Math.max(0.01, (z1 - z0) / 2)).setTranslation((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
      }
    }
    desc.setFriction(friction).setCollisionGroups(g).setSolverGroups(g);
    const col = world.createCollider(desc, body);
    (col as unknown as { userData: unknown }).userData = { kind: 'static', tag: c.tag };
  }
  return body;
}

/** convex hull collider for a prop model (points centred on the model's bounds centre) */
export function propColliderDesc(R: R, hull: number[], size: [number, number, number], scale = 1): RAPIER_NS.ColliderDesc {
  const pts = new Float32Array(hull.length);
  for (let i = 0; i < hull.length; i++) pts[i] = hull[i] * scale;
  return R.ColliderDesc.convexHull(pts) ?? R.ColliderDesc.cuboid(Math.max(0.02, (size[0] * scale) / 2), Math.max(0.02, (size[1] * scale) / 2), Math.max(0.02, (size[2] * scale) / 2));
}
