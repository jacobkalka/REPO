// Builds the visual facility from LevelData. Geometry is merged per room per material and
// grouped per room so portal culling can hide whole rooms.
import * as THREE from 'three';
import { getTheme, type SurfaceSet } from '../../../shared/catalog/maps';
import { WORLD } from '../../../shared/constants';
import { doorLeaves, type LeafSpec } from '../../../shared/doors';
import { STAIR, stairToWorld } from '../../../shared/levelgen/stairs';
import type { DoorData, HazardData, InteractableData, LevelData, LightData, RoomData } from '../../../shared/levelgen/types';
import { Rng } from '../../../shared/rng';
import { assets } from '../core/Assets';
import { makeCone, type VirtualLight } from '../render/LightPool';
import { materials, canvasTex } from '../render/Materials';
import { GeoBuilder } from './GeoBuilder';
import { buildProc, type ProcExtras } from './ProcModels';

const WT = WORLD.WALL_THICKNESS;
/** physical-light calibration: theme intensities are authored as relative values */
const LIGHT_GAIN = 2.6;

export interface DoorView { data: DoorData; leaves: { spec: LeafSpec; mesh: THREE.Object3D }[]; value: number; target: number; open: boolean; locked: boolean; broken: boolean; fast: boolean; revealed: boolean; reader: THREE.MeshBasicMaterial | null }
export interface InterView { data: InteractableData; obj: THREE.Object3D; state: number; parts: Record<string, THREE.Object3D>; led: THREE.MeshBasicMaterial | null }
export interface HazardView { data: HazardData; obj: THREE.Group; on: boolean }
export interface RoomView { data: RoomData; group: THREE.Group; box: THREE.Box3 }

export interface LevelView {
  root: THREE.Group;
  rooms: RoomView[];
  lights: VirtualLight[];
  lightsByRoom: Map<number, VirtualLight[]>;
  doors: DoorView[];
  inters: InterView[];
  hazards: HazardView[];
  anims: ProcExtras['anim'];
  liftGate: THREE.Object3D | null;
  board: { ctx: CanvasRenderingContext2D; tex: THREE.CanvasTexture } | null;
  ledMesh: THREE.InstancedMesh | null;
  dispose(): void;
}

function surfKey(set: SurfaceSet, which: 'floor' | 'wall' | 'wallLower' | 'ceiling') {
  const d = set[which] ?? set.wall;
  return materials.surfaceKey(d);
}

export class LevelBuilder {
  readonly theme;
  readonly rng: Rng;
  private builders = new Map<number, GeoBuilder>();
  readonly view: LevelView;
  private extras: ProcExtras = { leds: [], anim: [], objects: [] };
  private usedModels = new Set<string>();

  constructor(readonly level: LevelData, readonly cones: boolean) {
    this.theme = getTheme(level.map);
    this.rng = new Rng('visual:' + level.seed);
    const root = new THREE.Group();
    root.name = 'level';
    this.view = { root, rooms: [], lights: [], lightsByRoom: new Map(), doors: [], inters: [], hazards: [], anims: [], liftGate: null, board: null, ledMesh: null, dispose: () => this.dispose() };
  }

  /** model ids and texture ids this level needs (for preloading) */
  static requirements(level: LevelData): { models: string[]; textures: string[] } {
    const theme = getTheme(level.map);
    const models = new Set<string>();
    for (const s of level.statics) models.add(s.model);
    for (const p of level.props) models.add(p.def.includes('_') || p.def.length > 0 ? (p.kind === 'valuable' ? valModel(p.def) : p.def) : p.def);
    for (const m of ['mounted_fluorescent_lights', 'hanging_industrial_lamp', 'Chandelier_02', 'modern_ceiling_lamp_01', 'industrial_wall_sconce', 'security_light', 'lightbulb_01', 'signal_flashlight', 'alarm_clock_01', 'power_box_01']) models.add(m);
    const textures = new Set<string>();
    for (const set of Object.values(theme.surfaceSets)) for (const k of ['floor', 'wall', 'wallLower', 'ceiling'] as const) { const d = set[k]; if (d) textures.add(d.tex); }
    for (const t of ['blue_metal_plate', 'metal_plate_02', 'green_metal_rust', 'metal_plate', 'rust_coarse_01', 'rusty_metal_03', 'painted_metal_shutter', 'wood_cabinet_worn_long', 'dark_wood', 'concrete_wall_008', 'preconcrete_wall_001', 'marble_01', 'velour_velvet', 'corrugated_iron_02']) textures.add(t);
    return { models: [...models].filter((m) => assets.hasModel(m)), textures: [...textures] };
  }

  private gb(room: number): GeoBuilder {
    let g = this.builders.get(room);
    if (!g) { g = new GeoBuilder(); this.builders.set(room, g); }
    return g;
  }

  private set(room: RoomData): SurfaceSet {
    return this.theme.surfaceSets[room.surfaces] ?? Object.values(this.theme.surfaceSets)[0];
  }

