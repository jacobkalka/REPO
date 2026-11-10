// Room furnishing: places furniture (procedural + CC0 models), valuable slots,
// interactables, hazards and spawn points. Deterministic and navigability-preserving:
// every room keeps a walkable path between all of its doorways.

import type { Rng } from '../rng';
import { WORLD, MISSION } from '../constants';
import { DOCUMENTS } from '../catalog/documents';
import { FURNITURE, MODELS, modelSize } from '../catalog/furniture';
import { RARITY_WEIGHT, valuablesForTheme, type ValuableDef } from '../catalog/valuables';
import type { LevelGenerator } from './generate';
import { DIRS, type Dir, type HazardKind, type InteractableKind, type LevelData, type ProcData, type ProcKind, type RoomData, type ValuableSlot } from './types';

const CELL = 0.5;
const WALL = WORLD.WALL_THICKNESS / 2;
const HALF_PI = Math.PI / 2;

export interface Pose { x: number; z: number; rotY: number; side?: Dir }

/** exact quarter-turn rotation of a local offset */
export function rotQ(lx: number, lz: number, rotY: number): [number, number] {
  const k = ((Math.round(rotY / HALF_PI) % 4) + 4) % 4;
  switch (k) {
    case 0: return [lx, lz];
    case 1: return [lz, -lx];
    case 2: return [-lx, -lz];
    default: return [-lz, lx];
  }
}

function isQuarterSwap(rotY: number): boolean {
  const k = ((Math.round(rotY / HALF_PI) % 4) + 4) % 4;
  return k === 1 || k === 3;
}

export class RoomFurnisher {
  readonly nx: number;
  readonly nz: number;
  readonly occ: Uint8Array; // 0 free, 1 furniture, 2 door keep-out
  readonly centerItems: { cells: number[]; procs: number[]; statics: number[]; props: number[]; slots: number; hazards: number; inter: number }[] = [];
  readonly slots: ValuableSlot[] = [];

  constructor(readonly gen: LevelGenerator, readonly L: LevelData, readonly room: RoomData, readonly rng: Rng) {
    this.nx = Math.round((room.x1 - room.x0) / CELL);
    this.nz = Math.round((room.z1 - room.z0) / CELL);
    this.occ = new Uint8Array(this.nx * this.nz);
    // wall band
    for (let i = 0; i < this.nx; i++) for (let j = 0; j < this.nz; j++) if (i === 0 || j === 0 || i === this.nx - 1 || j === this.nz - 1) { /* edge cells remain usable for wall furniture */ }
    for (const did of room.doors) this.keepOutDoor(did);
  }

  private keepOutDoor(did: number) {
    const d = this.L.doors[did];
    if (d.floor !== this.room.floor && !(this.room.floorsSpanned > 1)) return;
    if (this.room.stair) return;
    const r = this.room;
    const half = d.width / 2 + 0.55;
    const depth = 2.1;
    if (d.axis === 'x') {
      const inward = Math.abs(d.z - r.z0) < 0.01 ? 1 : -1;
      const za = d.z, zb = d.z + inward * depth;
      this.mark(d.x - half, Math.min(za, zb), d.x + half, Math.max(za, zb), 2);
    } else {
      const inward = Math.abs(d.x - r.x0) < 0.01 ? 1 : -1;
      const xa = d.x, xb = d.x + inward * depth;
      this.mark(Math.min(xa, xb), d.z - half, Math.max(xa, xb), d.z + half, 2);
    }
  }

  cellRange(x0: number, z0: number, x1: number, z1: number): [number, number, number, number] {
    const r = this.room;
    const i0 = Math.max(0, Math.floor((x0 - r.x0) / CELL + 1e-6));
    const j0 = Math.max(0, Math.floor((z0 - r.z0) / CELL + 1e-6));
    const i1 = Math.min(this.nx - 1, Math.ceil((x1 - r.x0) / CELL - 1e-6) - 1);
    const j1 = Math.min(this.nz - 1, Math.ceil((z1 - r.z0) / CELL - 1e-6) - 1);
    return [i0, j0, i1, j1];
  }

