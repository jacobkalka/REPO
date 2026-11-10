// Accumulates static geometry per material key with world- or local-space UVs,
// then emits one merged mesh per material (few draw calls per room).
import * as THREE from 'three';

interface Part { pos: number[]; nor: number[]; uv: number[]; idx: number[]; shadow: boolean }

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3(1, 1, 1);
const Y = new THREE.Vector3(0, 1, 0);

export type UVMode = 'world' | 'local';

export class GeoBuilder {
  parts = new Map<string, Part>();

  private part(key: string): Part {
    let p = this.parts.get(key);
    if (!p) { p = { pos: [], nor: [], uv: [], idx: [], shadow: true }; this.parts.set(key, p); }
    return p;
  }

  private uvFor(x: number, y: number, z: number, nx: number, ny: number, nz: number, s: number): [number, number] {
    const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    if (ay >= ax && ay >= az) return [x / s, (ny > 0 ? -z : z) / s];
    if (ax >= az) return [(nx > 0 ? -z : z) / s, y / s];
    return [(nz > 0 ? x : -x) / s, y / s];
  }

  /** quad with corners a,b,c,d (counter-clockwise seen from the front) */
  quad(key: string, a: number[], b: number[], c: number[], d: number[], uvScale = 2, local?: number[][]) {
    const p = this.part(key);
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
    let nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    const base = p.pos.length / 3;
    const verts = [a, b, c, d];
    verts.forEach((v, i) => {
      p.pos.push(v[0], v[1], v[2]);
      p.nor.push(nx, ny, nz);
      const src = local ? local[i] : v;
      const [u, w] = this.uvFor(src[0], src[1], src[2], nx, ny, nz, uvScale);
      p.uv.push(u, w);
    });
    p.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /** axis-aligned (optionally yaw-rotated) box; faces bitmask: +x,-x,+y,-y,+z,-z */
  box(key: string, cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, opts: { rotY?: number; uv?: number; faces?: number; mode?: UVMode } = {}) {
    const rot = opts.rotY ?? 0;
    const faces = opts.faces ?? 0b111111;
    const s = opts.uv ?? 2;
    const c = Math.cos(rot), sn = Math.sin(rot);
    const tr = (x: number, y: number, z: number) => [cx + x * c + z * sn, cy + y, cz - x * sn + z * c];
    const loc = (x: number, y: number, z: number) => (opts.mode === 'local' ? [x + hx, y + hy, z + hz] : tr(x, y, z));
    const F = (bit: number, pts: number[][]) => {
      if (!(faces & bit)) return;
      this.quad(key, tr(pts[0][0], pts[0][1], pts[0][2]), tr(pts[1][0], pts[1][1], pts[1][2]), tr(pts[2][0], pts[2][1], pts[2][2]), tr(pts[3][0], pts[3][1], pts[3][2]), s, pts.map((q) => loc(q[0], q[1], q[2])));
    };
    F(1, [[hx, -hy, hz], [hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz]]);
    F(2, [[-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz]]);
    F(4, [[-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz], [-hx, hy, -hz]]);
    F(8, [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz]]);
    F(16, [[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]]);
    F(32, [[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]]);
  }

  /** add an arbitrary geometry (needs position/normal/uv) transformed by pos/yaw/scale */
  geometry(key: string, g: THREE.BufferGeometry, x: number, y: number, z: number, rotY = 0, scale: [number, number, number] = [1, 1, 1], rotX = 0, rotZ = 0) {
    const p = this.part(key);
    _q.setFromEuler(new THREE.Euler(rotX, rotY, rotZ, 'YXZ'));
    _s.set(scale[0], scale[1], scale[2]);
    _m.compose(_v.set(x, y, z), _q, _s);
    const nm = new THREE.Matrix3().getNormalMatrix(_m);
    const pos = g.getAttribute('position'), nor = g.getAttribute('normal'), uv = g.getAttribute('uv');
    const base = p.pos.length / 3;
    for (let i = 0; i < pos.count; i++) {
      _v.fromBufferAttribute(pos, i).applyMatrix4(_m);
      p.pos.push(_v.x, _v.y, _v.z);
      if (nor) { _n.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize(); p.nor.push(_n.x, _n.y, _n.z); } else p.nor.push(0, 1, 0);
      if (uv) p.uv.push(uv.getX(i), uv.getY(i)); else p.uv.push(0, 0);
    }
    const idx = g.getIndex();
    if (idx) for (let i = 0; i < idx.count; i++) p.idx.push(base + idx.getX(i));
    else for (let i = 0; i < pos.count; i++) p.idx.push(base + i);
  }

  cylinder(key: string, x: number, y: number, z: number, r: number, h: number, seg = 16, opts: { axis?: 'x' | 'y' | 'z'; rotY?: number; caps?: boolean; r2?: number } = {}) {
    const g = new THREE.CylinderGeometry(opts.r2 ?? r, r, h, seg, 1, !(opts.caps ?? true));
    const axis = opts.axis ?? 'y';
    this.geometry(key, g, x, y, z, opts.rotY ?? 0, [1, 1, 1], axis === 'z' ? Math.PI / 2 : 0, axis === 'x' ? Math.PI / 2 : 0);
    g.dispose();
  }

  noShadow(key: string) { this.part(key).shadow = false; }

  build(material: (key: string) => THREE.Material, castShadow = true): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const [key, p] of this.parts) {
      if (!p.idx.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(p.pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(p.nor, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(p.uv, 2));
      g.setIndex(p.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(p.idx, 1) : new THREE.Uint16BufferAttribute(p.idx, 1));
      g.computeBoundingSphere();
      g.computeBoundingBox();
      const mesh = new THREE.Mesh(g, material(key));
      mesh.name = key;
      mesh.castShadow = castShadow && p.shadow;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      out.push(mesh);
    }
    this.parts.clear();
    return out;
  }
}

void Y;