  build(): LevelView {
    const L = this.level;
    for (const r of L.rooms) {
      const group = new THREE.Group();
      group.name = 'room' + r.id;
      const box = new THREE.Box3(new THREE.Vector3(r.x0, r.y - 0.5, r.z0), new THREE.Vector3(r.x1, r.y + r.height + 0.5, r.z1));
      this.view.rooms.push({ data: r, group, box });
      this.view.root.add(group);
      this.floorCeiling(r);
      if (r.stair) this.stairs(r);
    }
    for (const w of L.walls) this.wall(w);
    for (const p of L.procs) buildProc(this.gb(p.room), p, this.theme.id, this.extras, L.rooms[p.room]?.height ?? 4);
    this.tallRoomBeams();
    for (const d of L.doors) this.door(d);
    for (const li of L.lights) this.fixture(li);
    for (const s of L.statics) this.staticModel(s);
    for (const it of L.interactables) this.interactable(it);
    for (const h of L.hazards) this.hazard(h);
    this.signs();
    this.liftExtras();
    // emit merged geometry
    for (const [roomId, g] of this.builders) {
      const room = this.view.rooms[roomId];
      for (const m of g.build((k) => materials.get(k))) room.group.add(m);
    }
    for (const o of this.extras.objects) this.view.root.add(o);
    this.view.anims = this.extras.anim;
    this.leds();
    return this.view;
  }

  // ------------------------------------------------------------------ floors / ceilings
  private floorCeiling(r: RoomData) {
    const g = this.gb(r.id);
    const set = this.set(r);
    const fs = set.floor.scale ?? 2.5, cs = set.ceiling.scale ?? 2.5;
    const fk = surfKey(set, 'floor'), ck = surfKey(set, 'ceiling');
    const y0 = r.y, y1 = r.y + r.height;
    g.quad(fk, [r.x0, y0, r.z1], [r.x1, y0, r.z1], [r.x1, y0, r.z0], [r.x0, y0, r.z0], fs);
    if (r.type !== 'lift' || true) g.quad(ck, [r.x0, y1, r.z0], [r.x1, y1, r.z0], [r.x1, y1, r.z1], [r.x0, y1, r.z1], cs);
  }

  private tallRoomBeams() {
    for (const r of this.level.rooms) {
      if (!r.tall || r.stair) continue;
      const g = this.gb(r.id);
      const along = r.x1 - r.x0 >= r.z1 - r.z0;
      const span = along ? r.z1 - r.z0 : r.x1 - r.x0;
      const len = along ? r.x1 - r.x0 : r.z1 - r.z0;
      const y = r.y + r.height - 0.35;
      for (let a = 2; a < len - 1; a += 4) {
        const cx = along ? r.x0 + a : (r.x0 + r.x1) / 2, cz = along ? (r.z0 + r.z1) / 2 : r.z0 + a;
        const hx = along ? 0.12 : span / 2, hz = along ? span / 2 : 0.12;
        g.box(this.theme.id === 'luxury' ? 'wood_dark' : 'metal_dark', cx, y, cz, hx, 0.3, hz, { uv: 2 });
        g.box(this.theme.id === 'luxury' ? 'wood_dark' : 'metal_dark', cx, y - 0.3, cz, along ? 0.2 : span / 2, 0.03, along ? span / 2 : 0.2, { uv: 2 });
      }
    }
  }