  mark(x0: number, z0: number, x1: number, z1: number, v: number): number[] {
    const [i0, j0, i1, j1] = this.cellRange(x0, z0, x1, z1);
    const cells: number[] = [];
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const k = i * this.nz + j; if (this.occ[k] === 0 || v === 2) { this.occ[k] = v; cells.push(k); } }
    return cells;
  }

  isFree(x0: number, z0: number, x1: number, z1: number): boolean {
    const r = this.room;
    if (x0 < r.x0 + WALL - 1e-6 || z0 < r.z0 + WALL - 1e-6 || x1 > r.x1 - WALL + 1e-6 || z1 > r.z1 - WALL + 1e-6) return false;
    const [i0, j0, i1, j1] = this.cellRange(x0, z0, x1, z1);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) if (this.occ[i * this.nz + j] !== 0) return false;
    return true;
  }

  footprint(p: Pose, w: number, d: number, margin = 0): [number, number, number, number] {
    const swap = isQuarterSwap(p.rotY);
    const hw = (swap ? d : w) / 2 + margin, hd = (swap ? w : d) / 2 + margin;
    return [p.x - hw, p.z - hd, p.x + hw, p.z + hd];
  }

  /** place against a wall; w = width along the wall, d = depth out from the wall */
  wall(w: number, d: number, side: Dir | -1 = -1, gap = 0.04): Pose | null {
    const r = this.room;
    const sides = side === -1 ? this.rng.shuffle([0, 1, 2, 3] as Dir[]) : [side];
    for (const s of sides) {
      const alongX = s === 0 || s === 2;
      const len = alongX ? r.x1 - r.x0 : r.z1 - r.z0;
      const start = alongX ? r.x0 : r.z0;
      const steps = Math.floor((len - 2 * WALL - w) / 0.25);
      if (steps < 0) continue;
      const offs = this.rng.shuffle(Array.from({ length: steps + 1 }, (_, i) => i));
      for (const o of offs.slice(0, 24)) {
        const a = start + WALL + w / 2 + o * 0.25;
        let p: Pose;
        if (s === 2) p = { x: a, z: r.z0 + WALL + gap + d / 2, rotY: 0, side: s };
        else if (s === 0) p = { x: a, z: r.z1 - WALL - gap - d / 2, rotY: Math.PI, side: s };
        else if (s === 3) p = { x: r.x0 + WALL + gap + d / 2, z: a, rotY: HALF_PI, side: s };
        else p = { x: r.x1 - WALL - gap - d / 2, z: a, rotY: -HALF_PI, side: s };
        const fp = this.footprint(p, w, d);
        if (this.isFree(fp[0], fp[1], fp[2], fp[3])) { this.mark(fp[0], fp[1], fp[2], fp[3], 1); return p; }
      }
    }
    return null;
  }

  /** place in the interior keeping `margin` clearance for walkways */
  center(w: number, d: number, margin = 1.0, rotY?: number, tries = 30): Pose | null {
    const r = this.room;
    for (let t = 0; t < tries; t++) {
      const ry = rotY ?? (this.rng.chance(0.5) ? 0 : HALF_PI);
      const swap = isQuarterSwap(ry);
      const hw = (swap ? d : w) / 2, hd = (swap ? w : d) / 2;
      const x = this.rng.range(r.x0 + WALL + hw + margin, r.x1 - WALL - hw - margin);
      const z = this.rng.range(r.z0 + WALL + hd + margin, r.z1 - WALL - hd - margin);
      if (!(x === x) || !(z === z)) return null;
      if (r.x1 - r.x0 - 2 * WALL < 2 * hw + 2 * margin || r.z1 - r.z0 - 2 * WALL < 2 * hd + 2 * margin) return null;
      const p: Pose = { x: Math.round(x * 4) / 4, z: Math.round(z * 4) / 4, rotY: ry };
      const fpm = this.footprint(p, w, d, margin * 0.5);
      if (!this.isFree(fpm[0], fpm[1], fpm[2], fpm[3])) continue;
      const fp = this.footprint(p, w, d);
      const cells = this.mark(fp[0], fp[1], fp[2], fp[3], 1);
      this.centerItems.push({ cells, procs: [this.L.procs.length], statics: [this.L.statics.length], props: [this.L.props.length], slots: this.slots.length, hazards: this.L.hazards.length, inter: this.L.interactables.length });
      return p;
    }
    return null;
  }

  proc(kind: ProcKind, p: Pose, w: number, h: number, d: number, param = 0, solid = true): ProcData {
    const pr: ProcData = { kind, room: this.room.id, x: p.x, y: this.room.y, z: p.z, rotY: p.rotY, w, h, d, p: param, seed: this.rng.int(0, 1e9), solid };
    this.L.procs.push(pr);
    return pr;
  }

  stat(model: string, p: Pose, solid = true, yOffset = 0): void {
    const s = modelSize(model);
    this.L.statics.push({ model, room: this.room.id, x: p.x, y: this.room.y + s[1] / 2 + yOffset, z: p.z, rotY: p.rotY, scale: 1, solid });
  }

  furniture(model: string, p: Pose): void {
    const s = modelSize(model);
    const f = FURNITURE[model];
    this.L.props.push({ id: this.L.props.length, kind: 'furniture', def: model, room: this.room.id, x: p.x, y: this.room.y + s[1] / 2 + 0.02, z: p.z, rotY: p.rotY + this.rng.range(-0.25, 0.25), value: 0, mass: f?.mass ?? 10 });
  }

  slot(x: number, y: number, z: number, maxSize: number, floor = false) {
    this.slots.push({ x, y, z, room: this.room.id, maxSize, floor });
  }

  /** valuable slots on a rectangular top surface */
  topSlots(p: Pose, w: number, d: number, y: number, n: number, maxSize?: number) {
    for (let i = 0; i < n; i++) {
      const lx = (n === 1 ? 0 : -w / 2 + (w * (i + 0.5)) / n) + this.rng.range(-0.08, 0.08);
      const lz = this.rng.range(-d * 0.18, d * 0.18);
      const [ox, oz] = rotQ(lx, lz, p.rotY);
      this.slot(p.x + ox, this.room.y + y, p.z + oz, maxSize ?? Math.min(d * 0.95, (w / n) * 1.1));
    }
  }

  floorSlots(n: number) {
    const r = this.room;
    for (let t = 0, made = 0; t < n * 8 && made < n; t++) {
      const x = this.rng.range(r.x0 + WALL + 0.6, r.x1 - WALL - 0.6);
      const z = this.rng.range(r.z0 + WALL + 0.6, r.z1 - WALL - 0.6);
      if (!this.isFree(x - 0.5, z - 0.5, x + 0.5, z + 0.5)) continue;
      this.mark(x - 0.5, z - 0.5, x + 0.5, z + 0.5, 1);
      this.slot(x, r.y, z, 1.8, true);
      made++;
    }
  }

  interact(kind: InteractableKind, x: number, y: number, z: number, rotY: number, target = -1, data = '') {
    const it = { id: this.L.interactables.length, kind, room: this.room.id, x, y, z, rotY, sector: this.room.sector, target, data };
    this.L.interactables.push(it);
    return it;
  }

  /** wall-mounted point (no footprint): returns position on the inner wall face */
  wallPoint(height: number, side: Dir | -1 = -1): { x: number; y: number; z: number; rotY: number } | null {
    const p = this.wall(0.6, 0.25, side, 0.0);
    if (!p) return null;
    const [fx, fz] = rotQ(0, -0.12, p.rotY);
    return { x: p.x + fx, y: this.room.y + height, z: p.z + fz, rotY: p.rotY };
  }

  hazard(kind: HazardKind, x: number, y: number, z: number, hx: number, hy: number, hz: number, period: number, duty: number, damage: number) {
    this.L.hazards.push({ id: this.L.hazards.length, kind, room: this.room.id, x, y, z, hx, hy, hz, rotY: 0, period, duty, phase: this.rng.next() * period, damage, sector: this.room.sector });
  }

  /** flood-fill check: all door keep-out zones mutually reachable through free cells */
  connected(): boolean {
    const doorCells: number[] = [];
    for (let k = 0; k < this.occ.length; k++) if (this.occ[k] === 2) doorCells.push(k);
    if (doorCells.length === 0) return true;
    const seen = new Uint8Array(this.occ.length);
    const q = [doorCells[0]];
    seen[doorCells[0]] = 1;
    while (q.length) {
      const k = q.pop()!;
      const i = Math.floor(k / this.nz), j = k % this.nz;
      for (const [di, dj] of DIRS) {
        const ni = i + di, nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= this.nx || nj >= this.nz) continue;
        const nk = ni * this.nz + nj;
        if (seen[nk] || this.occ[nk] === 1) continue;
        seen[nk] = 1; q.push(nk);
      }
    }
    return doorCells.every((k) => seen[k]);
  }

  /** remove most recent centre items until the room is passable */
  repair() {
    let guard = 0;
    while (!this.connected() && this.centerItems.length && guard++ < 20) {
      const it = this.centerItems.pop()!;
      for (const c of it.cells) if (this.occ[c] === 1) this.occ[c] = 0;
      this.L.procs.length = Math.min(this.L.procs.length, it.procs[0]);
      this.L.statics.length = Math.min(this.L.statics.length, it.statics[0]);
      this.L.props.length = Math.min(this.L.props.length, it.props[0]);
      this.slots.length = Math.min(this.slots.length, it.slots);
      this.L.hazards.length = Math.min(this.L.hazards.length, it.hazards);
      this.L.interactables.length = Math.min(this.L.interactables.length, it.inter);
    }
  }
}

