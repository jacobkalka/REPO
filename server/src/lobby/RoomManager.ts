import { ROOM_CODE_ALPHABET } from '../../../shared/rng';
import { NET } from '../../../shared/constants';
import type { RoomMode } from '../../../shared/protocol';
import type { Appearance } from '../../../shared/catalog/items';
import type { GameDatabase } from '../db/Database';
import type { Economy } from '../economy/Economy';
import type { Session } from '../net/Session';
import { Room } from './Room';
import { log } from '../log';
import crypto from 'node:crypto';

export class RoomManager {
  readonly rooms = new Map<string, Room>();
  /** player id → room code (for reconnect) */
  readonly membership = new Map<string, string>();

  constructor(readonly db: GameDatabase, readonly economy: Economy, readonly devMode: boolean) {}

  private newCode(): string {
    for (let attempt = 0; attempt < 1000; attempt++) {
      let c = '';
      const bytes = crypto.randomBytes(5);
      for (let i = 0; i < 5; i++) c += ROOM_CODE_ALPHABET[bytes[i] % ROOM_CODE_ALPHABET.length];
      if (!this.rooms.has(c)) return c;
    }
    throw new Error('room code space exhausted');
  }

  create(session: Session, mode: RoomMode): Room {
    if (session.room) session.room.leave(session.playerId!);
    const room = new Room(this, this.newCode(), mode);
    this.rooms.set(room.code, room);
    room.join(session);
    this.membership.set(session.playerId!, room.code);
    log.info(`room ${room.code} created (${mode}) by ${session.profile?.name}`);
    return room;
  }

  join(session: Session, code: string): string | null {
    const c = String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    const room = this.rooms.get(c);
    if (!room) return 'No crew found with that code. Check the code and try again.';
    if (session.room && session.room !== room) session.room.leave(session.playerId!);
    const err = room.join(session);
    if (!err) this.membership.set(session.playerId!, room.code);
    return err;
  }

  /** rejoin the room a player belonged to (after reconnect / server restart) */
  rejoin(session: Session): Room | null {
    const code = this.membership.get(session.playerId!);
    if (!code) return null;
    const room = this.rooms.get(code);
    if (!room || !room.members.has(session.playerId!)) { this.membership.delete(session.playerId!); return null; }
    room.join(session);
    return room;
  }

  remove(room: Room) {
    this.rooms.delete(room.code);
    for (const [pid, code] of [...this.membership]) if (code === room.code) this.membership.delete(pid);
    try { this.db.deleteLobby(room.code); } catch (e) { log.warn('deleteLobby failed', e); }
    log.info(`room ${room.code} closed`);
  }

  tick(now: number, dt: number) {
    for (const room of [...this.rooms.values()]) {
      room.tick(now, dt);
      for (const [pid, code] of [...this.membership]) if (code === room.code && !room.members.has(pid)) this.membership.delete(pid);
      if (room.members.size === 0) { this.remove(room); continue; }
      if (room.connectedCount === 0 && now - room.lastActive > NET.LOBBY_IDLE_TIMEOUT * 1000) this.remove(room);
    }
  }

  persistDirty() {
    for (const room of this.rooms.values()) {
      if (!room.takeDirty()) continue;
      try { this.db.saveLobby(room.code, room.serialize()); } catch (e) { log.warn('saveLobby failed', e); }
    }
  }

  /** restore lobbies saved before a restart; members are marked disconnected */
  restore() {
    for (const row of this.db.loadLobbies(30 * 60 * 1000)) {
      const d = row.data as { mode: RoomMode; hostId: string; settings: Room['settings']; streak: number; members: { id: string; name: string; level: number; appearance: Appearance; joinedAt: number; netId: number }[] };
      if (!d?.members?.length) { this.db.deleteLobby(row.code); continue; }
      const room = new Room(this, row.code, d.mode);
      room.hostId = d.hostId;
      room.settings = { ...room.settings, ...d.settings };
      room.streak = d.streak ?? 0;
      room.restored = true;
      for (const m of d.members) {
        room.members.set(m.id, { ...m, ready: false, session: null, connected: false, disconnectedAt: Date.now() });
        this.membership.set(m.id, room.code);
      }
      this.rooms.set(room.code, room);
      log.info(`restored lobby ${room.code} with ${room.members.size} member(s)`);
    }
    for (const m of this.db.abortedMissions()) { this.db.markMissionAborted(m.id); log.info(`mission ${m.id} marked aborted after restart`); }
  }

  stats() {
    let players = 0, missions = 0;
    for (const r of this.rooms.values()) { players += r.connectedCount; if (r.mission) missions++; }
    return { rooms: this.rooms.size, players, missions };
  }
}