  // ------------------------------------------------------------------ walls
  private wall(w: LevelData['walls'][number]) {
    const L = this.level;
    const sides: { room: number; sign: number }[] = [];
    if (w.neg >= 0) sides.push({ room: w.neg, sign: -1 });
    if (w.pos >= 0) sides.push({ room: w.pos, sign: 1 });
    const ops = [...w.openings].sort((a, b) => a.center - b.center);
    // solid spans along the wall
    const pieces: { a: number; b: number; y0: number; y1: number }[] = [];
    let cur = w.a - WT / 2;
    for (const o of ops) {
      const oa = o.center - o.width / 2, ob = o.center + o.width / 2;
      if (oa > cur) pieces.push({ a: cur, b: oa, y0: w.y, y1: w.y + w.height });
      if (o.height < w.height) pieces.push({ a: oa, b: ob, y0: w.y + o.height, y1: w.y + w.height });
      cur = ob;
    }
    if (cur < w.b + WT / 2) pieces.push({ a: cur, b: w.b + WT / 2, y0: w.y, y1: w.y + w.height });
    for (const side of sides) {
      const room = L.rooms[side.room];
      if (!room) continue;
      const set = this.set(room);
      const g = this.gb(side.room);
      const off = w.fixed + side.sign * WT / 2;
      // clamp visible faces to this room's ceiling on this floor
      const top = Math.min(w.y + w.height, room.y + room.height + (room.floorsSpanned > 1 ? 0 : 0.01));
      const lowerH = set.lowerHeight ?? 0;
      const lowerKey = set.wallLower ? surfKey(set, 'wallLower') : surfKey(set, 'wall');
      const upperKey = surfKey(set, 'wall');
      const sLower = (set.wallLower ?? set.wall).scale ?? 2.5, sUpper = set.wall.scale ?? 2.5;
      for (const p of pieces) {
        const y0 = p.y0, y1 = Math.min(p.y1, top);
        if (y1 <= y0 + 0.001) continue;
        const bandSplit = w.y + lowerH;
        const bands: [number, number, string, number][] = [];
        if (lowerH > 0 && bandSplit > y0 && bandSplit < y1) { bands.push([y0, bandSplit, lowerKey, sLower], [bandSplit, y1, upperKey, sUpper]); }
        else if (lowerH > 0 && y1 <= bandSplit) bands.push([y0, y1, lowerKey, sLower]);
        else bands.push([y0, y1, upperKey, sUpper]);
        for (const [b0, b1, key, sc] of bands) this.wallQuad(g, w.axis, off, p.a, p.b, b0, b1, side.sign, key, sc);
        // baseboard + chair rail + grime on full-height pieces
        if (p.y0 === w.y) {
          const trim = `trim|${set.trim}|${set.trimMetal ? 1 : 0}`;
          this.strip(g, w.axis, off, p.a, p.b, w.y + 0.06, 0.06, 0.018, side.sign, trim);
          if (lowerH > 0 && y1 > bandSplit) this.strip(g, w.axis, off, p.a, p.b, bandSplit, 0.025, 0.022, side.sign, trim);
          this.grime(g, w.axis, off + side.sign * 0.004, p.a, p.b, w.y, Math.min(0.9, y1 - w.y), side.sign);
        }
      }
      // door frames on this side
      for (const o of ops) {
        const d = L.doors[o.door];
        if (!d || d.kind === 'hidden') continue;
        const trim = d.style === 'security' ? 'metal_dark' : d.style === 'ornate' || this.theme.id === 'luxury' ? 'wood_dark' : `trim|${set.trim}|${set.trimMetal ? 1 : 0}`;
        const oa = o.center - o.width / 2, ob = o.center + o.width / 2;
        const fw = 0.09;
        this.frameBox(g, w.axis, off, oa - fw / 2, w.y, w.y + o.height + fw, side.sign, fw, trim);
        this.frameBox(g, w.axis, off, ob + fw / 2, w.y, w.y + o.height + fw, side.sign, fw, trim);
        const hc = (oa + ob) / 2;
        const [hx, hz] = w.axis === 'x' ? [hc, off + side.sign * 0.03] : [off + side.sign * 0.03, hc];
        g.box(trim, hx, w.y + o.height + fw / 2, hz, w.axis === 'x' ? o.width / 2 + fw : 0.03, fw / 2, w.axis === 'x' ? 0.03 : o.width / 2 + fw, { uv: 1 });
        if (d.kind === 'security' || (d.kind === 'shutter' && this.theme.id === 'industrial')) {
          const [sx, sz] = w.axis === 'x' ? [hc, off + side.sign * 0.035] : [off + side.sign * 0.035, hc];
          g.box('hazard', sx, w.y + o.height + fw + 0.08, sz, w.axis === 'x' ? o.width / 2 + fw : 0.004, 0.07, w.axis === 'x' ? 0.004 : o.width / 2 + fw, { uv: 1 });
        }
      }
    }
    // jambs (thickness faces inside openings)
    const jr = w.neg >= 0 ? w.neg : w.pos;
    if (jr >= 0) {
      const set = this.set(L.rooms[jr]);
      const g = this.gb(jr);
      const key = `trim|${set.trim}|${set.trimMetal ? 1 : 0}`;
      for (const o of ops) {
        const oa = o.center - o.width / 2, ob = o.center + o.width / 2;
        for (const [x, s] of [[oa, 1], [ob, -1]] as [number, number][]) {
          if (w.axis === 'x') g.quad(key, [x, w.y, w.fixed + WT / 2 * s], [x, w.y, w.fixed - WT / 2 * s], [x, w.y + o.height, w.fixed - WT / 2 * s], [x, w.y + o.height, w.fixed + WT / 2 * s], 1);
          else g.quad(key, [w.fixed - WT / 2 * s, w.y, x], [w.fixed + WT / 2 * s, w.y, x], [w.fixed + WT / 2 * s, w.y + o.height, x], [w.fixed - WT / 2 * s, w.y + o.height, x], 1);
        }
        if (o.height < w.height) {
          const y = w.y + o.height;
          if (w.axis === 'x') g.quad(key, [oa, y, w.fixed - WT / 2], [ob, y, w.fixed - WT / 2], [ob, y, w.fixed + WT / 2], [oa, y, w.fixed + WT / 2], 1);
          else g.quad(key, [w.fixed + WT / 2, y, oa], [w.fixed + WT / 2, y, ob], [w.fixed - WT / 2, y, ob], [w.fixed - WT / 2, y, oa], 1);
        }
        // threshold strip on the floor
        if (w.axis === 'x') g.box('metal_dark', o.center, w.y + 0.004, w.fixed, o.width / 2, 0.005, WT / 2 + 0.02, { uv: 1 });
        else g.box('metal_dark', w.fixed, w.y + 0.004, o.center, WT / 2 + 0.02, 0.005, o.width / 2, { uv: 1 });
      }
    }
  }

  private wallQuad(g: GeoBuilder, axis: 'x' | 'z', off: number, a: number, b: number, y0: number, y1: number, sign: number, key: string, scale: number) {
    if (axis === 'x') {
      if (sign < 0) g.quad(key, [b, y0, off], [a, y0, off], [a, y1, off], [b, y1, off], scale);
      else g.quad(key, [a, y0, off], [b, y0, off], [b, y1, off], [a, y1, off], scale);
    } else {
      if (sign < 0) g.quad(key, [off, y0, a], [off, y0, b], [off, y1, b], [off, y1, a], scale);
      else g.quad(key, [off, y0, b], [off, y0, a], [off, y1, a], [off, y1, b], scale);
    }
  }

  private strip(g: GeoBuilder, axis: 'x' | 'z', off: number, a: number, b: number, y: number, hy: number, depth: number, sign: number, key: string) {
    const c = (a + b) / 2, h = (b - a) / 2;
    if (axis === 'x') g.box(key, c, y, off + sign * depth / 2, h, hy, depth / 2, { uv: 1 });
    else g.box(key, off + sign * depth / 2, y, c, depth / 2, hy, h, { uv: 1 });
  }

  private frameBox(g: GeoBuilder, axis: 'x' | 'z', off: number, along: number, y0: number, y1: number, sign: number, fw: number, key: string) {
    const cy = (y0 + y1) / 2, hy = (y1 - y0) / 2;
    if (axis === 'x') g.box(key, along, cy, off + sign * 0.03, fw / 2, hy, 0.03, { uv: 1 });
    else g.box(key, off + sign * 0.03, cy, along, 0.03, hy, fw / 2, { uv: 1 });
  }

