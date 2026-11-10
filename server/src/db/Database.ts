// SQLite persistence (node:sqlite). WAL mode, synchronous=NORMAL, every economy change in a
// transaction with an idempotency key in the ledger table.

import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Profile } from '../../../shared/profile';
import { log } from '../log';

export interface LedgerEntry { key: string; kind: string; amount: number; detail?: string }

export class GameDatabase {
  readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS players (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        created INTEGER NOT NULL,
        last_seen INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS profiles (
        player_id TEXT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
        data TEXT NOT NULL,
        version INTEGER NOT NULL,
        updated INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id TEXT NOT NULL,
        key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        amount INTEGER NOT NULL,
        detail TEXT,
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ledger_player ON ledger(player_id, at);
      CREATE TABLE IF NOT EXISTS missions (
        id TEXT PRIMARY KEY,
        room TEXT NOT NULL,
        map TEXT NOT NULL,
        difficulty INTEGER NOT NULL,
        seed TEXT NOT NULL,
        crew INTEGER NOT NULL,
        started INTEGER NOT NULL,
        ended INTEGER,
        success INTEGER,
        value INTEGER,
        data TEXT
      );
      CREATE TABLE IF NOT EXISTS lobbies (
        code TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated INTEGER NOT NULL
      );
    `);
    this.db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run('schema', '1');
  }

  static hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  static newToken(): string {
    return crypto.randomBytes(32).toString('base64url');
  }

  static newId(prefix = 'p'): string {
    return prefix + crypto.randomBytes(9).toString('base64url');
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    }
  }

  createPlayer(name: string, profileFactory: (id: string) => Profile): { id: string; token: string; profile: Profile } {
    const id = GameDatabase.newId('p');
    const token = GameDatabase.newToken();
    const now = Date.now();
    const profile = profileFactory(id);
    this.transaction(() => {
      this.db.prepare('INSERT INTO players (id, token_hash, name, created, last_seen) VALUES (?, ?, ?, ?, ?)').run(id, GameDatabase.hashToken(token), name, now, now);
      this.db.prepare('INSERT INTO profiles (player_id, data, version, updated) VALUES (?, ?, ?, ?)').run(id, JSON.stringify(profile), profile.version, now);
    });
    return { id, token, profile };
  }

  authenticate(token: string): { id: string; profile: Profile } | null {
    if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
    const row = this.db.prepare('SELECT p.id as id, pr.data as data FROM players p JOIN profiles pr ON pr.player_id = p.id WHERE p.token_hash = ?').get(GameDatabase.hashToken(token)) as { id: string; data: string } | undefined;
    if (!row) return null;
    this.db.prepare('UPDATE players SET last_seen = ? WHERE id = ?').run(Date.now(), row.id);
    return { id: row.id, profile: JSON.parse(row.data) as Profile };
  }

  loadProfile(id: string): Profile | null {
    const row = this.db.prepare('SELECT data FROM profiles WHERE player_id = ?').get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Profile) : null;
  }

  /** write a profile, optionally with ledger entries, atomically. Returns false if any ledger key already exists. */
  saveProfile(profile: Profile, ledger: LedgerEntry[] = []): boolean {
    return this.transaction(() => {
      for (const l of ledger) {
        const exists = this.db.prepare('SELECT 1 FROM ledger WHERE key = ?').get(l.key);
        if (exists) return false;
      }
      profile.updated = Date.now();
      this.db.prepare('UPDATE profiles SET data = ?, version = ?, updated = ? WHERE player_id = ?').run(JSON.stringify(profile), profile.version, profile.updated, profile.id);
      this.db.prepare('UPDATE players SET name = ? WHERE id = ?').run(profile.name, profile.id);
      for (const l of ledger) this.db.prepare('INSERT INTO ledger (player_id, key, kind, amount, detail, at) VALUES (?, ?, ?, ?, ?, ?)').run(profile.id, l.key, l.kind, Math.round(l.amount), l.detail ?? null, Date.now());
      return true;
    });
  }

  ledgerHas(key: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM ledger WHERE key = ?').get(key);
  }

  ledgerFor(playerId: string, limit = 50): { key: string; kind: string; amount: number; detail: string | null; at: number }[] {
    return this.db.prepare('SELECT key, kind, amount, detail, at FROM ledger WHERE player_id = ? ORDER BY id DESC LIMIT ?').all(playerId, limit) as never;
  }

  recordMissionStart(m: { id: string; room: string; map: string; difficulty: number; seed: string; crew: number }) {
    this.db.prepare('INSERT OR REPLACE INTO missions (id, room, map, difficulty, seed, crew, started) VALUES (?, ?, ?, ?, ?, ?, ?)').run(m.id, m.room, m.map, m.difficulty, m.seed, m.crew, Date.now());
  }

  recordMissionEnd(id: string, success: boolean, value: number, data: unknown) {
    this.db.prepare('UPDATE missions SET ended = ?, success = ?, value = ?, data = ? WHERE id = ?').run(Date.now(), success ? 1 : 0, Math.round(value), JSON.stringify(data), id);
  }

  /** missions that never ended (server crashed / restarted mid-mission) */
  abortedMissions(): { id: string; room: string }[] {
    return this.db.prepare('SELECT id, room FROM missions WHERE ended IS NULL').all() as never;
  }

  markMissionAborted(id: string) {
    this.db.prepare('UPDATE missions SET ended = ?, success = 0, data = ? WHERE id = ?').run(Date.now(), JSON.stringify({ aborted: true }), id);
  }

  saveLobby(code: string, data: unknown) {
    this.db.prepare('INSERT OR REPLACE INTO lobbies (code, data, updated) VALUES (?, ?, ?)').run(code, JSON.stringify(data), Date.now());
  }

  deleteLobby(code: string) {
    this.db.prepare('DELETE FROM lobbies WHERE code = ?').run(code);
  }

  loadLobbies(maxAgeMs: number): { code: string; data: unknown }[] {
    const rows = this.db.prepare('SELECT code, data, updated FROM lobbies').all() as { code: string; data: string; updated: number }[];
    const out: { code: string; data: unknown }[] = [];
    for (const r of rows) {
      if (Date.now() - r.updated > maxAgeMs) { this.deleteLobby(r.code); continue; }
      try { out.push({ code: r.code, data: JSON.parse(r.data) }); } catch (e) { log.warn('bad lobby row', r.code, e); }
    }
    return out;
  }

  close() {
    try { this.db.close(); } catch { /* ignore */ }
  }
}
