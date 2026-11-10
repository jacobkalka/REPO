// A lobby / crew. Owns membership, host, ready states, settings and the running mission.

import { MAPS, MAP_LIST, type MapId } from '../../../shared/catalog/maps';
import { DIFFICULTIES } from '../../../shared/catalog/difficulty';
import { NET } from '../../../shared/constants';
import type { C2S, MemberInfo, MissionResults, RoomInfo, RoomMode, RoomPhase, S2C } from '../../../shared/protocol';
import type { Appearance } from '../../../shared/catalog/items';
import type { Session } from '../net/Session';
import type { RoomManager } from './RoomManager';
import { Mission } from '../sim/Mission';
import { log } from '../log';

export interface Member {
  id: string;
  name: string;
  level: number;
  appearance: Appearance;
  ready: boolean;
  session: Session | null;
  joinedAt: number;
  connected: boolean;
  disconnectedAt: number;
  netId: number;
}

export class Room {
  phase: RoomPhase = 'lobby';
  hostId = '';
  readonly members = new Map<string, Member>();
  settings: RoomInfo['settings'] = { map: 'random', difficulty: 1, voiceNoise: true };
  streak = 0;
  mission: Mission | null = null;
  lastResult: RoomInfo['lastResult'];
  results: MissionResults | null = null;
  resultsAt = 0;
  readonly createdAt = Date.now();
  lastActive = Date.now();
  restored = false;
  private dirty = true;

  constructor(readonly manager: RoomManager, readonly code: string, readonly mode: RoomMode) {
    if (mode === 'practice') this.settings.difficulty = 0;
  }

  get maxPlayers() { return this.mode === 'solo' ? 1 : NET.MAX_PLAYERS; }
  get connectedCount() { let n = 0; for (const m of this.members.values()) if (m.connected) n++; return n; }

  info(): RoomInfo {
    const members: MemberInfo[] = [...this.members.values()].sort((a, b) => a.joinedAt - b.joinedAt).map((m) => ({
      id: m.id, name: m.name, level: m.level, ready: m.ready, host: m.id === this.hostId, connected: m.connected,
      ping: Math.round(m.session?.rtt ?? 0), appearance: m.appearance, netId: m.netId,
    }));
    return { code: this.code, mode: this.mode, phase: this.phase, hostId: this.hostId, members, settings: this.settings, streak: this.streak, maxPlayers: this.maxPlayers, lastResult: this.lastResult };
  }

  broadcast(msg: S2C, except?: string) {
    const s = JSON.stringify(msg);
    for (const m of this.members.values()) {
      if (m.id === except || !m.session || m.session.closed || m.session.ws.readyState !== 1) continue;
      m.session.bytesOut += s.length;
      m.session.ws.send(s);
    }
  }

  sendInfo() {
    this.dirty = true;
    this.broadcast({ t: 'room', room: this.info() });
  }

  private freeNetId(): number {
    const used = new Set([...this.members.values()].map((m) => m.netId));
    for (let i = 1; i < 250; i++) if (!used.has(i)) return i;
    return 250;
  }

  /** returns error string or null */
  join(session: Session): string | null {
    const pid = session.playerId!;
    const existing = this.members.get(pid);
    if (existing) { this.reconnect(existing, session); return null; }
    if (this.phase !== 'lobby' && this.phase !== 'results') return 'A mission is in progress. Wait for the crew to return to the lobby.';
    if (this.members.size >= this.maxPlayers) return 'That crew is full.';
    const p = session.profile!;
    const m: Member = { id: pid, name: p.name, level: p.level, appearance: p.appearance, ready: false, session, joinedAt: Date.now(), connected: true, disconnectedAt: 0, netId: this.freeNetId() };
    this.members.set(pid, m);
    session.room = this;
    if (!this.hostId || !this.members.has(this.hostId)) this.hostId = pid;
    this.lastActive = Date.now();
    this.sendInfo();
    this.systemChat(`${m.name} joined the crew.`);
    return null;
  }

