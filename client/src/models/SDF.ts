// Signed-distance sculpting → surface-nets mesh → automatic skinning.
// Creatures are modelled as smooth unions of bone-attached primitives; the resulting single
// organic surface is skinned to the skeleton by primitive proximity.
import * as THREE from 'three';

export type V = [number, number, number];

export interface Prim {
  kind: 'capsule' | 'ellipsoid' | 'box' | 'torus';
  a: V; b?: V;             // capsule segment (round cone from a→b)
  r: number; r2?: number;  // radii (r2 at b)
  size?: V;                // ellipsoid radii / box half extents
  bone: number;
  color: string;
  blend?: number;          // smooth-union radius
  sub?: boolean;           // subtractive
  region?: number;         // recolour region id (crew suits)
  rough?: number;
}

export interface Joint { name: string; parent: number; pos: V }

export interface CreatureSpec {
  joints: Joint[];
  prims: Prim[];
  res?: number;            // grid resolution along the longest axis
  noise?: number;          // surface wrinkle amplitude
  pad?: number;
}

const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V) => Math.sqrt(dot(a, a));

function smin(a: number, b: number, k: number) {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}
function smax(a: number, b: number, k: number) { return -smin(-a, -b, k); }

function primDist(p: Prim, q: V): number {
  switch (p.kind) {
    case 'capsule': {
      const a = p.a, b = p.b ?? p.a;
      const ba = sub(b, a), pa = sub(q, a);
      const l2 = dot(ba, ba);
      const h = l2 > 0 ? Math.max(0, Math.min(1, dot(pa, ba) / l2)) : 0;
      const r = p.r + ((p.r2 ?? p.r) - p.r) * h;
      return len([pa[0] - ba[0] * h, pa[1] - ba[1] * h, pa[2] - ba[2] * h]) - r;
    }
    case 'ellipsoid': {
      const s = p.size ?? [p.r, p.r, p.r];
      const d = sub(q, p.a);
      const k0 = len([d[0] / s[0], d[1] / s[1], d[2] / s[2]]);
      const k1 = len([d[0] / (s[0] * s[0]), d[1] / (s[1] * s[1]), d[2] / (s[2] * s[2])]);
      return k1 > 0 ? (k0 * (k0 - 1)) / k1 : -Math.min(...s);
    }
    case 'box': {
      const s = p.size ?? [p.r, p.r, p.r];
      const d = sub(q, p.a);
      const qx = Math.abs(d[0]) - s[0] + p.r, qy = Math.abs(d[1]) - s[1] + p.r, qz = Math.abs(d[2]) - s[2] + p.r;
      return len([Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)]) + Math.min(Math.max(qx, qy, qz), 0) - p.r;
    }
    case 'torus': {
      const d = sub(q, p.a);
      const big = p.size?.[0] ?? 0.3;
      const qx = Math.sqrt(d[0] * d[0] + d[2] * d[2]) - big;
      return Math.sqrt(qx * qx + d[1] * d[1]) - p.r;
    }
  }
}

function hash3(x: number, y: number, z: number) { const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453; return s - Math.floor(s); }
function vnoise(x: number, y: number, z: number) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), w = fz * fz * (3 - 2 * fz);
  let r = 0;
  for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
    r += hash3(ix + dx, iy + dy, iz + dz) * (dx ? u : 1 - u) * (dy ? v : 1 - v) * (dz ? w : 1 - w);
  }
  return r;
}

export interface CreatureMesh { geometry: THREE.BufferGeometry; skeleton: THREE.Skeleton; bones: THREE.Bone[]; root: THREE.Bone; height: number }

