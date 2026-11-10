// Wire protocol. JSON text frames for control/reliable events, binary frames for state.

import type { Appearance, Loadout, LoadoutSlot } from './catalog/items';
import type { MapId } from './catalog/maps';
import type { MonsterId } from './catalog/monsters';
import type { Profile } from './profile';

// ------------------------------------------------------------------ shared shapes
export type V3 = [number, number, number];
export type Q4 = [number, number, number, number];

export type RoomMode = 'coop' | 'solo' | 'practice';
export type RoomPhase = 'lobby' | 'loading' | 'mission' | 'results';

export interface MemberInfo {
  id: string;
  name: string;
  level: number;
  ready: boolean;
  host: boolean;
  connected: boolean;
  ping: number;
  appearance: Appearance;
  netId: number;
}

export interface RoomInfo {
  code: string;
  mode: RoomMode;
  phase: RoomPhase;
  hostId: string;
  members: MemberInfo[];
  settings: { map: MapId | 'random'; difficulty: number; voiceNoise: boolean };
  streak: number;
  maxPlayers: number;
  lastResult?: { success: boolean; value: number; map: MapId };
}

export interface MissionPlayerInfo { netId: number; id: string; name: string; appearance: Appearance; level: number }

export interface MissionInfo {
  mid: string;
  map: MapId;
  seed: string;
  difficulty: number;
  crew: number;
  streak: number;
  quota: number;
  players: MissionPlayerInfo[];
  startAt: number;     // server time when control is released
  window: number;      // contract window seconds
  practice: boolean;
}

export interface PropState {
  id: number;
  def: string;          // valuable id or model id
  kind: 'valuable' | 'furniture' | 'thrown' | 'debris';
  p: V3;
  q: Q4;
  value: number;
  base: number;
  owner: number;        // netId or -1
  helpers: number[];
  mass: number;
}

export interface PlayerMState { netId: number; hp: number; state: PlayerLife; items: Record<string, number>; battery: number }
export type PlayerLife = 'alive' | 'downed' | 'dead' | 'extracted' | 'left';

export interface MissionStateFull {
  props: PropState[];
  doors: { id: number; open: boolean; locked: boolean; broken: boolean }[];
  inters: { id: number; state: number }[];
  sectors: { id: number; on: boolean }[];
  lightsOff: number[];
  players: PlayerMState[];
  keys: number[];
  quota: QuotaState;
  lift: LiftState;
  enemies: { id: number; type: MonsterId }[];
  placed: PlacedLight[];
  hazardsOff: number[];
  now: number;
  overtimeAt: number;
  mapUntil: number;
  docsRead: string[];
}

export interface QuotaState { quota: number; inZone: number; tubed: number; banked: number }
export interface LiftState { state: 'locked' | 'ready' | 'countdown' | 'departing' | 'gone'; until: number; aboard: number[] }
export interface PlacedLight { id: number; kind: 'flare' | 'glowstick' | 'decoy'; p: V3; until: number }

export type GameEvent =
  | { k: 'prop+'; p: PropState }
  | { k: 'prop-'; id: number; why: 'tube' | 'broken' | 'extracted' | 'despawn' | 'crushed' | 'exploded' }
  | { k: 'val'; id: number; v: number; dmg: number; p: V3 }
  | { k: 'own'; id: number; owner: number; helpers: number[]; lp: Record<number, V3> }
  | { k: 'door'; id: number; open: boolean; locked: boolean; broken: boolean; by: number; smash?: boolean }
  | { k: 'inter'; id: number; state: number; by: number }
  | { k: 'power'; sector: number; on: boolean; by: number }
  | { k: 'light'; room: number; on: boolean }
  | { k: 'dmg'; target: number; amount: number; hp: number; src: string; from?: V3; kb?: V3 }
  | { k: 'life'; id: number; state: PlayerLife; hp: number; by?: number }
  | { k: 'heal'; id: number; hp: number }
  | { k: 'enemy+'; id: number; type: MonsterId }
  | { k: 'enemy-'; id: number; why: string }
  | { k: 'eatk'; id: number; target: number; kind: string }
  | { k: 'sfx'; s: string; p: V3; v: number; r?: number; e?: number }
  | { k: 'quota'; q: QuotaState }
  | { k: 'lift'; l: LiftState }
  | { k: 'msg'; text: string; kind: 'dispatch' | 'warn' | 'info' | 'good' }
  | { k: 'director'; name: string; on: boolean; until?: number; data?: number }
  | { k: 'mark'; id: number; until: number }
  | { k: 'pin'; id: number; by: number }
  | { k: 'items'; id: number; items: Record<string, number>; battery: number }
  | { k: 'keys'; keys: number[] }
  | { k: 'doc'; doc: string; by: number }
  | { k: 'scan'; by: number; p: V3; r: number; until: number }
  | { k: 'placed'; l: PlacedLight }
  | { k: 'placed-'; id: number }
  | { k: 'map'; until: number }
  | { k: 'hazard'; id: number; on: boolean }
  | { k: 'stun'; id: number; until: number }
  | { k: 'boom'; p: V3; r: number }
  | { k: 'overtime' }
  | { k: 'use'; id: number; item: string; target?: number }
  | { k: 'revive'; id: number; by: number; progress: number }
  | { k: 'impulse'; id: number; v: V3 }
  | { k: 'tube'; id: number; sent: number; value: number }
  | { k: 'ping'; by: number; p: V3 };

