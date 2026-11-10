// Build-time creature meshing: high-resolution SDF sculpt → surface nets → meshoptimizer
// simplification → compact binary (client/public/assets/creatures/<id>.bin).
//
// Binary layout: u32 headerLen | header JSON (utf8, padded to 4) | f32 pos | f32 nor | u8 col(rgb) | u8 region |
//                u16 skinIndex(4) | u8 skinWeight(4) | u32 index
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MeshoptSimplifier } from 'meshoptimizer';
import { buildCreature } from '../client/src/models/SDF';
import { crewSpec, MONSTER_SPECS } from '../client/src/models/Creatures';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'client/public/assets/creatures');
fs.mkdirSync(OUT, { recursive: true });

const targets: Record<string, { res: number; tris: number }> = {
  crew0: { res: 104, tris: 9000 }, crew1: { res: 104, tris: 9000 }, crew2: { res: 104, tris: 9000 }, crew3: { res: 104, tris: 9000 },
  stalker: { res: 150, tris: 9000 }, mimic: { res: 96, tris: 9000 }, brute: { res: 104, tris: 14000 }, lurker: { res: 120, tris: 8000 },
  watcher: { res: 96, tris: 6000 }, swarm: { res: 64, tris: 1600 }, hunter: { res: 120, tris: 10000 }, unknown: { res: 80, tris: 5000 },
};

await MeshoptSimplifier.ready;
const jobs: [string, () => ReturnType<typeof crewSpec>][] = [
  ...[0, 1, 2, 3].map((h) => ['crew' + h, () => crewSpec(h)] as [string, () => ReturnType<typeof crewSpec>]),
  ...Object.entries(MONSTER_SPECS) as [string, () => ReturnType<typeof crewSpec>][],
];
for (const [id, make] of jobs) {
  const t0 = performance.now();
  const spec = make();
  spec.res = targets[id].res;
  const m = buildCreature(spec);
  const g = m.geometry;
  const pos = g.getAttribute('position').array as Float32Array;
  const idx = new Uint32Array(g.getIndex()!.array as ArrayLike<number>);
  const targetIndexCount = Math.min(idx.length, targets[id].tris * 3);
  const [simp] = MeshoptSimplifier.simplify(idx, pos, 3, targetIndexCount, 0.01, ['LockBorder']);
  // compact
  const remap = new Map<number, number>();
  const order: number[] = [];
  const outIdx = new Uint32Array(simp.length);
  for (let i = 0; i < simp.length; i++) { let n = remap.get(simp[i]); if (n === undefined) { n = order.length; remap.set(simp[i], n); order.push(simp[i]); } outIdx[i] = n; }
  const nv = order.length;
  const nor = g.getAttribute('normal').array as Float32Array, col = g.getAttribute('color').array as Float32Array, reg = g.getAttribute('region').array as Float32Array;
  const si = g.getAttribute('skinIndex').array as Uint16Array, sw = g.getAttribute('skinWeight').array as Float32Array;
  const P = new Float32Array(nv * 3), N = new Float32Array(nv * 3), C = new Uint8Array(nv * 3), RG = new Uint8Array(nv), SI = new Uint16Array(nv * 4), SW = new Uint8Array(nv * 4);
  order.forEach((o, i) => {
    for (let k = 0; k < 3; k++) { P[i * 3 + k] = pos[o * 3 + k]; N[i * 3 + k] = nor[o * 3 + k]; C[i * 3 + k] = Math.round(Math.min(1, col[o * 3 + k]) * 255); }
    RG[i] = reg[o];
    let wsum = 0;
    for (let k = 0; k < 4; k++) { SI[i * 4 + k] = si[o * 4 + k]; wsum += sw[o * 4 + k]; }
    let acc = 0;
    for (let k = 0; k < 4; k++) { const w = k < 3 ? Math.round((sw[o * 4 + k] / (wsum || 1)) * 255) : 255 - acc; SW[i * 4 + k] = Math.max(0, w); acc += k < 3 ? Math.round((sw[o * 4 + k] / (wsum || 1)) * 255) : 0; }
  });
  const header = Buffer.from(JSON.stringify({ id, verts: nv, indices: outIdx.length, joints: spec.joints, height: m.height }));
  const pad = (4 - (header.length % 4)) % 4;
  const parts = [Buffer.alloc(4), header, Buffer.alloc(pad), Buffer.from(P.buffer), Buffer.from(N.buffer), Buffer.from(C.buffer), Buffer.from(RG.buffer)];
  let off = 4 + header.length + pad + P.byteLength + N.byteLength + C.byteLength + RG.byteLength;
  const align = (n: number) => { const p = (n - (off % n)) % n; if (p) { parts.push(Buffer.alloc(p)); off += p; } };
  align(2); parts.push(Buffer.from(SI.buffer)); off += SI.byteLength;
  parts.push(Buffer.from(SW.buffer)); off += SW.byteLength;
  align(4); parts.push(Buffer.from(outIdx.buffer)); off += outIdx.byteLength;
  parts[0].writeUInt32LE(header.length + pad, 0);
  const file = path.join(OUT, `${id}.bin`);
  fs.writeFileSync(file, Buffer.concat(parts));
  console.log(`${id.padEnd(8)} res ${spec.res} → ${idx.length / 3} tris → ${outIdx.length / 3} tris, ${nv} verts, ${(fs.statSync(file).size / 1024).toFixed(0)} KB, ${(performance.now() - t0).toFixed(0)} ms`);
}
