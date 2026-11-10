// Door leaf geometry shared by server physics and client visuals/physics.
import type { DoorData } from './levelgen/types';

export const DOOR_OPEN_ANGLE = 1.65;
export const DOOR_SPEED = { hinge: 3.4, slide: 1.3, roll: 0.75 } as const;
export const LEAF_THICK = 0.045;

export interface LeafSpec {
  kind: 'hinge' | 'slide' | 'roll';
  hinge: [number, number];   // world x,z of the hinge (or slide anchor)
  along: [number, number];   // unit vector from hinge towards the far edge of the leaf
  width: number;
  height: number;
  mirror: 1 | -1;
  /** half extents of the leaf box in its local frame */
  half: [number, number, number];
}

export function doorLeaves(d: DoorData): LeafSpec[] {
  if (!d.leaf) return [];
  const ax: [number, number] = d.axis === 'x' ? [1, 0] : [0, 1];
  const h = d.height - 0.03;
  const halfFor = (w: number): [number, number, number] => (d.axis === 'x' ? [w / 2, h / 2, LEAF_THICK] : [LEAF_THICK, h / 2, w / 2]);
  const end = (s: number): [number, number] => [d.x + ax[0] * s * d.width / 2, d.z + ax[1] * s * d.width / 2];
  if (d.kind === 'double') {
    const w = d.width / 2 - 0.01;
    return [
      { kind: 'hinge', hinge: end(-1), along: [ax[0], ax[1]], width: w, height: h, mirror: 1, half: halfFor(w) },
      { kind: 'hinge', hinge: end(1), along: [-ax[0], -ax[1]], width: w, height: h, mirror: -1, half: halfFor(w) },
    ];
  }
  if (d.kind === 'security' || d.kind === 'hidden') {
    return [{ kind: 'slide', hinge: end(-d.hinge), along: [ax[0] * d.hinge, ax[1] * d.hinge], width: d.width, height: h, mirror: 1, half: halfFor(d.width) }];
  }
  if (d.kind === 'shutter') {
    return [{ kind: 'roll', hinge: end(-1), along: [ax[0], ax[1]], width: d.width, height: h, mirror: 1, half: halfFor(d.width) }];
  }
  const w = d.width - 0.02;
  const hingeEnd = end(d.hinge);
  return [{ kind: 'hinge', hinge: hingeEnd, along: [-ax[0] * d.hinge, -ax[1] * d.hinge], width: w, height: h, mirror: 1, half: halfFor(w) }];
}

/** rotate (x,z) by yaw using three.js rotation.y convention */
export function rotY(x: number, z: number, yaw: number): [number, number] {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return [x * c + z * s, -x * s + z * c];
}

/** pose of a leaf; value = signed angle for hinged leaves, 0..1 open fraction for slide/roll */
export function leafPose(d: DoorData, leaf: LeafSpec, value: number): { x: number; y: number; z: number; yaw: number } {
  if (leaf.kind === 'hinge') {
    const yaw = value * leaf.mirror;
    const [ox, oz] = rotY(leaf.along[0] * leaf.width / 2, leaf.along[1] * leaf.width / 2, yaw);
    return { x: leaf.hinge[0] + ox, y: d.y + leaf.height / 2 + 0.01, z: leaf.hinge[1] + oz, yaw };
  }
  if (leaf.kind === 'slide') {
    const cx = leaf.hinge[0] + leaf.along[0] * leaf.width / 2, cz = leaf.hinge[1] + leaf.along[1] * leaf.width / 2;
    const s = value * (leaf.width - 0.08);
    return { x: cx - leaf.along[0] * s, y: d.y + leaf.height / 2 + 0.01, z: cz - leaf.along[1] * s, yaw: 0 };
  }
  const cx = leaf.hinge[0] + leaf.along[0] * leaf.width / 2, cz = leaf.hinge[1] + leaf.along[1] * leaf.width / 2;
  return { x: cx, y: d.y + leaf.height / 2 + 0.01 + value * (leaf.height - 0.2), z: cz, yaw: 0 };
}

/** pick the hinge swing sign that opens the door away from `from` */
export function swingAway(d: DoorData, from: [number, number]): number {
  const leaves = doorLeaves(d);
  if (!leaves.length || leaves[0].kind !== 'hinge') return 1;
  const leaf = leaves[0];
  const n: [number, number] = d.axis === 'x' ? [0, 1] : [1, 0];
  const side = Math.sign((from[0] - d.x) * n[0] + (from[1] - d.z) * n[1]) || 1;
  const [cx, cz] = rotY(leaf.along[0], leaf.along[1], DOOR_OPEN_ANGLE);
  const s = Math.sign(cx * n[0] + cz * n[1]) || 1;
  return s === -side ? 1 : -1;
}

export function doorOpenTarget(d: DoorData, sign: number): number {
  const leaves = doorLeaves(d);
  if (!leaves.length) return 1;
  return leaves[0].kind === 'hinge' ? DOOR_OPEN_ANGLE * sign : 1;
}

export function stepDoorValue(d: DoorData, current: number, target: number, dt: number, fast = false): number {
  const leaves = doorLeaves(d);
  const kind = leaves[0]?.kind ?? 'hinge';
  const speed = DOOR_SPEED[kind] * (fast ? 1.8 : 1);
  const diff = target - current;
  if (Math.abs(diff) <= speed * dt) return target;
  return current + Math.sign(diff) * speed * dt;
}