export interface MissionResultPlayer {
  id: string; name: string; netId: number;
  state: PlayerLife;
  delivered: number;       // value personally delivered
  items: number;
  earned: number;
  xp: number;
  levelBefore: number;
  levelAfter: number;
  newAchievements: string[];
  revives: number;
  damageTaken: number;
}

export interface MissionResults {
  mid: string;
  success: boolean;
  reason: string;
  map: MapId;
  difficulty: number;
  quota: number;
  extracted: number;
  tubed: number;
  lostValue: number;
  duration: number;
  streak: number;
  bonus: { label: string; amount: number }[];
  players: MissionResultPlayer[];
}

// ------------------------------------------------------------------ JSON messages
export type C2S =
  | { t: 'hello'; token?: string; name?: string; v: number }
  | { t: 'setName'; name: string }
  | { t: 'create'; mode: RoomMode }
  | { t: 'join'; code: string }
  | { t: 'leave' }
  | { t: 'ready'; ready: boolean }
  | { t: 'kick'; id: string }
  | { t: 'settings'; map?: MapId | 'random'; difficulty?: number; voiceNoise?: boolean }
  | { t: 'start' }
  | { t: 'chat'; text: string }
  | { t: 'rtc'; to: string; data: unknown }
  | { t: 'ping'; c: number }
  | { t: 'buy'; item: string; req: number }
  | { t: 'loadout'; loadout: Loadout }
  | { t: 'appearance'; appearance: Appearance }
  | { t: 'grab'; prop: number; lp: V3; req: number }
  | { t: 'release'; prop: number; p: V3; q: Q4; v: V3; w: V3; thrown: boolean }
  | { t: 'interact'; target: number; kind: 'door' | 'inter' | 'player'; req: number; hold?: boolean }
  | { t: 'use'; slot: LoadoutSlot; req: number; target?: number; aim?: [number, number, number, number, number, number] }
  | { t: 'impact'; prop: number; speed: number; enemy?: number }
  | { t: 'voice'; level: number }
  | { t: 'toLobby' }
  | { t: 'abandon' }
  | { t: 'spectate'; target: number }
  | { t: 'mark'; p: V3 }
  | { t: 'dev'; cmd: string; args: string[] };

export type S2C =
  | { t: 'welcome'; id: string; token: string; profile: Profile; serverTime: number; dev: boolean; ice: { urls: string | string[]; username?: string; credential?: string }[]; v: number }
  | { t: 'profile'; profile: Profile; reason?: string }
  | { t: 'room'; room: RoomInfo }
  | { t: 'left'; reason: string }
  | { t: 'err'; code: string; msg: string; req?: number }
  | { t: 'chat'; from: string; name: string; text: string; sys?: boolean }
  | { t: 'rtc'; from: string; data: unknown }
  | { t: 'pong'; c: number; s: number }
  | { t: 'mission'; info: MissionInfo }
  | { t: 'mstate'; state: MissionStateFull }
  | { t: 'ev'; e: GameEvent[] }
  | { t: 'results'; results: MissionResults }
  | { t: 'correct'; p: V3; v: V3; epoch: number }
  | { t: 'grabRes'; prop: number; ok: boolean; role: 'owner' | 'helper' | 'none'; req: number }
  | { t: 'dev'; text: string };

