// Grid navigation for monsters: per-floor 0.5 m occupancy grid with a clearance map,
// door tagging and stairwell links between floors. A* (octile heuristic, binary heap,
// node budget) + line-of-sight string pulling.

import { WORLD } from '../constants';
import { colliderBounds, type ColliderSpec, TAG } from '../physics/colliders';
import { floorY, type LevelData, type Vec3 } from '../levelgen/types';
import type { Rng } from '../rng';

const CELL = WORLD.NAV_CELL;

export interface FloorGrid {
  floor: number;
  y: number;
  x0: number; z0: number;
  nx: number; nz: number;
  walk: Uint8Array;      // 1 walkable
  clear: Uint8Array;     // clearance in half-cells (chamfer distance / 2 … capped)
  room: Int16Array;
  door: Int16Array;
}

export interface Link { floorA: number; cellA: number; floorB: number; cellB: number; points: Vec3[]; cost: number; room: number }

export interface PathOptions {
  clearance?: number;              // required clearance in cells (0..)
  /** cost multiplier for passing a door cell; Infinity blocks */
  doorCost?: (doorId: number) => number;
  maxNodes?: number;
  /** allow following stair links */
  stairs?: boolean;
}

class MinHeap {
  ids: Int32Array;
  keys: Float32Array;
  size = 0;
  constructor(cap: number) { this.ids = new Int32Array(cap); this.keys = new Float32Array(cap); }
  clear() { this.size = 0; }
  push(id: number, key: number) {
    if (this.size >= this.ids.length) { const ni = new Int32Array(this.ids.length * 2); ni.set(this.ids); this.ids = ni; const nk = new Float32Array(this.keys.length * 2); nk.set(this.keys); this.keys = nk; }
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= key) break;
      this.ids[i] = this.ids[p]; this.keys[i] = this.keys[p]; i = p;
    }
    this.ids[i] = id; this.keys[i] = key;
  }
  pop(): number {
    const top = this.ids[0];
    const lastId = this.ids[--this.size], lastKey = this.keys[this.size];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && this.keys[c + 1] < this.keys[c]) c++;
      if (this.keys[c] >= lastKey) break;
      this.ids[i] = this.ids[c]; this.keys[i] = this.keys[c]; i = c;
    }
    this.ids[i] = lastId; this.keys[i] = lastKey;
    return top;
  }
}

export class NavGrid {
  readonly floors: FloorGrid[] = [];
  readonly links: Link[] = [];
  private floorIndex = new Map<number, number>();
  private offsets: number[] = [];
  private total = 0;
  // search scratch
  private g!: Float32Array;
  private parent!: Int32Array;
  private stamp!: Uint32Array;
  private closed!: Uint32Array;
  private curStamp = 1;
  private heap = new MinHeap(4096);
  private linkFrom = new Map<number, number[]>();