  reconnect(m: Member, session: Session) {
    if (m.session && m.session !== session && !m.session.closed) m.session.close(4001, 'replaced by a new connection');
    m.session = session;
    m.connected = true;
    m.disconnectedAt = 0;
    session.room = this;
    if (session.profile) { m.name = session.profile.name; m.level = session.profile.level; m.appearance = session.profile.appearance; }
    if (!this.members.has(this.hostId) || !this.members.get(this.hostId)!.connected) this.hostId = m.id;
    this.sendInfo();
    this.systemChat(`${m.name} reconnected.`);
    if (this.mission) this.mission.onReconnect(m);
    if (this.phase === 'results' && this.results) session.send({ t: 'results', results: this.results });
    log.info(`room ${this.code}: ${m.name} reconnected`);
  }

  onDisconnect(session: Session) {
    for (const m of this.members.values()) {
      if (m.session !== session) continue;
      m.connected = false;
      m.disconnectedAt = Date.now();
      m.session = null;
      if (this.mission) this.mission.onDisconnect(m);
      if (m.id === this.hostId) this.migrateHost();
      this.sendInfo();
      this.systemChat(`${m.name} lost connection.`);
    }
  }

  leave(pid: string, reason = 'left') {
    const m = this.members.get(pid);
    if (!m) return;
    this.members.delete(pid);
    if (this.mission) this.mission.onLeave(m);
    if (m.session) { m.session.room = null; m.session.send({ t: 'left', reason }); }
    if (pid === this.hostId) this.migrateHost();
    this.systemChat(`${m.name} ${reason === 'kicked' ? 'was removed from the crew' : 'left the crew'}.`);
    if (this.members.size === 0) { this.manager.remove(this); return; }
    this.sendInfo();
  }

