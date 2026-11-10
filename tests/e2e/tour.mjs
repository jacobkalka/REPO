// Visual tour of a generated facility (dev camera): screenshots of several rooms.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const out = process.env.OUT ?? '/tmp';
const map = process.env.MAP ?? 'research';
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await (await browser.newContext({ viewport: { width: Number(process.env.W ?? 960), height: Number(process.env.H ?? 540) } })).newPage();
await page.addInitScript((q) => localStorage.setItem('salvage.settings.v1', JSON.stringify({ quality: q, name: 'Tourist' })), process.env.QUALITY ?? 'medium');
const logs = [];
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') logs.push(`[error] ${m.text()}`); });
await page.goto('http://localhost:5173/?dev=1');
await page.waitForFunction(() => window.__game?.profile, null, { timeout: 30000 });
await page.evaluate((map) => { const g = window.__game; g.conn.send({ t: 'create', mode: 'solo' }); setTimeout(() => { g.conn.send({ t: 'settings', map }); setTimeout(() => g.conn.send({ t: 'start' }), 300); }, 300); }, map);
await page.waitForFunction(() => window.__game?.mission?.ready, null, { timeout: 180000 });
await page.waitForTimeout(3000);
await page.evaluate(() => { const o = document.querySelector('.start-overlay'); if (o) o.click(); });
const spots = await page.evaluate(() => {
  const L = window.__game.mission.level;
  const rooms = [...L.rooms].filter((r) => !r.stair).sort((a, b) => (b.x1 - b.x0) * (b.z1 - b.z0) - (a.x1 - a.x0) * (a.z1 - a.z0));
  const pick = [rooms.find((r) => r.type === 'lift'), ...rooms.filter((r) => !r.corridor && r.type !== 'lift').slice(0, 4), rooms.find((r) => r.corridor)].filter(Boolean);
  return pick.map((r) => ({ name: r.name + ' #' + r.id, x: r.x0 + 0.9, y: r.y + Math.min(1.7, r.height - 0.4), z: r.z0 + 0.9, yaw: Math.atan2(-((r.x1 - r.x0)), -((r.z1 - r.z0))), lights: r.lights.length, dark: r.dark }));
});
let i = 0;
for (const s of spots) {
  await page.evaluate((s) => { const m = window.__game.mission; m.debugCam = [s.x, s.y, s.z, s.yaw, -0.12]; m.torchOn = s.i % 2 === 1; }, { ...s, i });
  await page.waitForTimeout(Number(process.env.WAIT ?? 4000));
  await page.screenshot({ path: `${out}/tour_${map}_${i}.png`, timeout: 120000 });
  console.log(`tour_${map}_${i}.png`, s.name, `lights=${s.lights} dark=${s.dark}`);
  i++;
}
const perf = await page.evaluate(() => ({ fps: window.__game.engine.fps, cpu: window.__game.engine.cpuMs, stats: window.__game.engine.stats() }));
console.log('perf', JSON.stringify(perf));
console.log(logs.slice(0, 20).join('\n'));
await browser.close();
