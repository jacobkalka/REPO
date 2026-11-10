// Two independent browser clients: A walks to a prop, grabs it with E, carries and throws it;
// B observes the prop moving through server snapshots.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const out = process.env.OUT ?? '/tmp';
const base = 'http://localhost:5173/?dev=1';
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const mk = async (name) => {
  const ctx = await browser.newContext({ viewport: { width: 640, height: 360 } });
  const page = await ctx.newPage();
  await page.addInitScript((n) => localStorage.setItem('salvage.settings.v1', JSON.stringify({ quality: 'low', name: n, renderScale: 0.5 })), name);
  page.on('pageerror', (e) => console.log(`[${name} pageerror] ${e.message}`));
  await page.goto(base);
  await page.waitForFunction(() => window.__game?.profile, null, { timeout: 30000 });
  return page;
};
const A = await mk('Alpha'), B = await mk('Bravo');
await A.evaluate(() => window.__game.create('coop'));
await A.waitForFunction(() => window.__game.room?.code);
const code = await A.evaluate(() => window.__game.room.code);
console.log('room', code);
await B.evaluate((c) => window.__game.join(c), code);
await B.waitForFunction(() => window.__game.room?.members.length === 2);
await B.evaluate(() => window.__game.ready(true));
await A.waitForFunction(() => window.__game.room?.members.every((m) => m.host || m.ready));
await A.evaluate(() => { window.__game.roomSettings({ map: 'research', difficulty: 0 }); });
await A.waitForTimeout(400);
await A.evaluate(() => window.__game.start());
await Promise.all([A, B].map((p) => p.waitForFunction(() => window.__game?.mission?.ready, null, { timeout: 180000 })));
console.log('both clients in mission');
for (const p of [A, B]) await p.evaluate(() => document.querySelector('.start-overlay')?.click());
await A.evaluate(() => window.__game.conn.send({ t: 'dev', cmd: 'clear', args: [] }));
// wait for the gate
await A.waitForFunction(() => window.__game.conn.missionTime() > window.__game.mission.info.startAt + 0.5, null, { timeout: 30000 });
// pick the nearest light valuable reachable in the lift room's neighbourhood and walk A next to it
const target = await A.evaluate(() => {
  const m = window.__game.mission;
  const me = m.player.pos;
  let best = null, bd = 1e9;
  for (const p of m.props.items.values()) {
    if (p.kind !== 'valuable' || p.mass > 15) continue;
    const d = p.mesh.position.distanceTo(me);
    if (d < bd) { bd = d; best = p; }
  }
  return best ? { id: best.id, name: best.name, pos: best.mesh.position.toArray(), mass: best.mass, value: best.value } : null;
});
console.log('target', JSON.stringify(target));
// find a standing spot ~1.3 m from the prop with clear line of sight (client physics raycast)
const spot = await A.evaluate((t) => {
  const m = window.__game.mission;
  const floorY = Math.floor((t.pos[1] + 0.5) / 6) * 6;
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    for (const r of [1.3, 1.7, 2.1]) {
      const x = t.pos[0] + Math.cos(a) * r, z = t.pos[2] + Math.sin(a) * r;
      const eye = { x, y: floorY + 1.62, z };
      const d = { x: t.pos[0] - x, y: t.pos[1] - eye.y, z: t.pos[2] - z };
      const l = Math.hypot(d.x, d.y, d.z);
      const hit = m.world.raycast(eye, { x: d.x / l, y: d.y / l, z: d.z / l }, l + 0.5);
      const down = m.world.raycast({ x, y: floorY + 1.0, z }, { x: 0, y: -1, z: 0 }, 1.2);
      if (hit && hit.kind === 'prop' && hit.id === t.id && down && down.kind === 'static' && down.toi > 0.9) return [x, floorY + 0.05, z];
    }
  }
  return null;
}, target);
console.log('standing spot', JSON.stringify(spot));
if (spot) await A.evaluate((p) => window.__game.conn.send({ t: 'dev', cmd: 'goto', args: p.map(String) }), spot);
await A.waitForTimeout(1500);
// aim at it
await A.evaluate((t) => {
  const m = window.__game.mission;
  const e = m.player.eyePos;
  const dx = t.pos[0] - e.x, dy = t.pos[1] - e.y, dz = t.pos[2] - e.z;
  m.player.yaw = Math.atan2(-dx, -dz);
  m.player.pitch = Math.atan2(dy, Math.hypot(dx, dz));
}, target);
await A.waitForTimeout(800);
const focus = await A.evaluate(() => window.__game.mission.focus);
console.log('A focus', JSON.stringify(focus));
await A.evaluate(() => { if (window.__game.paused) window.__game.resume(); });
await A.evaluate(() => { window.__grabRes = []; window.__game.conn.on('grabRes', (m) => window.__grabRes.push(m)); });
const dbg0 = await A.evaluate(() => ({ enabled: window.__game.input.enabled, paused: window.__game.paused, locked: window.__game.input.locked, view: window.__game.view, life: window.__game.mission.life }));
console.log('A input state', JSON.stringify(dbg0));
await A.keyboard.press('KeyE');
await A.waitForTimeout(1500);
console.log('A grabRes', JSON.stringify(await A.evaluate(() => window.__grabRes)), 'pending', await A.evaluate(() => window.__game.mission.pendingGrab));
await A.waitForFunction(() => !!window.__game.mission.heldInfo(), null, { timeout: 10000 }).catch(() => {});
const held = await A.evaluate(() => window.__game.mission.heldInfo());
console.log('A holding', JSON.stringify(held));
const posB0 = await B.evaluate((id) => window.__game.mission.props.items.get(id)?.mesh.position.toArray(), target.id);
// carry it: turn 90 degrees over 1.5 s and walk forward 1.2 s
for (let i = 0; i < 15; i++) { await A.evaluate(() => { const g = window.__game; if (g.paused) g.resume(); g.mission.player.yaw += 0.1; }); await A.waitForTimeout(100); }
await A.keyboard.down('KeyW'); await A.waitForTimeout(1200); await A.keyboard.up('KeyW');
await A.waitForTimeout(1500);
const posA1 = await A.evaluate((id) => window.__game.mission.props.items.get(id)?.mesh.position.toArray(), target.id);
const posB1 = await B.evaluate((id) => window.__game.mission.props.items.get(id)?.mesh.position.toArray(), target.id);
console.log('prop before (B view)', posB0?.map((v) => v.toFixed(2)).join(','), '| after: A view', posA1?.map((v) => v.toFixed(2)).join(','), 'B view', posB1?.map((v) => v.toFixed(2)).join(','));
const bOwner = await B.evaluate((id) => window.__game.mission.props.items.get(id)?.owner, target.id);
console.log('B sees owner netId', bOwner);
await A.screenshot({ path: `${out}/grab_A.png`, timeout: 120000 });
await B.screenshot({ path: `${out}/grab_B.png`, timeout: 120000 });
// throw it (right mouse)
await A.mouse.down({ button: 'right' }); await A.mouse.up({ button: 'right' });
await A.evaluate(() => { const m = window.__game.mission; if (m.heldInfo()) m['release'](true); });
await A.waitForTimeout(2500);
const posB2 = await B.evaluate((id) => window.__game.mission.props.items.get(id)?.mesh.position.toArray(), target.id);
const posA2 = await A.evaluate((id) => window.__game.mission.props.items.get(id)?.mesh.position.toArray(), target.id);
console.log('after throw: A view', posA2?.map((v) => v.toFixed(2)).join(','), 'B view', posB2?.map((v) => v.toFixed(2)).join(','));
const vals = await B.evaluate((id) => window.__game.mission.props.items.get(id)?.value, target.id);
console.log('value now (B view)', vals, 'was', target.value);
console.log('B view of A:', JSON.stringify(await B.evaluate(() => { const r = [...window.__game.mission.remotes.players.values()][0]; return { flags: r.flags, hp: r.hp, life: r.life, extra: r.buf.outExtra }; })));
console.log('A self:', JSON.stringify(await A.evaluate(() => ({ hp: window.__game.mission.hp, life: window.__game.mission.life }))));
await browser.close();
