#!/usr/bin/env node
// Starts the authoritative game server (tsx watch) and the Vite dev server together.
import { spawn } from 'node:child_process';

const procs = [];
function run(name, cmd, args, env = {}) {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env }, shell: process.platform === 'win32' });
  const prefix = name === 'server' ? '\x1b[36m[server]\x1b[0m ' : '\x1b[35m[client]\x1b[0m ';
  const out = (d) => process.stdout.write(d.toString().split('\n').filter(Boolean).map((l) => prefix + l).join('\n') + '\n');
  p.stdout.on('data', out);
  p.stderr.on('data', out);
  p.on('exit', (code) => { console.log(prefix + `exited (${code})`); shutdown(); });
  procs.push(p);
}
function shutdown() { for (const p of procs) if (!p.killed) p.kill('SIGTERM'); setTimeout(() => process.exit(0), 300); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

run('server', 'npx', ['tsx', 'watch', '--clear-screen=false', 'server/src/index.ts'], { DEV_MODE: process.env.DEV_MODE ?? '1', PORT: process.env.GAME_SERVER_PORT || '8080' });
run('client', 'npx', ['vite']);