// ------------------------------------------------------------------ binary
export const BIN = { STATE: 1, SNAPSHOT: 2, VOICE: 3 } as const;

export const PF = {
  CROUCH: 1 << 0, SPRINT: 1 << 1, GROUNDED: 1 << 2, LIGHT: 1 << 3, TALKING: 1 << 4, HOLDING: 1 << 5,
  DOWNED: 1 << 6, DEAD: 1 << 7, PINNED: 1 << 8, MARKED: 1 << 9, RADIO: 1 << 10, EXTRACTED: 1 << 11,
  DISCONNECTED: 1 << 12, STUNNED: 1 << 13, TRACKER: 1 << 14, HEALING: 1 << 15,
} as const;

export class BinWriter {
  buf: ArrayBuffer;
  view: DataView;
  off = 0;
  constructor(size = 1024) { this.buf = new ArrayBuffer(size); this.view = new DataView(this.buf); }
  private ensure(n: number) {
    if (this.off + n <= this.buf.byteLength) return;
    let s = this.buf.byteLength * 2;
    while (s < this.off + n) s *= 2;
    const nb = new ArrayBuffer(s);
    new Uint8Array(nb).set(new Uint8Array(this.buf, 0, this.off));
    this.buf = nb; this.view = new DataView(nb);
  }
  reset() { this.off = 0; return this; }
  u8(v: number) { this.ensure(1); this.view.setUint8(this.off, v); this.off += 1; }
  u16(v: number) { this.ensure(2); this.view.setUint16(this.off, v, true); this.off += 2; }
  i16(v: number) { this.ensure(2); this.view.setInt16(this.off, Math.max(-32767, Math.min(32767, Math.round(v))), true); this.off += 2; }
  u32(v: number) { this.ensure(4); this.view.setUint32(this.off, v >>> 0, true); this.off += 4; }
  f32(v: number) { this.ensure(4); this.view.setFloat32(this.off, v, true); this.off += 4; }
  f64(v: number) { this.ensure(8); this.view.setFloat64(this.off, v, true); this.off += 8; }
  bytes(b: Uint8Array) { this.ensure(b.length); new Uint8Array(this.buf, this.off, b.length).set(b); this.off += b.length; }
  finish(): Uint8Array { return new Uint8Array(this.buf.slice(0, this.off)); }
}

export class BinReader {
  view: DataView;
  off = 0;
  constructor(data: ArrayBuffer | Uint8Array) {
    if (data instanceof Uint8Array) this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    else this.view = new DataView(data);
  }
  get remaining() { return this.view.byteLength - this.off; }
  u8() { const v = this.view.getUint8(this.off); this.off += 1; return v; }
  u16() { const v = this.view.getUint16(this.off, true); this.off += 2; return v; }
  i16() { const v = this.view.getInt16(this.off, true); this.off += 2; return v; }
  u32() { const v = this.view.getUint32(this.off, true); this.off += 4; return v; }
  f32() { const v = this.view.getFloat32(this.off, true); this.off += 4; return v; }
  f64() { const v = this.view.getFloat64(this.off, true); this.off += 8; return v; }
  bytes(n: number) { const b = new Uint8Array(this.view.buffer, this.view.byteOffset + this.off, n); this.off += n; return b; }
}

const TAU = Math.PI * 2;
export const qYaw = (yaw: number) => Math.round((((yaw % TAU) + TAU) % TAU) / TAU * 65535) & 0xffff;
export const dqYaw = (v: number) => (v / 65535) * TAU;

// ---- client → server player state
export interface OwnedPropState { id: number; p: V3; q: Q4; v: V3; w: V3 }
export interface ClientState {
  seq: number;
  p: V3;
  v: V3;
  yaw: number;
  pitch: number;
  flags: number;
  anim: number;
  /** last correction epoch the client applied (server ignores older packets) */
  epoch: number;
  owned: OwnedPropState[];
  /** helper hold target (world) */
  help: { prop: number; t: V3 } | null;
  /** held object's hold target (owner) for tether/remote rendering */
  hold: V3 | null;
}

