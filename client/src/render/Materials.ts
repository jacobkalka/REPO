// Material library: PBR surface sets (CC0 textures), named procedural materials and
// canvas-generated textures (hazard stripes, signage, grime, book spines, screens).
import * as THREE from 'three';
import type { SurfaceDef } from '../../../shared/catalog/maps';
import TEXTURES from '../../../shared/assets/textures.json';
import { assets } from '../core/Assets';

const TEX_META = TEXTURES as Record<string, { arm: boolean; metal: boolean }>;

function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, srgb = true, repeat = true): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  draw(g);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

export class Materials {
  private cache = new Map<string, THREE.Material>();
  readonly envIntensity = 0.5;

  surfaceKey(d: SurfaceDef) { return `surf|${d.tex}|${d.tint ?? '#ffffff'}|${d.rough ?? 1}|${d.metal ?? -1}`; }

  /** material for a CC0 texture set; textures stream in asynchronously */
  surface(d: SurfaceDef): THREE.MeshStandardMaterial {
    const key = this.surfaceKey(d);
    const hit = this.cache.get(key) as THREE.MeshStandardMaterial | undefined;
    if (hit) return hit;
    const meta = TEX_META[d.tex];
    const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(d.tint ?? '#ffffff'), roughness: d.rough ?? 1, metalness: d.metal ?? (meta?.metal ? 1 : 0), envMapIntensity: this.envIntensity });
    mat.color.multiplyScalar(0.001); // dark until textures arrive (avoids white flash)
    assets.loadSurface(d.tex).then((t) => {
      if (!t) { mat.color.set(d.tint ?? '#777777'); return; }
      mat.color.set(d.tint ?? '#ffffff');
      mat.map = t.map;
      mat.normalMap = t.normalMap;
      mat.normalScale.set(1, -1);
      if (t.arm) {
        mat.aoMap = t.arm; mat.aoMap.channel = 0; mat.aoMapIntensity = 0.8;
        mat.roughnessMap = t.arm;
        if (meta?.metal || (d.metal ?? 0) > 0) mat.metalnessMap = t.arm;
      }
      mat.needsUpdate = true;
    });
    this.cache.set(key, mat);
    return mat;
  }

  /** resolve a GeoBuilder key (either `surf|...` or a named material) */
  get(key: string): THREE.Material {
    const hit = this.cache.get(key);
    if (hit) return hit;
    if (key.startsWith('surf|')) {
      const [, tex, tint, rough, metal] = key.split('|');
      return this.surface({ tex, tint, rough: Number(rough), metal: Number(metal) < 0 ? undefined : Number(metal) });
    }
    if (key.startsWith('trim|')) {
      const [, color, metal] = key.split('|');
      const m = new THREE.MeshStandardMaterial({ color, roughness: metal === '1' ? 0.45 : 0.6, metalness: metal === '1' ? 0.8 : 0.05, envMapIntensity: this.envIntensity });
      this.cache.set(key, m);
      return m;
    }
    if (key.startsWith('col|')) {
      const [, color, rough, metal] = key.split('|');
      const m = new THREE.MeshStandardMaterial({ color, roughness: Number(rough ?? 0.7), metalness: Number(metal ?? 0), envMapIntensity: this.envIntensity });
      this.cache.set(key, m);
      return m;
    }
    const m = this.named(key);
    this.cache.set(key, m);
    return m;
  }

  private named(key: string): THREE.Material {
    const env = this.envIntensity;
    const S = (tex: string, extra: Partial<SurfaceDef> = {}) => this.surface({ tex, ...extra });
    switch (key) {
      case 'metal_painted': return S('blue_metal_plate', { tint: '#9aa3a3' });
      case 'metal_dark': return S('metal_plate_02', { tint: '#6c7072', metal: 0.85 });
      case 'metal_green': return S('green_metal_rust');
      case 'metal_floor': return S('metal_plate', { metal: 0.9 });
      case 'rust': return S('rust_coarse_01');
      case 'rusty': return S('rusty_metal_03');
      case 'shutter': return S('painted_metal_shutter', { tint: '#b8b2a2' });
      case 'corrugated': return S('corrugated_iron_02');
      case 'wood': return S('wood_cabinet_worn_long');
      case 'wood_dark': return S('dark_wood');
      case 'crate': return S('wood_cabinet_worn_long', { tint: '#b48a5c' });
      case 'concrete': return S('concrete_wall_008');
      case 'concrete_dark': return S('preconcrete_wall_001', { tint: '#8a8a82' });
      case 'marble': return S('marble_01', { rough: 0.6 });
      case 'fabric': return S('velour_velvet', { tint: '#7a2c2c' });
      case 'steel': return new THREE.MeshStandardMaterial({ color: '#8d9396', roughness: 0.38, metalness: 1, envMapIntensity: env });
      case 'chrome': return new THREE.MeshStandardMaterial({ color: '#d8dcdf', roughness: 0.12, metalness: 1, envMapIntensity: env * 1.4 });
      case 'brass': return new THREE.MeshStandardMaterial({ color: '#b08d47', roughness: 0.35, metalness: 1, envMapIntensity: env * 1.2 });
      case 'rubber': return new THREE.MeshStandardMaterial({ color: '#151515', roughness: 0.9, metalness: 0 });
      case 'plastic_white': return new THREE.MeshStandardMaterial({ color: '#d4d6d2', roughness: 0.45, metalness: 0, envMapIntensity: env });
      case 'plastic_dark': return new THREE.MeshStandardMaterial({ color: '#2a2c2e', roughness: 0.55, metalness: 0, envMapIntensity: env });
      case 'plastic_yellow': return new THREE.MeshStandardMaterial({ color: '#c79a1c', roughness: 0.5, metalness: 0 });
      case 'plastic_red': return new THREE.MeshStandardMaterial({ color: '#8f2219', roughness: 0.5, metalness: 0 });
      case 'enamel': return new THREE.MeshStandardMaterial({ color: '#c9cdc6', roughness: 0.3, metalness: 0.1, envMapIntensity: env });
      case 'glass': return new THREE.MeshPhysicalMaterial({ color: '#b8d4d8', roughness: 0.05, metalness: 0, transmission: 0, transparent: true, opacity: 0.18, envMapIntensity: env * 2, depthWrite: false, side: THREE.DoubleSide });
      case 'glass_frosted': return new THREE.MeshStandardMaterial({ color: '#cfdcdc', roughness: 0.5, metalness: 0, transparent: true, opacity: 0.55, envMapIntensity: env });
      case 'liquid_green': return new THREE.MeshStandardMaterial({ color: '#2f5a3a', roughness: 0.1, metalness: 0, emissive: '#2b6b3a', emissiveIntensity: 0.6, transparent: true, opacity: 0.75 });
      case 'liquid_amber': return new THREE.MeshStandardMaterial({ color: '#6a4a1a', roughness: 0.1, metalness: 0, emissive: '#7a4a10', emissiveIntensity: 0.4, transparent: true, opacity: 0.8 });
      case 'water': return new THREE.MeshStandardMaterial({ color: '#0d1214', roughness: 0.04, metalness: 0.2, envMapIntensity: env * 2.4, transparent: true, opacity: 0.86 });
      case 'hazard': {
        const t = canvasTex(256, 64, (g) => { g.fillStyle = '#c8961a'; g.fillRect(0, 0, 256, 64); g.fillStyle = '#16140f'; for (let i = -2; i < 10; i++) { g.beginPath(); g.moveTo(i * 32, 64); g.lineTo(i * 32 + 16, 64); g.lineTo(i * 32 + 48, 0); g.lineTo(i * 32 + 32, 0); g.fill(); } });
        return new THREE.MeshStandardMaterial({ map: t, roughness: 0.7, metalness: 0.2 });
      }
      case 'books': {
        const t = canvasTex(256, 128, (g) => {
          const cols = ['#5a2a22', '#22384a', '#2e4a2a', '#6a5a3a', '#3a2a40', '#7a6a50', '#1f2a2f', '#7a3a1e'];
          let x = 0; let i = 0;
          while (x < 256) { const w = 6 + ((i * 37) % 9); g.fillStyle = cols[(i * 5) % cols.length]; g.fillRect(x, 8 + ((i * 13) % 14), w - 1, 128); g.fillStyle = 'rgba(220,200,150,0.25)'; g.fillRect(x + 1, 30 + ((i * 7) % 20), w - 3, 3); x += w; i++; }
        });
        return new THREE.MeshStandardMaterial({ map: t, roughness: 0.85 });
      }
      case 'screen_off': return new THREE.MeshStandardMaterial({ color: '#050708', roughness: 0.15, metalness: 0.4, envMapIntensity: env * 1.5 });
      case 'screen_on': return new THREE.MeshStandardMaterial({ color: '#0a1410', emissive: '#4fbf8a', emissiveIntensity: 0.8, roughness: 0.2, emissiveMap: this.screenTex() });
      case 'led_green': return new THREE.MeshBasicMaterial({ color: '#7dff9a' });
      case 'led_red': return new THREE.MeshBasicMaterial({ color: '#ff4a3a' });
      case 'led_amber': return new THREE.MeshBasicMaterial({ color: '#ffb340' });
      case 'glow_warm': return new THREE.MeshBasicMaterial({ color: new THREE.Color('#ffd9a0').multiplyScalar(3) });
      case 'glow_cool': return new THREE.MeshBasicMaterial({ color: new THREE.Color('#e6f2ff').multiplyScalar(3) });
      case 'paper': return new THREE.MeshStandardMaterial({ color: '#d9d2bf', roughness: 0.95, map: this.paperTex() });
      case 'keycard': return new THREE.MeshStandardMaterial({ color: '#d04a2a', roughness: 0.4, metalness: 0.1, emissive: '#5a1408', emissiveIntensity: 0.6 });
      case 'grime': return new THREE.MeshBasicMaterial({ map: this.grimeTex(), transparent: true, depthWrite: false, opacity: 0.85, blending: THREE.MultiplyBlending, premultipliedAlpha: true });
      default: return new THREE.MeshStandardMaterial({ color: '#808080', roughness: 0.8 });
    }
  }

  private _screen: THREE.Texture | null = null;
  screenTex() {
    if (this._screen) return this._screen;
    this._screen = canvasTex(256, 160, (g) => {
      g.fillStyle = '#020403'; g.fillRect(0, 0, 256, 160);
      g.fillStyle = '#3fbf7a'; g.font = '12px monospace';
      const lines = ['GREYLINE SYS 4.11', 'SECTOR STATUS ......', 'PWR  ##########  OK', 'CAM  ####......  ERR', 'DOOR ##########  OK', '> diag --full', 'NO RESPONSE FROM B2', '> _'];
      lines.forEach((l, i) => g.fillText(l, 10, 20 + i * 17));
      for (let y = 0; y < 160; y += 3) { g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(0, y, 256, 1); }
    }, true, false);
    return this._screen;
  }

  private paperTex() {
    return canvasTex(128, 160, (g) => {
      g.fillStyle = '#e4dcc8'; g.fillRect(0, 0, 128, 160);
      g.fillStyle = 'rgba(40,40,50,0.55)';
      for (let i = 0; i < 16; i++) g.fillRect(12, 18 + i * 8, 60 + ((i * 29) % 44), 2);
      g.fillStyle = 'rgba(120,90,40,0.15)'; g.beginPath(); g.arc(90, 120, 22, 0, 6.28); g.fill();
    }, true, false);
  }

  private grimeTex() {
    return canvasTex(64, 256, (g) => {
      const grd = g.createLinearGradient(0, 256, 0, 0);
      grd.addColorStop(0, 'rgba(40,34,28,1)'); grd.addColorStop(0.25, 'rgba(120,110,100,1)'); grd.addColorStop(1, 'rgba(255,255,255,1)');
      g.fillStyle = grd; g.fillRect(0, 0, 64, 256);
    }, true, true);
  }

  /** emissive material for a light fixture (per light so it can flicker) */
  glow(color: string, strength = 4): THREE.MeshBasicMaterial {
    return new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(strength), toneMapped: true });
  }

  /** a sign texture with text */
  sign(text: string, sub = '', style: 'dark' | 'light' | 'hazard' | 'exit' = 'dark'): THREE.MeshStandardMaterial {
    const key = `sign|${text}|${sub}|${style}`;
    const hit = this.cache.get(key) as THREE.MeshStandardMaterial | undefined;
    if (hit) return hit;
    const t = canvasTex(512, 160, (g) => {
      const bg = style === 'light' ? '#d9d6cc' : style === 'hazard' ? '#c8961a' : style === 'exit' ? '#1d5a32' : '#1c1f21';
      const fg = style === 'light' || style === 'hazard' ? '#141414' : '#e6e1d4';
      g.fillStyle = bg; g.fillRect(0, 0, 512, 160);
      g.strokeStyle = fg; g.globalAlpha = 0.6; g.lineWidth = 4; g.strokeRect(8, 8, 496, 144); g.globalAlpha = 1;
      g.fillStyle = fg; g.font = '700 64px "Barlow Condensed", Arial Narrow, sans-serif'; g.textBaseline = 'middle';
      g.fillText(text.toUpperCase(), 28, sub ? 62 : 82);
      if (sub) { g.font = '500 30px "Barlow Condensed", Arial Narrow, sans-serif'; g.globalAlpha = 0.8; g.fillText(sub.toUpperCase(), 30, 118); }
      // wear
      for (let i = 0; i < 300; i++) { g.fillStyle = `rgba(0,0,0,${Math.random() * 0.12})`; g.fillRect(Math.random() * 512, Math.random() * 160, 2 + Math.random() * 8, 1 + Math.random() * 3); }
    }, true, false);
    const m = new THREE.MeshStandardMaterial({ map: t, roughness: 0.7, metalness: 0.05, emissive: style === 'exit' ? '#2a8a4a' : '#000000', emissiveIntensity: style === 'exit' ? 0.6 : 0 });
    this.cache.set(key, m);
    return m;
  }
}

export const materials = new Materials();
export { canvasTex };
