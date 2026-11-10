// Fixed-size pool of real lights assigned each frame to the most relevant "virtual" fixture
// lights. The number of lights never changes, so shaders never recompile.
import * as THREE from 'three';

export interface VirtualLight {
  id: number;
  room: number;
  pos: THREE.Vector3;
  dir: THREE.Vector3;
  color: THREE.Color;
  intensity: number;
  range: number;
  angle: number;
  broken: boolean;
  flicker: number;
  seed: number;
  /** externally controlled: power / switch / blackout */
  enabled: boolean;
  /** 0..1 current brightness incl. flicker (computed) */
  level: number;
  glows: { mat: THREE.MeshBasicMaterial; base: THREE.Color }[];
  cone: THREE.Mesh | null;
  surge: number;
}

interface Slot { light: THREE.SpotLight; target: VirtualLight | null; fade: number; shadow: boolean }

function noise1(t: number, seed: number) {
  const i = Math.floor(t), f = t - i;
  const h = (n: number) => { const s = Math.sin((n + seed * 17.13) * 127.1) * 43758.5453; return s - Math.floor(s); };
  const u = f * f * (3 - 2 * f);
  return h(i) * (1 - u) + h(i + 1) * u;
}

export class LightPool {
  readonly slots: Slot[] = [];
  readonly group = new THREE.Group();
  reduceFlicker = false;
  disturbances: THREE.Vector3[] = [];

  constructor(scene: THREE.Object3D, size: number, shadowCount: number, shadowSize: number) {
    for (let i = 0; i < size; i++) {
      const l = new THREE.SpotLight(0xffffff, 0, 10, 1, 0.65, 2);
      const shadow = i < shadowCount;
      l.castShadow = shadow;
      if (shadow) {
        l.shadow.mapSize.set(shadowSize, shadowSize);
        l.shadow.bias = -0.0006;
        l.shadow.normalBias = 0.035;
        l.shadow.radius = 3;
        l.shadow.camera.near = 0.15;
      }
      l.visible = true;
      this.group.add(l);
      this.group.add(l.target);
      this.slots.push({ light: l, target: null, fade: 0, shadow });
    }
    scene.add(this.group);
  }

  dispose() { this.group.removeFromParent(); for (const s of this.slots) s.light.dispose(); }

  /** brightness of a virtual light this frame (also drives glow materials and cones) */
  evaluate(v: VirtualLight, t: number): number {
    if (v.broken || !v.enabled) return 0;
    let f = 1;
    let sev = v.flicker;
    for (const d of this.disturbances) { const dist = d.distanceTo(v.pos); if (dist < 9) sev = Math.max(sev, 1 - dist / 9); }
    if (v.surge > 0) sev = Math.max(sev, 0.6);
    if (sev > 0) {
      const speed = this.reduceFlicker ? 2 : 9;
      const n = noise1(t * speed, v.seed);
      const drop = noise1(t * 1.7 + 30, v.seed) > 1 - sev * 0.35 ? (this.reduceFlicker ? 0.5 : 0.04) : 1;
      f = (1 - sev * 0.45 * n) * drop;
    }
    return f;
  }

  update(camera: THREE.Camera, candidates: VirtualLight[], dt: number, t: number) {
    const cam = camera.position;
    // compute levels and scores
    const scored: { v: VirtualLight; s: number }[] = [];
    for (const v of candidates) {
      v.level = this.evaluate(v, t);
      for (const g of v.glows) g.mat.color.copy(g.base).multiplyScalar(0.05 + 0.95 * v.level);
      if (v.cone) { v.cone.visible = v.level > 0.02; (v.cone.material as THREE.ShaderMaterial).uniforms.strength.value = v.level; }
      if (v.level <= 0.01) continue;
      const d2 = v.pos.distanceToSquared(cam);
      scored.push({ v, s: (v.intensity * (0.4 + v.level)) / (d2 + 4) });
    }
    scored.sort((a, b) => b.s - a.s);
    const n = this.slots.length;
    const chosen = new Set(scored.slice(0, n).map((x) => x.v));
    // keep existing assignments that are still chosen; prefer shadow slots for the closest
    const shadowWant = scored.slice(0, this.slots.filter((s) => s.shadow).length).map((x) => x.v);
    for (const s of this.slots) if (s.target && (!chosen.has(s.target) || (s.shadow && !shadowWant.includes(s.target)))) { s.fade -= dt * 6; if (s.fade <= 0) { s.target = null; s.fade = 0; } }
    const assigned = new Set(this.slots.map((s) => s.target).filter(Boolean));
    for (const x of scored.slice(0, n)) {
      if (assigned.has(x.v)) continue;
      const wantShadow = shadowWant.includes(x.v);
      const slot = this.slots.find((s) => !s.target && s.shadow === wantShadow) ?? this.slots.find((s) => !s.target);
      if (!slot) break;
      slot.target = x.v;
      slot.fade = 0;
      assigned.add(x.v);
    }
    for (const s of this.slots) {
      const l = s.light;
      if (!s.target) { l.intensity = 0; continue; }
      const v = s.target;
      if (chosen.has(v)) s.fade = Math.min(1, s.fade + dt * 5);
      l.position.copy(v.pos);
      l.target.position.copy(v.pos).add(v.dir);
      l.color.copy(v.color);
      l.angle = v.angle;
      l.distance = v.range;
      l.intensity = v.intensity * v.level * s.fade;
      if (s.shadow) l.shadow.camera.far = v.range;
    }
  }
}

/** additive "volumetric" light cone under a fixture */
export function makeCone(color: THREE.Color, height: number, angle: number): THREE.Mesh {
  const r = Math.tan(Math.min(angle, 1.2) * 0.75) * height;
  const g = new THREE.CylinderGeometry(0.08, r, height, 24, 1, true);
  g.translate(0, -height / 2, 0);
  const m = new THREE.ShaderMaterial({
    uniforms: { color: { value: color.clone() }, strength: { value: 1 }, time: { value: 0 } },
    vertexShader: /* glsl */ `varying float vH; varying vec3 vN; varying vec3 vV; varying vec3 vW;
      void main(){ vH = -position.y; vec4 wp = modelMatrix * vec4(position,1.0); vW = wp.xyz; vN = normalize(mat3(modelMatrix) * normal); vV = normalize(cameraPosition - wp.xyz); gl_Position = projectionMatrix * viewMatrix * wp; }`,
    fragmentShader: /* glsl */ `uniform vec3 color; uniform float strength; uniform float time; varying float vH; varying vec3 vN; varying vec3 vV; varying vec3 vW;
      float h(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,37.719)))*43758.5453); }
      void main(){
        float edge = pow(abs(dot(normalize(vN), normalize(vV))), 1.6);
        float fall = exp(-vH * 0.55) * smoothstep(0.0, 0.25, vH);
        float dust = 0.85 + 0.15 * sin(vW.x*3.1 + vW.z*2.3 + time*0.7 + vW.y*4.0);
        float a = edge * fall * dust * strength * 0.075;
        gl_FragColor = vec4(color * a, a);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.renderOrder = 10;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return mesh;
}
