// Salvage Shift game server: static client hosting + WebSocket game endpoint.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { GAME_VERSION, NET, PROTOCOL_VERSION } from '../../shared/constants';
import { sanitizeName, type C2S } from '../../shared/protocol';
import { GameDatabase } from './db/Database';
import { Economy, EconomyError, newProfile } from './economy/Economy';
import { RoomManager } from './lobby/RoomManager';
import { Session } from './net/Session';
import { initPhysics } from './sim/Physics';
import { log, recentErrors } from './log';

// node:sqlite prints an experimental warning; keep logs clean
process.removeAllListeners('warning');
process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') log.warn(w.message); });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const DEV_MODE = process.env.DEV_MODE === '1';
const DATA_DIR = process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'salvage.db');
const CLIENT_DIR = process.env.CLIENT_DIR || [path.resolve(__dirname, '../client'), path.resolve(process.cwd(), 'dist/client')].find((d) => fs.existsSync(path.join(d, 'index.html'))) || '';
const ICE = (() => {
  const servers: { urls: string | string[]; username?: string; credential?: string }[] = [];
  const stun = (process.env.STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302').split(',').map((s) => s.trim()).filter(Boolean);
  if (stun.length) servers.push({ urls: stun });
  if (process.env.TURN_URLS) servers.push({ urls: process.env.TURN_URLS.split(',').map((s) => s.trim()), username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL });
  return servers;
})();

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary', '.bin': 'application/octet-stream', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon', '.map': 'application/json', '.txt': 'text/plain',
};

export interface ServerHandle { close(): Promise<void>; port: number; rooms: RoomManager; db: GameDatabase }