// ---------------------------------------------------------------------------- recipes
type Recipe = (f: RoomFurnisher) => void;

const shelfRow = (f: RoomFurnisher, n: number, h = 2.1, levels = 4, depth = 0.55) => {
  for (let i = 0; i < n; i++) {
    const w = f.rng.pick([1.8, 2.2, 2.4]);
    const p = f.wall(w, depth);
    if (!p) break;
    f.proc('shelf', p, w, h, depth, levels);
    for (let l = 0; l < levels; l++) {
      const y = 0.12 + (l * (h - 0.12)) / (levels - 1);
      const clear = l < levels - 1 ? (h - 0.12) / (levels - 1) - 0.06 : f.room.height - h - 0.2;
      if (clear < 0.25) continue;
      if (f.rng.chance(0.75)) f.topSlots(p, w, depth, y + 0.03, f.rng.int(1, 2), Math.min(depth * 1.1, 0.9));
    }
  }
};

const benchRow = (f: RoomFurnisher, n: number, kind: ProcKind = 'bench', h = 0.92, d = 0.78) => {
  for (let i = 0; i < n; i++) {
    const w = f.rng.pick([2.0, 2.4, 3.0]);
    const p = f.wall(w, d);
    if (!p) break;
    f.proc(kind, p, w, h, d, f.rng.int(0, 3));
    f.topSlots(p, w, d, h + 0.02, f.rng.int(1, 3));
  }
};

const clutter = (f: RoomFurnisher, models: string[], n: number) => {
  for (let i = 0; i < n; i++) {
    const m = f.rng.pick(models);
    const s = modelSize(m);
    const p = f.rng.chance(0.6) ? f.wall(Math.max(s[0], 0.4) + 0.1, Math.max(s[2], 0.4) + 0.1) : f.center(Math.max(s[0], 0.4), Math.max(s[2], 0.4), 0.8);
    if (!p) continue;
    if (FURNITURE[m]?.dynamic) f.furniture(m, p);
    else f.stat(m, p);
  }
};

const staticWall = (f: RoomFurnisher, model: string, slotsOnTop = 0, side: Dir | -1 = -1) => {
  const s = modelSize(model);
  const p = f.wall(s[0], s[2], side);
  if (!p) return null;
  f.stat(model, p);
  if (slotsOnTop) f.topSlots(p, s[0] * 0.8, s[2] * 0.8, s[1] + 0.02, slotsOnTop);
  return p;
};

const staticCenter = (f: RoomFurnisher, model: string, slotsOnTop = 0, margin = 0.9) => {
  const s = modelSize(model);
  const p = f.center(s[0], s[2], margin);
  if (!p) return null;
  f.stat(model, p);
  if (slotsOnTop) f.topSlots(p, s[0] * 0.8, s[2] * 0.7, s[1] + 0.02, slotsOnTop);
  return p;
};

const desks = (f: RoomFurnisher, n: number, chair = 'SchoolChair_01') => {
  for (let i = 0; i < n; i++) {
    const p = f.wall(2.0, 0.95);
    if (!p) break;
    f.stat('metal_office_desk', p);
    f.topSlots(p, 1.6, 0.6, 0.8, f.rng.int(1, 2));
    if (f.rng.chance(0.75)) {
      const [ox, oz] = rotQ(f.rng.range(-0.4, 0.4), 0.95, p.rotY);
      const cp = { x: p.x + ox, z: p.z + oz, rotY: p.rotY + Math.PI };
      if (f.isFree(cp.x - 0.3, cp.z - 0.3, cp.x + 0.3, cp.z + 0.3)) f.furniture(chair, cp);
    }
  }
};

const columns = (f: RoomFurnisher) => {
  const r = f.room;
  const w = r.x1 - r.x0, d = r.z1 - r.z0;
  const nx = Math.max(1, Math.floor(w / 8)), nz = Math.max(1, Math.floor(d / 8));
  for (let i = 1; i <= nx; i++) for (let j = 1; j <= nz; j++) {
    const x = r.x0 + (i * w) / (nx + 1), z = r.z0 + (j * d) / (nz + 1);
    if (!f.isFree(x - 0.35, z - 0.35, x + 0.35, z + 0.35)) continue;
    f.mark(x - 0.35, z - 0.35, x + 0.35, z + 0.35, 1);
    f.proc('column', { x, z, rotY: 0 }, 0.6, r.height, 0.6);
  }
};

