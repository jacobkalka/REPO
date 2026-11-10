// Quick visual check: open the client, screenshot the menu, start a solo mission, screenshot in-game.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? 'playwright');
const url = process.env.URL ?? 'http://localhost:5173/?dev=1';
const out = process.env.OUT ?? '/tmp';
const mode = process.env.MODE ?? 'solo';
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: Number(process.env.W ?? 1280), height: Number(process.env.H ?? 720) } });
const page = await ctx.newPage();
if (process.env.QUALITY) await page.addInitScript((q) => localStorage.setItem('salvage.settings.v1', JSON.stringify({ quality: q, name: 'Tester' })), process.env.QUALITY);
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack}`));
await page.goto(url);
await page.waitForFunction(() => window.__game?.profile, null, { timeout: 30000 });
await page.waitForTimeout(Number(process.env.MENU_WAIT ?? 6000));
await page.screenshot({ path: `${out}/menu.png` });
console.log('menu screenshot done');
if (mode !== 'menu') {
  await page.evaluate((m) => window.__game.create(m), mode);
  await page.waitForFunction(() => window.__game?.mission?.ready, null, { timeout: 120000 });
  console.log('mission ready');
  await page.waitForTimeout(5000);
  await page.screenshot({ path: `${out}/mission0.png`, timeout: 120000 });
  const info = await page.evaluate(() => { const m = window.__game.mission; return { map: m.info.map, pos: m.player.pos.toArray(), props: m.props.items.size, rooms: m.vis.visible.size, enemies: m.remotes.enemies.size }; });
  console.log(JSON.stringify(info));
  // turn around and walk forward a bit
  await page.evaluate(() => { const m = window.__game.mission; m.player.yaw += 0; m.torchOn = true; });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/mission1.png`, timeout: 120000 });
  const perf = await page.evaluate(() => ({ fps: window.__game.engine.fps, cpu: window.__game.engine.cpuMs, stats: window.__game.engine.stats() }));
  console.log('perf', JSON.stringify(perf));
}
console.log(logs.slice(0, 40).join('\n'));
await browser.close();