export async function startServer(opts: { port?: number; dbFile?: string; devMode?: boolean; quiet?: boolean } = {}): Promise<ServerHandle> {
  await initPhysics();
  const db = new GameDatabase(opts.dbFile ?? DB_FILE);
  const economy = new Economy(db);
  const devMode = opts.devMode ?? DEV_MODE;
  const rooms = new RoomManager(db, economy, devMode);
  rooms.restore();
  const sessions = new Set<Session>();
  const startedAt = Date.now();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://x');
    if (url.pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, version: GAME_VERSION, protocol: PROTOCOL_VERSION, uptime: Math.round((Date.now() - startedAt) / 1000), sessions: sessions.size, ...rooms.stats() }));
      return;
    }
    if (url.pathname === '/api/errors' && devMode) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(recentErrors.slice(-50)));
      return;
    }
    if (!CLIENT_DIR) { res.writeHead(404); res.end('Client not built. Run `npm run build` (or use `npm run dev`).'); return; }
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(CLIENT_DIR, '.' + rel);
    if (!file.startsWith(path.resolve(CLIENT_DIR))) { res.writeHead(403); res.end(); return; }
    fs.stat(file, (err, st) => {
      const target = !err && st.isFile() ? file : path.join(CLIENT_DIR, 'index.html');
      const ext = path.extname(target).toLowerCase();
      const immutable = target.includes(`${path.sep}assets${path.sep}`) && ext !== '.html';
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': immutable ? 'public, max-age=604800' : 'no-cache', 'Cross-Origin-Opener-Policy': 'same-origin' });
      fs.createReadStream(target).pipe(res);
    });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://x');
    if (url.pathname !== '/ws') { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  const byPlayer = new Map<string, Session>();

  wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '');
    const s = new Session(ws, ip);
    sessions.add(s);
    ws.on('message', (data, isBinary) => {
      s.lastRecv = Date.now();
      const buf = data as Buffer;
      s.bytesIn += buf.length;
      if (isBinary) {
        if (!s.binBucket.take()) return s.violation('binary rate');
        if (s.room?.mission && s.playerId) {
          const m = s.room.members.get(s.playerId);
          if (m) s.room.mission.onBinary(m, new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
        }
        return;
      }
      if (!s.jsonBucket.take()) return s.violation('json rate');
      let msg: C2S;
      try { msg = JSON.parse(buf.toString('utf8')); } catch { return s.violation('bad json'); }
      if (!msg || typeof msg !== 'object' || typeof (msg as { t?: unknown }).t !== 'string') return s.violation('bad message');
      try { handle(s, msg); }
      catch (e) {
        if (e instanceof EconomyError) s.send({ t: 'err', code: e.code, msg: e.message, req: (msg as { req?: number }).req });
        else { log.error('handler error', msg.t, e); s.send({ t: 'err', code: 'server', msg: 'Something went wrong on the server.' }); }
      }
    });
    ws.on('pong', () => { s.lastRecv = Date.now(); });
    ws.on('close', () => {
      s.closed = true;
      sessions.delete(s);
      if (s.playerId && byPlayer.get(s.playerId) === s) byPlayer.delete(s.playerId);
      if (s.room) s.room.onDisconnect(s);
      if (s.playerId && !byPlayer.has(s.playerId)) economy.forget(s.playerId);
    });
    ws.on('error', (e) => log.debug('ws error', e.message));
  });

  function handle(s: Session, msg: C2S) {
    if (msg.t === 'ping') { s.send({ t: 'pong', c: msg.c, s: Date.now() }); return; }
    if (msg.t === 'hello') {
      if (s.playerId) return;
      if (msg.v !== PROTOCOL_VERSION) { s.send({ t: 'err', code: 'version', msg: 'The game was updated. Please reload the page.' }); s.close(4000, 'version'); return; }
      let id: string, token: string, profile;
      const auth = msg.token ? db.authenticate(msg.token) : null;
      if (auth) { id = auth.id; token = msg.token!; profile = auth.profile; economy.remember(profile); profile = economy.get(id)!; }
      else {
        const created = db.createPlayer(sanitizeName(msg.name), (pid) => newProfile(pid, msg.name ?? 'Salvager'));
        id = created.id; token = created.token; profile = created.profile; economy.remember(profile);
        log.info(`new player ${profile.name} (${id})`);
      }
      const old = byPlayer.get(id);
      if (old && old !== s) { old.send({ t: 'left', reason: 'You signed in from another window.' }); if (old.room) old.room.onDisconnect(old); old.room = null; old.close(4001, 'replaced'); }
      byPlayer.set(id, s);
      s.playerId = id;
      s.profile = profile;
      s.send({ t: 'welcome', id, token, profile, serverTime: Date.now(), dev: devMode, ice: ICE, v: PROTOCOL_VERSION });
      const room = rooms.rejoin(s);
      if (room) log.info(`${profile.name} rejoined room ${room.code}`);
      return;
    }
    if (!s.playerId) { s.send({ t: 'err', code: 'auth', msg: 'Not signed in.' }); return; }
    const pid = s.playerId;
    switch (msg.t) {
      case 'setName': { const p = economy.setName(pid, msg.name); s.profile = p; s.send({ t: 'profile', profile: p }); if (s.room) { const m = s.room.members.get(pid); if (m) { m.name = p.name; s.room.sendInfo(); } } return; }
      case 'create': {
        const mode = msg.mode === 'solo' || msg.mode === 'practice' ? msg.mode : 'coop';
        rooms.create(s, mode);
        return;
      }
      case 'join': { const err = rooms.join(s, msg.code); if (err) s.send({ t: 'err', code: 'join', msg: err }); return; }
      case 'buy': {
        if (!s.econBucket.take()) return;
        if (s.room?.phase === 'mission') { s.send({ t: 'err', code: 'busy', msg: 'The shop is closed during a mission.', req: msg.req }); return; }
        const p = economy.purchase(pid, String(msg.item), Number(msg.req) || 0);
        s.profile = p;
        s.send({ t: 'profile', profile: p, reason: 'purchase:' + msg.item });
        return;
      }
      case 'loadout': {
        if (s.room?.phase === 'mission') return;
        const p = economy.setLoadout(pid, msg.loadout);
        s.profile = p;
        s.send({ t: 'profile', profile: p, reason: 'loadout' });
        return;
      }
      case 'appearance': {
        const p = economy.setAppearance(pid, msg.appearance);
        s.profile = p;
        s.send({ t: 'profile', profile: p, reason: 'appearance' });
        if (s.room) { const m = s.room.members.get(pid); if (m) { m.appearance = p.appearance; s.room.sendInfo(); } }
        return;
      }
      case 'dev': {
        if (!devMode) return;
        if (msg.cmd === 'grant') { const p = economy.grant(pid, Number(msg.args?.[0] ?? 10000), Number(msg.args?.[1] ?? 0)); s.send({ t: 'profile', profile: p }); return; }
        if (s.room) s.room.handle(s, msg);
        return;
      }
      default:
        if (s.room) s.room.handle(s, msg);
        else if (msg.t !== 'leave') s.send({ t: 'err', code: 'no_room', msg: 'You are not in a crew.' });
    }
  }

  // ---- 30 Hz simulation loop (drift-corrected)
  const tickMs = 1000 / NET.TICK_HZ;
  let next = performance.now();
  let last = Date.now();
  let running = true;
  let persistAt = 0;
  const loop = () => {
    if (!running) return;
    const now = Date.now();
    try { rooms.tick(now, (now - last) / 1000); } catch (e) { log.error('tick failed', e); }
    last = now;
    if (now > persistAt) { persistAt = now + 2000; rooms.persistDirty(); }
    next += tickMs;
    const delay = next - performance.now();
    if (delay < -250) next = performance.now();
    setTimeout(loop, Math.max(0, delay));
  };
  setTimeout(loop, tickMs);

  // ---- heartbeat / dead connection cleanup
  const hb = setInterval(() => {
    const now = Date.now();
    for (const s of sessions) {
      if (now - s.lastRecv > NET.TIMEOUT_MS) { log.debug('timeout', s.playerId); s.ws.terminate(); continue; }
      try { s.ws.ping(); } catch { /* ignore */ }
    }
  }, NET.HEARTBEAT_MS);

  await new Promise<void>((resolve) => server.listen(opts.port ?? PORT, HOST, () => resolve()));
  const port = (server.address() as { port: number }).port;
  if (!opts.quiet) log.info(`Salvage Shift server v${GAME_VERSION} listening on http://${HOST}:${port} (ws path /ws)${devMode ? ' [DEV MODE]' : ''}${CLIENT_DIR ? '' : ' (no client build found)'}`);

  return {
    port, rooms, db,
    async close() {
      running = false;
      clearInterval(hb);
      for (const r of rooms.rooms.values()) { if (r.mission) r.mission.abort('The server is restarting. Your progress is safe.'); }
      rooms.persistDirty();
      for (const s of sessions) { s.send({ t: 'err', code: 'server_restart', msg: 'The server is restarting. Reconnecting automatically...' }); s.close(1012, 'restart'); }
      await new Promise<void>((r) => wss.close(() => r()));
      await new Promise<void>((r) => server.close(() => r()));
      db.close();
    },
  };
}

// run directly
const isMain = process.argv[1] && (process.argv[1].endsWith('index.ts') || process.argv[1].endsWith('index.js')) && !process.env.VITEST;
if (isMain) {
  startServer().then((h) => {
    let closing = false;
    const shutdown = async (sig: string) => {
      if (closing) return;
      closing = true;
      log.info(`${sig} received, shutting down gracefully...`);
      const t = setTimeout(() => process.exit(1), 8000);
      try { await h.close(); } catch (e) { log.error('shutdown error', e); }
      clearTimeout(t);
      process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('uncaughtException', (e) => log.error('uncaught exception', e));
    process.on('unhandledRejection', (e) => log.error('unhandled rejection', e));
  }).catch((e) => { log.error('failed to start', e); process.exit(1); });
}