const RECIPES: Partial<Record<string, Recipe>> = {
  lab: (f) => {
    benchRow(f, f.rng.int(2, 4), 'bench');
    if (f.rng.chance(0.6)) shelfRow(f, 1, 2.0, 4, 0.45);
    for (let i = 0; i < f.rng.int(1, 2); i++) {
      const p = f.center(f.rng.pick([2.4, 3.0]), 1.3, 1.1);
      if (p) { f.proc('bench', p, 2.6, 0.92, 1.3, 9); f.topSlots(p, 2.4, 1.1, 0.94, f.rng.int(2, 3)); }
    }
    if (f.rng.chance(0.5)) { const p = f.wall(1.1, 1.1); if (p) f.proc('tank', p, 1.0, 2.1, 1.0, 1); }
    clutter(f, ['SchoolChair_01', 'metal_stool_01', 'korean_fire_extinguisher_01', 'cardboard_box_01'], f.rng.int(1, 3));
  },
  specimen: (f) => {
    for (let i = 0; i < f.rng.int(3, 6); i++) { const p = f.wall(1.1, 1.1); if (p) f.proc('tank', p, 1.0, 2.1, 1.0, f.rng.int(0, 2)); }
    shelfRow(f, f.rng.int(1, 3), 2.0, 4, 0.5);
    const p = f.center(1.0, 1.0, 1.2); if (p) f.proc('tank', p, 1.0, 2.1, 1.0, 2);
    clutter(f, ['industrial_pastic_container', 'cardboard_box_01'], 2);
  },
  office: (f) => {
    desks(f, f.rng.int(2, 4));
    if (f.rng.chance(0.7)) staticWall(f, 'drawer_cabinet', 1);
    if (f.rng.chance(0.5)) staticWall(f, 'standing_chalkboard_01');
    if (f.rng.chance(0.5)) shelfRow(f, 1, 2.0, 4, 0.45);
    clutter(f, ['modern_arm_chair_01', 'cardboard_box_01', 'WetFloorSign_01'], f.rng.int(0, 2));
  },
  medical: (f) => {
    for (let i = 0; i < f.rng.int(2, 4); i++) { const p = f.wall(0.85, 2.1); if (p) { f.proc('gurney', p, 0.8, 0.9, 2.0); f.topSlots(p, 0.6, 1.4, 0.92, 1); } }
    benchRow(f, f.rng.int(1, 2), 'bench');
    if (f.rng.chance(0.6)) staticWall(f, 'drawer_cabinet', 1);
    clutter(f, ['wheelchair_01', 'metal_stool_01'], f.rng.int(1, 2));
  },
  server: (f) => {
    const r = f.room;
    const rows = Math.max(1, Math.floor((r.x1 - r.x0 - 2) / 2.4));
    for (let i = 0; i < rows; i++) {
      const p = f.center(0.8, Math.min(4.8, r.z1 - r.z0 - 3.4), 0.8, 0);
      if (p) f.proc('serverRack', p, 0.8, 2.1, Math.min(4.8, r.z1 - r.z0 - 3.4), f.rng.int(3, 6));
    }
    benchRow(f, 1, 'desk', 0.78, 0.8);
    clutter(f, ['SchoolChair_01', 'cardboard_box_01'], 1);
  },
  security: (f) => {
    benchRow(f, 2, 'desk', 0.78, 0.85);
    const p = f.wall(1.8, 0.5);
    if (p) f.proc('lockers', p, 1.8, 1.95, 0.5, 4);
    const t = f.wallPoint(1.25);
    if (t) f.interact('terminal', t.x, t.y, t.z, t.rotY);
    clutter(f, ['SchoolChair_01', 'modern_arm_chair_01'], 2);
  },
  storage: (f) => {
    shelfRow(f, f.rng.int(2, 5), f.room.tall ? 3.4 : 2.2, f.room.tall ? 5 : 4, 0.6);
    for (let i = 0; i < f.rng.int(1, 3); i++) { const p = f.center(1.3, 1.3, 0.9); if (p) { const h = f.rng.pick([0.9, 1.4, 1.9]); f.proc('crateStack', p, 1.3, h, 1.3, f.rng.int(0, 3)); f.topSlots(p, 1.0, 1.0, h + 0.02, 1); } }
    clutter(f, ['Barrel_01', 'barrel_03', 'cardboard_box_01', 'wooden_crate_01', 'plastic_crate_03', 'hand_truck'], f.rng.int(2, 4));
  },
  electrical: (f) => {
    staticWall(f, f.rng.pick(['utility_box_01', 'utility_box_02']));
    staticWall(f, 'utility_box_01');
    const p = f.center(2.2, 1.4, 1.0);
    if (p) f.proc('generator', p, 2.2, 1.6, 1.4);
    shelfRow(f, 1, 2.0, 4, 0.5);
    clutter(f, ['cardboard_box_01', 'korean_fire_extinguisher_01'], 1);
  },
  breakroom: (f) => {
    benchRow(f, 1, 'counter', 0.92, 0.65);
    staticCenter(f, 'round_wooden_table_01', 2, 1.0);
    clutter(f, ['SchoolChair_01', 'SchoolChair_01', 'dining_chair_02', 'metal_trash_can'], f.rng.int(2, 4));
  },
  archive: (f) => {
    for (let i = 0; i < f.rng.int(3, 6); i++) { const p = f.wall(1.6, 0.45); if (p) { f.proc('bookcase', p, 1.6, 2.2, 0.45, 5); f.topSlots(p, 1.4, 0.4, 0.95, 1, 0.45); f.topSlots(p, 1.4, 0.4, 1.4, 1, 0.45); } }
    const p = f.center(2.4, 1.2, 1.1); if (p) { f.proc('bench', p, 2.4, 0.8, 1.2, 8); f.topSlots(p, 2.0, 1.0, 0.82, 2); }
  },
  vault: (f) => {
    shelfRow(f, 2, 2.0, 4, 0.55);
    for (let i = 0; i < 2; i++) { const p = f.center(0.6, 0.6, 0.7); if (p) { f.proc('pedestal', p, 0.6, 1.0, 0.6, 1); f.slot(p.x, f.room.y + 1.02, p.z, 0.75); } }
    f.floorSlots(2);
  },
  // ---------------- industrial
  factory: (f) => {
    columns(f);
    const r = f.room;
    const len = Math.min(r.x1 - r.x0 - 6, 14);
    if (len > 5) { const p = f.center(len, 1.1, 1.2, 0); if (p) { f.proc('conveyor', p, len, 0.95, 1.1, 0); f.topSlots(p, len - 1, 0.6, 0.97, Math.floor(len / 2.5)); } }
    for (let i = 0; i < f.rng.int(2, 4); i++) { const w = f.rng.pick([2.6, 3.2, 4.0]); const p = f.center(w, 2.0, 1.2); if (p) f.proc('machine', p, w, f.rng.pick([1.8, 2.4, 3.0]), 2.0, f.rng.int(0, 3)); }
    if (f.rng.chance(0.75)) {
      const p = f.center(2.6, 2.2, 1.3);
      if (p) { f.proc('press', p, 2.6, 3.4, 2.2); f.hazard('crusher', p.x, r.y + 0.9, p.z, 0.95, 0.9, 0.85, 7, 0.14, 70); f.slot(p.x, r.y + 0.72, p.z, 1.2); }
    }
    benchRow(f, f.rng.int(1, 2), 'bench');
    clutter(f, ['Barrel_01', 'barrel_03', 'industrial_storage_cart', 'tool_cart', 'wooden_crate_02', 'old_tyre'], f.rng.int(3, 5));
    f.floorSlots(f.rng.int(2, 4));
  },
  warehouse: (f) => {
    const r = f.room;
    const lanes = Math.max(1, Math.floor((r.x1 - r.x0 - 4) / 4.5));
    for (let i = 0; i < lanes; i++) {
      const len = Math.min(r.z1 - r.z0 - 5.5, 10);
      if (len < 2.5) break;
      const p = f.center(len, 1.1, 1.3, HALF_PI);
      if (!p) continue;
      f.proc('shelf', p, len, 3.6, 1.1, 5);
      for (let l = 0; l < 5; l++) if (f.rng.chance(0.7)) f.topSlots(p, len - 0.4, 0.9, 0.12 + (l * 3.48) / 4 + 0.03, f.rng.int(1, 3), 0.95);
    }
    shelfRow(f, f.rng.int(1, 3), 3.4, 5, 0.8);
    for (let i = 0; i < f.rng.int(2, 4); i++) { const p = f.center(1.3, 1.1, 1.0); if (p) { const h = f.rng.pick([0.9, 1.5, 2.1]); f.proc('crateStack', p, 1.3, h, 1.1, f.rng.int(0, 3)); f.topSlots(p, 1.0, 0.8, h + 0.02, 1); } }
    clutter(f, ['hand_truck', 'Barrel_01', 'wooden_crate_01', 'wooden_military_crate', 'industrial_storage_cart'], f.rng.int(2, 4));
    f.floorSlots(f.rng.int(2, 3));
  },
  workshop: (f) => {
    benchRow(f, f.rng.int(2, 3), 'bench', 0.95, 0.85);
    shelfRow(f, 1, 2.0, 4, 0.55);
    staticWall(f, 'portable_welding_cart');
    clutter(f, ['tool_cart', 'metal_stool_01', 'Barrel_01', 'industrial_pastic_container'], f.rng.int(1, 3));
    f.floorSlots(1);
  },
  loading: (f) => {
    for (let i = 0; i < f.rng.int(3, 5); i++) { const p = f.center(1.3, 1.1, 1.0); if (p) { const h = f.rng.pick([0.15, 0.9, 1.5]); f.proc(h < 0.3 ? 'pallet' : 'crateStack', p, 1.3, h, 1.1, f.rng.int(0, 3)); f.topSlots(p, 1.0, 0.8, h + 0.02, 1); } }
    clutter(f, ['hand_truck', 'Barrel_01', 'barrel_03', 'wooden_military_crate', 'industrial_storage_cart', 'old_tyre'], f.rng.int(3, 5));
    f.floorSlots(2);
  },
  boiler: (f) => {
    for (let i = 0; i < f.rng.int(1, 2); i++) {
      const p = f.wall(2.2, 2.2);
      if (p) {
        f.proc('boiler', p, 2.0, Math.min(3.2, f.room.height - 0.4), 2.0);
        const [ox, oz] = rotQ(0, 1.6, p.rotY);
        f.hazard('steam', p.x + ox, f.room.y + 1.0, p.z + oz, 0.75, 1.0, 0.75, f.rng.range(7, 11), 0.28, 14);
        const vp = f.wallPoint(1.2);
        if (vp) f.interact('valveWheel', vp.x, vp.y, vp.z, vp.rotY, f.L.hazards.length - 1);
      }
    }
    clutter(f, ['Barrel_01', 'barrel_03'], 2);
    f.floorSlots(1);
  },
  control: (f) => {
    benchRow(f, f.rng.int(2, 3), 'desk', 0.85, 0.9);
    desks(f, 1, 'modern_arm_chair_01');
    clutter(f, ['modern_arm_chair_01', 'SchoolChair_01'], 2);
  },
  locker: (f) => {
    for (let i = 0; i < f.rng.int(2, 3); i++) { const p = f.wall(2.25, 0.5); if (p) { f.proc('lockers', p, 2.25, 1.95, 0.5, 5); } }
    const p = f.center(2.0, 0.45, 0.9); if (p) { f.proc('bench', p, 2.0, 0.45, 0.4, 7); f.topSlots(p, 1.8, 0.3, 0.47, 2, 0.5); }
    clutter(f, ['cardboard_box_01', 'WetFloorSign_01'], 1);
  },
  // ---------------- underground
  bunker: (f) => {
    for (let i = 0; i < f.rng.int(2, 4); i++) { const p = f.wall(0.95, 2.05); if (p) { f.proc('bunk', p, 0.95, 1.75, 2.05); f.topSlots(p, 0.6, 1.4, 0.5, 1, 0.8); } }
    const p = f.wall(1.8, 0.5); if (p) f.proc('lockers', p, 1.8, 1.95, 0.5, 4);
    staticCenter(f, 'round_wooden_table_01', 1, 1.0);
    clutter(f, ['dining_chair_02', 'wooden_military_crate', 'cardboard_box_01'], 2);
  },
  pumproom: (f) => {
    const r = f.room;
    for (let i = 0; i < 2; i++) { const p = f.wall(2.4, 1.6); if (p) f.proc('machine', p, 2.4, 1.6, 1.6, 4); }
    const w = Math.min(4, r.x1 - r.x0 - 3), d = Math.min(3, r.z1 - r.z0 - 3);
    const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
    f.hazard('water', cx, r.y + 0.15, cz, w / 2, 0.3, d / 2, f.rng.range(9, 14), 0.4, 22);
    const vp = f.wallPoint(1.2);
    if (vp) f.interact('valveWheel', vp.x, vp.y, vp.z, vp.rotY, f.L.hazards.length - 1);
    clutter(f, ['Barrel_01', 'barrel_03'], 2);
    f.floorSlots(1);
  },
  cellblock: (f) => {
    const r = f.room;
    const alongX = r.x1 - r.x0 >= r.z1 - r.z0;
    const len = (alongX ? r.x1 - r.x0 : r.z1 - r.z0) - 1.0;
    const p = f.wall(len, 2.2, alongX ? 0 : 1);
    if (p) {
      f.proc('cellBars', p, len, 2.6, 2.2, Math.max(2, Math.floor(len / 2.6)));
      f.topSlots(p, len - 1, 1.4, 0.02, Math.max(2, Math.floor(len / 2.6)), 1.0);
    }
    clutter(f, ['wooden_crate_01', 'old_tyre', 'cardboard_box_01'], 2);
  },
  cavern: (f) => {
    columns(f);
    for (let i = 0; i < f.rng.int(2, 4); i++) { const p = f.center(1.3, 1.1, 1.0); if (p) { const h = f.rng.pick([0.9, 1.4]); f.proc('crateStack', p, 1.3, h, 1.1, f.rng.int(0, 3)); f.topSlots(p, 1.0, 0.8, h + 0.02, 1); } }
    clutter(f, ['wooden_military_crate', 'Barrel_01', 'old_tyre'], 3);
    f.floorSlots(f.rng.int(3, 5));
  },
  maintenance: (f) => {
    benchRow(f, f.rng.int(1, 2), 'bench', 0.95, 0.85);
    shelfRow(f, f.rng.int(1, 2), 2.0, 4, 0.55);
    if (f.rng.chance(0.5)) { const p = f.center(2.2, 1.4, 1.0); if (p) f.proc('generator', p, 2.2, 1.6, 1.4); }
    clutter(f, ['tool_cart', 'Barrel_01', 'old_tyre'], 2);
  },
  armory: (f) => {
    for (let i = 0; i < 2; i++) { const p = f.wall(2.25, 0.5); if (p) f.proc('lockers', p, 2.25, 1.95, 0.5, 5); }
    shelfRow(f, f.rng.int(1, 2), 2.0, 4, 0.55);
    for (let i = 0; i < 2; i++) { const p = f.center(1.2, 0.6, 0.9); if (p) { f.furniture('wooden_military_crate', p); } }
    f.floorSlots(1);
  },
  // ---------------- luxury
  lobby: (f) => {
    columns(f);
    const p = f.wall(4.0, 1.0); if (p) { f.proc('counter', p, 4.0, 1.1, 1.0, 2); f.topSlots(p, 3.6, 0.6, 1.12, 2); }
    staticCenter(f, 'Sofa_01', 0, 1.1); staticCenter(f, 'Sofa_01', 0, 1.1);
    staticCenter(f, 'CoffeeTable_01', 2, 1.0);
    staticCenter(f, 'gothic_coffee_table', 2, 1.0);
    clutter(f, ['ArmChair_01', 'side_table_01'], 3);
    f.floorSlots(2);
  },
  ballroom: (f) => {
    columns(f);
    for (let i = 0; i < f.rng.int(3, 5); i++) staticCenter(f, 'round_wooden_table_01', 2, 1.1);
    clutter(f, ['dining_chair_02', 'dining_chair_02', 'side_table_01'], f.rng.int(3, 6));
    f.floorSlots(2);
  },
  gallery: (f) => {
    for (let i = 0; i < f.rng.int(3, 6); i++) { const p = f.center(0.6, 0.6, 0.9); if (p) { f.proc('pedestal', p, 0.6, 1.0, 0.6, 0); f.slot(p.x, f.room.y + 1.02, p.z, 0.8); } }
    for (let i = 0; i < f.rng.int(2, 3); i++) { const p = f.wall(0.6, 0.6); if (p) { f.proc('pedestal', p, 0.6, 1.0, 0.6, 0); f.slot(p.x, f.room.y + 1.02, p.z, 0.8); } }
    staticWall(f, 'wooden_display_shelves_01', 2);
    f.floorSlots(f.rng.int(2, 3));
  },
  dining: (f) => {
    const p = staticCenter(f, 'dining_table', 3, 1.0);
    if (p) for (let i = 0; i < 4; i++) { const [ox, oz] = rotQ(-0.7 + (i % 2) * 1.4, i < 2 ? -1.0 : 1.0, p.rotY); f.furniture('dining_chair_02', { x: p.x + ox, z: p.z + oz, rotY: p.rotY + (i < 2 ? 0 : Math.PI) }); }
    staticWall(f, 'ClassicConsole_01', 2);
    staticWall(f, 'GothicCabinet_01');
    clutter(f, ['dining_chair_02', 'side_table_01'], 1);
  },
  library: (f) => {
    for (let i = 0; i < f.rng.int(3, 5); i++) { const p = f.wall(1.37, 0.58); if (p) { f.stat('wooden_bookshelf_worn', p); f.topSlots(p, 1.1, 0.4, 1.02, 1, 0.45); } }
    const p = f.center(2.4, 1.2, 1.1); if (p) { f.proc('bench', p, 2.4, 0.8, 1.2, 8); f.topSlots(p, 2.0, 1.0, 0.82, 2); }
    clutter(f, ['mid_century_lounge_chair', 'ArmChair_01', 'side_table_01'], 2);
  },
  suite: (f) => {
    staticWall(f, 'old_bed_frame');
    staticWall(f, 'GothicCommode_01', 2);
    staticWall(f, 'side_table_01', 1);
    if (f.rng.chance(0.6)) staticWall(f, 'vintage_cabinet_01');
    clutter(f, ['ArmChair_01', 'mid_century_lounge_chair', 'side_table_01'], f.rng.int(1, 2));
  },
  lounge: (f) => {
    const p = f.wall(3.2, 0.8); if (p) { f.proc('bar', p, 3.2, 1.1, 0.8); f.topSlots(p, 2.8, 0.5, 1.12, 2); }
    staticCenter(f, 'Sofa_01', 0, 1.0);
    staticCenter(f, 'CoffeeTable_01', 2, 1.0);
    clutter(f, ['ArmChair_01', 'mid_century_lounge_chair', 'side_table_01'], f.rng.int(2, 3));
  },
  study: (f) => {
    staticWall(f, 'ClassicConsole_01', 2);
    staticWall(f, 'wooden_bookshelf_worn', 1);
    staticWall(f, 'GothicCabinet_01');
    clutter(f, ['ArmChair_01', 'side_table_01'], 1);
  },
  boardroom: (f) => {
    const p = staticCenter(f, 'dining_table', 2, 1.0);
    if (p) for (let i = 0; i < 6; i++) { const [ox, oz] = rotQ(-1.3 + (i % 3) * 1.3, i < 3 ? -1.05 : 1.05, p.rotY); f.furniture('modern_arm_chair_01', { x: p.x + ox, z: p.z + oz, rotY: p.rotY + (i < 3 ? 0 : Math.PI) }); }
    staticWall(f, 'standing_chalkboard_01');
    staticWall(f, 'drawer_cabinet', 1);
  },
  kitchen: (f) => {
    benchRow(f, f.rng.int(2, 3), 'counter', 0.92, 0.65);
    const p = f.center(2.4, 1.0, 1.1); if (p) { f.proc('counter', p, 2.4, 0.92, 1.0, 1); f.topSlots(p, 2.0, 0.8, 0.94, 2); }
    clutter(f, ['metal_trash_can', 'metal_stool_01', 'cardboard_box_01'], 2);
  },
  lift: () => { /* handled by setupExtraction + furnishLift */ },
  corridor: (f) => {
    const t = f.gen.theme;
    if (t.pipes) f.proc('pipeRun', { x: (f.room.x0 + f.room.x1) / 2, z: (f.room.z0 + f.room.z1) / 2, rotY: f.room.x1 - f.room.x0 > f.room.z1 - f.room.z0 ? 0 : HALF_PI }, Math.max(f.room.x1 - f.room.x0, f.room.z1 - f.room.z0), f.room.height - 0.35, 0.8, f.rng.int(2, 4), false);
    if (f.rng.chance(0.4)) clutter(f, t.id === 'luxury' ? ['side_table_01', 'ArmChair_01'] : ['Barrel_01', 'cardboard_box_01', 'WetFloorSign_01', 'korean_fire_extinguisher_01', 'wooden_crate_01', 'metal_trash_can'], f.rng.int(1, 2));
    if (f.rng.chance(0.3)) f.floorSlots(1);
  },
  junction: (f) => {
    if (f.rng.chance(0.3)) clutter(f, ['Barrel_01', 'cardboard_box_01', 'korean_fire_extinguisher_01'], 1);
  },
};

