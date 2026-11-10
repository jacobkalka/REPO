#!/usr/bin/env node
// Asset pipeline: downloads curated CC0 assets from Poly Haven and converts them into
// game-ready, compressed files.
//
//  models   -> client/public/assets/models/<id>.glb  (meshopt-compressed, WebP textures,
//              simplified to a triangle budget, re-centred on the bounding-box centre)
//  textures -> client/public/assets/textures/<id>_{diff,nor,arm}.webp
//  manifest -> shared/assets/models.json (sizes + convex hull points used by server physics)
//              shared/assets/textures.json
//
// Usage: node tools/fetch-assets.mjs [--only id1,id2] [--force]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, weld, simplify, textureCompress, meshopt, flatten, join, center, getBounds } from '@gltf-transform/functions';
import { MeshoptSimplifier, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';
import { MODELS, TEXTURES } from './asset-list.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'tools/.cache/polyhaven');
const OUT_MODELS = path.join(ROOT, 'client/public/assets/models');
const OUT_TEX = path.join(ROOT, 'client/public/assets/textures');
const OUT_MANIFEST = path.join(ROOT, 'shared/assets');
const API = 'https://api.polyhaven.com/files/';
const UA = { 'User-Agent': 'salvage-shift-asset-pipeline/1.0' };

const args = process.argv.slice(2);
const force = args.includes('--force');
const onlyIdx = args.indexOf('--only');
const only = onlyIdx >= 0 ? new Set(args[onlyIdx + 1].split(',')) : null;

for (const d of [CACHE, OUT_MODELS, OUT_TEX, OUT_MANIFEST]) fs.mkdirSync(d, { recursive: true });

async function fetchRetry(url, asJson = false, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: UA });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return asJson ? await res.json() : Buffer.from(await res.arrayBuffer());
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
  throw lastErr;
}

async function download(url, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const buf = await fetchRetry(url);
  fs.writeFileSync(dest, buf);
}

async function pool(items, n, fn) {
  const results = [];
  let i = 0;
  const workers = Array.from({ length: n }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        results[idx] = await fn(items[idx]);
      } catch (e) {
        console.error(`  ! ${items[idx].id}: ${e.message}`);
        results[idx] = null;
      }
    }
  });
  await Promise.all(workers);
  return results;
}

// 42 well-distributed directions (icosahedron vertices + edge midpoints) for k-DOP hull points
function hullDirections() {
  const t = (1 + Math.sqrt(5)) / 2;
  const v = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t],
    [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map(([x, y, z]) => { const l = Math.hypot(x, y, z); return [x / l, y / l, z / l]; });
  const dirs = [...v];
  for (let a = 0; a < v.length; a++) for (let b = a + 1; b < v.length; b++) {
    const d = Math.hypot(v[a][0] - v[b][0], v[a][1] - v[b][1], v[a][2] - v[b][2]);
    if (d < 1.1) { const m = [(v[a][0] + v[b][0]) / 2, (v[a][1] + v[b][1]) / 2, (v[a][2] + v[b][2]) / 2]; const l = Math.hypot(...m); dirs.push(m.map((c) => c / l)); }
  }
  // axis aligned + box corners for tight boxes
  for (const ax of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) dirs.push(ax);
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) dirs.push([sx / Math.sqrt(3), sy / Math.sqrt(3), sz / Math.sqrt(3)]);
  return dirs;
}
const DIRS = hullDirections();

function collectWorldPositions(doc) {
  const pts = [];
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const m = node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      const el = [0, 0, 0];
      for (let i = 0; i < pos.getCount(); i++) {
        pos.getElement(i, el);
        const x = m[0] * el[0] + m[4] * el[1] + m[8] * el[2] + m[12];
        const y = m[1] * el[0] + m[5] * el[1] + m[9] * el[2] + m[13];
        const z = m[2] * el[0] + m[6] * el[1] + m[10] * el[2] + m[14];
        pts.push(x, y, z);
      }
    }
  }
  return pts;
}

function hullPoints(pts) {
  const out = [];
  const seen = new Set();
  for (const d of DIRS) {
    let best = -Infinity, bi = 0;
    for (let i = 0; i < pts.length; i += 3) {
      const s = pts[i] * d[0] + pts[i + 1] * d[1] + pts[i + 2] * d[2];
      if (s > best) { best = s; bi = i; }
    }
    if (!seen.has(bi)) { seen.add(bi); out.push(+pts[bi].toFixed(4), +pts[bi + 1].toFixed(4), +pts[bi + 2].toFixed(4)); }
  }
  return out;
}

function countTris(doc) {
  let n = 0;
  for (const mesh of doc.getRoot().listMeshes()) for (const p of mesh.listPrimitives()) {
    const idx = p.getIndices();
    n += idx ? idx.getCount() / 3 : p.getAttribute('POSITION').getCount() / 3;
  }
  return Math.round(n);
}

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });

