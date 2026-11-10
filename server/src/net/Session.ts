import type { WebSocket } from 'ws';
import type { S2C } from '../../../shared/protocol';
import type { Profile } from '../../../shared/profile';
import type { Room } from '../lobby/Room';
import { log } from '../log';

/** simple token bucket */
export class Bucket {
  private tokens: number;
  private last = Date.now();
  constructor(private rate: number, private burst: number) { this.tokens = burst; }
  take(n = 1): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}

let nextConn = 1;

export class Session {
  readonly conn = nextConn++;
  playerId: string | null = null;
  profile: Profile | null = null;
  room: Room | null = null;
  rtt = 0;
  pingSentAt = 0;
  lastRecv = Date.now();
  closed = false;
  readonly ip: string;
  readonly jsonBucket = new Bucket(60, 140);
  readonly binBucket = new Bucket(75, 150);
  readonly chatBucket = new Bucket(2, 6);
  readonly econBucket = new Bucket(4, 10);
  readonly voiceBucket = new Bucket(60, 90);
  violations = 0;
  bytesIn = 0;
  bytesOut = 0;

  constructor(readonly ws: WebSocket, ip: string) {
    this.ip = ip;
  }

  send(msg: S2C) {
    if (this.closed || this.ws.readyState !== 1) return;
    const s = JSON.stringify(msg);
    this.bytesOut += s.length;
    this.ws.send(s);
  }

  sendBin(buf: Uint8Array) {
    if (this.closed || this.ws.readyState !== 1) return;
    // drop state packets for congested sockets instead of buffering without bound
    if (this.ws.bufferedAmount > 512 * 1024) return;
    this.bytesOut += buf.byteLength;
    this.ws.send(buf, { binary: true });
  }

  violation(what: string) {
    this.violations++;
    if (this.violations % 20 === 1) log.warn(`rate/validation violation from ${this.playerId ?? this.conn}: ${what} (${this.violations})`);
    if (this.violations > 400) this.close(4008, 'too many invalid messages');
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    this.closed = true;
    try { this.ws.close(code, reason); } catch { /* ignore */ }
  }
}