  static build(L: LevelData, colliders: ColliderSpec[]): NavGrid {
    const nav = new NavGrid();
    const b = L.bounds;
    const x0 = Math.floor(b.x0) - 1, z0 = Math.floor(b.z0) - 1;
    const nx = Math.ceil((b.x1 - x0 + 1) / CELL), nz = Math.ceil((b.z1 - z0 + 1) / CELL);
    for (const f of L.floors) {
      const n = nx * nz;
      const grid: FloorGrid = { floor: f, y: floorY(f), x0, z0, nx, nz, walk: new Uint8Array(n), clear: new Uint8Array(n), room: new Int16Array(n).fill(-1), door: new Int16Array(n).fill(-1) };
      nav.floorIndex.set(f, nav.floors.length);
      nav.floors.push(grid);
      // rooms
      for (const r of L.rooms) {
        if (r.floor !== f || r.stair) continue;
        const [i0, j0, i1, j1] = nav.rangeOf(grid, r.x0, r.z0, r.x1, r.z1, 0.0);
        for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { grid.walk[i * nz + j] = 1; grid.room[i * nz + j] = r.id; }
      }
      // colliders that block a standing agent on this floor
      const yLo = grid.y + 0.25, yHi = grid.y + 1.9;
      for (const c of colliders) {
        if (c.tag === TAG.FLOOR || c.tag === TAG.CEIL) continue;
        const cb = colliderBounds(c);
        if (cb.y1 < yLo || cb.y0 > yHi) continue;
        const [i0, j0, i1, j1] = nav.rangeOf(grid, cb.x0, cb.z0, cb.x1, cb.z1, -0.05);
        for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) grid.walk[i * nz + j] = 0;
      }
      // doors
      for (const d of L.doors) {
        if (d.floor !== f) continue;
        const hw = d.width / 2 - 0.2;
        const [i0, j0, i1, j1] = d.axis === 'x' ? nav.rangeOf(grid, d.x - hw, d.z - 0.45, d.x + hw, d.z + 0.45, 0) : nav.rangeOf(grid, d.x - 0.45, d.z - hw, d.x + 0.45, d.z + hw, 0);
        for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const k = i * nz + j; if (grid.walk[k]) grid.door[k] = d.id; }
      }
      nav.computeClearance(grid);
    }
    nav.offsets = [];
    let acc = 0;
    for (const g of nav.floors) { nav.offsets.push(acc); acc += g.nx * g.nz; }
    nav.total = acc;
    nav.g = new Float32Array(acc);
    nav.parent = new Int32Array(acc);
    nav.stamp = new Uint32Array(acc);
    nav.closed = new Uint32Array(acc);
    // stair links
    for (const l of L.navLinks) {
      const a = nav.nearestCell(l.points[0], 1, 4);
      const bb = nav.nearestCell(l.points[l.points.length - 1], 1, 4);
      if (!a || !bb) continue;
      let len = 0;
      for (let i = 1; i < l.points.length; i++) len += Math.hypot(l.points[i].x - l.points[i - 1].x, l.points[i].y - l.points[i - 1].y, l.points[i].z - l.points[i - 1].z);
      const link: Link = { floorA: a.floor, cellA: a.idx, floorB: bb.floor, cellB: bb.idx, points: l.points, cost: len / CELL, room: l.room };
      const li = nav.links.length;
      nav.links.push(link);
      const ga = nav.globalId(a.floor, a.idx), gb = nav.globalId(bb.floor, bb.idx);
      nav.linkFrom.set(ga, [...(nav.linkFrom.get(ga) ?? []), li]);
      nav.linkFrom.set(gb, [...(nav.linkFrom.get(gb) ?? []), li]);
    }
    return nav;
  }

  private rangeOf(g: FloorGrid, x0: number, z0: number, x1: number, z1: number, shrink: number): [number, number, number, number] {
    // cells whose centre lies within [x0-shrink, x1+shrink] (shrink<0 expands)
    const i0 = Math.max(0, Math.ceil((x0 - g.x0) / CELL - 0.5 + shrink / CELL - 1e-6));
    const j0 = Math.max(0, Math.ceil((z0 - g.z0) / CELL - 0.5 + shrink / CELL - 1e-6));
    const i1 = Math.min(g.nx - 1, Math.floor((x1 - g.x0) / CELL - 0.5 - shrink / CELL + 1e-6));
    const j1 = Math.min(g.nz - 1, Math.floor((z1 - g.z0) / CELL - 0.5 - shrink / CELL + 1e-6));
    return [i0, j0, i1, j1];
  }

  private computeClearance(g: FloorGrid) {
    const { nx, nz } = g;
    const d = new Uint16Array(nx * nz);
    for (let k = 0; k < d.length; k++) d[k] = g.walk[k] ? 60000 : 0;
    // two-pass chamfer (2,3)
    for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
      const k = i * nz + j;
      if (!d[k]) continue;
      let v = d[k];
      if (i > 0) v = Math.min(v, d[k - nz] + 2);
      if (j > 0) v = Math.min(v, d[k - 1] + 2);
      if (i > 0 && j > 0) v = Math.min(v, d[k - nz - 1] + 3);
      if (i > 0 && j < nz - 1) v = Math.min(v, d[k - nz + 1] + 3);
      if (i === 0 || j === 0) v = Math.min(v, 2);
      d[k] = v;
    }
    for (let i = nx - 1; i >= 0; i--) for (let j = nz - 1; j >= 0; j--) {
      const k = i * nz + j;
      if (!d[k]) continue;
      let v = d[k];
      if (i < nx - 1) v = Math.min(v, d[k + nz] + 2);
      if (j < nz - 1) v = Math.min(v, d[k + 1] + 2);
      if (i < nx - 1 && j < nz - 1) v = Math.min(v, d[k + nz + 1] + 3);
      if (i < nx - 1 && j > 0) v = Math.min(v, d[k + nz - 1] + 3);
      if (i === nx - 1 || j === nz - 1) v = Math.min(v, 2);
      d[k] = v;
    }
    for (let k = 0; k < d.length; k++) g.clear[k] = Math.min(255, Math.floor(d[k] / 2));
  }

  grid(floor: number): FloorGrid | undefined { const i = this.floorIndex.get(floor); return i === undefined ? undefined : this.floors[i]; }
  private globalId(floor: number, idx: number) { return this.offsets[this.floorIndex.get(floor)!] + idx; }
  private fromGlobal(id: number): [FloorGrid, number] {
    for (let f = this.floors.length - 1; f >= 0; f--) if (id >= this.offsets[f]) return [this.floors[f], id - this.offsets[f]];
    return [this.floors[0], id];
  }

  floorOf(y: number): number {
    let best = this.floors[0].floor, bd = Infinity;
    for (const g of this.floors) { const d = Math.abs(y - g.y); if (d < bd) { bd = d; best = g.floor; } }
    return best;
  }

  cellCenter(g: FloorGrid, idx: number): Vec3 {
    const i = Math.floor(idx / g.nz), j = idx % g.nz;
    return { x: g.x0 + (i + 0.5) * CELL, y: g.y, z: g.z0 + (j + 0.5) * CELL };
  }

  cellIndex(g: FloorGrid, x: number, z: number): number {
    const i = Math.floor((x - g.x0) / CELL), j = Math.floor((z - g.z0) / CELL);
    if (i < 0 || j < 0 || i >= g.nx || j >= g.nz) return -1;
    return i * g.nz + j;
  }

  isWalkable(p: Vec3, clearance = 0): boolean {
    const g = this.grid(this.floorOf(p.y));
    if (!g) return false;
    const k = this.cellIndex(g, p.x, p.z);
    return k >= 0 && g.walk[k] === 1 && g.clear[k] >= clearance;
  }

  roomAt(p: Vec3): number {
    const g = this.grid(this.floorOf(p.y));
    if (!g) return -1;
    const k = this.cellIndex(g, p.x, p.z);
    return k >= 0 ? g.room[k] : -1;
  }

  nearestCell(p: Vec3, clearance = 1, radius = 6): { floor: number; idx: number } | null {
    const g = this.grid(this.floorOf(p.y));
    if (!g) return null;
    const ci = Math.floor((p.x - g.x0) / CELL), cj = Math.floor((p.z - g.z0) / CELL);
    const rCells = Math.ceil(radius / CELL);
    let best = -1, bd = Infinity;
    for (let r = 0; r <= rCells; r++) {
      for (let i = ci - r; i <= ci + r; i++) for (let j = cj - r; j <= cj + r; j++) {
        if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== r) continue;
        if (i < 0 || j < 0 || i >= g.nx || j >= g.nz) continue;
        const k = i * g.nz + j;
        if (!g.walk[k] || g.clear[k] < clearance) continue;
        const d = (i - ci) ** 2 + (j - cj) ** 2;
        if (d < bd) { bd = d; best = k; }
      }
      if (best >= 0) return { floor: g.floor, idx: best };
    }
    return null;
  }

  /** grid line-of-sight on one floor with clearance */
  lineClear(g: FloorGrid, ax: number, az: number, bx: number, bz: number, clearance: number, doorCost?: (d: number) => number): boolean {
    const dx = bx - ax, dz = bz - az;
    const dist = Math.hypot(dx, dz);
    const steps = Math.max(1, Math.ceil(dist / (CELL * 0.5)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const k = this.cellIndex(g, ax + dx * t, az + dz * t);
      if (k < 0 || !g.walk[k] || g.clear[k] < clearance) return false;
      if (doorCost && g.door[k] >= 0 && !Number.isFinite(doorCost(g.door[k]))) return false;
    }
    return true;
  }

  findPath(from: Vec3, to: Vec3, opts: PathOptions = {}): Vec3[] | null {
    const clearance = opts.clearance ?? 1;
    const maxNodes = opts.maxNodes ?? 12000;
    const s = this.nearestCell(from, clearance, 3);
    const t = this.nearestCell(to, clearance, 4);
    if (!s || !t) return null;
    const start = this.globalId(s.floor, s.idx), goal = this.globalId(t.floor, t.idx);
    const [gGoal, goalIdx] = this.fromGlobal(goal);
    const goalPos = this.cellCenter(gGoal, goalIdx);
    if (++this.curStamp >= 0xffffffff) { this.stamp.fill(0); this.closed.fill(0); this.curStamp = 1; }
    const stampV = this.curStamp;
    const heur = (id: number) => {
      const [g, idx] = this.fromGlobal(id);
      const p = this.cellCenter(g, idx);
      const dx = Math.abs(p.x - goalPos.x) / CELL, dz = Math.abs(p.z - goalPos.z) / CELL;
      return Math.max(dx, dz) + 0.4142 * Math.min(dx, dz) + Math.abs(p.y - goalPos.y) / CELL;
    };
    this.heap.clear();
    this.g[start] = 0; this.parent[start] = -1; this.stamp[start] = stampV;
    this.heap.push(start, heur(start));
    let expanded = 0;
    let found = false;
    const linkUsed = new Map<number, number>(); // node -> link index used to reach it
    while (this.heap.size) {
      const cur = this.heap.pop();
      if (this.closed[cur] === stampV) continue;
      this.closed[cur] = stampV;
      if (cur === goal) { found = true; break; }
      if (++expanded > maxNodes) break;
      const [g, idx] = this.fromGlobal(cur);
      const base = this.offsets[this.floorIndex.get(g.floor)!];
      const i = Math.floor(idx / g.nz), j = idx % g.nz;
      const gc = this.g[cur];
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
        if (!di && !dj) continue;
        const ni = i + di, nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= g.nx || nj >= g.nz) continue;
        const nk = ni * g.nz + nj;
        if (!g.walk[nk] || g.clear[nk] < clearance) continue;
        if (di && dj) { // no corner cutting
          if (!g.walk[i * g.nz + nj] || !g.walk[ni * g.nz + j]) continue;
        }
        let cost = di && dj ? 1.4142 : 1;
        if (g.door[nk] >= 0 && opts.doorCost) {
          const dc = opts.doorCost(g.door[nk]);
          if (!Number.isFinite(dc)) continue;
          cost *= dc;
        }
        // prefer cells with more clearance (keeps agents off walls)
        if (g.clear[nk] < clearance + 2) cost *= 1.25;
        const nid = base + nk;
        const ng = gc + cost;
        if (this.stamp[nid] === stampV && ng >= this.g[nid]) continue;
        this.stamp[nid] = stampV; this.g[nid] = ng; this.parent[nid] = cur;
        this.heap.push(nid, ng + heur(nid));
      }
      if (opts.stairs !== false) {
        const ls = this.linkFrom.get(cur);
        if (ls) for (const li of ls) {
          const l = this.links[li];
          const other = this.globalId(l.floorA, l.cellA) === cur ? this.globalId(l.floorB, l.cellB) : this.globalId(l.floorA, l.cellA);
          const ng = gc + l.cost;
          if (this.stamp[other] === stampV && ng >= this.g[other]) continue;
          this.stamp[other] = stampV; this.g[other] = ng; this.parent[other] = cur;
          linkUsed.set(other, li);
          this.heap.push(other, ng + heur(other));
        }
      }
    }
    if (!found) return null;
    // reconstruct
    const nodes: number[] = [];
    for (let c = goal; c !== -1; c = this.parent[c]) { nodes.push(c); if (nodes.length > 100000) return null; }
    nodes.reverse();
    const out: Vec3[] = [];
    let seg: Vec3[] = [];
    let segFloor: FloorGrid | null = null;
    const flush = () => { if (seg.length && segFloor) out.push(...this.smooth(segFloor, seg, clearance, opts.doorCost)); seg = []; };
    for (let n = 0; n < nodes.length; n++) {
      const id = nodes[n];
      const li = linkUsed.get(id);
      const prev = n > 0 ? nodes[n - 1] : -1;
      if (li !== undefined && prev >= 0 && this.parent[id] === prev) {
        const l = this.links[li];
        const [gp] = this.fromGlobal(prev);
        flush();
        const forward = gp.floor === l.floorA;
        const pts = forward ? l.points : [...l.points].reverse();
        out.push(...pts.map((p) => ({ ...p })));
        const [gn, idxn] = this.fromGlobal(id);
        segFloor = gn;
        seg.push(this.cellCenter(gn, idxn));
        continue;
      }
      const [g, idx] = this.fromGlobal(id);
      if (segFloor && g !== segFloor) flush();
      segFloor = g;
      seg.push(this.cellCenter(g, idx));
    }
    flush();
    if (out.length) out[out.length - 1] = { x: to.x, y: out[out.length - 1].y, z: to.z };
    return out;
  }

  private smooth(g: FloorGrid, pts: Vec3[], clearance: number, doorCost?: (d: number) => number): Vec3[] {
    if (pts.length <= 2) return pts;
    const out: Vec3[] = [pts[0]];
    let anchor = 0;
    while (anchor < pts.length - 1) {
      let far = anchor + 1;
      for (let k = pts.length - 1; k > anchor + 1; k--) {
        if (this.lineClear(g, pts[anchor].x, pts[anchor].z, pts[k].x, pts[k].z, clearance, doorCost)) { far = k; break; }
      }
      out.push(pts[far]);
      anchor = far;
    }
    return out;
  }

  randomPointInRoom(roomId: number, rng: Rng, clearance = 1): Vec3 | null {
    for (const g of this.floors) {
      const cells: number[] = [];
      for (let k = 0; k < g.room.length; k++) if (g.room[k] === roomId && g.walk[k] && g.clear[k] >= clearance) cells.push(k);
      if (cells.length) return this.cellCenter(g, rng.pick(cells));
    }
    return null;
  }

  /** count walkable cells (for tests / debug) */
  stats() { let walk = 0; for (const g of this.floors) for (let k = 0; k < g.walk.length; k++) walk += g.walk[k]; return { cells: this.total, walk, links: this.links.length }; }
}