/** build the full SDF field, mesh it, colour and skin it */
export function buildCreature(spec: CreatureSpec): CreatureMesh {
  const prims = spec.prims;
  const pad = spec.pad ?? 0.08;
  // bounds
  const min: V = [Infinity, Infinity, Infinity], max: V = [-Infinity, -Infinity, -Infinity];
  for (const p of prims) {
    if (p.sub) continue;
    const ext = Math.max(p.r, p.r2 ?? 0, ...(p.size ?? [0, 0, 0])) + (p.kind === 'torus' ? (p.size?.[0] ?? 0) : 0) + pad;
    for (const pt of [p.a, p.b ?? p.a]) for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], pt[i] - ext); max[i] = Math.max(max[i], pt[i] + ext); }
  }
  const size = sub(max, min);
  const res = spec.res ?? 56;
  const cell = Math.max(size[0], size[1], size[2]) / res;
  const nx = Math.ceil(size[0] / cell) + 2, ny = Math.ceil(size[1] / cell) + 2, nz = Math.ceil(size[2] / cell) + 2;
  const ox = min[0] - cell, oy = min[1] - cell, oz = min[2] - cell;
  const noiseAmp = spec.noise ?? 0;
  const field = (q: V): number => {
    let d = Infinity;
    for (const p of prims) {
      if (p.sub) continue;
      d = d === Infinity ? primDist(p, q) : smin(d, primDist(p, q), p.blend ?? 0.06);
    }
    for (const p of prims) if (p.sub) d = smax(d, -primDist(p, q), p.blend ?? 0.03);
    if (noiseAmp) d += (vnoise(q[0] * 14, q[1] * 14, q[2] * 14) - 0.5) * noiseAmp + (vnoise(q[0] * 37, q[1] * 37, q[2] * 37) - 0.5) * noiseAmp * 0.4;
    return d;
  };
  // sample grid
  const grid = new Float32Array(nx * ny * nz);
  const idx = (i: number, j: number, k: number) => i + nx * (j + ny * k);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) grid[idx(i, j, k)] = field([ox + i * cell, oy + j * cell, oz + k * cell]);
  // surface nets: one vertex per sign-changing cell
  const vIndex = new Int32Array(nx * ny * nz).fill(-1);
  const pos: number[] = [];
  const cornerOff = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  for (let k = 0; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    let mask = 0;
    const vals: number[] = [];
    for (let c = 0; c < 8; c++) { const v = grid[idx(i + cornerOff[c][0], j + cornerOff[c][1], k + cornerOff[c][2])]; vals.push(v); if (v < 0) mask |= 1 << c; }
    if (mask === 0 || mask === 255) continue;
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (const [a, b] of edges) {
      const va = vals[a], vb = vals[b];
      if ((va < 0) === (vb < 0)) continue;
      const t = va / (va - vb);
      sx += cornerOff[a][0] + (cornerOff[b][0] - cornerOff[a][0]) * t;
      sy += cornerOff[a][1] + (cornerOff[b][1] - cornerOff[a][1]) * t;
      sz += cornerOff[a][2] + (cornerOff[b][2] - cornerOff[a][2]) * t;
      n++;
    }
    vIndex[idx(i, j, k)] = pos.length / 3;
    pos.push(ox + (i + sx / n) * cell, oy + (j + sy / n) * cell, oz + (k + sz / n) * cell);
  }
  // faces across sign-changing edges
  const ind: number[] = [];
  for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const v0 = grid[idx(i, j, k)];
    const axes: [number, number, number, number[][]][] = [
      [i + 1, j, k, [[0, 0, 0], [0, -1, 0], [0, -1, -1], [0, 0, -1]]],
      [i, j + 1, k, [[0, 0, 0], [0, 0, -1], [-1, 0, -1], [-1, 0, 0]]],
      [i, j, k + 1, [[0, 0, 0], [-1, 0, 0], [-1, -1, 0], [0, -1, 0]]],
    ];
    for (const [ai, aj, ak, quad] of axes) {
      if (ai >= nx || aj >= ny || ak >= nz) continue;
      const v1 = grid[idx(ai, aj, ak)];
      if ((v0 < 0) === (v1 < 0)) continue;
      const q = quad.map(([di, dj, dk]) => vIndex[idx(i + di, j + dj, k + dk)]);
      if (q.some((x) => x < 0)) continue;
      if (v0 < 0) ind.push(q[0], q[1], q[2], q[0], q[2], q[3]);
      else ind.push(q[0], q[2], q[1], q[0], q[3], q[2]);
    }
  }
  const vcount = pos.length / 3;
  // normals from the field gradient, colours + skin weights from nearest primitives
  const nor = new Float32Array(vcount * 3);
  const col = new Float32Array(vcount * 3);
  const reg = new Float32Array(vcount);
  const skinI = new Uint16Array(vcount * 4);
  const skinW = new Float32Array(vcount * 4);
  const e = cell * 0.5;
  const colors = prims.map((p) => new THREE.Color(p.color));
  for (let v = 0; v < vcount; v++) {
    const q: V = [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]];
    const gx = field([q[0] + e, q[1], q[2]]) - field([q[0] - e, q[1], q[2]]);
    const gy = field([q[0], q[1] + e, q[2]]) - field([q[0], q[1] - e, q[2]]);
    const gz = field([q[0], q[1], q[2] + e]) - field([q[0], q[1], q[2] - e]);
    const gl = Math.hypot(gx, gy, gz) || 1;
    nor[v * 3] = gx / gl; nor[v * 3 + 1] = gy / gl; nor[v * 3 + 2] = gz / gl;
    // weights per bone: exp falloff of primitive distance
    const boneW = new Map<number, number>();
    let best = Infinity, bestP = 0;
    for (let pi = 0; pi < prims.length; pi++) {
      const p = prims[pi];
      if (p.sub) continue;
      const d = primDist(p, q);
      if (d < best) { best = d; bestP = pi; }
      const w = Math.exp(-Math.max(0, d) / 0.045);
      boneW.set(p.bone, Math.max(boneW.get(p.bone) ?? 0, w));
    }
    const sorted = [...boneW.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    const tot = sorted.reduce((s, x) => s + x[1], 0) || 1;
    sorted.forEach(([b, w], k) => { skinI[v * 4 + k] = b; skinW[v * 4 + k] = w / tot; });
    const c = colors[bestP];
    const n = 0.88 + vnoise(q[0] * 9, q[1] * 9, q[2] * 9) * 0.24;
    col[v * 3] = c.r * n; col[v * 3 + 1] = c.g * n; col[v * 3 + 2] = c.b * n;
    reg[v] = prims[bestP].region ?? 0;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geometry.setAttribute('region', new THREE.BufferAttribute(reg, 1));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinI, 4));
  geometry.setAttribute('skinWeight', new THREE.BufferAttribute(skinW, 4));
  geometry.setIndex(vcount > 65535 ? new THREE.Uint32BufferAttribute(ind, 1) : new THREE.Uint16BufferAttribute(ind, 1));
  geometry.computeBoundingSphere();
  // skeleton in rest pose
  const bones = spec.joints.map((j) => { const b = new THREE.Bone(); b.name = j.name; return b; });
  spec.joints.forEach((j, i) => {
    const parent = j.parent >= 0 ? spec.joints[j.parent] : null;
    bones[i].position.set(j.pos[0] - (parent?.pos[0] ?? 0), j.pos[1] - (parent?.pos[1] ?? 0), j.pos[2] - (parent?.pos[2] ?? 0));
    if (j.parent >= 0) bones[j.parent].add(bones[i]);
  });
  const root = bones[0];
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);
  return { geometry, skeleton, bones, root, height: max[1] };
}