export function encodeClientState(w: BinWriter, s: ClientState): Uint8Array {
  w.reset();
  w.u8(BIN.STATE);
  w.u16(s.seq & 0xffff);
  w.f32(s.p[0]); w.f32(s.p[1]); w.f32(s.p[2]);
  w.i16(s.v[0] * 100); w.i16(s.v[1] * 100); w.i16(s.v[2] * 100);
  w.u16(qYaw(s.yaw)); w.i16(s.pitch * 10000);
  w.u16(s.flags); w.u8(s.anim); w.u8(s.epoch & 0xff);
  w.u8(s.owned.length);
  for (const o of s.owned) {
    w.u16(o.id);
    w.f32(o.p[0]); w.f32(o.p[1]); w.f32(o.p[2]);
    w.i16(o.q[0] * 32767); w.i16(o.q[1] * 32767); w.i16(o.q[2] * 32767); w.i16(o.q[3] * 32767);
    w.i16(o.v[0] * 100); w.i16(o.v[1] * 100); w.i16(o.v[2] * 100);
    w.i16(o.w[0] * 500); w.i16(o.w[1] * 500); w.i16(o.w[2] * 500);
  }
  if (s.help) { w.u8(1); w.u16(s.help.prop); w.f32(s.help.t[0]); w.f32(s.help.t[1]); w.f32(s.help.t[2]); } else w.u8(0);
  if (s.hold) { w.u8(1); w.f32(s.hold[0]); w.f32(s.hold[1]); w.f32(s.hold[2]); } else w.u8(0);
  return w.finish();
}