  private grime(g: GeoBuilder, axis: 'x' | 'z', off: number, a: number, b: number, y0: number, h: number, sign: number) {
    const key = 'grime';
    g.noShadow(key);
    if (axis === 'x') {
      if (sign < 0) g.quad(key, [b, y0, off], [a, y0, off], [a, y0 + h, off], [b, y0 + h, off], 50);
      else g.quad(key, [a, y0, off], [b, y0, off], [b, y0 + h, off], [a, y0 + h, off], 50);
    } else {
      if (sign < 0) g.quad(key, [off, y0, a], [off, y0, b], [off, y0 + h, b], [off, y0 + h, a], 50);
      else g.quad(key, [off, y0, b], [off, y0, a], [off, y0 + h, a], [off, y0 + h, b], 50);
    }
    // grime uses its own UV: vertical gradient. Patch the last quad's v coordinates.
    const part = g.parts.get(key)!;
    const n = part.uv.length;
    part.uv[n - 8 + 1] = 1; part.uv[n - 6 + 1] = 1; part.uv[n - 4 + 1] = 0; part.uv[n - 2 + 1] = 0;
  }

  // ------------------------------------------------------------------ stairs
  private stairs(r: RoomData) {
    const g = this.gb(r.id);
    const set = this.set(r);
    const stepKey = 'metal_floor';
    const sideKey = surfKey(set, 'wall');
    const W = (u: number, y: number, v: number) => { const p = stairToWorld(r, u, y, v); return [p.x, p.y, p.z]; };
    const f = r.stair!;
    const yaw = Math.atan2(f.forward[0], f.forward[1]);
    const boxL = (key: string, u0: number, u1: number, y0: number, y1: number, v0: number, v1: number) => {
      const c = W((u0 + u1) / 2, (y0 + y1) / 2, (v0 + v1) / 2);
      g.box(key, c[0], c[1], c[2], (u1 - u0) / 2, (y1 - y0) / 2, (v1 - v0) / 2, { rotY: yaw + Math.PI / 2 * 0, uv: 1.5 });
    };
    // flights as solid steps
    const steps = 16;
    const { U_F1, U_F2, U_CORE, V_LAND, V_MID, V_MAX, RISE } = STAIR;
    const run = (V_MID - V_LAND) / steps;
    for (let i = 0; i < steps; i++) {
      const y1 = ((i + 1) * RISE) / steps;
      boxL(stepKey, U_F1[0], U_F1[1], 0, y1, V_LAND + i * run, V_LAND + (i + 1) * run);
      const y2 = RISE + ((i + 1) * RISE) / steps;
      boxL(stepKey, U_F2[0], U_F2[1], 0, y2, V_MID - (i + 1) * run, V_MID - i * run);
      boxL('hazard', U_F1[0], U_F1[1], y1 - 0.01, y1 + 0.004, V_LAND + i * run, V_LAND + i * run + 0.04);
      boxL('hazard', U_F2[0], U_F2[1], y2 - 0.01, y2 + 0.004, V_MID - i * run - 0.04, V_MID - i * run);
    }
    boxL(stepKey, U_F2[0], U_F1[1], 0, RISE, V_MID, V_MAX);
    boxL(stepKey, U_F2[0], U_F2[1], 0, 2 * RISE, 0.15, V_LAND);
    boxL(sideKey, U_CORE[0], U_CORE[1], 0, r.height, 0.15, V_MID);
    // handrails
    for (const [u, y0, y1] of [[U_F1[0] + 0.05, 0, RISE], [U_F2[1] - 0.05, 2 * RISE, RISE]] as [number, number, number][]) {
      const a = W(u, y0 + 0.95, y0 === 0 ? V_LAND : V_LAND), b = W(u, y1 + 0.95, V_MID);
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      const cyl = new THREE.CylinderGeometry(0.025, 0.025, len, 8);
      const dir = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      const e = new THREE.Euler().setFromQuaternion(q, 'YXZ');
      g.geometry('steel', cyl, mid[0], mid[1], mid[2], e.y, [1, 1, 1], e.x, e.z);
      cyl.dispose();
    }
  }

