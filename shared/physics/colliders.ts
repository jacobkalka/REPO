// Static collision geometry derived from LevelData. The server, the client and the nav grid
// all consume this list, so collision is identical everywhere.

import { WORLD } from '../constants';
import { MODELS } from '../catalog/furniture';
import { rotQ } from '../levelgen/furnish';
import { stairSolids, stairToWorld } from '../levelgen/stairs';
import type { LevelData, ProcData } from '../levelgen/types';

export type ColliderSpec =
  | { t: 'box'; x: number; y: number; z: number; hx: number; hy: number; hz: number; rotY: number; tag: number }
  | { t: 'hull'; points: number[]; tag: number }
  | { t: 'cyl'; x: number; y: number; z: number; r: number; hh: number; tag: number };

/** tag values let queries distinguish surfaces (footstep material, nav) */
export const TAG = { FLOOR: 1, WALL: 2, CEIL: 3, FURN: 4, STAIR: 5, LIFT: 6 } as const;

const WT = WORLD.WALL_THICKNESS;

export function procBoxes(p: ProcData, roomHeight: number): ColliderSpec[] {
  const out: ColliderSpec[] = [];
  const box = (lx: number, ly: number, lz: number, hx: number, hy: number, hz: number) => {
    const [ox, oz] = rotQ(lx, lz, p.rotY);
    const k = ((Math.round(p.rotY / (Math.PI / 2)) % 4) + 4) % 4;
    const swap = k === 1 || k === 3;
    out.push({ t: 'box', x: p.x + ox, y: p.y + ly, z: p.z + oz, hx: swap ? hz : hx, hy, hz: swap ? hx : hz, rotY: 0, tag: TAG.FURN });
  };
  const { w, h, d } = p;
  switch (p.kind) {
    case 'shelf': {
      const levels = Math.max(2, p.p);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(sx * (w / 2 - 0.03), h / 2, sz * (d / 2 - 0.03), 0.03, h / 2, 0.03);
      for (let l = 0; l < levels; l++) {
        const y = 0.12 + (l * (h - 0.12)) / (levels - 1);
        box(0, y - 0.02, 0, w / 2, 0.02, d / 2);
      }
      break;
    }
    case 'bookcase': {
      box(0, h / 2, -d / 2 + 0.03, w / 2, h / 2, 0.03);
      for (const sx of [-1, 1]) box(sx * (w / 2 - 0.02), h / 2, 0, 0.02, h / 2, d / 2);
      const levels = Math.max(2, p.p);
      for (let l = 0; l < levels; l++) box(0, 0.05 + (l * (h - 0.1)) / (levels - 1), 0, w / 2, 0.02, d / 2);
      break;
    }
    case 'cellBars': {
      const cells = Math.max(1, p.p);
      const cw = w / cells;
      // front bars with a gap (open cell door) per cell
      for (let c = 0; c < cells; c++) {
        const x0 = -w / 2 + c * cw;
        box(x0 + cw * 0.3, h / 2, d / 2 - 0.04, cw * 0.3, h / 2, 0.04);
        box(x0 + cw * 0.95, h / 2, d / 2 - 0.04, cw * 0.05, h / 2, 0.04);
        if (c > 0) box(x0, h / 2, 0, 0.05, h / 2, d / 2);
      }
      break;
    }
    case 'press': {
      // two columns + crown; the bed itself is low
      for (const sx of [-1, 1]) box(sx * (w / 2 - 0.2), h / 2, 0, 0.2, h / 2, d / 2);
      box(0, h - 0.35, 0, w / 2, 0.35, d / 2);
      box(0, 0.3, 0, w / 2 - 0.4, 0.3, d / 2 - 0.2);
      break;
    }
    case 'tank':
      out.push({ t: 'cyl', x: p.x, y: p.y + h / 2, z: p.z, r: Math.min(w, d) / 2, hh: h / 2, tag: TAG.FURN });
      break;
    case 'boiler':
      out.push({ t: 'cyl', x: p.x, y: p.y + h / 2, z: p.z, r: Math.min(w, d) / 2, hh: h / 2, tag: TAG.FURN });
      break;
    case 'column':
      box(0, roomHeight / 2, 0, w / 2, roomHeight / 2, d / 2);
      break;
    case 'bunk':
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(sx * (w / 2 - 0.03), h / 2, sz * (d / 2 - 0.03), 0.03, h / 2, 0.03);
      box(0, 0.4, 0, w / 2, 0.08, d / 2);
      box(0, 1.3, 0, w / 2, 0.08, d / 2);
      break;
    case 'gurney':
      box(0, 0.82, 0, w / 2, 0.08, d / 2);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(sx * (w / 2 - 0.05), 0.4, sz * (d / 2 - 0.08), 0.03, 0.4, 0.03);
      break;
    case 'liftCar': {
      // side cage walls and back wall of the lift car
      box(-w / 2 - 0.1, h / 2, 0, 0.1, h / 2, d / 2);
      box(w / 2 + 0.1, h / 2, 0, 0.1, h / 2, d / 2);
      box(0, -0.05, 0, w / 2 + 0.2, 0.05, d / 2);
      break;
    }
    case 'pipeRun':
    case 'beam':
    case 'catwalkRail':
      break;
    case 'cargoTube':
      box(0, h / 2, -0.1, w / 2, h / 2, d / 2 - 0.1);
      break;
    case 'conveyor':
      box(0, h / 2, 0, w / 2, h / 2, d / 2);
      break;
    default:
      box(0, h / 2, 0, w / 2, h / 2, d / 2);
  }
  return out;
}

