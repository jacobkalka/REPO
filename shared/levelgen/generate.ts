// Deterministic facility generator. Given {map, seed, difficulty, crew, streak} it produces
// identical LevelData on every machine. Only +,-,*,/,sqrt and integer RNG are used in
// decision paths so results do not depend on the JS engine's transcendental functions.

import { Rng } from '../rng';
import { WORLD } from '../constants';
import { getTheme, type MapId, type MapTheme, type RoomTypeDef, type RoomTypeId } from '../catalog/maps';
import { baseQuota, DIFFICULTIES } from '../catalog/difficulty';
import { DIRS, floorY, type Axis, type Dir, type DoorData, type DoorKind, type DoorStyle, type LevelData, type LightData, type RoomData, type WallData } from './types';
import { furnishLevel } from './furnish';
import { stairNavLink } from './stairs';

const T = WORLD.TILE;
const SPACING = WORLD.FLOOR_SPACING;
const BOUND = 13; // tiles from origin in each direction
export const LEVEL_VERSION = 3;

export interface GenParams { map: MapId; seed: string; difficulty: number; crew: number; streak?: number }

interface Socket { floor: number; tx: number; tz: number; dir: Dir; from: number; age: number }
interface Rect { tx: number; tz: number; tw: number; td: number }

class TileGrid {
  private floors = new Map<number, Map<number, number>>();
  private key(x: number, z: number) { return (x + 512) * 1024 + (z + 512); }
  get(f: number, x: number, z: number): number {
    const m = this.floors.get(f);
    if (!m) return -1;
    const v = m.get(this.key(x, z));
    return v === undefined ? -1 : v;
  }
  set(f: number, x: number, z: number, id: number) {
    let m = this.floors.get(f);
    if (!m) { m = new Map(); this.floors.set(f, m); }
    m.set(this.key(x, z), id);
  }
  /** remap / clear room ids after compaction (-1 removes) */
  remap(map: Map<number, number>) {
    for (const m of this.floors.values()) for (const [k, v] of [...m.entries()]) {
      const nv = map.get(v);
      if (nv === undefined || nv < 0) m.delete(k); else m.set(k, nv);
    }
  }
}

export class LevelGenerator {
  readonly rng: Rng;
  readonly theme: MapTheme;
  readonly grid = new TileGrid();
  readonly level: LevelData;
  private typeCounts = new Map<RoomTypeId, number>();
  private floorsList: number[];

  constructor(readonly params: GenParams) {
    this.rng = new Rng(`level:${params.map}:${params.seed}:${params.difficulty}`);
    this.theme = getTheme(params.map);
    const floors: number[] = [];
    for (let i = 0; i < this.theme.floors; i++) floors.push(this.theme.floorOffset + i);
    this.floorsList = floors;
    const quota = baseQuota(params.difficulty, params.crew, params.streak ?? 0);
    this.level = {
      version: LEVEL_VERSION, seed: params.seed, map: params.map, difficulty: params.difficulty, crew: params.crew, quota,
      floors, rooms: [], doors: [], walls: [], lights: [], interactables: [], hazards: [], procs: [], statics: [], props: [],
      playerSpawns: [], enemySpawns: [], navLinks: [], elevators: [], sectors: [], keycards: [],
      extraction: null as unknown as LevelData['extraction'],
      bounds: { x0: 0, z0: 0, x1: 0, z1: 0, y0: 0, y1: 0 }, totalValue: 0,
    };
  }

  // ------------------------------------------------------------------ rooms
  private rectTiles(r: Rect): [number, number][] {
    const out: [number, number][] = [];
    for (let x = r.tx; x < r.tx + r.tw; x++) for (let z = r.tz; z < r.tz + r.td; z++) out.push([x, z]);
    return out;
  }

  private free(floor: number, r: Rect, span: number): boolean {
    if (r.tx < -BOUND || r.tz < -BOUND || r.tx + r.tw > BOUND || r.tz + r.td > BOUND) return false;
    for (let f = floor; f < floor + span; f++) {
      if (!this.floorsList.includes(f)) { if (span > 1 && f !== floor) return false; }
      for (const [x, z] of this.rectTiles(r)) if (this.grid.get(f, x, z) !== -1) return false;
    }
    return true;
  }

  addRoom(floor: number, r: Rect, type: RoomTypeId, def: RoomTypeDef | null, opts: Partial<RoomData> = {}): RoomData {
    const id = this.level.rooms.length;
    const corridor = type === 'corridor' || type === 'junction';
    let height = opts.height ?? (corridor ? 3.2 : def?.height ?? this.rng.pick([3.6, 3.8, 4.0]));
    const tall = height > SPACING - 0.4;
    let span = opts.floorsSpanned ?? 1;
    if (tall && this.floorsList.includes(floor + 1)) span = Math.max(span, 2);
    if (!tall && span === 1) height = Math.min(height, SPACING - 0.6);
    const room: RoomData = {
      id, type, name: def?.name ?? (type === 'corridor' ? 'Corridor' : type === 'junction' ? 'Junction' : type),
      floor, floorsSpanned: span,
      tx: r.tx, tz: r.tz, tw: r.tw, td: r.td,
      x0: r.tx * T, z0: r.tz * T, x1: (r.tx + r.tw) * T, z1: (r.tz + r.td) * T,
      y: floorY(floor), height,
      surfaces: def?.surfaces ?? this.theme.corridorSurfaces,
      sector: 0, corridor, tall, locked: false, hidden: false, dark: false,
      doors: [], lights: [], loot: def?.loot ?? 0.3, depth: 0,
      ...opts,
    };
    room.floorsSpanned = span;
    this.level.rooms.push(room);
    for (let f = floor; f < floor + span; f++) for (const [x, z] of this.rectTiles(r)) this.grid.set(f, x, z, id);
    this.typeCounts.set(type, (this.typeCounts.get(type) ?? 0) + 1);
    return room;
  }