// ---------------------------------------------------------------------------- level pass
function furnishLift(gen: LevelGenerator, f: RoomFurnisher) {
  const L = gen.level;
  const e = L.extraction;
  const r = f.room;
  // lift car structure (visual + side walls)
  f.L.procs.push({ kind: 'liftCar', room: r.id, x: (e.aboard.x0 + e.aboard.x1) / 2, y: r.y, z: (e.aboard.z0 + e.aboard.z1) / 2, rotY: 0, w: e.aboard.x1 - e.aboard.x0, h: 3.6, d: e.aboard.z1 - e.aboard.z0, p: 0, seed: 1, solid: true });
  f.mark(e.aboard.x0 - 0.3, e.aboard.z0 - 0.4, e.aboard.x1 + 0.3, r.z1, 1);
  // some starting clutter in the loading area
  clutter(f, ['wooden_crate_01', 'Barrel_01', 'hand_truck', 'cardboard_box_01'], 2);
}

const PROC_SLOT_KINDS = new Set(['bench', 'counter', 'shelf', 'pedestal', 'crateStack', 'pallet', 'conveyor', 'bunk', 'desk', 'bar', 'gurney', 'bookcase', 'cellBars', 'press']);
void PROC_SLOT_KINDS;

export function furnishLevel(gen: LevelGenerator) {
  const L = gen.level;
  const rng = gen.rng.fork('furnish');
  const allSlots: ValuableSlot[] = [];
  const furnishers: RoomFurnisher[] = [];
  for (const room of L.rooms) {
    if (room.stair) continue;
    const f = new RoomFurnisher(gen, L, room, rng.fork('room' + room.id));
    furnishers.push(f);
    if (room.type === 'lift') furnishLift(gen, f);
    else (RECIPES[room.type] ?? RECIPES.storage)!(f);
    f.repair();
    allSlots.push(...f.slots);
  }

  // ---- breakers (one per sector)
  for (const s of L.sectors) {
    const rooms = furnishers.filter((f) => f.room.sector === s.id && !f.room.hidden && !f.room.locked && f.room.type !== 'lift');
    const pref = rooms.filter((f) => f.room.type === 'electrical');
    const pick = (pref.length ? pref : rooms.filter((f) => f.room.corridor).concat(rooms))[0];
    if (!pick) continue;
    const p = pick.wallPoint(1.35);
    if (p) { const it = pick.interact('breaker', p.x, p.y, p.z, p.rotY, s.id); s.breaker = it.id; }
  }

  // ---- light switches near the first door of rooms with lights
  for (const f of furnishers) {
    const r = f.room;
    if (r.corridor || r.type === 'lift' || !r.lights.length || r.hidden) continue;
    if (!rng.chance(0.75)) continue;
    const p = f.wallPoint(1.3);
    if (p) f.interact('lightSwitch', p.x, p.y, p.z, p.rotY, r.id);
  }

  // ---- cargo tubes: 2-3 in deep rooms, spread apart
  const tubeRooms = furnishers.filter((f) => f.room.depth >= 3 && !f.room.locked && !f.room.hidden && !f.room.corridor && f.room.type !== 'stairs').sort((a, b) => b.room.depth - a.room.depth + rng.range(-2, 2));
  const tubes: RoomFurnisher[] = [];
  const nTubes = rng.int(2, 3);
  for (const f of tubeRooms) {
    if (tubes.length >= nTubes) break;
    const c = [(f.room.x0 + f.room.x1) / 2, (f.room.z0 + f.room.z1) / 2];
    if (tubes.some((t) => Math.hypot((t.room.x0 + t.room.x1) / 2 - c[0], (t.room.z0 + t.room.z1) / 2 - c[1]) < 18 && t.room.floor === f.room.floor)) continue;
    const p = f.wall(1.2, 0.9);
    if (!p) continue;
    f.proc('cargoTube', p, 1.2, 2.4, 0.9);
    const [ox, oz] = rotQ(0.75, 0.2, p.rotY);
    f.interact('tube', p.x + ox, f.room.y + 1.2, p.z + oz, p.rotY, L.procs.length - 1);
    tubes.push(f);
  }

  // ---- keycards: in reachable rooms, away from their vault
  const reachable = gen.reachableUnlocked();
  for (const k of L.keycards) {
    const door = L.doors[k.door];
    const cands = furnishers.filter((f) => reachable.has(f.room.id) && f.room.depth >= 2 && !f.room.corridor && f.room.type !== 'lift' && !door.rooms.includes(f.room.id) && f.slots.some((s) => !s.floor));
    if (!cands.length) continue;
    const f = rng.pick(cands);
    const s = rng.pick(f.slots.filter((x) => !x.floor));
    f.slots.splice(f.slots.indexOf(s), 1);
    allSlots.splice(allSlots.indexOf(s), 1);
    const it = f.interact('keycard', s.x, s.y + 0.02, s.z, rng.range(0, 6.28), k.door, String(k.id));
    k.interactable = it.id;
  }

  // ---- hidden room trigger in the parent room
  for (const d of L.doors) {
    if (d.kind !== 'hidden') continue;
    const parent = furnishers.find((f) => f.room.id === d.rooms[0]);
    if (!parent) continue;
    const p = parent.wallPoint(1.1);
    if (p) parent.interact('hiddenTrigger', p.x, p.y, p.z, p.rotY, d.id);
  }

  // ---- documents and supply caches
  const docs = DOCUMENTS.filter((d) => d.map === L.map || d.map === 'any').map((d) => d.id);
  rng.shuffle(docs);
  const docRooms = furnishers.filter((f) => !f.room.corridor && f.room.type !== 'lift' && f.slots.some((s) => !s.floor));
  rng.shuffle(docRooms);
  for (let i = 0; i < Math.min(docs.length, 3 + (rng.chance(0.5) ? 1 : 0), docRooms.length); i++) {
    const f = docRooms[i];
    const s = rng.pick(f.slots.filter((x) => !x.floor));
    if (!s) continue;
    f.slots.splice(f.slots.indexOf(s), 1);
    const ai = allSlots.indexOf(s); if (ai >= 0) allSlots.splice(ai, 1);
    f.interact('document', s.x, s.y + 0.01, s.z, rng.range(0, 6.28), -1, docs[i]);
  }
  const supplyPool = ['medkit', 'battery', 'battery', 'flare', 'flare', 'glowstick', 'glowstick', 'decoy'];
  for (const f of furnishers) {
    if (f.room.corridor && !rng.chance(0.08)) continue;
    if (f.room.type === 'lift' || !rng.chance(f.room.hidden ? 1 : 0.22)) continue;
    const p = f.wall(0.7, 0.5);
    if (!p) continue;
    f.interact('supply', p.x, f.room.y + 0.3, p.z, p.rotY, -1, rng.pick(supplyPool));
  }

  // ---- hazards from the theme in suitable rooms
  const th = gen.theme;
  const hazardBudget = Math.round(rng.int(2, 4) * gen.difficultyDef.hazardDensity);
  let hz = L.hazards.length;
  for (const f of rng.shuffle([...furnishers])) {
    if (hz >= hazardBudget + 3) break;
    const r = f.room;
    if (r.type === 'lift' || r.depth < 2 || r.hidden) continue;
    const kind = rng.pick(th.hazards) as HazardKind;
    const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
    if (kind === 'gas' && (r.type === 'lab' || r.type === 'specimen' || r.type === 'storage') && rng.chance(0.5)) { f.hazard('gas', cx, r.y + 1.0, cz, Math.min(2.5, (r.x1 - r.x0) / 2 - 1), 1.1, Math.min(2.5, (r.z1 - r.z0) / 2 - 1), 30, 0.55, 7); const vp = f.wallPoint(1.2); if (vp) f.interact('valveWheel', vp.x, vp.y, vp.z, vp.rotY, L.hazards.length - 1); hz++; }
    else if (kind === 'steam' && r.corridor && rng.chance(0.35)) { f.hazard('steam', cx, r.y + r.height - 1.2, cz, 0.9, 1.2, 0.9, rng.range(6, 10), 0.3, 12); hz++; }
    else if (kind === 'sparks' && (r.type === 'electrical' || r.type === 'server' || r.corridor) && rng.chance(0.35)) { const p = f.wallPoint(1.6); if (p) { f.hazard('sparks', p.x, p.y - 0.6, p.z, 0.7, 1.0, 0.7, rng.range(3, 6), 0.25, 9); hz++; } }
    else if (kind === 'laser' && r.corridor && r.depth >= 3 && rng.chance(0.3)) {
      const alongX = r.x1 - r.x0 > r.z1 - r.z0;
      f.hazard('laser', cx, r.y + 0.9, cz, alongX ? 0.06 : (r.x1 - r.x0) / 2 - WALL, 0.8, alongX ? (r.z1 - r.z0) / 2 - WALL : 0.06, rng.range(5, 9), 0.6, 0);
      L.hazards[L.hazards.length - 1].rotY = alongX ? HALF_PI : 0;
      hz++;
    } else if (kind === 'water' && (r.corridor || r.type === 'maintenance') && rng.chance(0.25)) { f.hazard('water', cx, r.y + 0.1, cz, Math.min(1.6, (r.x1 - r.x0) / 2 - 0.4), 0.3, Math.min(1.6, (r.z1 - r.z0) / 2 - 0.4), rng.range(8, 12), 0.35, 20); hz++; }
  }

  // ---- enemy spawn points
  for (const f of furnishers) {
    const r = f.room;
    if (r.type === 'lift' || r.depth < 2 || r.hidden) continue;
    const pts = r.corridor ? 1 : 2;
    for (let i = 0; i < pts; i++) {
      for (let t = 0; t < 12; t++) {
        const x = rng.range(r.x0 + 0.8, r.x1 - 0.8), z = rng.range(r.z0 + 0.8, r.z1 - 0.8);
        if (!f.isFree(x - 0.6, z - 0.6, x + 0.6, z + 0.6)) continue;
        L.enemySpawns.push({ x, y: r.y + 0.05, z, room: r.id, floor: r.floor, dark: r.dark, ceiling: r.y + r.height });
        break;
      }
    }
  }

  // ---- valuables
  distributeValuables(gen, rng, allSlots);
}

