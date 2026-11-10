// Visual representation of one monster: skinned model, materials, special effects.
import * as THREE from 'three';
import { MONSTERS, type MonsterId } from '../../../shared/catalog/monsters';
import { Animator, type AnimInput } from './Animator';
import { loadCreature, Rig } from './CreatureMesh';
import { creatureMaterial } from './SDF';

const MATS: Partial<Record<MonsterId, THREE.MeshStandardMaterial>> = {};
function matFor(type: MonsterId): THREE.MeshStandardMaterial {
  if (MATS[type]) return MATS[type]!;
  let m: THREE.MeshStandardMaterial;
  switch (type) {
    case 'stalker': m = creatureMaterial({ rough: 0.55, bump: 0.8, rim: '#3c4a44' }); break;
    case 'mimic': m = creatureMaterial({ rough: 0.4, bump: 1.2, rim: '#4a2a28' }); break;
    case 'brute': m = creatureMaterial({ rough: 0.7, bump: 1.4, rim: '#2a2420' }); break;
    case 'lurker': m = creatureMaterial({ rough: 0.25, metal: 0.2, bump: 0.4, rim: '#3a1210' }); break;
    case 'watcher': m = creatureMaterial({ rough: 0.35, bump: 1.0, rim: '#5a2a2a' }); break;
    case 'swarm': m = creatureMaterial({ rough: 0.35, bump: 0.6, rim: '#3a3018' }); break;
    case 'hunter': m = creatureMaterial({ rough: 0.5, bump: 1.1, rim: '#3a2c28' }); break;
    case 'unknown': {
      m = new THREE.MeshStandardMaterial({ color: '#030304', roughness: 1, metalness: 0, vertexColors: false });
      m.onBeforeCompile = (sh) => {
        sh.uniforms.uTime = { value: 0 };
        (m.userData as { shader?: unknown }).shader = sh;
        sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime;')
          .replace('#include <begin_vertex>', `#include <begin_vertex>
            float w = sin(position.y * 9.0 + uTime * 3.0) * 0.02 + sin(position.y * 23.0 - uTime * 7.0) * 0.008;
            transformed.xz += normal.xz * w * (1.0 + smoothstep(1.0, 0.0, position.y));`);
        sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          { float rim = pow(1.0 - clamp(abs(dot(normal, normalize(vViewPosition))), 0.0, 1.0), 4.0); totalEmissiveRadiance += vec3(0.25, 0.28, 0.4) * rim; }`);
      };
      break;
    }
    default: m = creatureMaterial();
  }
  MATS[type] = m;
  return m;
}

export class MonsterView {
  readonly group = new THREE.Group();
  rig: Rig | null = null;
  anim: Animator | null = null;
  ready: Promise<void>;
  eyes: THREE.Group | null = null;
  gaze: THREE.Mesh | null = null;
  private gazeMat: THREE.ShaderMaterial | null = null;
  lock = 0;

  constructor(readonly type: MonsterId) {
    this.ready = loadCreature(type).then((data) => {
      this.rig = new Rig(data, matFor(type));
      this.anim = new Animator(this.rig, type);
      this.group.add(this.rig.mesh);
      if (type === 'watcher') this.buildWatcherEyes();
      if (type === 'lurker') this.addGlints(this.rig.by.body, 0.14, '#ff3a2a', [0, 0.66, -0.36]);
      if (type === 'swarm') this.addGlints(this.rig.by.body, 0.04, '#d9b24a', [0, 0.1, -0.16], 0.008);
      if (type === 'unknown') this.rig.mesh.castShadow = false;
    });
  }

  private addGlints(bone: THREE.Bone, spread: number, color: string, at: [number, number, number], size = 0.014) {
    const m = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(2.5) });
    // rest pose has identity rotations, so bone-local offset = model-space point - bone rest position
    const boneRest = new THREE.Vector3().setFromMatrixPosition(bone.matrixWorld);
    for (let i = 0; i < 4; i++) {
      const s = new THREE.Mesh(new THREE.SphereGeometry(size, 6, 5), m);
      const modelPt = new THREE.Vector3(at[0] + (i % 2 ? 1 : -1) * spread * (0.3 + (i >> 1) * 0.4), at[1] + (i >> 1) * 0.02, at[2]);
      s.position.copy(modelPt.sub(boneRest));
      bone.add(s);
    }
  }

  private buildWatcherEyes() {
    const bulb = this.rig!.by.bulb;
    this.eyes = new THREE.Group();
    const white = new THREE.MeshPhysicalMaterial({ color: '#d8d2c4', roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.05 });
    const iris = new THREE.MeshBasicMaterial({ color: '#8a1a10' });
    const n = 9;
    for (let i = 0; i < n; i++) {
      const phi = Math.acos(1 - (2 * (i + 0.5)) / n) * 0.6 + 0.9;
      const th = i * 2.4;
      const dir = new THREE.Vector3(Math.sin(phi) * Math.cos(th), -Math.cos(phi), Math.sin(phi) * Math.sin(th));
      const r = 0.05 + (i % 3) * 0.015;
      const eye = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 10), white);
      eye.position.copy(dir.clone().multiplyScalar(0.24));
      const ir = new THREE.Mesh(new THREE.CircleGeometry(r * 0.55, 12), iris);
      ir.position.z = -r * 1.001; ir.rotation.y = Math.PI;
      eye.add(ir);
      eye.lookAt(eye.position.clone().multiplyScalar(3));
      eye.userData.base = eye.quaternion.clone();
      this.eyes.add(eye);
    }
    this.eyes.position.set(0, 0, 0);
    bulb.add(this.eyes);
    const def = MONSTERS.watcher;
    const len = def.sightRange;
    const rad = Math.tan((def.sightFov * Math.PI) / 360) * len;
    const g = new THREE.ConeGeometry(rad, len, 24, 1, true);
    g.translate(0, -len / 2, 0);
    g.rotateX(-Math.PI / 2);
    this.gazeMat = new THREE.ShaderMaterial({
      uniforms: { lock: { value: 0 }, time: { value: 0 } },
      vertexShader: /* glsl */ `varying vec3 vL; void main(){ vL = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: /* glsl */ `uniform float lock; uniform float time; varying vec3 vL;
        void main(){ float d = clamp(-vL.z / ${len.toFixed(1)}, 0.0, 1.0); float a = (1.0 - d) * 0.055 * (0.8 + 0.2*sin(time*3.0 + vL.z));
          vec3 c = mix(vec3(0.75,0.82,0.95), vec3(1.0,0.18,0.12), lock); gl_FragColor = vec4(c * a * (1.0 + lock*2.0), a); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    this.gaze = new THREE.Mesh(g, this.gazeMat);
    this.gaze.renderOrder = 9;
    this.group.add(this.gaze);
  }

  update(a: AnimInput, gazeYaw: number, gazePitch: number) {
    this.anim?.update(a);
    if (this.type === 'unknown') { const sh = (MATS.unknown?.userData as { shader?: { uniforms: { uTime: { value: number } } } })?.shader; if (sh) sh.uniforms.uTime.value = a.t; }
    if (this.gaze && this.gazeMat) {
      this.lock += ((a.lock ?? 0) - this.lock) * Math.min(1, a.dt * 6);
      this.gazeMat.uniforms.lock.value = this.lock;
      this.gazeMat.uniforms.time.value = a.t;
      this.gaze.position.set(0, 0.5, 0);
      this.gaze.rotation.set(gazePitch, 0, 0);
      this.gaze.visible = !a.stunned;
      if (this.eyes) for (const e of this.eyes.children) e.rotation.y = Math.sin(a.t * 1.7 + e.id) * 0.2;
    }
  }

  dispose() { this.group.removeFromParent(); }
}