  migrateHost() {
    const cands = [...this.members.values()].filter((m) => m.connected).sort((a, b) => a.joinedAt - b.joinedAt);
    const next = cands[0] ?? [...this.members.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
    if (next && next.id !== this.hostId) {
      this.hostId = next.id;
      this.systemChat(`${next.name} is now the host.`);
    }
  }

  systemChat(text: string) { this.broadcast({ t: 'chat', from: '', name: '', text, sys: true }); }

  handle(session: Session, msg: C2S) {
    const pid = session.playerId!;
    const m = this.members.get(pid);
    if (!m) return;
    this.lastActive = Date.now();
    const isHost = pid === this.hostId;
    switch (msg.t) {
      case 'leave': this.leave(pid); return;
      case 'ready':
        if (this.phase !== 'lobby') return;
        m.ready = !!msg.ready;
        this.sendInfo();
        return;
      case 'kick':
        if (!isHost || msg.id === pid) return session.send({ t: 'err', code: 'not_host', msg: 'Only the host can do that.' });
        if (this.members.has(msg.id)) this.leave(msg.id, 'kicked');
        return;
      case 'settings': {
        if (!isHost || this.phase !== 'lobby') return;
        if (msg.map !== undefined) {
          if (msg.map === 'random' || (MAPS as Record<string, unknown>)[msg.map]) this.settings.map = msg.map;
        }
        if (msg.difficulty !== undefined) {
          const d = Math.max(0, Math.min(3, Math.floor(Number(msg.difficulty))));
          const hostLevel = this.members.get(this.hostId)?.level ?? 1;
          if (DIFFICULTIES[d].unlockLevel <= hostLevel || this.manager.devMode) this.settings.difficulty = d;
          else session.send({ t: 'err', code: 'locked', msg: `${DIFFICULTIES[d].name} unlocks at level ${DIFFICULTIES[d].unlockLevel}.` });
        }
        if (msg.voiceNoise !== undefined) this.settings.voiceNoise = !!msg.voiceNoise;
        this.sendInfo();
        return;
      }
      case 'start': this.tryStart(session); return;
      case 'chat': {
        if (!session.chatBucket.take()) return;
        const text = String(msg.text ?? '').slice(0, 200).trim();
        if (text) this.broadcast({ t: 'chat', from: pid, name: m.name, text });
        return;
      }
      case 'rtc': {
        const to = this.members.get(String(msg.to));
        if (to?.session) to.session.send({ t: 'rtc', from: pid, data: msg.data });
        return;
      }
      case 'toLobby':
        if (this.phase === 'results' && (isHost || Date.now() - this.resultsAt > 20000)) this.backToLobby();
        return;
      default:
        if (this.mission && this.phase === 'mission') this.mission.handle(m, msg);
    }
  }

  private tryStart(session: Session) {
    const pid = session.playerId!;
    if (pid !== this.hostId) return session.send({ t: 'err', code: 'not_host', msg: 'Only the host can start the mission.' });
    if (this.phase !== 'lobby') return;
    const connected = [...this.members.values()].filter((m) => m.connected);
    const notReady = connected.filter((m) => m.id !== this.hostId && !m.ready);
    if (notReady.length) return session.send({ t: 'err', code: 'not_ready', msg: `Waiting for ${notReady.map((m) => m.name).join(', ')} to ready up.` });
    // drop members who are not connected before starting
    for (const m of [...this.members.values()]) if (!m.connected) this.leave(m.id, 'left');
    const hostLevel = this.members.get(this.hostId)?.level ?? 1;
    let map: MapId;
    if (this.mode === 'practice') map = 'practice';
    else if (this.settings.map === 'random') {
      const avail = MAP_LIST.filter((x) => x.unlockLevel <= Math.max(hostLevel, 1) || this.manager.devMode);
      map = avail[Math.floor(Math.random() * avail.length)].id;
    } else map = this.settings.map;
    this.phase = 'loading';
    try {
      this.mission = new Mission(this, map, this.mode === 'practice' ? 0 : this.settings.difficulty, this.streak);
    } catch (e) {
      log.error('mission creation failed', e);
      this.phase = 'lobby';
      this.mission = null;
      return session.send({ t: 'err', code: 'start_failed', msg: 'The mission could not be generated. Please try again.' });
    }
    this.phase = 'mission';
    for (const m of this.members.values()) m.ready = false;
    this.sendInfo();
    this.mission.begin();
  }

  /** called by the mission when it ends */
  missionEnded(results: MissionResults) {
    this.results = results;
    this.resultsAt = Date.now();
    this.phase = 'results';
    this.lastResult = { success: results.success, value: results.extracted + results.tubed, map: results.map };
    if (this.mode !== 'practice') this.streak = results.success ? this.streak + 1 : 0;
    this.mission = null;
    this.broadcast({ t: 'results', results });
    this.sendInfo();
  }

  backToLobby() {
    this.phase = 'lobby';
    this.results = null;
    for (const m of this.members.values()) m.ready = false;
    this.sendInfo();
  }

  /** global 30 Hz tick */
  tick(now: number, dt: number) {
    if (this.mission) {
      try { this.mission.tick(now, dt); }
      catch (e) {
        log.error(`mission tick crashed in room ${this.code}`, e);
        this.mission.abort('A server error ended the mission. Your progress up to now is safe.');
      }
    }
    if (this.phase === 'results' && now - this.resultsAt > 60000) this.backToLobby();
    // remove members whose reconnect grace expired
    for (const m of [...this.members.values()]) {
      if (!m.connected && m.disconnectedAt && now - m.disconnectedAt > (this.restored ? 300 : NET.RECONNECT_GRACE) * 1000) this.leave(m.id, 'timed out');
    }
  }

  serialize() {
    return {
      mode: this.mode, hostId: this.hostId, settings: this.settings, streak: this.streak,
      members: [...this.members.values()].map((m) => ({ id: m.id, name: m.name, level: m.level, appearance: m.appearance, joinedAt: m.joinedAt, netId: m.netId })),
    };
  }

  takeDirty(): boolean { const d = this.dirty; this.dirty = false; return d; }
}
