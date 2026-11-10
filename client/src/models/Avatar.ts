// Crew member avatar: skinned SDF body, cosmetics (suit colour, helmet, visor, patch), torch.
import * as THREE from 'three';
import { COSMETIC_BY_ID, type Appearance } from '../../../shared/catalog/items';
import { Animator, type AnimInput } from './Animator';
import { loadCreature, Rig } from './CreatureMesh';
import { creatureMaterial } from './SDF';
import { canvasTex } from '../render/Materials';

const suitMaterial = (() => { let m: THREE.MeshStandardMaterial | null = null; return () => (m ??= (() => { const x = creatureMaterial({ rough: 0.78, bump: 0.25, rim: '#202426' }); x.envMapIntensity = 0.5; return x; })()); })();

function patchTexture(style: number): THREE.Texture {
  return canvasTex(64, 64, (g) => {
    g.clearRect(0, 0, 64, 64);
    g.fillStyle = '#1b1d1e'; g.beginPath(); g.arc(32, 32, 30, 0, 6.29); g.fill();
    g.strokeStyle = '#d9d5c8'; g.lineWidth = 3; g.stroke();
    g.fillStyle = '#e0a030';
    if (style === 1) { g.beginPath(); g.moveTo(14, 46); g.lineTo(32, 14); g.lineTo(50, 46); g.closePath(); g.lineWidth = 5; g.strokeStyle = '#e0a030'; g.stroke(); g.fillRect(29, 26, 6, 10); }
    if (style === 2) { for (let i = -2; i < 6; i++) { g.beginPath(); g.moveTo(i * 14, 64); g.lineTo(i * 14 + 7, 64); g.lineTo(i * 14 + 30, 0); g.lineTo(i * 14 + 23, 0); g.fill(); } }
    if (style === 3) { g.fillStyle = '#d9d5c8'; g.beginPath(); g.arc(32, 28, 13, 0, 6.29); g.fill(); g.fillStyle = '#1b1d1e'; g.fillRect(24, 26, 6, 6); g.fillRect(34, 26, 6, 6); g.fillStyle = '#d9d5c8'; g.fillRect(25, 40, 14, 8); }
    if (style === 4) { g.beginPath(); for (let i = 0; i < 10; i++) { const r = i % 2 ? 9 : 22; const a = (i / 10) * Math.PI * 2 - Math.PI / 2; g.lineTo(32 + Math.cos(a) * r, 32 + Math.sin(a) * r); } g.fill(); }
    if (style === 5) { g.fillStyle = '#c83a2a'; g.fillRect(26, 14, 12, 36); g.fillRect(14, 26, 36, 12); }
  }, true, false);
}

export class CrewAvatar {
  readonly group = new THREE.Group();
  rig: Rig | null = null;
  anim: Animator | null = null;
  private visor: THREE.Mesh | null = null;
  private visorMat = new THREE.MeshPhysicalMaterial({ color: '#9fb4c0', roughness: 0.06, metalness: 0.5, clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: 1.6 });
  private patch: THREE.Mesh | null = null;
  readonly torch = new THREE.Group();
  readonly torchLens: THREE.Mesh;
  private torchLensMat = new THREE.MeshBasicMaterial({ color: '#fff1d6' });
  private tag: THREE.Sprite | null = null;
  private helmet = -1;
  appearance: Appearance;
  ready: Promise<void>;
  private geom: THREE.BufferGeometry | null = null;

