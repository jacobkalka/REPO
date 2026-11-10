// Visual builders for procedural furniture (ProcData). Geometry matches the shared colliders.
import * as THREE from 'three';
import type { ProcData } from '../../../shared/levelgen/types';
import { Rng } from '../../../shared/rng';
import type { GeoBuilder } from './GeoBuilder';

/** local → world helper for a proc (quarter-turn yaw) */
function frame(p: ProcData) {
  const c = Math.cos(p.rotY), s = Math.sin(p.rotY);
  return {
    at: (lx: number, ly: number, lz: number): [number, number, number] => [p.x + lx * c + lz * s, p.y + ly, p.z - lx * s + lz * c],
    rot: p.rotY,
  };
}

export interface ProcExtras {
  /** emissive points that should glow (server LEDs etc.) */
  leds: { pos: THREE.Vector3; color: string }[];
  /** objects needing per-frame animation (press head, conveyor) */
  anim: { kind: string; obj: THREE.Object3D; data?: number }[];
  objects: THREE.Object3D[];
}

export function buildProc(g: GeoBuilder, p: ProcData, theme: string, ex: ProcExtras, roomHeight: number) {
  const f = frame(p);
  const rng = new Rng(p.seed);
  const B = (key: string, lx: number, ly: number, lz: number, hx: number, hy: number, hz: number, uv = 1.5, faces?: number) => {
    const [x, y, z] = f.at(lx, ly, lz);
    g.box(key, x, y, z, hx, hy, hz, { rotY: f.rot, uv, faces });
  };
  const C = (key: string, lx: number, ly: number, lz: number, r: number, h: number, seg = 14, axis: 'x' | 'y' | 'z' = 'y', r2?: number) => {
    const [x, y, z] = f.at(lx, ly, lz);
    g.cylinder(key, x, y, z, r, h, seg, { axis, rotY: f.rot, r2 });
  };
  const { w, h, d } = p;
  const metal = theme === 'luxury' ? 'wood_dark' : 'metal_painted';
  switch (p.kind) {
    case 'shelf': {
      const levels = Math.max(2, p.p);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) B('metal_dark', sx * (w / 2 - 0.025), h / 2, sz * (d / 2 - 0.025), 0.025, h / 2, 0.025, 1);
      for (let l = 0; l < levels; l++) {
        const y = 0.12 + (l * (h - 0.12)) / (levels - 1);
        B('metal_painted', 0, y - 0.02, 0, w / 2, 0.018, d / 2, 1.2);
        B('metal_dark', 0, y - 0.05, d / 2 - 0.02, w / 2, 0.03, 0.012, 1);
        B('metal_dark', 0, y - 0.05, -d / 2 + 0.02, w / 2, 0.03, 0.012, 1);
        // clutter boxes on lower shelves
        if (l < levels - 1 && rng.chance(0.6)) {
          const n = rng.int(1, 3);
          for (let i = 0; i < n; i++) {
            const bw = rng.range(0.18, 0.34), bh = rng.range(0.12, 0.28), bd = Math.min(d * 0.7, rng.range(0.2, 0.36));
            const bx = rng.range(-w / 2 + bw, w / 2 - bw);
            if (Math.abs(bx) < 0.25 && rng.chance(0.5)) continue;
            B(rng.chance(0.6) ? 'crate' : 'col|#5d5243|0.9|0', bx, y + bh / 2, rng.range(-0.05, 0.05), bw / 2, bh / 2, bd / 2, 0.6);
          }
        }
      }
      break;
    }
    case 'bookcase': {
      const levels = Math.max(2, p.p);
      B('wood_dark', 0, h / 2, -d / 2 + 0.02, w / 2, h / 2, 0.02, 1.5);
      for (const sx of [-1, 1]) B('wood_dark', sx * (w / 2 - 0.02), h / 2, 0, 0.02, h / 2, d / 2, 1.5);
      for (let l = 0; l < levels; l++) {
        const y = 0.05 + (l * (h - 0.1)) / (levels - 1);
        B('wood_dark', 0, y, 0, w / 2, 0.02, d / 2, 1.5);
        if (l < levels - 1 && rng.chance(0.85)) B('books', rng.range(-0.15, 0.15), y + 0.15, -0.02, w / 2 - 0.25 - rng.range(0, 0.3), 0.13, d / 2 - 0.06, 1);
      }
      break;
    }
    case 'bench': case 'counter': case 'desk': case 'bar': {
      const top = p.kind === 'bench' && theme === 'research' ? 'enamel' : p.kind === 'bar' || theme === 'luxury' ? 'wood' : p.kind === 'desk' ? 'plastic_dark' : 'metal_floor';
      const base = theme === 'luxury' ? 'wood_dark' : p.kind === 'desk' ? 'metal_dark' : metal;
      B(top, 0, h - 0.025, 0, w / 2, 0.025, d / 2, 1.2);
      if (p.p === 9 || p.p === 7) { for (const sx of [-1, 1]) for (const sz of [-1, 1]) B('metal_dark', sx * (w / 2 - 0.05), (h - 0.05) / 2, sz * (d / 2 - 0.05), 0.025, (h - 0.05) / 2, 0.025, 1); B('metal_dark', 0, 0.18, 0, w / 2 - 0.05, 0.015, d / 2 - 0.08); }
      else {
        B(base, 0, (h - 0.05) / 2, -0.03, w / 2 - 0.02, (h - 0.05) / 2, d / 2 - 0.06, 1.2);
        const doors = Math.max(1, Math.round(w / 0.6));
        for (let i = 0; i < doors; i++) {
          const cx = -w / 2 + (i + 0.5) * (w / doors);
          B('metal_dark', cx + 0.08, h * 0.55, d / 2 - 0.03, 0.06, 0.012, 0.015, 1);
          B(base, cx, (h - 0.1) / 2, d / 2 - 0.055, w / doors / 2 - 0.015, (h - 0.15) / 2, 0.01, 1);
        }
        B('rubber', 0, 0.04, d / 2 - 0.08, w / 2 - 0.03, 0.04, 0.02, 1);
      }
      if (p.kind === 'bench' && theme === 'research' && p.p % 3 === 0) {
        B('steel', w * 0.25, h + 0.005, 0, 0.22, 0.01, 0.17, 1);
        C('chrome', w * 0.25, h + 0.18, -d / 2 + 0.12, 0.015, 0.36, 8);
        C('chrome', w * 0.25, h + 0.35, -d / 2 + 0.2, 0.012, 0.18, 8, 'z');
      }
      if (p.kind === 'desk') {
        for (let i = 0; i < Math.max(1, Math.round(w / 0.9)); i++) {
          const cx = -w / 2 + (i + 0.5) * (w / Math.max(1, Math.round(w / 0.9)));
          B('plastic_dark', cx, h + 0.24, -d / 2 + 0.16, 0.26, 0.18, 0.04, 1);
          B(rng.chance(0.4) ? 'screen_on' : 'screen_off', cx, h + 0.25, -d / 2 + 0.205, 0.23, 0.15, 0.002, 1);
          B('plastic_dark', cx, h + 0.03, -d / 2 + 0.16, 0.06, 0.03, 0.06, 1);
          B('plastic_dark', cx, h + 0.012, 0.05, 0.22, 0.012, 0.08, 1);
          if (rng.chance(0.5)) ex.leds.push({ pos: new THREE.Vector3(...f.at(cx + 0.2, h + 0.1, -d / 2 + 0.205)), color: rng.chance(0.5) ? '#7dff9a' : '#ffb340' });
        }
      }
      if (p.kind === 'bar') {
        B('wood_dark', 0, 1.0, -d / 2 - 0.25, w / 2, 0.02, 0.12, 1);
        for (let i = 0; i < 8; i++) C(rng.chance(0.5) ? 'glass' : 'liquid_amber', -w / 2 + 0.2 + i * (w - 0.4) / 7, 1.14, -d / 2 - 0.25, 0.035, rng.range(0.2, 0.3), 8);
      }
      break;
    }
    case 'pedestal':
      B(theme === 'luxury' ? 'marble' : 'concrete', 0, h / 2, 0, w / 2, h / 2, d / 2, 0.8);
      B(theme === 'luxury' ? 'marble' : 'concrete', 0, h - 0.03, 0, w / 2 + 0.04, 0.03, d / 2 + 0.04, 0.8);
      B(theme === 'luxury' ? 'marble' : 'concrete', 0, 0.04, 0, w / 2 + 0.05, 0.04, d / 2 + 0.05, 0.8);
      if (p.p === 1) B('brass', 0, 0.3, d / 2 + 0.001, 0.12, 0.04, 0.003, 1);
      break;
    case 'cabinet':
      B(metal, 0, h / 2, 0, w / 2, h / 2, d / 2, 1.2);
      B('metal_dark', 0, h * 0.5, d / 2, 0.01, h * 0.45, 0.012, 1);
      break;
    case 'crateStack': case 'pallet': {
      B('crate', 0, 0.07, 0, w / 2, 0.07, d / 2, 0.8);
      if (p.kind === 'crateStack') {
        let y = 0.14;
        while (y < h - 0.1) {
          const bh = Math.min(h - y, rng.range(0.4, 0.62));
          const shrink = rng.range(0.0, 0.08);
          B(rng.chance(0.7) ? 'crate' : 'shutter', rng.range(-0.04, 0.04), y + bh / 2, rng.range(-0.04, 0.04), w / 2 - 0.04 - shrink, bh / 2, d / 2 - 0.04 - shrink, 0.7);
          y += bh;
        }
      }
      break;
    }
    case 'machine': {
      const accent = rng.pick(['col|#5b6f5a|0.6|0.3', 'col|#6e5a3a|0.6|0.3', 'col|#3d5266|0.6|0.3', 'metal_green']);
      B('metal_dark', 0, 0.12, 0, w / 2, 0.12, d / 2, 1.2);
      B(accent, -w * 0.12, 0.24 + (h - 0.4) / 2, 0, w * 0.36, (h - 0.4) / 2, d / 2 - 0.1, 1.5);
      B('metal_dark', w * 0.32, 0.24 + h * 0.3, 0, w * 0.16, h * 0.3, d * 0.35, 1.2);
      C('steel', w * 0.32, 0.24 + h * 0.6 + 0.25, 0, Math.min(d, w) * 0.18, 0.5, 16);
      B('hazard', 0, 0.26, d / 2 - 0.1 + 0.002, w / 2 - 0.1, 0.04, 0.002, 1);
      B('plastic_dark', -w * 0.3, h * 0.55, d / 2 - 0.08, 0.25, 0.2, 0.02, 1);
      for (let i = 0; i < 3; i++) ex.leds.push({ pos: new THREE.Vector3(...f.at(-w * 0.3 - 0.12 + i * 0.12, h * 0.62, d / 2 - 0.055)), color: i === 0 ? '#ff4a3a' : i === 1 ? '#ffb340' : '#7dff9a' });
      C('metal_dark', -w / 2 + 0.2, h + 0.3, 0, 0.09, 0.8, 12);
      C('rusty', 0, h - 0.1, -d / 2 + 0.2, 0.07, w * 0.9, 10, 'x');
      break;
    }
    case 'generator':
      B('metal_green', 0, h / 2, 0, w / 2, h / 2, d / 2, 1.2);
      B('metal_dark', 0, h + 0.05, 0, w / 2 - 0.1, 0.05, d / 2 - 0.1, 1);
      for (let i = 0; i < 6; i++) B('metal_dark', -w / 2 + 0.25 + i * (w - 0.5) / 5, h * 0.55, d / 2 + 0.005, 0.02, h * 0.3, 0.005, 1);
      ex.leds.push({ pos: new THREE.Vector3(...f.at(w / 2 - 0.2, h * 0.85, d / 2 + 0.01)), color: '#7dff9a' });
      break;
    case 'tank': {
      const r = Math.min(w, d) / 2;
      C('metal_dark', 0, 0.12, 0, r + 0.04, 0.24, 20);
      C('metal_dark', 0, h - 0.12, 0, r + 0.04, 0.24, 20);
      C(p.p === 1 ? 'liquid_amber' : 'liquid_green', 0, 0.24 + (h - 0.6) / 2, 0, r - 0.04, h - 0.6, 20);
      C('glass', 0, h / 2, 0, r, h - 0.48, 24);
      if (p.p === 2) { C('col|#c7bfa8|0.7|0', 0, h * 0.45, 0, r * 0.35, 0.5, 10); }
      ex.leds.push({ pos: new THREE.Vector3(...f.at(0, 0.18, r + 0.05)), color: '#7dff9a' });
      break;
    }
    case 'lockers': {
      const n = Math.max(1, p.p);
      const lw = w / n;
      for (let i = 0; i < n; i++) {
        const cx = -w / 2 + (i + 0.5) * lw;
        B(rng.chance(0.15) ? 'rusty' : metal, cx, h / 2, 0, lw / 2 - 0.005, h / 2, d / 2, 1.2);
        for (let v = 0; v < 4; v++) B('metal_dark', cx, h - 0.25 - v * 0.04, d / 2 + 0.003, lw * 0.3, 0.008, 0.003, 1);
        B('chrome', cx + lw * 0.32, h * 0.52, d / 2 + 0.012, 0.012, 0.05, 0.01, 1);
      }
      break;
    }
    case 'bunk':
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) B('metal_dark', sx * (w / 2 - 0.03), h / 2, sz * (d / 2 - 0.03), 0.03, h / 2, 0.03, 1);
      for (const y of [0.4, 1.3]) { B('metal_dark', 0, y - 0.06, 0, w / 2, 0.02, d / 2, 1); B('fabric', 0, y + 0.02, 0, w / 2 - 0.05, 0.06, d / 2 - 0.05, 1); B('plastic_white', 0, y + 0.1, -d / 2 + 0.25, w / 2 - 0.12, 0.05, 0.15, 1); }
      break;
    case 'gurney':
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) { B('chrome', sx * (w / 2 - 0.05), 0.42, sz * (d / 2 - 0.08), 0.015, 0.38, 0.015, 1); C('rubber', sx * (w / 2 - 0.05), 0.05, sz * (d / 2 - 0.08), 0.05, 0.03, 10, 'x'); }
      B('chrome', 0, 0.78, 0, w / 2, 0.02, d / 2, 1);
      B('plastic_white', 0, 0.84, 0, w / 2 - 0.03, 0.05, d / 2 - 0.03, 1);
      break;
    case 'conveyor': {
      B('metal_dark', 0, h - 0.06, 0, w / 2, 0.06, d / 2, 1.2);
      B('rubber', 0, h + 0.005, 0, w / 2 - 0.05, 0.01, d / 2 - 0.08, 0.6);
      for (let x = -w / 2 + 0.4; x < w / 2; x += 1.4) for (const sz of [-1, 1]) B('metal_painted', x, (h - 0.12) / 2, sz * (d / 2 - 0.06), 0.05, (h - 0.12) / 2, 0.05, 1);
      for (const sz of [-1, 1]) B('hazard', 0, h - 0.06, sz * (d / 2 + 0.002), w / 2, 0.05, 0.002, 1);
      break;
    }
    case 'serverRack': {
      const n = Math.max(1, Math.round(d / 0.65));
      for (let i = 0; i < n; i++) {
        const cz = -d / 2 + (i + 0.5) * (d / n);
        B('plastic_dark', 0, h / 2, cz, w / 2, h / 2, d / n / 2 - 0.01, 1);
        for (let k = 0; k < 10; k++) {
          const y = 0.25 + k * 0.17;
          B('metal_dark', w / 2 + 0.003, y, cz, 0.003, 0.06, d / n / 2 - 0.05, 1);
          if (rng.chance(0.7)) ex.leds.push({ pos: new THREE.Vector3(...f.at(w / 2 + 0.01, y, cz + rng.range(-0.2, 0.2))), color: rng.chance(0.75) ? '#7dff9a' : rng.chance(0.5) ? '#ffb340' : '#ff4a3a' });
        }
      }
      break;
    }
    case 'column':
      B(theme === 'luxury' ? 'marble' : 'concrete', 0, roomHeight / 2, 0, w / 2, roomHeight / 2, d / 2, 2);
      B(theme === 'luxury' ? 'marble' : 'concrete', 0, 0.15, 0, w / 2 + 0.06, 0.15, d / 2 + 0.06, 1);
      if (theme === 'luxury') B('marble', 0, roomHeight - 0.2, 0, w / 2 + 0.1, 0.2, d / 2 + 0.1, 1);
      else B('hazard', 0, 0.8, 0, w / 2 + 0.005, 0.25, d / 2 + 0.005, 0.5, 0b110011);
      break;
    case 'cellBars': {
      const cells = Math.max(1, p.p);
      const cw = w / cells;
      for (let x = -w / 2 + 0.06; x <= w / 2 - 0.05; x += 0.14) {
        const ci = Math.floor((x + w / 2) / cw);
        const local = x + w / 2 - ci * cw;
        if (local > cw * 0.62 && local < cw * 0.88) continue; // open cell door gap
        C('rusty', x, h / 2, d / 2 - 0.04, 0.018, h, 6);
      }
      B('rusty', 0, h - 0.04, d / 2 - 0.04, w / 2, 0.04, 0.04, 1);
      B('rusty', 0, 0.06, d / 2 - 0.04, w / 2, 0.04, 0.04, 1);
      for (let c = 1; c < cells; c++) B('concrete_dark', -w / 2 + c * cw, h / 2, 0, 0.05, h / 2, d / 2, 1.5);
      break;
    }
    case 'boiler': {
      const r = Math.min(w, d) / 2;
      C('rusty', 0, h / 2 + 0.1, 0, r, h - 0.2, 24);
      C('metal_dark', 0, 0.05, 0, r + 0.08, 0.1, 24);
      C('rusty', 0, h - 0.05, 0, r * 0.25, 0.4, 12);
      for (let i = 0; i < 3; i++) C('metal_dark', 0, 0.5 + i * (h - 0.8) / 2, 0, r + 0.03, 0.06, 24);
      C('brass', r * 0.6, h * 0.6, r * 0.75, 0.09, 0.03, 16, 'z');
      C('rusty', r * 0.5, h * 0.25, r * 0.85, 0.08, 1.0, 10, 'z');
      break;
    }
    case 'press': {
      for (const sx of [-1, 1]) B('metal_green', sx * (w / 2 - 0.2), h / 2, 0, 0.2, h / 2, d / 2, 1.5);
      B('metal_green', 0, h - 0.35, 0, w / 2, 0.35, d / 2, 1.5);
      B('metal_dark', 0, 0.3, 0, w / 2 - 0.4, 0.3, d / 2 - 0.2, 1.2);
      B('hazard', 0, 0.62, d / 2 - 0.2 + 0.002, w / 2 - 0.4, 0.04, 0.002, 1);
      for (const sx of [-1, 1]) B('hazard', sx * (w / 2 - 0.2), 1.2, d / 2 + 0.002, 0.2, 0.6, 0.002, 1);
      // animated head (separate object)
      const head = new THREE.Group();
      const hg = new THREE.BoxGeometry(w - 0.85, 0.5, d - 0.5);
      const hm = new THREE.Mesh(hg, new THREE.MeshStandardMaterial({ color: '#4a4f50', roughness: 0.45, metalness: 0.9 }));
      hm.castShadow = true;
      head.add(hm);
      const [x, , z] = f.at(0, 0, 0);
      head.position.set(x, p.y + h - 0.95, z);
      head.rotation.y = p.rotY;
      head.userData.top = p.y + h - 0.95;
      head.userData.bottom = p.y + 0.85;
      ex.anim.push({ kind: 'press', obj: head });
      ex.objects.push(head);
      break;
    }
    case 'pipeRun': {
      const n = Math.max(1, p.p);
      for (let i = 0; i < n; i++) {
        const r = 0.05 + (i % 3) * 0.03;
        const off = -0.35 + i * (0.7 / Math.max(1, n - 1));
        C(i % 2 ? 'rusty' : 'metal_dark', 0, p.h - i * 0.05, off, r, w, 10, 'x');
        for (let x = -w / 2 + 0.5; x < w / 2; x += 2.0) B('metal_dark', x, p.h + 0.12, off, 0.03, 0.12, r + 0.02, 1);
      }
      g.noShadow('rusty');
      break;
    }
    case 'liftCar': {
      // floor plate, side cage, back panel and value board frame
      B('metal_floor', 0, 0.01, 0, w / 2, 0.02, d / 2, 1.5, 0b000100);
      for (const sx of [-1, 1]) {
        B('metal_dark', sx * (w / 2 + 0.1), h / 2, 0, 0.06, h / 2, d / 2, 1.5);
        for (let z = -d / 2 + 0.2; z < d / 2; z += 0.35) C('steel', sx * (w / 2 + 0.03), h / 2, z, 0.018, h, 6);
      }
      B('metal_dark', 0, h + 0.08, 0, w / 2 + 0.2, 0.08, d / 2, 1.5);
      B('hazard', 0, 0.03, -d / 2 + 0.06, w / 2, 0.03, 0.06, 1, 0b000100);
      for (const sx of [-1, 1]) C('steel', sx * (w / 2 + 0.14), h + 2.5, -d / 2 + 0.2, 0.06, 5, 8);
      break;
    }
    case 'cargoTube': {
      B('metal_dark', 0, 0.45, -0.1, w / 2, 0.45, d / 2 - 0.1, 1.2);
      C('glass', 0, 1.55, -0.15, 0.32, 1.3, 20);
      C('metal_dark', 0, 0.95, -0.15, 0.36, 0.1, 20);
      C('metal_dark', 0, 2.25, -0.15, 0.36, 0.16, 20);
      C('steel', 0, 2.25 + (roomHeight - 2.3) / 2, -0.15, 0.22, roomHeight - 2.3, 14);
      B('hazard', 0, 0.86, d / 2 - 0.2 + 0.002, w / 2, 0.04, 0.002, 1);
      B('plastic_dark', w / 2 - 0.15, 1.2, d / 2 - 0.2, 0.1, 0.14, 0.04, 1);
      break;
    }
    default:
      B(metal, 0, h / 2, 0, w / 2, h / 2, d / 2, 1.5);
  }
}