/** creature skin material: vertex colours + procedural bump + wet rim */
export function creatureMaterial(opts: { rough?: number; metal?: number; bump?: number; rim?: string; emissive?: string; transparent?: boolean } = {}): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: opts.rough ?? 0.62, metalness: opts.metal ?? 0, envMapIntensity: 0.6 });
  if (opts.emissive) { m.emissive = new THREE.Color(opts.emissive); m.emissiveIntensity = 1; }
  const bump = opts.bump ?? 1;
  const rim = new THREE.Color(opts.rim ?? '#3a4a48');
  m.onBeforeCompile = (sh) => {
    sh.uniforms.bumpAmt = { value: bump };
    sh.uniforms.rimColor = { value: rim };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vObjPos;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvObjPos = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vObjPos; uniform float bumpAmt; uniform vec3 rimColor;
        float h3(vec3 p){ return fract(sin(dot(p, vec3(127.1,311.7,74.7)))*43758.5453); }
        float vn(vec3 p){ vec3 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
          return mix(mix(mix(h3(i),h3(i+vec3(1,0,0)),f.x), mix(h3(i+vec3(0,1,0)),h3(i+vec3(1,1,0)),f.x), f.y),
                     mix(mix(h3(i+vec3(0,0,1)),h3(i+vec3(1,0,1)),f.x), mix(h3(i+vec3(0,1,1)),h3(i+vec3(1,1,1)),f.x), f.y), f.z); }
        float fbm(vec3 p){ return vn(p)*0.55 + vn(p*2.1)*0.28 + vn(p*4.3)*0.17; }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        { vec3 p = vObjPos * 22.0; float e = 0.06;
          float b0 = fbm(p); vec3 g = vec3(fbm(p+vec3(e,0,0))-b0, fbm(p+vec3(0,e,0))-b0, fbm(p+vec3(0,0,e))-b0);
          normal = normalize(normal - g * bumpAmt * 4.0); }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        { float rim = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 3.0); totalEmissiveRadiance += rimColor * rim * 0.35; }`);
  };
  return m;
}
