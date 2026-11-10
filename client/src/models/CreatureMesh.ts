// Loads prebuilt creature binaries and creates skinned instances with their own skeletons.
import * as THREE from 'three';
import type { Joint } from './SDF';

export interface CreatureData { id: string; geometry: THREE.BufferGeometry; joints: Joint[]; height: number }

const cache = new Map<string, Promise<CreatureData>>();

export function loadCreature(id: string): Promise<CreatureData> {
  let p = cache.get(id);
  if (!p) {
    p = fetch(`${import.meta.env.BASE_URL}assets/creatures/${id}.bin`).then((r) => { if (!r.ok) throw new Error('creature ' + id); return r.arrayBuffer(); }).then((buf) => {
      const dv = new DataView(buf);
      const hl = dv.getUint32(0, true);
      const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hl)).replace(/\0+$/, '')) as { verts: number; indices: number; joints: Joint[]; height: number };
      let off = 4 + hl;
      const nv = header.verts;
      const take = <T extends ArrayBufferView>(ctor: new (b: ArrayBuffer, o: number, n: number) => T, n: number, bytes: number, align = 1): T => {
        if (off % align) off += align - (off % align);
        const a = new ctor(buf, off, n);
        off += n * bytes;
        return a;
      };
      const P = take(Float32Array, nv * 3, 4, 4), N = take(Float32Array, nv * 3, 4, 4), C = take(Uint8Array, nv * 3, 1), RG = take(Uint8Array, nv, 1);
      const SI = take(Uint16Array, nv * 4, 2, 2), SW = take(Uint8Array, nv * 4, 1), I = take(Uint32Array, header.indices, 4, 4);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(P, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
      g.setAttribute('color', new THREE.BufferAttribute(C, 3, true));
      g.setAttribute('region', new THREE.BufferAttribute(RG, 1));
      g.setAttribute('skinIndex', new THREE.BufferAttribute(SI, 4));
      g.setAttribute('skinWeight', new THREE.BufferAttribute(SW, 4, true));
      g.setIndex(new THREE.BufferAttribute(nv > 65535 ? I : new Uint16Array(I), 1));
      g.computeBoundingSphere();
      g.boundingSphere!.radius *= 1.6; // poses extend beyond the rest pose
      return { id, geometry: g, joints: header.joints, height: header.height };
    });
    cache.set(id, p);
  }
  return p;
}

export class Rig {
  readonly bones: THREE.Bone[];
  readonly by: Record<string, THREE.Bone> = {};
  readonly rest: THREE.Vector3[];
  readonly mesh: THREE.SkinnedMesh;
  readonly root: THREE.Bone;

  constructor(data: CreatureData, material: THREE.Material, geometry?: THREE.BufferGeometry) {
    this.bones = data.joints.map((j) => { const b = new THREE.Bone(); b.name = j.name; return b; });
    data.joints.forEach((j, i) => {
      const parent = j.parent >= 0 ? data.joints[j.parent] : null;
      this.bones[i].position.set(j.pos[0] - (parent?.pos[0] ?? 0), j.pos[1] - (parent?.pos[1] ?? 0), j.pos[2] - (parent?.pos[2] ?? 0));
      if (j.parent >= 0) this.bones[j.parent].add(this.bones[i]);
      this.by[j.name] = this.bones[i];
    });
    this.root = this.bones[0];
    this.rest = this.bones.map((b) => b.position.clone());
    this.mesh = new THREE.SkinnedMesh(geometry ?? data.geometry, material);
    this.mesh.add(this.root);
    this.root.updateMatrixWorld(true);
    this.mesh.bind(new THREE.Skeleton(this.bones));
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = true;
  }

  rot(name: string, x: number, y = 0, z = 0) { const b = this.by[name]; if (b) b.rotation.set(x, y, z); }
  addRot(name: string, x: number, y = 0, z = 0) { const b = this.by[name]; if (b) { b.rotation.x += x; b.rotation.y += y; b.rotation.z += z; } }
  offset(name: string, dx: number, dy: number, dz: number) {
    const i = this.bones.findIndex((b) => b.name === name);
    if (i >= 0) this.bones[i].position.set(this.rest[i].x + dx, this.rest[i].y + dy, this.rest[i].z + dz);
  }
  reset() { this.bones.forEach((b, i) => { b.rotation.set(0, 0, 0); b.position.copy(this.rest[i]); b.scale.set(1, 1, 1); }); }
}