async function processModel(spec) {
  const outFile = path.join(OUT_MODELS, `${spec.id}.glb`);
  const metaFile = path.join(CACHE, spec.id, 'meta.json');
  if (!force && fs.existsSync(outFile) && fs.existsSync(metaFile)) return JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  const info = await fetchRetry(API + spec.id, true);
  const entry = info.gltf?.['1k']?.gltf;
  if (!entry) throw new Error('no 1k gltf');
  const dir = path.join(CACHE, spec.id);
  const gltfPath = path.join(dir, path.basename(new URL(entry.url).pathname));
  await download(entry.url, gltfPath);
  for (const [rel, inc] of Object.entries(entry.include || {})) await download(inc.url, path.join(dir, rel));

  await MeshoptSimplifier.ready;
  await MeshoptEncoder.ready;
  const doc = await io.read(gltfPath);
  const before = countTris(doc);
  const ratio = Math.min(1, spec.tris / Math.max(1, before));
  await doc.transform(dedup(), flatten(), join(), weld());
  if (ratio < 0.98) await doc.transform(simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.01, lockBorder: false }));
  await doc.transform(center({ pivot: 'center' }));
  const scene = doc.getRoot().getDefaultScene() || doc.getRoot().listScenes()[0];
  const b = getBounds(scene);
  const size = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]].map((v) => +v.toFixed(4));
  const hull = hullPoints(collectWorldPositions(doc));
  const tris = countTris(doc);
  await doc.transform(
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [spec.tex, spec.tex], quality: 80 }),
    prune(),
    meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
  );
  await io.write(outFile, doc);
  const meta = { id: spec.id, role: spec.role, size, hull, tris, bytes: fs.statSync(outFile).size, name: info.name || spec.id };
  fs.writeFileSync(metaFile, JSON.stringify(meta));
  console.log(`  model ${spec.id}: ${before} -> ${tris} tris, ${(meta.bytes / 1024).toFixed(0)} KB, size ${size.join('x')}`);
  return meta;
}

async function processTexture(spec) {
  const outBase = path.join(OUT_TEX, spec.id);
  const metaFile = path.join(CACHE, 'tex_' + spec.id + '.json');
  if (!force && fs.existsSync(metaFile) && fs.existsSync(outBase + '_diff.webp')) return JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  const info = await fetchRetry(API + spec.id, true);
  const get = (key) => info[key]?.['1k']?.jpg?.url || info[key]?.['1k']?.png?.url;
  const diff = get('Diffuse');
  const nor = get('nor_gl');
  const arm = get('arm');
  const rough = get('Rough');
  if (!diff || !nor) throw new Error('missing diffuse/normal');
  const dl = async (url, name) => { const p = path.join(CACHE, 'tex', spec.id, name); await download(url, p); return p; };
  const dP = await dl(diff, 'diff.jpg');
  const nP = await dl(nor, 'nor.jpg');
  await sharp(dP).resize(1024, 1024, { fit: 'inside' }).webp({ quality: 78 }).toFile(outBase + '_diff.webp');
  await sharp(nP).resize(1024, 1024, { fit: 'inside' }).webp({ quality: 85 }).toFile(outBase + '_nor.webp');
  let hasArm = false;
  if (arm) {
    const aP = await dl(arm, 'arm.jpg');
    await sharp(aP).resize(spec.arm, spec.arm, { fit: 'inside' }).webp({ quality: 80 }).toFile(outBase + '_arm.webp');
    hasArm = true;
  } else if (rough) {
    // synthesise an ARM map: AO = 255, rough = rough, metal = 0
    const rP = await dl(rough, 'rough.jpg');
    const r = await sharp(rP).resize(spec.arm, spec.arm, { fit: 'inside' }).greyscale().raw().toBuffer({ resolveWithObject: true });
    const { width, height } = r.info;
    const buf = Buffer.alloc(width * height * 3);
    for (let i = 0; i < width * height; i++) { buf[i * 3] = 255; buf[i * 3 + 1] = r.data[i]; buf[i * 3 + 2] = 0; }
    await sharp(buf, { raw: { width, height, channels: 3 } }).webp({ quality: 80 }).toFile(outBase + '_arm.webp');
    hasArm = true;
  }
  const meta = { id: spec.id, arm: hasArm, metal: !!info.Metal || /metal|rust|iron|shutter|grate/.test(spec.id), name: info.name || spec.id };
  fs.writeFileSync(metaFile, JSON.stringify(meta));
  console.log(`  texture ${spec.id} ok`);
  return meta;
}

const t0 = Date.now();
const models = only ? MODELS.filter((m) => only.has(m.id)) : MODELS;
const textures = only ? TEXTURES.filter((m) => only.has(m.id)) : TEXTURES;
console.log(`Processing ${models.length} models and ${textures.length} texture sets...`);
const texMeta = await pool(textures, 4, processTexture);
const modelMeta = await pool(models, 3, processModel);

// merge into existing manifests (so --only runs keep other entries)
const mPath = path.join(OUT_MANIFEST, 'models.json');
const tPath = path.join(OUT_MANIFEST, 'textures.json');
const mOld = fs.existsSync(mPath) ? JSON.parse(fs.readFileSync(mPath, 'utf8')) : {};
const tOld = fs.existsSync(tPath) ? JSON.parse(fs.readFileSync(tPath, 'utf8')) : {};
for (const m of modelMeta) if (m) mOld[m.id] = { role: m.role, size: m.size, hull: m.hull, tris: m.tris, bytes: m.bytes, name: m.name };
for (const t of texMeta) if (t) tOld[t.id] = { arm: t.arm, metal: t.metal, name: t.name };
const sortObj = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
fs.writeFileSync(mPath, JSON.stringify(sortObj(mOld), null, 0).replace(/\},"/g, '},\n"'));
fs.writeFileSync(tPath, JSON.stringify(sortObj(tOld), null, 0).replace(/\},"/g, '},\n"'));
const failedM = models.filter((_, i) => !modelMeta[i]).map((m) => m.id);
const failedT = textures.filter((_, i) => !texMeta[i]).map((m) => m.id);
console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s. models ok=${modelMeta.filter(Boolean).length} textures ok=${texMeta.filter(Boolean).length}`);
if (failedM.length || failedT.length) console.log('FAILED:', failedM.concat(failedT).join(', '));