  /** world-space rectangle for a module of local size (w along right, d along forward) attached at socket tile */
  private orientedRect(s: Socket, w: number, d: number, ex: number): Rect {
    const [fx, fz] = DIRS[s.dir];
    const rx = fz, rz = -fx;
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const lx of [0, w - 1]) for (const lz of [0, d - 1]) {
      const x = s.tx + (lx - ex) * rx + lz * fx;
      const z = s.tz + (lx - ex) * rz + lz * fz;
      minX = Math.min(minX, x); minZ = Math.min(minZ, z); maxX = Math.max(maxX, x); maxZ = Math.max(maxZ, z);
    }
    return { tx: minX, tz: minZ, tw: maxX - minX + 1, td: maxZ - minZ + 1 };
  }

  // ------------------------------------------------------------------ doors
  addDoor(roomA: number, roomB: number, floor: number, tileX: number, tileZ: number, dir: Dir, kind: DoorKind, style: DoorStyle, opts: Partial<DoorData> = {}): DoorData {
    const [dx, dz] = DIRS[dir];
    const cx = (tileX + 0.5) * T + dx * T * 0.5;
    const cz = (tileZ + 0.5) * T + dz * T * 0.5;
    const axis: Axis = dz !== 0 ? 'x' : 'z';
    const width = kind === 'double' ? 2.7 : kind === 'arch' ? 2.4 : kind === 'shutter' ? 3.0 : WORLD.DOOR_WIDTH;
    const height = kind === 'double' || kind === 'shutter' ? 2.9 : kind === 'arch' ? 2.7 : WORLD.DOOR_HEIGHT;
    const door: DoorData = {
      id: this.level.doors.length, rooms: [roomA, roomB], floor, x: cx, y: floorY(floor), z: cz, axis,
      width, height, kind, style, lockedBy: -1, startOpen: kind === 'arch', hinge: this.rng.chance(0.5) ? 1 : -1,
      leaf: kind !== 'arch', ...opts,
    };
    this.level.doors.push(door);
    this.level.rooms[roomA]?.doors.push(door.id);
    if (roomB >= 0) this.level.rooms[roomB]?.doors.push(door.id);
    return door;
  }

  private doorBetween(a: number, b: number): boolean {
    return this.level.doors.some((d) => (d.rooms[0] === a && d.rooms[1] === b) || (d.rooms[0] === b && d.rooms[1] === a));
  }

  private pickDoorKind(a: RoomData, b: RoomData): { kind: DoorKind; style: DoorStyle } {
    const style: DoorStyle = this.theme.doorStyle === 'ornate' ? (a.corridor && b.corridor ? 'panel' : 'ornate') : this.theme.doorStyle === 'wood' ? 'wood' : this.rng.chance(0.3) ? 'panel' : 'metal';
    if (a.corridor && b.corridor) return { kind: 'arch', style };
    if (a.tall || b.tall) return { kind: this.rng.chance(0.5) ? 'double' : 'arch', style };
    if (this.theme.id === 'industrial' && (a.type === 'loading' || b.type === 'loading' || a.type === 'warehouse' || b.type === 'warehouse')) return { kind: 'shutter', style: 'metal' };
    const r = this.rng.next();
    if (r < 0.72) return { kind: 'hinged', style };
    if (r < 0.85) return { kind: 'double', style };
    return { kind: 'arch', style };
  }

  // ------------------------------------------------------------------ sockets
  private socketsFor(room: RoomData, entranceDir: Dir | -1, floor: number, age: number, corridorDir?: Dir): Socket[] {
    const out: Socket[] = [];
    const add = (tx: number, tz: number, dir: Dir) => { if (this.grid.get(floor, tx, tz) === -1) out.push({ floor, tx, tz, dir, from: room.id, age }); };
    const sides: Dir[] = [0, 1, 2, 3];
    for (const dir of sides) {
      if (dir === ((entranceDir + 2) % 4) && entranceDir !== -1) continue; // entrance side
      const [dx, dz] = DIRS[dir];
      const edgeTiles: [number, number][] = [];
      if (dz !== 0) { const z = dz > 0 ? room.tz + room.td : room.tz - 1; for (let x = room.tx; x < room.tx + room.tw; x++) edgeTiles.push([x, z]); }
      else { const x = dx > 0 ? room.tx + room.tw : room.tx - 1; for (let z = room.tz; z < room.tz + room.td; z++) edgeTiles.push([x, z]); }
      if (room.corridor && corridorDir !== undefined) {
        if (dir === corridorDir) { const t = edgeTiles[Math.floor(edgeTiles.length / 2)]; add(t[0], t[1], dir); continue; }
        for (const t of edgeTiles) if (this.rng.chance(0.32)) add(t[0], t[1], dir);
        continue;
      }
      if (room.corridor) { for (const t of edgeTiles) if (this.rng.chance(0.55)) add(t[0], t[1], dir); continue; }
      const n = edgeTiles.length >= 3 && this.rng.chance(0.35) ? 2 : 1;
      this.rng.shuffle(edgeTiles);
      for (let i = 0; i < n && i < edgeTiles.length; i++) if (this.rng.chance(0.78)) add(edgeTiles[i][0], edgeTiles[i][1], dir);
    }
    return out;
  }

  private chooseRoomType(maxTilesAvail = 30): RoomTypeDef | null {
    const options = this.theme.roomTypes.filter((t) => t.weight > 0 && (t.max === undefined || (this.typeCounts.get(t.id) ?? 0) < t.max) && t.minTiles <= maxTilesAvail);
    if (!options.length) return null;
    return this.rng.weighted(options, (t) => t.weight / (1 + 0.6 * (this.typeCounts.get(t.id) ?? 0)));
  }

  private sizesFor(def: RoomTypeDef): [number, number][] {
    const out: [number, number][] = [];
    for (let w = 1; w <= 6; w++) for (let d = 1; d <= 6; d++) {
      const n = w * d;
      if (n < def.minTiles || n > def.maxTiles) continue;
      if (Math.max(w, d) > 2.5 * Math.min(w, d) + 0.01) continue;
      if (Math.min(w, d) < 2 && n > 2) continue;
      out.push([w, d]);
    }
    return this.rng.shuffle(out);
  }

  private tryAttach(s: Socket, kind: 'room' | 'corridor' | 'junction'): RoomData | null {
    const from = this.level.rooms[s.from];
    const backDir = ((s.dir + 2) % 4) as Dir;
    const fromTileX = s.tx - DIRS[s.dir][0];
    const fromTileZ = s.tz - DIRS[s.dir][1];
    if (kind === 'corridor' || kind === 'junction') {
      const lengths = kind === 'junction' ? [1] : this.rng.shuffle([2, 3, 3, 4, 5]);
      for (const len of lengths) {
        const r = this.orientedRect(s, 1, len, 0);
        if (!this.free(s.floor, r, 1)) continue;
        const type = kind === 'junction' ? 'junction' : 'corridor';
        const room = this.addRoom(s.floor, r, type, null, { surfaces: this.theme.corridorSurfaces });
        const dk = this.pickDoorKind(from, room);
        this.addDoor(from.id, room.id, s.floor, fromTileX, fromTileZ, s.dir, dk.kind, dk.style);
        room.depth = from.depth + 1;
        this.pendingSockets.push(...this.socketsFor(room, s.dir, s.floor, s.age + 1, kind === 'corridor' ? s.dir : undefined));
        return room;
      }
      return null;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const def = this.chooseRoomType();
      if (!def) return null;
      for (const [w, d] of this.sizesFor(def)) {
        const exs = this.rng.shuffle(Array.from({ length: w }, (_, i) => i));
        for (const ex of exs) {
          const r = this.orientedRect(s, w, d, ex);
          const tall = (def.height ?? 0) > SPACING - 0.4;
          const span = tall && this.floorsList.includes(s.floor + 1) ? 2 : 1;
          if (!this.free(s.floor, r, span)) continue;
          const room = this.addRoom(s.floor, r, def.id, def);
          const dk = this.pickDoorKind(from, room);
          this.addDoor(from.id, room.id, s.floor, fromTileX, fromTileZ, s.dir, dk.kind, dk.style);
          room.depth = from.depth + 1;
          this.pendingSockets.push(...this.socketsFor(room, s.dir, s.floor, s.age + 1));
          void backDir;
          return room;
        }
      }
    }
    return null;
  }

  private pendingSockets: Socket[] = [];

  private growFloor(floor: number, seeds: Socket[], target: number) {
    this.pendingSockets = [...seeds];
    let placed = 0;
    let guard = 0;
    while (placed < target && this.pendingSockets.length && guard++ < 4000) {
      // prefer younger sockets (breadth-ish growth) with randomness
      this.pendingSockets.sort((a, b) => a.age - b.age);
      const idx = Math.min(this.pendingSockets.length - 1, Math.floor(this.rng.next() * this.rng.next() * this.pendingSockets.length * 1.5));
      const s = this.pendingSockets.splice(idx, 1)[0];
      if (this.grid.get(floor, s.tx, s.tz) !== -1) continue;
      const from = this.level.rooms[s.from];
      const order: ('room' | 'corridor' | 'junction')[] = from.corridor
        ? this.rng.weighted([['room', 'corridor', 'junction'], ['room', 'junction', 'corridor'], ['corridor', 'room', 'junction']], (o) => (o[0] === 'room' ? 6 : o[0] === 'junction' ? 2 : 3))
        : this.rng.chance(0.78) ? ['corridor', 'room', 'junction'] : ['room', 'corridor', 'junction'];
      for (const k of order) {
        const r = this.tryAttach(s, k);
        if (r) { placed++; break; }
      }
    }
  }

  // ------------------------------------------------------------------ main
  generate(): LevelData {
    const L = this.level;
    const t = this.theme;
    const target = this.rng.int(t.targetRooms[0], t.targetRooms[1]);

    // 1. Lift bay (spawn + extraction), 3x2 tiles, open side to the south
    const lift = this.addRoom(0, { tx: -1, tz: 0, tw: 3, td: 2 }, 'lift', null, { name: 'Freight Lift Bay', height: 4.6, surfaces: this.liftSurfaces(), loot: 0 });
    const seeds: Socket[] = [{ floor: 0, tx: 0, tz: -1, dir: 2, from: lift.id, age: 0 }];
    if (this.rng.chance(0.6)) seeds.push({ floor: 0, tx: 2, tz: 0, dir: 1, from: lift.id, age: 1 });
    if (this.rng.chance(0.6)) seeds.push({ floor: 0, tx: -2, tz: 0, dir: 3, from: lift.id, age: 1 });

    const otherFloors = this.floorsList.filter((f) => f !== 0);
    const mainShare = otherFloors.length ? Math.round(target * 0.58) : target;
    this.growFloor(0, seeds, mainShare);

    // 2. stairwells to the other floor(s)
    for (const of of otherFloors) {
      const stairs: RoomData[] = [];
      const want = 2;
      for (let i = 0; i < want; i++) {
        const st = this.placeStairwell(0, of, stairs);
        if (st) stairs.push(st);
      }
      if (!stairs.length) continue;
      const seedsB: Socket[] = [];
      for (const st of stairs) seedsB.push(...this.stairSockets(st, of));
      this.growFloor(of, seedsB, target - mainShare);
    }

    this.addLoops();
    this.pruneDeadEnds();
    this.computeDepths();
    this.addVaults();
    this.addHiddenRoom();
    this.computeDepths();
    this.buildWalls();
    this.assignSectors();
    this.placeLights();
    this.setupExtraction(lift);
    furnishLevel(this);
    this.computeBounds();
    return L;
  }

  private liftSurfaces(): string {
    const keys = Object.keys(this.theme.surfaceSets);
    return keys.includes('utility') ? 'utility' : keys.includes('steel') ? 'steel' : keys.includes('grime') ? 'grime' : keys.includes('service') ? 'service' : keys[0];
  }

  // ------------------------------------------------------------------ stairs
  private placeStairwell(fromFloor: number, otherFloor: number, existing: RoomData[]): RoomData | null {
    const lower = Math.min(fromFloor, otherFloor);
    const upper = Math.max(fromFloor, otherFloor);
    // candidate sockets: from corridors / junctions on fromFloor
    const candidates: Socket[] = [];
    for (const r of this.level.rooms) {
      if (r.floor !== fromFloor || !r.corridor) continue;
      for (const s of this.socketsFor(r, -1, fromFloor, 0)) candidates.push(s);
    }
    this.rng.shuffle(candidates);
    // prefer far from lift and from other stairwells
    candidates.sort((a, b) => this.stairScore(b, existing) - this.stairScore(a, existing));
    for (const s of candidates.slice(0, 40)) {
      // stairwell is 2x2; entrance tile index: lower entrance on the right tile (ex = 1), upper on the left (ex = 0)
      const ex = fromFloor === lower ? 1 : 0;
      const r = this.orientedRect(s, 2, 2, ex);
      if (!this.free(lower, r, 2)) continue;
      // other floor's entrance must have a free outside tile
      const [fx, fz] = DIRS[s.dir];
      const rx = fz, rz = -fx;
      const otherEx = 1 - ex;
      const otherTileX = s.tx + (otherEx - ex) * rx;
      const otherTileZ = s.tz + (otherEx - ex) * rz;
      const outX = otherTileX - fx, outZ = otherTileZ - fz;
      if (this.grid.get(otherFloor, outX, outZ) !== -1) continue;
      // frame: origin at the corner (-right, -forward) of local tile (0,0)
      const t0x = s.tx + (0 - ex) * rx, t0z = s.tz + (0 - ex) * rz;
      const origin: [number, number] = [(t0x + 0.5) * T - 0.5 * T * rx - 0.5 * T * fx, (t0z + 0.5) * T - 0.5 * T * rz - 0.5 * T * fz];
      const room = this.addRoom(lower, r, 'stairs', null, {
        name: 'Stairwell', height: (upper - lower) * SPACING + 3.6, floorsSpanned: upper - lower + 1,
        surfaces: this.theme.corridorSurfaces, loot: 0,
        stair: { origin, right: [rx, rz], forward: [fx, fz], lowerFloor: lower, upperFloor: upper },
      });
      const from = this.level.rooms[s.from];
      this.addDoor(from.id, room.id, fromFloor, s.tx - fx, s.tz - fz, s.dir, 'hinged', this.theme.doorStyle === 'ornate' ? 'panel' : 'metal');
      room.depth = from.depth + 1;
      this.level.navLinks.push(stairNavLink(room));
      return room;
    }
    return null;
  }

  private stairScore(s: Socket, existing: RoomData[]): number {
    const cx = (s.tx + 0.5) * T, cz = (s.tz + 0.5) * T;
    let score = Math.sqrt(cx * cx + cz * cz) * 0.4 + this.rng.next() * 6;
    for (const e of existing) {
      const ex = (e.x0 + e.x1) / 2, ez = (e.z0 + e.z1) / 2;
      score += Math.min(30, Math.sqrt((cx - ex) ** 2 + (cz - ez) ** 2)) * 0.8;
    }
    return score;
  }

  private stairSockets(st: RoomData, floor: number): Socket[] {
    const fr = st.stair!;
    const ex = floor === fr.lowerFloor ? 1 : 0;
    // tile for local (ex, 0)
    const ox = fr.origin[0] + (ex + 0.5) * T * fr.right[0] + 0.5 * T * fr.forward[0];
    const oz = fr.origin[1] + (ex + 0.5) * T * fr.right[1] + 0.5 * T * fr.forward[1];
    const tx = Math.floor(ox / T), tz = Math.floor(oz / T);
    const outX = tx - fr.forward[0], outZ = tz - fr.forward[1];
    const dir = DIRS.findIndex(([x, z]) => x === -fr.forward[0] && z === -fr.forward[1]) as Dir;
    // the door is created when the first room attaches; handled through a pseudo socket
    return [{ floor, tx: outX, tz: outZ, dir, from: st.id, age: 0 }];
  }

  // ------------------------------------------------------------------ loops
  private addLoops() {
    const L = this.level;
    const pairs = new Map<string, { a: number; b: number; floor: number; tiles: [number, number, Dir][] }>();
    for (const room of L.rooms) {
      for (let f = room.floor; f < room.floor + room.floorsSpanned; f++) {
        if (room.stair) continue;
        for (let x = room.tx; x < room.tx + room.tw; x++) for (let z = room.tz; z < room.tz + room.td; z++) {
          for (const dir of [0, 1] as Dir[]) {
            const nx = x + DIRS[dir][0], nz = z + DIRS[dir][1];
            const other = this.grid.get(f, nx, nz);
            if (other < 0 || other === room.id) continue;
            const o = L.rooms[other];
            if (o.stair || o.floor !== f || room.floor !== f) continue;
            const key = room.id < other ? `${room.id}:${other}` : `${other}:${room.id}`;
            let p = pairs.get(key);
            if (!p) { p = { a: room.id, b: other, floor: f, tiles: [] }; pairs.set(key, p); }
            p.tiles.push([x, z, dir]);
          }
        }
      }
    }
    for (const p of pairs.values()) {
      if (this.doorBetween(p.a, p.b)) continue;
      const a = L.rooms[p.a], b = L.rooms[p.b];
      if (a.type === 'lift' || b.type === 'lift') continue;
      const chance = a.corridor && b.corridor ? 0.55 : a.corridor || b.corridor ? 0.3 : 0.2;
      if (!this.rng.chance(chance)) continue;
      const [x, z, dir] = this.rng.pick(p.tiles);
      const dk = this.pickDoorKind(a, b);
      this.addDoor(this.grid.get(p.floor, x, z), this.grid.get(p.floor, x + DIRS[dir][0], z + DIRS[dir][1]), p.floor, x, z, dir, dk.kind, dk.style);
    }
  }

  /** remove most corridor stubs that lead nowhere (keeps ~25% for atmosphere) */
  private pruneDeadEnds() {
    const L = this.level;
    const removed = new Set<number>();
    for (let pass = 0; pass < 6; pass++) {
      let any = false;
      for (const r of L.rooms) {
        if (removed.has(r.id) || !r.corridor) continue;
        const live = r.doors.filter((d) => { const dd = L.doors[d]; return !removed.has(dd.rooms[0]) && !removed.has(dd.rooms[1]); });
        if (live.length <= 1 && this.rng.chance(0.75)) { removed.add(r.id); any = true; }
      }
      if (!any) break;
    }
    if (!removed.size) return;
    const map = new Map<number, number>();
    const rooms: RoomData[] = [];
    for (const r of L.rooms) {
      if (removed.has(r.id)) { map.set(r.id, -1); this.typeCounts.set(r.type, (this.typeCounts.get(r.type) ?? 1) - 1); continue; }
      map.set(r.id, rooms.length);
      r.id = rooms.length;
      rooms.push(r);
    }
    const doorMap = new Map<number, number>();
    const doors: DoorData[] = [];
    for (const d of L.doors) {
      const a = map.get(d.rooms[0]) ?? -1, b = d.rooms[1] < 0 ? -1 : map.get(d.rooms[1]) ?? -1;
      if (a < 0 || (d.rooms[1] >= 0 && b < 0)) { doorMap.set(d.id, -1); continue; }
      doorMap.set(d.id, doors.length);
      d.id = doors.length;
      d.rooms = [a, b];
      doors.push(d);
    }
    for (const r of rooms) r.doors = r.doors.map((x) => doorMap.get(x) ?? -1).filter((x) => x >= 0);
    for (const l of L.navLinks) l.room = map.get(l.room) ?? l.room;
    L.rooms = rooms;
    L.doors = doors;
    this.grid.remap(map);
  }

  computeDepths() {
    const L = this.level;
    for (const r of L.rooms) r.depth = 9999;
    L.rooms[0].depth = 0;
    const q = [0];
    while (q.length) {
      const id = q.shift()!;
      for (const did of L.rooms[id].doors) {
        const d = L.doors[did];
        const other = d.rooms[0] === id ? d.rooms[1] : d.rooms[0];
        if (other < 0) continue;
        if (L.rooms[other].depth > L.rooms[id].depth + 1) { L.rooms[other].depth = L.rooms[id].depth + 1; q.push(other); }
      }
    }
  }

  /** rooms reachable from the lift without passing locked or hidden doors */
  reachableUnlocked(): Set<number> {
    const L = this.level;
    const seen = new Set<number>([0]);
    const q = [0];
    while (q.length) {
      const id = q.shift()!;
      for (const did of L.rooms[id].doors) {
        const d = L.doors[did];
        if (d.lockedBy >= 0 || d.kind === 'hidden') continue;
        const other = d.rooms[0] === id ? d.rooms[1] : d.rooms[0];
        if (other < 0 || seen.has(other)) continue;
        seen.add(other); q.push(other);
      }
    }
    return seen;
  }

  // ------------------------------------------------------------------ vaults / hidden
  private findDeadEndSlot(w: number, d: number, preferDepth: number, fromCorridor: boolean): { s: Socket; r: Rect; ex: number } | null {
    const cands: { s: Socket; r: Rect; ex: number; score: number }[] = [];
    for (const room of this.level.rooms) {
      if (room.stair || room.type === 'lift' || room.hidden || room.locked) continue;
      if (fromCorridor !== room.corridor) continue;
      for (const s of this.socketsFor(room, -1, room.floor, 0)) {
        for (let ex = 0; ex < w; ex++) {
          const r = this.orientedRect(s, w, d, ex);
          if (!this.free(s.floor, r, 1)) continue;
          cands.push({ s, r, ex, score: -Math.abs(room.depth - preferDepth) + this.rng.next() * 2 });
        }
      }
    }
    if (!cands.length) return null;
    cands.sort((a, b) => b.score - a.score);
    return cands[0];
  }

  private addVaults() {
    const vaultDef = this.theme.roomTypes.find((r) => r.id === 'vault');
    if (!vaultDef) return;
    const count = this.params.difficulty >= 2 ? 2 : 1;
    let maxDepth = 0;
    for (const r of this.level.rooms) if (r.depth < 9999) maxDepth = Math.max(maxDepth, r.depth);
    for (let i = 0; i < count; i++) {
      const slot = this.findDeadEndSlot(this.rng.chance(0.5) ? 2 : 1, 2, Math.max(3, maxDepth - 1 - i), true);
      if (!slot) continue;
      const room = this.addRoom(slot.s.floor, slot.r, 'vault', vaultDef, { locked: true, height: 3.4 });
      const from = this.level.rooms[slot.s.from];
      room.depth = from.depth + 1;
      const keyId = this.level.keycards.length;
      const door = this.addDoor(from.id, room.id, slot.s.floor, slot.s.tx - DIRS[slot.s.dir][0], slot.s.tz - DIRS[slot.s.dir][1], slot.s.dir, 'security', 'security', { lockedBy: keyId });
      this.level.keycards.push({ id: keyId, door: door.id, interactable: -1 });
    }
  }

  private addHiddenRoom() {
    const slot = this.findDeadEndSlot(this.rng.chance(0.5) ? 1 : 2, 1 + (this.rng.chance(0.5) ? 1 : 0), 4, false);
    if (!slot) return;
    const def = this.theme.roomTypes.find((r) => r.id === 'study') ?? this.theme.roomTypes.find((r) => r.id === 'storage') ?? this.theme.roomTypes[0];
    const room = this.addRoom(slot.s.floor, slot.r, def.id, def, { hidden: true, name: 'Hidden Room', loot: 2.2, height: 3.2 });
    const from = this.level.rooms[slot.s.from];
    room.depth = from.depth + 1;
    this.addDoor(from.id, room.id, slot.s.floor, slot.s.tx - DIRS[slot.s.dir][0], slot.s.tz - DIRS[slot.s.dir][1], slot.s.dir, 'hidden', 'panel');
  }

  // ------------------------------------------------------------------ walls
  buildWalls() {
    const L = this.level;
    const roomTop = (id: number) => (id < 0 ? -Infinity : L.rooms[id].y + L.rooms[id].height);
    const doorAt = new Map<string, number>();
    for (const d of L.doors) doorAt.set(`${d.floor}:${d.axis}:${d.x.toFixed(2)}:${d.z.toFixed(2)}`, d.id);
    for (const floor of this.floorsList) {
      const y = floorY(floor);
      // edges along x (fixed z) and along z (fixed x)
      for (const axis of ['x', 'z'] as Axis[]) {
        for (let fixedT = -BOUND; fixedT <= BOUND; fixedT++) {
          let run: WallData | null = null;
          for (let alongT = -BOUND; alongT <= BOUND; alongT++) {
            const negTile = axis === 'x' ? [alongT, fixedT - 1] : [fixedT - 1, alongT];
            const posTile = axis === 'x' ? [alongT, fixedT] : [fixedT, alongT];
            const neg = this.grid.get(floor, negTile[0], negTile[1]);
            const pos = this.grid.get(floor, posTile[0], posTile[1]);
            let need = neg !== pos;
            let height = 0;
            if (need) {
              const top = Math.max(roomTop(neg), roomTop(pos));
              height = Math.min(SPACING, top - y);
              if (height <= 0.01) need = false;
            }
            const sameRun = run && run.neg === neg && run.pos === pos && Math.abs(run.height - height) < 1e-6;
            if (!need || !sameRun) {
              if (run) { L.walls.push(run); run = null; }
            }
            if (need) {
              if (!run) run = { floor, axis, fixed: fixedT * T, a: alongT * T, b: (alongT + 1) * T, y, height, neg, pos, openings: [] };
              else run.b = (alongT + 1) * T;
              const cx = axis === 'x' ? (alongT + 0.5) * T : fixedT * T;
              const cz = axis === 'x' ? fixedT * T : (alongT + 0.5) * T;
              const did = doorAt.get(`${floor}:${axis}:${cx.toFixed(2)}:${cz.toFixed(2)}`);
              if (did !== undefined) {
                const d = L.doors[did];
                run.openings.push({ center: (alongT + 0.5) * T, width: d.width, height: d.height, door: did });
              }
            }
          }
          if (run) L.walls.push(run);
        }
      }
    }
  }

  // ------------------------------------------------------------------ sectors
  assignSectors() {
    const L = this.level;
    const lift = L.rooms[0];
    const lcx = (lift.x0 + lift.x1) / 2, lcz = (lift.z0 + lift.z1) / 2;
    // sector 0: lift and depth<=1; floors != 0 → own sector; main floor split into two by side
    for (const r of L.rooms) {
      if (r.type === 'lift' || r.depth <= 1) { r.sector = 0; continue; }
      if (r.floor !== 0) { r.sector = 3; continue; }
      const cx = (r.x0 + r.x1) / 2 - lcx;
      const cz = (r.z0 + r.z1) / 2 - lcz;
      r.sector = cx + cz * 0.25 >= 0 ? 1 : 2;
    }
    const used = [...new Set(L.rooms.map((r) => r.sector))].sort((a, b) => a - b);
    const darkCandidates = used.filter((s) => s !== 0);
    let dark = -1;
    const pDark = [0.25, 0.5, 0.7, 0.85][Math.max(0, Math.min(3, this.params.difficulty))];
    if (darkCandidates.length && this.rng.chance(pDark)) dark = this.rng.pick(darkCandidates);
    L.sectors = used.map((id) => ({ id, powered: id !== dark, breaker: -1 }));
  }

  // ------------------------------------------------------------------ lights
  placeLights() {
    const L = this.level;
    const th = this.theme;
    for (const r of L.rooms) {
      if (r.type === 'lift') {
        // lift bay: two bright work lights + amber beacon
        this.addLight(r, (r.x0 + r.x1) / 2 - 3, r.y + r.height - 0.2, (r.z0 + r.z1) / 2 + 1, { fixture: 'caged', color: '#f2e6cc', intensity: 26, range: 13, broken: 0, flicker: 0 }, false);
        this.addLight(r, (r.x0 + r.x1) / 2 + 3, r.y + r.height - 0.2, (r.z0 + r.z1) / 2 + 1, { fixture: 'caged', color: '#f2e6cc', intensity: 26, range: 13, broken: 0, flicker: 0 }, false);
        continue;
      }
      const styleKey = r.stair || r.corridor ? th.corridorLight : th.roomTypes.find((t) => t.id === r.type)?.light ?? 'main';
      const style = th.lights[styleKey] ?? th.lights.main ?? Object.values(th.lights)[0];
      const w = r.x1 - r.x0, d = r.z1 - r.z0;
      if (r.stair) {
        const fr = r.stair;
        const at = (u: number, v: number, yy: number) => [fr.origin[0] + u * fr.right[0] + v * fr.forward[0], yy, fr.origin[1] + u * fr.right[1] + v * fr.forward[1]];
        const p1 = at(4, 7, r.y + 3 + 3.2), p2 = at(1.5, 1.0, r.y + (fr.upperFloor - fr.lowerFloor) * SPACING + 3.3);
        this.addLight(r, p1[0], p1[1], p1[2], style, true);
        this.addLight(r, p2[0], p2[1], p2[2], style, true);
        continue;
      }
      if (style.fixture === 'wallSconce') {
        // sconces on the long walls
        const alongX = w >= d;
        const len = alongX ? w : d;
        const n = Math.max(1, Math.round(len / 5));
        for (let i = 0; i < n; i++) {
          const t = (i + 0.5) / n;
          const side = i % 2 === 0 ? -1 : 1;
          const inset = WORLD.WALL_THICKNESS / 2 + 0.12;
          const x = alongX ? r.x0 + t * w : side < 0 ? r.x0 + inset : r.x1 - inset;
          const z = alongX ? (side < 0 ? r.z0 + inset : r.z1 - inset) : r.z0 + t * d;
          const rotY = alongX ? (side < 0 ? 0 : Math.PI) : side < 0 ? Math.PI / 2 : -Math.PI / 2;
          const li = this.addLight(r, x, r.y + Math.min(2.4, r.height - 0.6), z, style, true);
          li.wall = true; li.rotY = rotY; li.type = 'point';
        }
        continue;
      }
      const spacing = r.tall ? 8 : r.corridor ? 6 : 5;
      const nx = Math.max(1, Math.round(w / spacing));
      const nz = Math.max(1, Math.round(d / spacing));
      for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
        const x = r.x0 + ((i + 0.5) / nx) * w;
        const z = r.z0 + ((j + 0.5) / nz) * d;
        const drop = style.fixture === 'hanging' || style.fixture === 'chandelier' ? (r.tall ? 2.2 : 0.9) : style.fixture === 'floodlight' ? 0.4 : 0.06;
        this.addLight(r, x, r.y + r.height - drop, z, style, true);
      }
    }
    for (const r of L.rooms) {
      const lights = r.lights.map((id) => L.lights[id]);
      r.dark = lights.length > 0 && lights.every((l) => l.broken);
      if (r.hidden) { r.dark = true; for (const l of lights) l.broken = true; }
    }
  }

  addLight(r: RoomData, x: number, y: number, z: number, style: { fixture: LightData['fixture']; color: string; intensity: number; range: number; broken: number; flicker: number }, roll: boolean): LightData {
    const broken = roll && this.rng.chance(style.broken);
    const flicker = !broken && roll && this.rng.chance(style.flicker) ? 0.3 + this.rng.next() * 0.7 : 0;
    const li: LightData = {
      id: this.level.lights.length, room: r.id, x, y, z, fixture: style.fixture, color: style.color,
      intensity: style.intensity * (0.85 + this.rng.next() * 0.3), range: style.range, type: 'spot',
      angle: style.fixture === 'floodlight' ? 1.05 : style.fixture === 'chandelier' ? 1.25 : 1.15,
      broken, flicker, sector: r.sector, rotY: 0, wall: false,
    };
    if (style.fixture === 'bulb' || style.fixture === 'chandelier') li.type = 'point';
    this.level.lights.push(li);
    r.lights.push(li.id);
    return li;
  }

  // ------------------------------------------------------------------ extraction
  setupExtraction(lift: RoomData) {
    const L = this.level;
    // lift car occupies the north part of the bay
    const inset = 0.6;
    const carZ0 = lift.z0 + 3.4, carZ1 = lift.z1 - WORLD.WALL_THICKNESS / 2 - 0.1;
    const carX0 = lift.x0 + 1.4, carX1 = lift.x1 - 1.4;
    L.extraction = {
      room: lift.id,
      zone: { x0: carX0 + 0.2, z0: carZ0 + 0.2, x1: carX1 - 0.2, z1: carZ1 - 0.2, y: lift.y },
      aboard: { x0: carX0, z0: carZ0, x1: carX1, z1: carZ1, y: lift.y },
      lever: { x: carX1 + 0.55, y: lift.y + 1.05, z: carZ0 - 0.35 },
      board: { x: (carX0 + carX1) / 2, y: lift.y + 3.15, z: carZ1 - 0.05, rotY: Math.PI },
      gate: { x: (carX0 + carX1) / 2, z: carZ0, axis: 'x', width: carX1 - carX0 },
      liftRotY: 0,
    };
    void inset;
    const cx = (carX0 + carX1) / 2, cz = (carZ0 + carZ1) / 2;
    const offs = [[-2.4, -0.6], [-0.8, 0.6], [0.8, -0.6], [2.4, 0.6]];
    for (const [ox, oz] of offs) L.playerSpawns.push({ x: cx + ox, y: lift.y + 0.05, z: cz + oz, rotY: Math.PI });
    L.interactables.push({ id: L.interactables.length, kind: 'liftLever', room: lift.id, x: L.extraction.lever.x, y: L.extraction.lever.y, z: L.extraction.lever.z, rotY: Math.PI, sector: 0, target: -1, data: '' });
  }

  computeBounds() {
    const L = this.level;
    const b = { x0: Infinity, z0: Infinity, x1: -Infinity, z1: -Infinity, y0: Infinity, y1: -Infinity };
    for (const r of L.rooms) {
      b.x0 = Math.min(b.x0, r.x0); b.z0 = Math.min(b.z0, r.z0); b.x1 = Math.max(b.x1, r.x1); b.z1 = Math.max(b.z1, r.z1);
      b.y0 = Math.min(b.y0, r.y); b.y1 = Math.max(b.y1, r.y + r.height);
    }
    L.bounds = b;
    L.totalValue = L.props.reduce((s, p) => s + (p.kind === 'valuable' ? p.value : 0), 0);
  }

  // helpers used by furnish.ts
  roomAtTile(floor: number, tx: number, tz: number) { return this.grid.get(floor, tx, tz); }
  get difficultyDef() { return DIFFICULTIES[Math.max(0, Math.min(3, this.params.difficulty))]; }
}

export function generateLevel(params: GenParams): LevelData {
  return new LevelGenerator(params).generate();
}
