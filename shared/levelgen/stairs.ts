// Switchback stairwell geometry in the stairwell's local (u = right, v = forward, y) frame.
// Single source of truth for colliders (shared), visuals (client) and AI nav links.
//
//  v ^  ┌──────────────── mid landing (y=3) ────────────────┐
//    |  │ flight 2 (3→6)  │   core (solid)   │ flight 1 (0→3)│
//    |  │ top landing (6) │                  │ bottom landing│
//    +--└─[upper door]────┴──────────────────┴─[lower door]──┘--> u
import { WORLD } from '../constants';
import type { NavLink, RoomData, Vec3 } from './types';

const RISE = WORLD.FLOOR_SPACING / 2; // per flight
export const STAIR = {
  WALL: WORLD.WALL_THICKNESS / 2,
  U_F2: [0.15, 2.9] as [number, number],
  U_CORE: [2.9, 5.1] as [number, number],
  U_F1: [5.1, 7.85] as [number, number],
  V_LAND: 1.6,      // landings occupy v ∈ [0.15, 1.6]
  V_MID: 6.1,       // mid landing v ∈ [6.1, 7.85]
  V_MAX: 7.85,
  RISE,
};

/** convex solids (lists of local points) */
export interface StairSolid { pts: [number, number, number][]; kind: 'ramp' | 'box' }

export function stairSolids(totalHeight: number): StairSolid[] {
  const { U_F1, U_F2, U_CORE, V_LAND, V_MID, V_MAX } = STAIR;
  const box = (u0: number, u1: number, y0: number, y1: number, v0: number, v1: number): StairSolid => ({
    kind: 'box',
    pts: [[u0, y0, v0], [u1, y0, v0], [u0, y0, v1], [u1, y0, v1], [u0, y1, v0], [u1, y1, v0], [u0, y1, v1], [u1, y1, v1]],
  });
  return [
    // flight 1: ramp rising from v=V_LAND (y=0) to v=V_MID (y=RISE)
    { kind: 'ramp', pts: [[U_F1[0], 0, V_LAND], [U_F1[1], 0, V_LAND], [U_F1[0], 0, V_MID], [U_F1[1], 0, V_MID], [U_F1[0], RISE, V_MID], [U_F1[1], RISE, V_MID]] },
    // mid landing
    box(STAIR.U_F2[0], U_F1[1], 0, RISE, V_MID, V_MAX),
    // flight 2: solid block rising from y=RISE at v=V_MID to y=2*RISE at v=V_LAND
    { kind: 'ramp', pts: [[U_F2[0], 0, V_LAND], [U_F2[1], 0, V_LAND], [U_F2[0], 0, V_MID], [U_F2[1], 0, V_MID], [U_F2[0], RISE, V_MID], [U_F2[1], RISE, V_MID], [U_F2[0], 2 * RISE, V_LAND], [U_F2[1], 2 * RISE, V_LAND]] },
    // top landing
    box(U_F2[0], U_F2[1], 0, 2 * RISE, 0.15, V_LAND),
    // central core, full height
    box(U_CORE[0], U_CORE[1], 0, totalHeight, 0.15, V_MID),
  ];
}

export function stairToWorld(room: RoomData, u: number, y: number, v: number): Vec3 {
  const f = room.stair!;
  return { x: f.origin[0] + u * f.right[0] + v * f.forward[0], y: room.y + y, z: f.origin[1] + u * f.right[1] + v * f.forward[1] };
}

export function stairNavLink(room: RoomData): NavLink {
  const f = room.stair!;
  const mid = (STAIR.U_F1[0] + STAIR.U_F1[1]) / 2;
  const mid2 = (STAIR.U_F2[0] + STAIR.U_F2[1]) / 2;
  const pts = [
    stairToWorld(room, mid, 0, -0.6),           // outside lower door
    stairToWorld(room, mid, 0, 0.9),
    stairToWorld(room, mid, 0, STAIR.V_LAND + 0.1),
    stairToWorld(room, mid, RISE, STAIR.V_MID + 0.3),
    stairToWorld(room, (mid + mid2) / 2, RISE, (STAIR.V_MID + STAIR.V_MAX) / 2),
    stairToWorld(room, mid2, RISE, STAIR.V_MID + 0.3),
    stairToWorld(room, mid2, 2 * RISE, STAIR.V_LAND - 0.1),
    stairToWorld(room, mid2, 2 * RISE, 0.9),
    stairToWorld(room, mid2, 2 * RISE, -0.6),   // outside upper door
  ];
  return { points: pts, floorA: f.lowerFloor, floorB: f.upperFloor, room: room.id };
}

/** height of the walkable stair surface at local (u, v), or null if outside the stair area */
export function stairSurfaceY(u: number, v: number): number | null {
  const { U_F1, U_F2, V_LAND, V_MID, V_MAX } = STAIR;
  if (v >= V_MID && v <= V_MAX) return RISE;
  if (u >= U_F1[0] && u <= U_F1[1]) {
    if (v <= V_LAND) return 0;
    return ((v - V_LAND) / (V_MID - V_LAND)) * RISE;
  }
  if (u >= U_F2[0] && u <= U_F2[1]) {
    if (v <= V_LAND) return 2 * RISE;
    return RISE + ((V_MID - v) / (V_MID - V_LAND)) * RISE;
  }
  return null;
}
