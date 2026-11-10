// WebSocket connection: auth, reconnect with backoff, clock sync, typed dispatch.
import { PROTOCOL_VERSION } from '../../../shared/constants';
import { BIN, BinReader, decodeSnapshot, type C2S, type S2C, type Snapshot } from '../../../shared/protocol';
import { Emitter } from '../core/Events';

type Msg<T extends S2C['t']> = Extract<S2C, { t: T }>;
type ConnEvents = { [K in S2C['t']]: Msg<K> } & {
  snapshot: Snapshot;
  status: ConnStatus;
  voiceData: ArrayBuffer;
};
export type ConnStatus = 'connecting' | 'online' | 'reconnecting' | 'offline';

const TOKEN_KEY = 'salvage.token.v1';

export class Connection extends Emitter<ConnEvents> {
  ws: WebSocket | null = null;
  status: ConnStatus = 'offline';
  playerId = '';
  rtt = 0;
  jitter = 0.01;
  bytesIn = 0;
  bytesOut = 0;
  private bwWindow: { t: number; i: number; o: number }[] = [];
  private attempts = 0;
  private pingTimer = 0;
  private wanted = false;
  private clockOffset = 0;      // missionTime - localTime (s)
  private clockReady = false;
  private interp = 0.1;
  lastSnapshotAt = 0;
  serverClockDelta = 0;         // server Date.now() - local Date.now()

  constructor(readonly url: string) { super(); }

  get token(): string | null { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } }
  set token(v: string | null) { try { if (v) localStorage.setItem(TOKEN_KEY, v); else localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } }

  connect(name: string) {
    this.wanted = true;
    this.open(name);
  }

  private open(name: string) {
    this.setStatus(this.attempts ? 'reconnecting' : 'connecting');
    let ws: WebSocket;
    try { ws = new WebSocket(this.url); } catch { this.scheduleReconnect(name); return; }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.send({ t: 'hello', token: this.token ?? undefined, name, v: PROTOCOL_VERSION });
    };
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        this.bytesIn += e.data.length;
        let m: S2C;
        try { m = JSON.parse(e.data); } catch { return; }
        if (m.t === 'welcome') {
          this.attempts = 0;
          this.playerId = m.id;
          this.token = m.token;
          this.serverClockDelta = m.serverTime - Date.now();
          this.setStatus('online');
          clearInterval(this.pingTimer);
          this.pingTimer = window.setInterval(() => this.send({ t: 'ping', c: performance.now() }), 2000);
          this.send({ t: 'ping', c: performance.now() });
        } else if (m.t === 'pong') {
          const rtt = (performance.now() - m.c) / 1000;
          this.rtt = this.rtt ? this.rtt * 0.8 + rtt * 0.2 : rtt;
        } else if (m.t === 'err' && m.code === 'version') {
          this.wanted = false;
        }
        this.emit(m.t, m as never);
        return;
      }
      const buf = e.data as ArrayBuffer;
      this.bytesIn += buf.byteLength;
      const r = new BinReader(buf);
      const type = r.u8();
      if (type === BIN.SNAPSHOT) {
        let snap: Snapshot;
        try { snap = decodeSnapshot(r); } catch (err) { console.warn('bad snapshot', err); return; }
        this.observeClock(snap.time);
        this.emit('snapshot', snap);
      } else if (type === BIN.VOICE) this.emit('voiceData', buf);
    };
    ws.onclose = (e) => {
      clearInterval(this.pingTimer);
      this.ws = null;
      if (e.code === 4001) { this.wanted = false; this.setStatus('offline'); return; }
      if (this.wanted) this.scheduleReconnect(name);
      else this.setStatus('offline');
    };
    ws.onerror = () => { /* close follows */ };
  }

  private scheduleReconnect(name: string) {
    this.setStatus('reconnecting');
    const delay = Math.min(10000, 500 * 2 ** Math.min(this.attempts, 5)) * (0.75 + Math.random() * 0.5);
    this.attempts++;
    setTimeout(() => { if (this.wanted && !this.ws) this.open(name); }, delay);
  }

  private setStatus(s: ConnStatus) { if (this.status !== s) { this.status = s; this.emit('status', s); } }

  send(m: C2S) {
    if (this.ws?.readyState !== 1) return false;
    const s = JSON.stringify(m);
    this.bytesOut += s.length;
    this.ws.send(s);
    return true;
  }

  sendBin(buf: Uint8Array) {
    if (this.ws?.readyState !== 1) return;
    if (this.ws.bufferedAmount > 256 * 1024) return;
    this.bytesOut += buf.byteLength;
    this.ws.send(buf);
  }

  disconnect() { this.wanted = false; this.ws?.close(); }

  // ------------------------------------------------------------- clock / interpolation
  private observeClock(missionTime: number) {
    const local = performance.now() / 1000;
    this.lastSnapshotAt = local;
    const sample = missionTime - local;
    if (!this.clockReady) { this.clockOffset = sample; this.clockReady = true; return; }
    const dev = sample - this.clockOffset;
    this.jitter = this.jitter * 0.95 + Math.abs(dev) * 0.05;
    // fast to catch up with lower-latency samples, slow to drift the other way
    this.clockOffset += dev > 0 ? dev * 0.25 : dev * 0.03;
    const target = Math.min(0.25, Math.max(0.07, 0.055 + this.jitter * 2.8));
    this.interp += (target - this.interp) * 0.05;
  }

  resetClock() { this.clockReady = false; }

  /** estimated current mission time on the server */
  missionTime() { return performance.now() / 1000 + this.clockOffset; }
  /** time at which remote entities are rendered */
  renderTime() { return this.missionTime() - this.interp; }
  get interpDelay() { return this.interp; }

  /** bandwidth in KB/s over the last few seconds */
  bandwidth(): { down: number; up: number } {
    const now = performance.now();
    this.bwWindow.push({ t: now, i: this.bytesIn, o: this.bytesOut });
    while (this.bwWindow.length > 2 && now - this.bwWindow[0].t > 3000) this.bwWindow.shift();
    const a = this.bwWindow[0], b = this.bwWindow[this.bwWindow.length - 1];
    const dt = Math.max(0.001, (b.t - a.t) / 1000);
    return { down: (b.i - a.i) / 1024 / dt, up: (b.o - a.o) / 1024 / dt };
  }
}