  constructor(appearance: Appearance, public name: string, showTag = true) {
    this.appearance = appearance;
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.032, 0.2, 10), new THREE.MeshStandardMaterial({ color: '#2a2b2c', roughness: 0.4, metalness: 0.7 }));
    body.rotation.x = Math.PI / 2;
    this.torchLens = new THREE.Mesh(new THREE.CircleGeometry(0.03, 14), this.torchLensMat);
    this.torchLens.position.z = -0.101;
    this.torchLens.rotation.y = Math.PI;
    this.torch.add(body, this.torchLens);
    this.ready = this.setAppearance(appearance);
    if (showTag) this.setName(name);
  }

  setName(name: string) {
    this.name = name;
    this.tag?.removeFromParent();
    const tex = canvasTex(256, 64, (g) => {
      g.clearRect(0, 0, 256, 64);
      g.font = '600 30px "Barlow Condensed", Arial Narrow, sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillText(name.toUpperCase(), 129, 34);
      g.fillStyle = '#e8e4da'; g.fillText(name.toUpperCase(), 128, 32);
    }, true, false);
    this.tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: true, opacity: 0.9 }));
    this.tag.scale.set(0.9, 0.225, 1);
    this.tag.position.y = 2.05;
    this.tag.renderOrder = 20;
    this.group.add(this.tag);
  }

  showTag(v: boolean, opacity = 0.9) { if (this.tag) { this.tag.visible = v; (this.tag.material as THREE.SpriteMaterial).opacity = opacity; } }

  async setAppearance(a: Appearance) {
    this.appearance = a;
    const style = COSMETIC_BY_ID[a.helmet]?.style ?? 0;
    if (style !== this.helmet || !this.rig) {
      this.helmet = style;
      const data = await loadCreature('crew' + style);
      if (this.rig) this.rig.mesh.removeFromParent();
      this.geom = data.geometry.clone();
      this.rig = new Rig(data, suitMaterial(), this.geom);
      this.anim = new Animator(this.rig, 'crew');
      this.group.add(this.rig.mesh);
      // visor on the head bone
      const head = this.rig.by.head;
      const vg = new THREE.SphereGeometry(0.138, 20, 12, Math.PI * 1.18, Math.PI * 0.64, Math.PI * 0.36, Math.PI * 0.3);
      this.visor = new THREE.Mesh(vg, this.visorMat);
      this.visor.position.set(0, 0.03, 0.0);
      this.visor.scale.set(1, 1.05, 1.12);
      head.add(this.visor);
      // torch in the right hand
      this.rig.by.rHand.add(this.torch);
      this.torch.position.set(-0.02, -0.06, -0.06);
      // shoulder patch
      this.patch = new THREE.Mesh(new THREE.PlaneGeometry(0.09, 0.09), new THREE.MeshStandardMaterial({ transparent: true, roughness: 0.8 }));
      this.patch.position.set(0.255, 0.0, -0.01);
      this.patch.rotation.y = Math.PI / 2;
      this.rig.by.lUpper.add(this.patch);
    }
    this.recolor();
  }

  private recolor() {
    if (!this.geom) return;
    const a = this.appearance;
    const suit = new THREE.Color(COSMETIC_BY_ID[a.suit]?.color ?? '#c8642a');
    const shell = new THREE.Color('#d9d5c8');
    const dark = new THREE.Color('#26282a');
    const pack = new THREE.Color('#4a4f52');
    const col = this.geom.getAttribute('color') as THREE.BufferAttribute;
    const reg = this.geom.getAttribute('region') as THREE.BufferAttribute;
    const arr = col.array as Uint8Array;
    for (let i = 0; i < reg.count; i++) {
      const r = reg.getX(i);
      const c = r === 1 ? suit : r === 2 ? dark : r === 3 ? shell : r === 4 ? pack : null;
      if (!c) continue;
      const n = 0.92 + ((i * 2654435761) % 1000) / 1000 * 0.12;
      arr[i * 3] = Math.min(255, c.r * 255 * n); arr[i * 3 + 1] = Math.min(255, c.g * 255 * n); arr[i * 3 + 2] = Math.min(255, c.b * 255 * n);
    }
    col.needsUpdate = true;
    this.visorMat.color.set(COSMETIC_BY_ID[a.visor]?.color ?? '#9fb4c0');
    const ps = COSMETIC_BY_ID[a.patch]?.style ?? 0;
    if (this.patch) {
      this.patch.visible = ps > 0;
      const m = this.patch.material as THREE.MeshStandardMaterial;
      m.map?.dispose();
      m.map = ps > 0 ? patchTexture(ps) : null;
      m.needsUpdate = true;
    }
  }

  setTorch(on: boolean) { this.torchLensMat.color.set(on ? '#fff1d6' : '#222222'); }

  update(a: AnimInput) { this.anim?.update(a); }

  dispose() { this.group.removeFromParent(); this.geom?.dispose(); }
}