export function buildStaticColliders(L: LevelData): ColliderSpec[] {
  const out: ColliderSpec[] = [];
  // floors + ceilings
  for (const r of L.rooms) {
    const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2, hx = (r.x1 - r.x0) / 2, hz = (r.z1 - r.z0) / 2;
    out.push({ t: 'box', x: cx, y: r.y - 0.25, z: cz, hx, hy: 0.25, hz, rotY: 0, tag: TAG.FLOOR });
    out.push({ t: 'box', x: cx, y: r.y + r.height + 0.15, z: cz, hx, hy: 0.15, hz, rotY: 0, tag: TAG.CEIL });
  }
  // walls split around openings
  for (const w of L.walls) {
    const pieces: { a: number; b: number; y0: number; y1: number }[] = [];
    const ops = [...w.openings].sort((p, q) => p.center - q.center);
    let cur = w.a;
    for (const o of ops) {
      const oa = o.center - o.width / 2, ob = o.center + o.width / 2;
      if (oa > cur) pieces.push({ a: cur, b: oa, y0: w.y, y1: w.y + w.height });
      if (o.height < w.height) pieces.push({ a: oa, b: ob, y0: w.y + o.height, y1: w.y + w.height });
      cur = ob;
    }
    if (cur < w.b) pieces.push({ a: cur, b: w.b, y0: w.y, y1: w.y + w.height });
    for (const p of pieces) {
      // extend pieces that touch the wall's ends by half a thickness so corners close
      const pa = p.a - (p.a === w.a ? WT / 2 : 0), pb = p.b + (p.b === w.b ? WT / 2 : 0);
      const along = (pa + pb) / 2, half = (pb - pa) / 2;
      const y = (p.y0 + p.y1) / 2, hy = (p.y1 - p.y0) / 2;
      if (w.axis === 'x') out.push({ t: 'box', x: along, y, z: w.fixed, hx: half, hy, hz: WT / 2, rotY: 0, tag: TAG.WALL });
      else out.push({ t: 'box', x: w.fixed, y, z: along, hx: WT / 2, hy, hz: half, rotY: 0, tag: TAG.WALL });
    }
  }
  // stairs
  for (const r of L.rooms) {
    if (!r.stair) continue;
    for (const s of stairSolids(r.height)) {
      const pts: number[] = [];
      for (const [u, y, v] of s.pts) { const p = stairToWorld(r, u, y, v); pts.push(p.x, p.y, p.z); }
      out.push({ t: 'hull', points: pts, tag: TAG.STAIR });
    }
  }
  // procedural furniture
  for (const p of L.procs) if (p.solid) out.push(...procBoxes(p, L.rooms[p.room].height).map((c) => (p.kind === 'liftCar' ? { ...c, tag: TAG.LIFT } : c)));
  // static models
  for (const s of L.statics) {
    if (!s.solid) continue;
    const m = MODELS[s.model];
    if (!m) continue;
    const pts: number[] = [];
    for (let i = 0; i < m.hull.length; i += 3) {
      const [ox, oz] = rotQ(m.hull[i] * s.scale, m.hull[i + 2] * s.scale, s.rotY);
      pts.push(s.x + ox, s.y + m.hull[i + 1] * s.scale, s.z + oz);
    }
    out.push({ t: 'hull', points: pts, tag: TAG.FURN });
  }
  return out;
}

/** XZ footprint AABB and vertical span of a collider */
export function colliderBounds(c: ColliderSpec): { x0: number; z0: number; x1: number; z1: number; y0: number; y1: number } {
  if (c.t === 'box') return { x0: c.x - c.hx, x1: c.x + c.hx, z0: c.z - c.hz, z1: c.z + c.hz, y0: c.y - c.hy, y1: c.y + c.hy };
  if (c.t === 'cyl') return { x0: c.x - c.r, x1: c.x + c.r, z0: c.z - c.r, z1: c.z + c.r, y0: c.y - c.hh, y1: c.y + c.hh };
  let x0 = Infinity, z0 = Infinity, y0 = Infinity, x1 = -Infinity, z1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < c.points.length; i += 3) {
    x0 = Math.min(x0, c.points[i]); x1 = Math.max(x1, c.points[i]);
    y0 = Math.min(y0, c.points[i + 1]); y1 = Math.max(y1, c.points[i + 1]);
    z0 = Math.min(z0, c.points[i + 2]); z1 = Math.max(z1, c.points[i + 2]);
  }
  return { x0, z0, x1, z1, y0, y1 };
}
