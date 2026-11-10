// Headless test client that speaks the real protocol over a real WebSocket.
// Used by the multiplayer integration tests (each bot is an independent client).
import WebSocket from 'ws';
import { PROTOCOL_VERSION } from '../../shared/constants';
import { generateLevel } from '../../shared/levelgen/generate';
import { buildPracticeLevel } from '../../shared/levelgen/practice';
import type { LevelData } from '../../shared/levelgen/types';
import { BIN, BinReader, BinWriter, decodeSnapshot, encodeClientState, PF, type C2S, type ClientState, type GameEvent, type MissionInfo, type MissionStateFull, type RoomInfo, type S2C, type Snapshot, type V3 } from '../../shared/protocol';
import type { Profile } from '../../shared/profile';

export class Bot {
  ws!: WebSocket;
  id = '';
  token = '';
  profile: Profile | null = null;
  room: RoomInfo | null = null;
  mission: MissionInfo | null = null;
  mstate: MissionStateFull | null = null;
  level: LevelData | null = null;
  snap: Snapshot | null = null;
  snaps = 0;
  events: GameEvent[] = [];
  msgs: S2C[] = [];
  errors: S2C[] = [];
  results: Extract<S2C, { t: 'results' }>['results'] | null = null;
  epoch = 0;
  seq = 0;
  pos: V3 = [0, 0, 0];
  yaw = 0;
  pitch = 0;
  flags = PF.GROUNDED;
  owned: { id: number; p: V3; q: [number, number, number, number]; v: V3; w: V3 }[] = [];
  closed = false;
  private w = new BinWriter(512);
  private waiters: { pred: (m: S2C) => boolean; resolve: (m: S2C) => void }[] = [];

  constructor(public url: string, public name = 'Bot') {}

  connect(token?: string): Promise<this> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.binaryType = 'arraybuffer';
      this.closed = false;
      this.ws.on('open', () => this.send({ t: 'hello', token: token ?? (this.token || undefined), name: this.name, v: PROTOCOL_VERSION }));
      this.ws.on('message', (data: ArrayBuffer | Buffer, isBinary: boolean) => {
        if (isBinary) {
          const u8 = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array((data as Buffer).buffer, (data as Buffer).byteOffset, (data as Buffer).byteLength);
          const r = new BinReader(u8);
          if (r.u8() === BIN.SNAPSHOT) { this.snap = decodeSnapshot(r); this.snaps++; }
          return;
        }
        const m = JSON.parse(data.toString()) as S2C;
        this.onMsg(m);
        if (m.t === 'welcome') resolve(this);
      });
      this.ws.on('error', (e) => reject(e));
      this.ws.on('close', () => { this.closed = true; });
    });
  }

  private onMsg(m: S2C) {
    this.msgs.push(m);
    switch (m.t) {
      case 'welcome': this.id = m.id; this.token = m.token; this.profile = m.profile; break;
      case 'profile': this.profile = m.profile; break;
      case 'room': this.room = m.room; break;
      case 'err': this.errors.push(m); break;
      case 'mission':
        this.mission = m.info;
        this.level = m.info.practice ? buildPracticeLevel() : generateLevel({ map: m.info.map, seed: m.info.seed, difficulty: m.info.difficulty, crew: m.info.crew, streak: m.info.streak });
        { const me = m.info.players.find((p) => p.id === this.id); const idx = m.info.players.indexOf(me!); const sp = this.level.playerSpawns[idx % this.level.playerSpawns.length]; this.pos = [sp.x, sp.y, sp.z]; }
        break;
      case 'mstate': this.mstate = m.state; break;
      case 'ev': this.events.push(...m.e); break;
      case 'correct': this.pos = [...m.p]; this.epoch = m.epoch; break;
      case 'results': this.results = m.results; break;
      default:
    }
    for (const w of [...this.waiters]) if (w.pred(m)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(m); }
  }

  send(m: C2S) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(m)); }

  waitFor<T extends S2C['t']>(t: T, pred: (m: Extract<S2C, { t: T }>) => boolean = () => true, timeout = 8000): Promise<Extract<S2C, { t: T }>> {
    const existing = this.msgs.find((m) => m.t === t && pred(m as Extract<S2C, { t: T }>));
    if (existing) return Promise.resolve(existing as Extract<S2C, { t: T }>);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.name}: timeout waiting for ${t}`)), timeout);
      this.waiters.push({ pred: (m) => m.t === t && pred(m as Extract<S2C, { t: T }>), resolve: (m) => { clearTimeout(timer); resolve(m as Extract<S2C, { t: T }>); } });
    });
  }

  waitEvent<K extends GameEvent['k']>(k: K, pred: (e: Extract<GameEvent, { k: K }>) => boolean = () => true, timeout = 8000): Promise<Extract<GameEvent, { k: K }>> {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const check = () => {
        const e = this.events.find((x) => x.k === k && pred(x as Extract<GameEvent, { k: K }>));
        if (e) return resolve(e as Extract<GameEvent, { k: K }>);
        if (Date.now() - start > timeout) return reject(new Error(`${this.name}: timeout waiting for event ${k}`));
        setTimeout(check, 20);
      };
      check();
    });
  }

  clearMsgs() { this.msgs = []; this.events = []; }

  sendState(extra: Partial<ClientState> = {}) {
    const s: ClientState = { seq: this.seq++, p: this.pos, v: [0, 0, 0], yaw: this.yaw, pitch: this.pitch, flags: this.flags, anim: 0, epoch: this.epoch, owned: this.owned, help: null, hold: null, ...extra };
    if (this.ws.readyState === 1) this.ws.send(encodeClientState(this.w, s));
  }

  /** walk toward a point at `speed` m/s, sending 30 Hz states (straight line) */
  async walkTo(target: V3, speed = 3, maxTime = 20): Promise<void> {
    const dt = 1 / 30;
    const t0 = Date.now();
    while (Date.now() - t0 < maxTime * 1000) {
      const dx = target[0] - this.pos[0], dz = target[2] - this.pos[2];
      const d = Math.hypot(dx, dz);
      if (d < 0.15) break;
      const step = Math.min(d, speed * dt);
      this.pos = [this.pos[0] + (dx / d) * step, target[1], this.pos[2] + (dz / d) * step];
      this.yaw = Math.atan2(-dx, -dz);
      this.sendState({ v: [(dx / d) * speed, 0, (dz / d) * speed] });
      await sleep(dt * 1000);
    }
  }

  async idle(seconds: number) { const n = Math.round(seconds * 30); for (let i = 0; i < n; i++) { this.sendState(); await sleep(1000 / 30); } }

  close() { this.ws.close(); }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