  // ------------------------------------------------------------------ doors
  private door(d: DoorData) {
    const leaves: DoorView['leaves'] = [];
    let reader: THREE.MeshBasicMaterial | null = null;
    const style = d.style;
    for (const spec of doorLeaves(d)) {
      const obj = new THREE.Group();
      const [hx, hy, hz] = spec.half;
      const along = d.axis === 'x';
      const mat = style === 'security' ? 'metal_dark' : style === 'wood' || style === 'ornate' ? 'wood' : style === 'glass' ? 'glass' : style === 'panel' ? (this.theme.id === 'luxury' ? 'wood_dark' : 'metal_painted') : spec.kind === 'roll' ? 'shutter' : 'metal_painted';
      const g = new GeoBuilder();
      if (d.kind === 'hidden') {
        // matches the wall it hides in
        const room = this.level.rooms[d.rooms[0]];
        const set = this.set(room);
        g.box(surfKey(set, 'wall'), 0, 0, 0, hx, hy, hz, { uv: 2.5 });
      } else {
        g.box(mat, 0, 0, 0, hx, hy, hz, { uv: 1.5, mode: 'local' });
        if (spec.kind === 'hinge') {
          // panels + handle
          const pw = (along ? hx : hz) * 0.72;
          for (const s of [-1, 1]) {
            const off = s * (hz > hx ? hx : hz) + s * 0.004;
            if (along) { g.box(mat === 'wood' ? 'wood_dark' : 'metal_dark', 0, hy * 0.4, off, pw, hy * 0.35, 0.006, { uv: 1 }); g.box(mat === 'wood' ? 'wood_dark' : 'metal_dark', 0, -hy * 0.45, off, pw, hy * 0.3, 0.006, { uv: 1 }); }
            else { g.box(mat === 'wood' ? 'wood_dark' : 'metal_dark', off, hy * 0.4, 0, 0.006, hy * 0.35, pw, { uv: 1 }); g.box(mat === 'wood' ? 'wood_dark' : 'metal_dark', off, -hy * 0.45, 0, 0.006, hy * 0.3, pw, { uv: 1 }); }
          }
          const far = (along ? hx : hz) * 0.82;
          for (const s of [-1, 1]) {
            if (along) g.box('brass', spec.along[0] * far, -0.12, s * (hz + 0.035), 0.06, 0.012, 0.012, { uv: 1 });
            else g.box('brass', s * (hx + 0.035), -0.12, spec.along[1] * far, 0.012, 0.012, 0.06, { uv: 1 });
          }
          if (style === 'metal' || style === 'panel') {
            // small window
            if (along) g.box('glass_frosted', -spec.along[0] * (hx * 0.2), hy * 0.55, 0, hx * 0.28, hy * 0.18, hz + 0.002, { uv: 1 });
            else g.box('glass_frosted', 0, hy * 0.55, -spec.along[1] * (hz * 0.2), hx + 0.002, hy * 0.18, hz * 0.28, { uv: 1 });
          }
        } else if (spec.kind === 'slide') {
          for (let i = -2; i <= 2; i++) {
            if (along) g.box('hazard', 0, i * hy * 0.38, 0, hx * 0.95, 0.05, hz + 0.004, { uv: 1 });
            else g.box('hazard', 0, i * hy * 0.38, 0, hx + 0.004, 0.05, hz * 0.95, { uv: 1 });
          }
        } else {
          for (let i = 0; i < 18; i++) {
            const y = -hy + (i + 0.5) * (2 * hy / 18);
            if (along) g.box('metal_dark', 0, y, 0, hx, 0.008, hz + 0.006, { uv: 1 }); else g.box('metal_dark', 0, y, 0, hx + 0.006, 0.008, hz, { uv: 1 });
          }
        }
      }
      for (const m of g.build((k) => materials.get(k))) { m.matrixAutoUpdate = true; obj.add(m); }
      this.view.root.add(obj);
      leaves.push({ spec, mesh: obj });
    }
    if (d.kind === 'security') {
      // keycard reader beside the door on both sides
      const lm = new THREE.MeshBasicMaterial({ color: d.lockedBy >= 0 ? '#ff4a3a' : '#7dff9a' });
      for (const s of [-1, 1]) {
        const grp = new THREE.Group();
        const box = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.16, 0.04), materials.get('plastic_dark'));
        const led = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.015, 0.045), lm);
        led.position.y = 0.05;
        grp.add(box, led);
        const off = d.width / 2 + 0.28;
        if (d.axis === 'x') grp.position.set(d.x + off, d.y + 1.3, d.z + s * (WT / 2 + 0.02));
        else grp.position.set(d.x + s * (WT / 2 + 0.02), d.y + 1.3, d.z + off);
        if (d.axis === 'z') grp.rotation.y = Math.PI / 2;
        this.view.root.add(grp);
      }
      reader = lm;
    }
    this.view.doors.push({ data: d, leaves, value: 0, target: 0, open: false, locked: d.lockedBy >= 0, broken: false, fast: false, revealed: d.kind !== 'hidden', reader });
  }

  // ------------------------------------------------------------------ lights / fixtures
  private fixture(li: LightData) {
    const room = this.view.rooms[li.room];
    if (!room) return;
    const color = new THREE.Color(li.color);
    const glowMat = materials.glow(li.color, li.fixture === 'floodlight' ? 6 : 4);
    const obj = new THREE.Group();
    obj.position.set(li.x, li.y, li.z);
    obj.rotation.y = li.rotY;
    const addModel = (id: string, y: number, scale = 1) => {
      const m = assets.instance(id);
      if (!m) return null;
      m.position.y = y;
      m.scale.setScalar(scale);
      m.traverse((o) => { if ((o as THREE.Mesh).isMesh) { (o as THREE.Mesh).castShadow = false; } });
      obj.add(m);
      this.usedModels.add(id);
      return m;
    };
    const glow = (geo: THREE.BufferGeometry, y: number) => { const m = new THREE.Mesh(geo, glowMat); m.position.y = y; obj.add(m); return m; };
    let dir = new THREE.Vector3(0, -1, 0);
    switch (li.fixture) {
      case 'fluorescent': addModel('mounted_fluorescent_lights', 0.04); glow(new THREE.BoxGeometry(0.8, 0.01, 0.12), 0.005).position.z = 0; break;
      case 'hanging': addModel('hanging_industrial_lamp', -0.0 + 0.68) ; glow(new THREE.SphereGeometry(0.07, 10, 8), 0.05); break;
      case 'chandelier': addModel('Chandelier_02', 0.42); for (let i = 0; i < 5; i++) { const a = (i / 5) * Math.PI * 2; const s = glow(new THREE.SphereGeometry(0.03, 8, 6), 0.25); s.position.x = Math.cos(a) * 0.24; s.position.z = Math.sin(a) * 0.24; } break;
      case 'ceilingLamp': addModel('modern_ceiling_lamp_01', 0.47); glow(new THREE.SphereGeometry(0.06, 10, 8), 0.05); break;
      case 'wallSconce': { addModel('industrial_wall_sconce', 0.0); glow(new THREE.SphereGeometry(0.035, 8, 6), 0.0).position.z = 0.1; dir = new THREE.Vector3(Math.sin(li.rotY) * 0.55, -0.8, Math.cos(li.rotY) * 0.55).normalize(); break; }
      case 'security': addModel('security_light', 0.25); glow(new THREE.SphereGeometry(0.05, 8, 6), 0.0); break;
      case 'bulb': {
        const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.6, 5), materials.get('rubber'));
        cord.position.y = 0.3; obj.add(cord);
        if (!addModel('lightbulb_01', -0.02)) glow(new THREE.SphereGeometry(0.04, 10, 8), -0.02);
        glow(new THREE.SphereGeometry(0.022, 8, 6), -0.025);
        break;
      }
      case 'caged': {
        const cage = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.2, 10, 1, true), new THREE.MeshStandardMaterial({ color: '#2a2b2c', wireframe: true }));
        cage.position.y = -0.04; obj.add(cage);
        const base = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.06, 12), materials.get('metal_dark'));
        base.position.y = 0.06; obj.add(base);
        glow(new THREE.SphereGeometry(0.045, 10, 8), -0.04);
        break;
      }
      case 'floodlight': {
        const housing = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.2, 0.4), materials.get('metal_dark'));
        housing.position.y = 0.1; obj.add(housing);
        glow(new THREE.BoxGeometry(0.52, 0.01, 0.32), -0.005);
        const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.4, 6), materials.get('metal_dark'));
        rod.position.y = 0.4; obj.add(rod);
        break;
      }
    }
    room.group.add(obj);
    const v: VirtualLight = {
      id: li.id, room: li.room, pos: new THREE.Vector3(li.x, li.y - 0.12, li.z), dir, color, intensity: li.intensity * LIGHT_GAIN, range: li.range * 1.15, angle: li.angle,
      broken: li.broken, flicker: li.flicker, seed: li.id * 1.37 + 0.5, enabled: true, level: 1, glows: [{ mat: glowMat, base: glowMat.color.clone() }], cone: null, surge: 0,
    };
    if (this.cones && !li.wall && li.fixture !== 'chandelier') {
      const h = Math.min(li.y - this.level.rooms[li.room].y, 5.5);
      const cone = makeCone(color, h, li.angle);
      cone.position.set(li.x, li.y - 0.05, li.z);
      room.group.add(cone);
      v.cone = cone;
    }
    if (li.broken) glowMat.color.multiplyScalar(0.05);
    this.view.lights.push(v);
    const list = this.view.lightsByRoom.get(li.room) ?? [];
    list.push(v);
    this.view.lightsByRoom.set(li.room, list);
  }

  // ------------------------------------------------------------------ static models
  private staticModel(s: LevelData['statics'][number]) {
    const room = this.view.rooms[s.room];
    const m = assets.instance(s.model);
    if (!room || !m) return;
    m.position.set(s.x, s.y, s.z);
    m.rotation.y = s.rotY;
    m.scale.setScalar(s.scale);
    m.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; o.matrixAutoUpdate = false; o.updateMatrix(); } });
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    room.group.add(m);
  }

  // ------------------------------------------------------------------ interactables
  private interactable(it: InteractableData) {
    const room = this.view.rooms[it.room];
    if (!room) return;
    const obj = new THREE.Group();
    obj.position.set(it.x, it.y, it.z);
    obj.rotation.y = it.rotY;
    const parts: Record<string, THREE.Object3D> = {};
    let led: THREE.MeshBasicMaterial | null = null;
    const M = (k: string) => materials.get(k);
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0, name?: string) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; obj.add(m); if (name) parts[name] = m; return m; };
    switch (it.kind) {
      case 'breaker': {
        add(new THREE.BoxGeometry(0.5, 0.7, 0.14), M('metal_painted'), 0, 0, 0.07);
        add(new THREE.BoxGeometry(0.42, 0.24, 0.02), M('hazard'), 0, 0.24, 0.145);
        const lever = new THREE.Group(); lever.position.set(0, -0.05, 0.16);
        const h = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.26, 0.05), M('plastic_red')); h.position.y = 0.1; lever.add(h);
        obj.add(lever); parts.lever = lever;
        led = new THREE.MeshBasicMaterial({ color: '#ff4a3a' });
        add(new THREE.SphereGeometry(0.018, 8, 6), led, 0.18, -0.25, 0.15);
        const label = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.12), materials.sign(`Sector ${it.target}`, 'breaker', 'light'));
        label.position.set(0, 0.47, 0.01); obj.add(label);
        break;
      }
      case 'lightSwitch': {
        add(new THREE.BoxGeometry(0.08, 0.12, 0.015), M('plastic_white'), 0, 0, 0.008);
        const tog = add(new THREE.BoxGeometry(0.02, 0.04, 0.02), M('plastic_white'), 0, 0.01, 0.02, 'toggle');
        tog.rotation.x = -0.4;
        break;
      }
      case 'tube': {
        add(new THREE.BoxGeometry(0.18, 0.24, 0.06), M('plastic_dark'), 0, 0, 0.03);
        add(new THREE.CylinderGeometry(0.04, 0.04, 0.03, 14), M('plastic_red'), 0, -0.03, 0.07).rotation.x = Math.PI / 2;
        led = new THREE.MeshBasicMaterial({ color: '#7dff9a' });
        add(new THREE.BoxGeometry(0.12, 0.02, 0.01), led, 0, 0.08, 0.062);
        break;
      }
      case 'keycard': {
        add(new THREE.BoxGeometry(0.086, 0.004, 0.054), M('keycard'));
        add(new THREE.BoxGeometry(0.07, 0.0045, 0.012), M('led_amber'), 0, 0, -0.012);
        break;
      }
      case 'document': {
        const m = add(new THREE.BoxGeometry(0.21, 0.003, 0.297), M('paper'));
        m.castShadow = false;
        break;
      }
      case 'terminal': {
        add(new THREE.BoxGeometry(0.62, 0.42, 0.08), M('plastic_dark'), 0, 0.1, 0.04);
        add(new THREE.PlaneGeometry(0.54, 0.34), M('screen_on'), 0, 0.1, 0.082);
        add(new THREE.BoxGeometry(0.5, 0.03, 0.22), M('plastic_dark'), 0, -0.2, 0.15);
        break;
      }
      case 'hiddenTrigger': {
        if (this.theme.id === 'luxury') { add(new THREE.CylinderGeometry(0.03, 0.05, 0.16, 10), M('brass'), 0, 0, 0.08); add(new THREE.CylinderGeometry(0.012, 0.012, 0.1, 6), M('plastic_white'), 0, 0.12, 0.08); }
        else { add(new THREE.BoxGeometry(0.16, 0.1, 0.06), M('metal_dark'), 0, 0, 0.03); add(new THREE.CylinderGeometry(0.015, 0.015, 0.12, 6), M('rusty'), 0, 0.05, 0.08, 'handle'); }
        break;
      }
      case 'supply': {
        add(new THREE.BoxGeometry(0.6, 0.36, 0.42), M('plastic_dark'), 0, -0.12, 0);
        const lid = new THREE.Group(); lid.position.set(0, 0.06, -0.21);
        const lm = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.06, 0.44), M('plastic_yellow')); lm.position.z = 0.22; lm.castShadow = true; lid.add(lm);
        obj.add(lid); parts.lid = lid;
        add(new THREE.BoxGeometry(0.3, 0.12, 0.005), materials.sign('Supplies', '', 'hazard'), 0, -0.1, 0.212);
        break;
      }
      case 'liftLever': {
        add(new THREE.BoxGeometry(0.34, 1.0, 0.24), M('metal_dark'), 0, -0.55, 0);
        const lever = new THREE.Group(); lever.position.set(0, 0.0, 0.1);
        const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.5, 8), M('steel')); rod.position.y = 0.22; lever.add(rod);
        const knob = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 10), M('plastic_red')); knob.position.y = 0.48; lever.add(knob);
        lever.rotation.x = 0.55;
        obj.add(lever); parts.lever = lever;
        led = new THREE.MeshBasicMaterial({ color: '#ff4a3a' });
        add(new THREE.BoxGeometry(0.2, 0.04, 0.02), led, 0, -0.15, 0.125);
        break;
      }
      case 'valveWheel': {
        add(new THREE.CylinderGeometry(0.04, 0.04, 0.2, 10), M('rusty'), 0, 0, 0.1).rotation.x = Math.PI / 2;
        const wheel = new THREE.Group(); wheel.position.z = 0.2;
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.018, 8, 24), M('plastic_red')); wheel.add(ring);
        for (let i = 0; i < 3; i++) { const sp = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.02, 0.02), M('plastic_red')); sp.rotation.z = (i * Math.PI) / 3; wheel.add(sp); }
        obj.add(wheel); parts.wheel = wheel;
        break;
      }
      default: add(new THREE.BoxGeometry(0.2, 0.2, 0.2), M('metal_dark'));
    }
    obj.userData.inter = it.id;
    obj.traverse((o) => { o.userData.inter = it.id; });
    room.group.add(obj);
    this.view.inters.push({ data: it, obj, state: 0, parts, led });
  }

  // ------------------------------------------------------------------ hazards
  private hazard(h: HazardData) {
    const room = this.view.rooms[h.room];
    if (!room) return;
    const obj = new THREE.Group();
    obj.position.set(h.x, h.y, h.z);
    const M = (k: string) => materials.get(k);
    switch (h.kind) {
      case 'steam': {
        const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.5, 12), M('rusty'));
        pipe.position.y = h.hy + 0.2; obj.add(pipe);
        const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.08, 0.12, 12), M('metal_dark'));
        nozzle.position.y = h.hy - 0.06; obj.add(nozzle);
        break;
      }
      case 'water': {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(h.hx * 2, h.hz * 2), M('water'));
        m.rotation.x = -Math.PI / 2; m.position.y = -h.hy + 0.02 + 0.13; m.receiveShadow = true; obj.add(m);
        const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, h.hx * 1.6, 6), M('rubber'));
        cable.rotation.z = Math.PI / 2; cable.position.set(0, -h.hy + 0.16, h.hz * 0.3); obj.add(cable);
        break;
      }
      case 'laser': {
        const beams = new THREE.Group();
        const lm = new THREE.MeshBasicMaterial({ color: new THREE.Color('#ff2a1a').multiplyScalar(3), transparent: true, opacity: 0.85 });
        const span = Math.max(h.hx, h.hz) * 2;
        for (let i = 0; i < 4; i++) {
          const b = new THREE.Mesh(new THREE.BoxGeometry(h.hx > h.hz ? span : 0.008, 0.008, h.hz > h.hx ? span : 0.008), lm);
          b.position.y = -0.55 + i * 0.4;
          beams.add(b);
        }
        obj.add(beams);
        obj.userData.beams = beams;
        for (const s of [-1, 1]) {
          const em = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.6, 0.08), M('metal_dark'));
          em.position.set(h.hx > h.hz ? s * (span / 2) : 0, 0, h.hz > h.hx ? s * (span / 2) : 0);
          obj.add(em);
        }
        break;
      }
      case 'sparks': {
        const box = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.5, 0.15), M('metal_painted'));
        box.position.y = 0.6; obj.add(box);
        const wire = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.5, 5), M('rubber'));
        wire.position.set(0.1, 0.25, 0.05); wire.rotation.z = 0.4; obj.add(wire);
        break;
      }
      default: break;
    }
    room.group.add(obj);
    this.view.hazards.push({ data: h, obj, on: true });
  }

  // ------------------------------------------------------------------ signage
  private signs() {
    const L = this.level;
    const prefix = this.theme.id === 'research' ? 'K' : this.theme.id === 'industrial' ? 'V' : this.theme.id === 'underground' ? 'S9' : 'A';
    for (const d of L.doors) {
      if (d.kind === 'hidden' || d.kind === 'arch') continue;
      const [a, b] = d.rooms;
      const ra = L.rooms[a], rb = b >= 0 ? L.rooms[b] : null;
      // label the non-corridor room, placed on the corridor side
      let target = rb && !rb.corridor ? rb : !ra.corridor ? ra : null;
      if (!target || target.type === 'stairs') { if (rb?.stair || ra.stair) target = rb?.stair ? rb : ra; else continue; }
      const other = target === ra ? rb : ra;
      if (!other) continue;
      const num = `${prefix}-${String(target.id + 1).padStart(2, '0')}`;
      const mat = materials.sign(target.name, num, target.locked ? 'hazard' : target.stair ? 'exit' : 'dark');
      const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.2), mat);
      // which side is "other"
      const ocx = (other.x0 + other.x1) / 2, ocz = (other.z0 + other.z1) / 2;
      const off = d.width / 2 + 0.55;
      if (d.axis === 'x') {
        const s = Math.sign(ocz - d.z) || 1;
        plate.position.set(d.x + off, d.y + 1.75, d.z + s * (WT / 2 + 0.01));
        plate.rotation.y = s > 0 ? 0 : Math.PI;
      } else {
        const s = Math.sign(ocx - d.x) || 1;
        plate.position.set(d.x + s * (WT / 2 + 0.01), d.y + 1.75, d.z + off);
        plate.rotation.y = s > 0 ? Math.PI / 2 : -Math.PI / 2;
      }
      this.view.rooms[other.id].group.add(plate);
    }
  }

  // ------------------------------------------------------------------ lift
  private liftExtras() {
    const e = this.level.extraction;
    const room = this.view.rooms[e.room];
    // gate
    const gate = new THREE.Group();
    const width = e.gate.width;
    const gm = materials.get('steel');
    for (let x = -width / 2; x <= width / 2 + 0.01; x += 0.16) { const bar = new THREE.Mesh(new THREE.BoxGeometry(0.03, 2.6, 0.03), gm); bar.position.set(x, 1.3, 0); bar.castShadow = true; gate.add(bar); }
    for (const y of [0.1, 1.3, 2.55]) { const rail = new THREE.Mesh(new THREE.BoxGeometry(width, 0.06, 0.05), materials.get('metal_dark')); rail.position.set(0, y, 0); gate.add(rail); }
    gate.position.set(e.gate.x, e.zone.y, e.gate.z);
    room.group.add(gate);
    this.view.liftGate = gate;
    // quota board
    const c = document.createElement('canvas');
    c.width = 512; c.height = 192;
    const ctx = c.getContext('2d')!;
    const tex = canvasTex(512, 192, () => {}, true, false);
    (tex as unknown as { image: HTMLCanvasElement }).image = c;
    const board = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.9), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
    board.position.set(e.board.x, e.board.y, e.board.z - 0.02);
    board.rotation.y = e.board.rotY;
    const frame = new THREE.Mesh(new THREE.BoxGeometry(2.55, 1.05, 0.08), materials.get('metal_dark'));
    frame.position.set(e.board.x, e.board.y, e.board.z + 0.03);
    room.group.add(frame, board);
    this.view.board = { ctx, tex };
    // warning stripes on the bay floor at the car edge
    const g = this.gb(e.room);
    g.box('hazard', (e.aboard.x0 + e.aboard.x1) / 2, e.zone.y + 0.005, e.aboard.z0 - 0.15, (e.aboard.x1 - e.aboard.x0) / 2, 0.006, 0.12, { uv: 1 });
  }

  private leds() {
    const leds = this.extras.leds;
    if (!leds.length) return;
    const geo = new THREE.BoxGeometry(0.018, 0.018, 0.006);
    const mat = new THREE.MeshBasicMaterial({ color: '#ffffff' });
    const im = new THREE.InstancedMesh(geo, mat, leds.length);
    const m = new THREE.Matrix4();
    const col = new THREE.Color();
    leds.forEach((l, i) => { m.makeTranslation(l.pos.x, l.pos.y, l.pos.z); im.setMatrixAt(i, m); col.set(l.color).multiplyScalar(2.2); im.setColorAt(i, col); });
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.frustumCulled = false;
    this.view.root.add(im);
    this.view.ledMesh = im;
  }

  private dispose() {
    this.view.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && !m.userData.shared) {
        // geometries of model instances are shared with the asset cache; only free our own
        if (m.geometry && !(m.geometry as unknown as { userData: { cached?: boolean } }).userData?.cached && m.name !== '') m.geometry.dispose();
      }
    });
    this.view.root.removeFromParent();
  }
}

import { VALUABLE_BY_ID } from '../../../shared/catalog/valuables';
function valModel(def: string) { return VALUABLE_BY_ID[def]?.model ?? def; }
