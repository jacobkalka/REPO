// Handcrafted practice facility: safe place to learn movement, physics handling,
// co-op lifting, doors, power, tubes and equipment. No creatures, no quota.

import { getTheme } from '../catalog/maps';
import { modelSize } from '../catalog/furniture';
import { VALUABLE_BY_ID } from '../catalog/valuables';
import { LevelGenerator } from './generate';
import { RoomFurnisher, rotQ } from './furnish';
import type { LevelData } from './types';
import { stairNavLink } from './stairs';

export function buildPracticeLevel(): LevelData {
  const gen = new LevelGenerator({ map: 'practice', seed: 'practice', difficulty: 0, crew: 1 });
  const L = gen.level;
  const th = getTheme('practice');
  const def = (id: string) => th.roomTypes.find((r) => r.id === id) ?? null;
  const lift = gen.addRoom(0, { tx: -1, tz: 0, tw: 3, td: 2 }, 'lift', null, { name: 'Freight Lift Bay', height: 4.6, surfaces: 'office', loot: 0 });
  const corr = gen.addRoom(0, { tx: 0, tz: -3, tw: 1, td: 3 }, 'corridor', null, { surfaces: 'shop' });
  gen.addDoor(lift.id, corr.id, 0, 0, 0, 2, 'double', 'metal');
  const hall = gen.addRoom(0, { tx: -3, tz: -8, tw: 6, td: 5 }, 'factory', def('factory'), { name: 'Training Hall', height: 7, surfaces: 'factory' });
  gen.addDoor(corr.id, hall.id, 0, 0, -3, 2, 'arch', 'metal');
  const gear = gen.addRoom(0, { tx: 1, tz: -3, tw: 2, td: 2 }, 'locker', def('locker'), { name: 'Equipment Room', surfaces: 'office' });
  gen.addDoor(corr.id, gear.id, 0, 0, -2, 1, 'hinged', 'metal');
  const sys = gen.addRoom(0, { tx: -2, tz: -3, tw: 2, td: 2 }, 'control', def('control'), { name: 'Systems Room', surfaces: 'office' });
  gen.addDoor(corr.id, sys.id, 0, 0, -2, 3, 'hinged', 'panel');
  const vault = gen.addRoom(0, { tx: -3, tz: -3, tw: 1, td: 2 }, 'vault', def('vault'), { name: 'Keycard Vault', surfaces: 'grime', locked: true, height: 3.4 });
  const keyId = 0;
  const vd = gen.addDoor(sys.id, vault.id, 0, -2, -3, 3, 'security', 'security', { lockedBy: keyId });
  L.keycards.push({ id: keyId, door: vd.id, interactable: -1 });
  void stairNavLink;

  gen.computeDepths();
  gen.buildWalls();
  gen.assignSectors();
  for (const s of L.sectors) s.powered = true;
  gen.placeLights();
  for (const l of L.lights) { l.broken = false; l.flicker = 0; }
  for (const r of L.rooms) r.dark = false;
  gen.setupExtraction(lift);

  const rng = gen.rng.fork('practice');
  const F = (room: typeof hall) => new RoomFurnisher(gen, L, room, rng.fork('r' + room.id));
  const value = (id: string) => { const v = VALUABLE_BY_ID[id]; return v ? Math.round((v.value[0] + v.value[1]) / 2) : 0; };
  const putValuable = (id: string, room: number, x: number, y: number, z: number, rot = 0) => {
    const v = VALUABLE_BY_ID[id];
    const s = modelSize(v.model);
    L.props.push({ id: L.props.length, kind: 'valuable', def: id, room, x, y: y + s[1] / 2 + 0.03, z, rotY: rot, value: value(id), mass: v.mass });
  };

  // lift bay: car + a couple of crates
  const fl = F(lift);
  L.procs.push({ kind: 'liftCar', room: lift.id, x: (L.extraction.aboard.x0 + L.extraction.aboard.x1) / 2, y: lift.y, z: (L.extraction.aboard.z0 + L.extraction.aboard.z1) / 2, rotY: 0, w: L.extraction.aboard.x1 - L.extraction.aboard.x0, h: 3.6, d: L.extraction.aboard.z1 - L.extraction.aboard.z0, p: 0, seed: 1, solid: true });
  void fl;

  // training hall
  const fh = F(hall);
  const hx0 = hall.x0, hz0 = hall.z0, hx1 = hall.x1, hz1 = hall.z1;
  // weight test lineup along the north side
  const lineup = ['brass_vase_03', 'metal_toolbox', 'portable_generator', 'metal_tool_chest', 'old_military_compressor', 'bronze_whale_statue'];
  lineup.forEach((id, i) => {
    const x = hx0 + 3 + i * ((hx1 - hx0 - 6) / (lineup.length - 1));
    const z = hz1 - 3.2;
    const p = { x, z, rotY: Math.PI };
    fh.proc('pallet', p, 1.5, 0.15, 1.3, 0);
    putValuable(id, hall.id, x, hall.y + 0.15, z, Math.PI);
  });
  // fragile pedestals
  ['ceramic_vase_01', 'wine_bottles_01', 'antique_ceramic_vase_01', 'tea_set_01'].forEach((id, i) => {
    const x = hx0 + 2.5, z = hz0 + 3 + i * 2.6;
    fh.proc('pedestal', { x, z, rotY: Math.PI / 2 }, 0.7, 1.0, 0.7, 0);
    putValuable(id, hall.id, x, hall.y + 1.0, z, 0);
  });
  // throwing range: barrels and crates at the east wall
  for (let i = 0; i < 5; i++) {
    const z = hz0 + 3 + i * 2.2;
    L.props.push({ id: L.props.length, kind: 'furniture', def: i % 2 ? 'Barrel_01' : 'wooden_crate_01', room: hall.id, x: hx1 - 2, y: hall.y + modelSize(i % 2 ? 'Barrel_01' : 'wooden_crate_01')[1] / 2 + 0.02, z, rotY: 0, value: 0, mass: i % 2 ? 28 : 12 });
  }
  // carts for hauling practice
  L.props.push({ id: L.props.length, kind: 'furniture', def: 'industrial_storage_cart', room: hall.id, x: (hx0 + hx1) / 2 - 3, y: hall.y + modelSize('industrial_storage_cart')[1] / 2 + 0.02, z: (hz0 + hz1) / 2, rotY: 0, value: 0, mass: 45 });
  L.props.push({ id: L.props.length, kind: 'furniture', def: 'tool_cart', room: hall.id, x: (hx0 + hx1) / 2 + 3, y: hall.y + modelSize('tool_cart')[1] / 2 + 0.02, z: (hz0 + hz1) / 2, rotY: 0, value: 0, mass: 38 });
  // bench with small items
  const bp = { x: (hx0 + hx1) / 2, z: hz0 + 2.0, rotY: 0 };
  fh.proc('bench', bp, 3.0, 0.92, 0.9, 1);
  ['Drill_01', 'brass_blowtorch', 'retro_multimeter', 'pocket_watch'].forEach((id, i) => { const [ox, oz] = rotQ(-1.1 + i * 0.73, 0, 0); putValuable(id, hall.id, bp.x + ox, hall.y + 0.94, bp.z + oz, 0); });
  // a crusher so players can learn hazards (with valve)
  const pp = { x: (hx0 + hx1) / 2 + 6, z: hz0 + 5.5, rotY: 0 };
  fh.proc('press', pp, 2.6, 3.4, 2.2);
  fh.hazard('crusher', pp.x, hall.y + 0.9, pp.z, 0.95, 0.9, 0.85, 7, 0.14, 70);
  fh.interact('document', bp.x + 1.3, hall.y + 0.95, bp.z, 0, -1, 'g1');

  // equipment room: supply crates + documents
  const fg = F(gear);
  for (const item of ['medkit', 'battery', 'flare', 'decoy', 'glowstick', 'stim']) {
    const p = fg.wall(0.7, 0.5);
    if (p) fg.interact('supply', p.x, gear.y + 0.3, p.z, p.rotY, -1, item);
  }
  const lp = fg.wall(2.25, 0.5);
  if (lp) fg.proc('lockers', lp, 2.25, 1.95, 0.5, 5);

  // systems room: breaker, light switch, tube, keycard on the desk
  const fs = F(sys);
  const dp = fs.wall(2.2, 0.85, 0);
  if (dp) { fs.proc('desk', dp, 2.2, 0.8, 0.85, 1); const [ox, oz] = rotQ(0.5, 0, dp.rotY); const it = fs.interact('keycard', dp.x + ox, sys.y + 0.83, dp.z + oz, 0, vd.id, String(keyId)); L.keycards[0].interactable = it.id; }
  const brp = fs.wallPoint(1.35);
  if (brp) { const it = fs.interact('breaker', brp.x, brp.y, brp.z, brp.rotY, 0); const s = L.sectors.find((x) => x.id === 0); if (s) s.breaker = it.id; }
  const lsp = fs.wallPoint(1.3);
  if (lsp) fs.interact('lightSwitch', lsp.x, lsp.y, lsp.z, lsp.rotY, sys.id);
  const tp = fs.wall(1.2, 0.9);
  if (tp) { fs.proc('cargoTube', tp, 1.2, 2.4, 0.9); const [ox, oz] = rotQ(0.75, 0.2, tp.rotY); fs.interact('tube', tp.x + ox, sys.y + 1.2, tp.z + oz, tp.rotY, L.procs.length - 1); }
  fs.interact('document', (sys.x0 + sys.x1) / 2, sys.y + 0.02, (sys.z0 + sys.z1) / 2 + 1.2, 0, -1, 'g2');

  // vault: one shelf of goodies
  const fv = F(vault);
  const sp = fv.wall(1.6, 0.5);
  if (sp) { fv.proc('shelf', sp, 1.6, 2.0, 0.5, 4); putValuable('vintage_pocket_watch', vault.id, sp.x, vault.y + 0.78, sp.z, 0); putValuable('cigarette_case', vault.id, sp.x, vault.y + 1.42, sp.z, 0); }

  // practice spawns for enemy points (unused) and bounds
  L.enemySpawns.push({ x: (hx0 + hx1) / 2, y: hall.y, z: (hz0 + hz1) / 2, room: hall.id, floor: 0, dark: false, ceiling: hall.y + hall.height });
  L.props.forEach((p, i) => (p.id = i));
  gen.computeBounds();
  L.quota = 0;
  return L;
}