function distributeValuables(gen: LevelGenerator, rng: Rng, slots: ValuableSlot[]) {
  const L = gen.level;
  const theme = L.map === 'practice' ? 'industrial' : L.map;
  const pool = valuablesForTheme(theme);
  const d = gen.difficultyDef;
  const target = L.quota * 1.85 * d.valuableMult;
  // room budgets
  const roomWeight = new Map<number, number>();
  let totalW = 0;
  for (const r of L.rooms) {
    if (r.stair || r.type === 'lift') continue;
    const area = (r.x1 - r.x0) * (r.z1 - r.z0);
    const w = r.loot * Math.sqrt(area) * (r.corridor ? 0.25 : 1) * (1 + Math.min(6, r.depth) * 0.07);
    roomWeight.set(r.id, w);
    totalW += w;
  }
  const bySlotRoom = new Map<number, ValuableSlot[]>();
  for (const s of slots) { const a = bySlotRoom.get(s.room) ?? []; a.push(s); bySlotRoom.set(s.room, a); }
  const sizeOf = (v: ValuableDef) => { const s = modelSize(v.model); return { foot: Math.max(s[0], s[2]), h: s[1] }; };
  const roomPrefs: Partial<Record<string, string[]>> = {
    lab: ['scientific', 'electronics'], specimen: ['scientific'], office: ['electronics', 'scientific'], medical: ['container', 'scientific'], server: ['electronics'],
    security: ['electronics'], storage: ['container', 'tools', 'industrial'], electrical: ['electronics', 'industrial'], archive: ['antique', 'scientific'],
    factory: ['industrial', 'tools'], warehouse: ['industrial', 'container', 'tools'], workshop: ['tools', 'industrial'], loading: ['container', 'industrial'],
    boiler: ['industrial'], control: ['electronics'], locker: ['tools', 'container'], bunker: ['antique', 'electronics'], pumproom: ['industrial'],
    cellblock: ['antique', 'artifact'], cavern: ['artifact', 'container', 'antique'], maintenance: ['tools', 'industrial'], armory: ['container', 'antique'],
    lobby: ['decorative', 'antique'], ballroom: ['decorative', 'antique'], gallery: ['artifact', 'decorative', 'antique'], dining: ['decorative'], library: ['antique', 'artifact'],
    suite: ['antique', 'decorative', 'electronics'], lounge: ['decorative', 'antique'], study: ['antique', 'artifact'], boardroom: ['electronics', 'decorative'], kitchen: ['decorative'],
  };
  let placed = 0;
  let cursedPlaced = false;
  const roomIds = [...roomWeight.keys()];
  for (const rid of roomIds) {
    const room = L.rooms[rid];
    const budget = (target * (roomWeight.get(rid) ?? 0)) / Math.max(1e-6, totalW);
    let spent = 0;
    const rs = rng.shuffle([...(bySlotRoom.get(rid) ?? [])]);
    const prefs = roomPrefs[room.type] ?? [];
    for (const s of rs) {
      if (spent >= budget) break;
      const fits = pool.filter((v) => {
        const z = sizeOf(v);
        if (v.cursed && (cursedPlaced || L.difficulty < 1)) return false;
        if (s.floor) return z.foot <= s.maxSize * 1.4;
        return z.foot <= s.maxSize * 1.15 && v.mass < 30 && z.h < 1.1;
      });
      if (!fits.length) continue;
      const v = rng.weighted(fits, (x) => RARITY_WEIGHT[x.rarity] * (prefs.includes(x.category) ? 2.4 : 1) * (room.locked || room.hidden ? (x.rarity === 'common' ? 0.3 : 2) : 1) * (s.floor && sizeOf(x).foot > 0.6 ? 1.6 : 1));
      if (v.cursed) cursedPlaced = true;
      const value = Math.round(rng.range(v.value[0], v.value[1]) / 10) * 10;
      const size = modelSize(v.model);
      L.props.push({ id: L.props.length, kind: 'valuable', def: v.id, room: rid, x: s.x, y: s.y + size[1] / 2 + 0.03, z: s.z, rotY: rng.range(0, Math.PI * 2), value, mass: v.mass });
      spent += value;
      placed++;
    }
  }
  // renumber prop ids (furniture + valuables share the id space)
  L.props.forEach((p, i) => (p.id = i));
  void placed;
  void MISSION;
}