function normQ(q: Q4): Q4 {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

export function decodeClientState(r: BinReader): ClientState {
  const seq = r.u16();
  const p: V3 = [r.f32(), r.f32(), r.f32()];
  const v: V3 = [r.i16() / 100, r.i16() / 100, r.i16() / 100];
  const yaw = dqYaw(r.u16());
  const pitch = r.i16() / 10000;
  const flags = r.u16();
  const anim = r.u8();
  const epoch = r.u8();
  const n = r.u8();
  const owned: OwnedPropState[] = [];
  for (let i = 0; i < n; i++) {
    const id = r.u16();
    const pp: V3 = [r.f32(), r.f32(), r.f32()];
    const q = normQ([r.i16() / 32767, r.i16() / 32767, r.i16() / 32767, r.i16() / 32767]);
    const vv: V3 = [r.i16() / 100, r.i16() / 100, r.i16() / 100];
    const ww: V3 = [r.i16() / 500, r.i16() / 500, r.i16() / 500];
    owned.push({ id, p: pp, q, v: vv, w: ww });
  }
  let help: ClientState['help'] = null;
  if (r.u8()) help = { prop: r.u16(), t: [r.f32(), r.f32(), r.f32()] };
  let hold: V3 | null = null;
  if (r.remaining >= 1 && r.u8()) hold = [r.f32(), r.f32(), r.f32()];
  for (const x of [...p, ...v]) if (!Number.isFinite(x)) throw new Error('non-finite state');
  return { seq, p, v, yaw, pitch, flags, anim, epoch, owned, help, hold };
}

// ---- server → client snapshot
export interface SnapPlayer { netId: number; p: V3; yaw: number; pitch: number; v: V3; flags: number; hp: number; anim: number; hold: V3 | null }
export interface SnapProp { id: number; flags: number; p: V3; q: Q4; v: V3 }
export interface SnapEnemy { id: number; type: number; state: number; p: V3; yaw: number; speed: number; aux: number; target: number }
export interface SnapMover { id: number; value: number }
export interface SnapHelper { prop: number; netId: number; t: V3 }
export interface Snapshot { tick: number; time: number; players: SnapPlayer[]; props: SnapProp[]; enemies: SnapEnemy[]; movers: SnapMover[]; helpers: SnapHelper[] }

export const SPF = { ASLEEP: 1, OWNED: 2, KINEMATIC: 4 } as const;

export function encodeSnapshot(w: BinWriter, s: Snapshot): Uint8Array {
  w.reset();
  w.u8(BIN.SNAPSHOT);
  w.u32(s.tick);
  w.f64(s.time);
  w.u8(s.players.length);
  for (const p of s.players) {
    w.u8(p.netId);
    w.f32(p.p[0]); w.f32(p.p[1]); w.f32(p.p[2]);
    w.u16(qYaw(p.yaw)); w.i16(p.pitch * 10000);
    w.i16(p.v[0] * 100); w.i16(p.v[1] * 100); w.i16(p.v[2] * 100);
    w.u16(p.flags); w.u8(Math.max(0, Math.min(255, Math.round(p.hp)))); w.u8(p.anim);
    if (p.hold) { w.u8(1); w.f32(p.hold[0]); w.f32(p.hold[1]); w.f32(p.hold[2]); } else w.u8(0);
  }
  w.u16(s.props.length);
  for (const p of s.props) {
    w.u16(p.id); w.u8(p.flags);
    w.f32(p.p[0]); w.f32(p.p[1]); w.f32(p.p[2]);
    w.i16(p.q[0] * 32767); w.i16(p.q[1] * 32767); w.i16(p.q[2] * 32767); w.i16(p.q[3] * 32767);
    w.i16(p.v[0] * 100); w.i16(p.v[1] * 100); w.i16(p.v[2] * 100);
  }
  w.u8(s.enemies.length);
  for (const e of s.enemies) {
    w.u16(e.id); w.u8(e.type); w.u8(e.state);
    w.f32(e.p[0]); w.f32(e.p[1]); w.f32(e.p[2]);
    w.u16(qYaw(e.yaw)); w.u8(Math.max(0, Math.min(255, Math.round(e.speed * 20)))); w.u8(e.aux & 0xff); w.u8(e.target < 0 ? 255 : e.target);
  }
  w.u8(s.movers.length);
  for (const m of s.movers) { w.u16(m.id); w.f32(m.value); }
  w.u8(s.helpers.length);
  for (const h of s.helpers) { w.u16(h.prop); w.u8(h.netId); w.f32(h.t[0]); w.f32(h.t[1]); w.f32(h.t[2]); }
  return w.finish();
}

export function decodeSnapshot(r: BinReader): Snapshot {
  const tick = r.u32();
  const time = r.f64();
  const players: SnapPlayer[] = [];
  const np = r.u8();
  for (let i = 0; i < np; i++) {
    const netId = r.u8();
    const p: V3 = [r.f32(), r.f32(), r.f32()];
    const yaw = dqYaw(r.u16());
    const pitch = r.i16() / 10000;
    const v: V3 = [r.i16() / 100, r.i16() / 100, r.i16() / 100];
    const flags = r.u16(); const hp = r.u8(); const anim = r.u8();
    const hold: V3 | null = r.u8() ? [r.f32(), r.f32(), r.f32()] : null;
    players.push({ netId, p, yaw, pitch, v, flags, hp, anim, hold });
  }
  const props: SnapProp[] = [];
  const nprops = r.u16();
  for (let i = 0; i < nprops; i++) {
    const id = r.u16(); const flags = r.u8();
    const p: V3 = [r.f32(), r.f32(), r.f32()];
    const q = normQ([r.i16() / 32767, r.i16() / 32767, r.i16() / 32767, r.i16() / 32767]);
    const v: V3 = [r.i16() / 100, r.i16() / 100, r.i16() / 100];
    props.push({ id, flags, p, q, v });
  }
  const enemies: SnapEnemy[] = [];
  const ne = r.u8();
  for (let i = 0; i < ne; i++) {
    const id = r.u16(); const type = r.u8(); const state = r.u8();
    const p: V3 = [r.f32(), r.f32(), r.f32()];
    const yaw = dqYaw(r.u16()); const speed = r.u8() / 20; const aux = r.u8(); const t = r.u8();
    enemies.push({ id, type, state, p, yaw, speed, aux, target: t === 255 ? -1 : t });
  }
  const movers: SnapMover[] = [];
  const nm = r.u8();
  for (let i = 0; i < nm; i++) movers.push({ id: r.u16(), value: r.f32() });
  const helpers: SnapHelper[] = [];
  const nh = r.u8();
  for (let i = 0; i < nh; i++) helpers.push({ prop: r.u16(), netId: r.u8(), t: [r.f32(), r.f32(), r.f32()] });
  return { tick, time, players, props, enemies, movers, helpers };
}

export function sanitizeName(name: unknown): string {
  const s = String(name ?? '').replace(/[^\p{L}\p{N} _\-.']/gu, '').trim().slice(0, 18);
  return s || 'Salvager';
}
