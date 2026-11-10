// Asset loading: meshopt-compressed GLB models, PBR texture sets, caching.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import TEXTURES from '../../../shared/assets/textures.json';
import { MODELS } from '../../../shared/catalog/furniture';

export interface SurfaceTextures { map: THREE.Texture; normalMap: THREE.Texture; arm: THREE.Texture | null }

const BASE = import.meta.env.BASE_URL + 'assets/';

export class Assets {
  private gltf = new GLTFLoader();
  private models = new Map<string, Promise<THREE.Group | null>>();
  private loadedModels = new Map<string, THREE.Group>();
  private textures = new Map<string, Promise<SurfaceTextures | null>>();
  textureScale = 1;
  anisotropy = 4;
  bytesLoaded = 0;

  constructor() {
    this.gltf.setMeshoptDecoder(MeshoptDecoder);
  }

  hasModel(id: string) { return !!MODELS[id]; }

  loadModel(id: string): Promise<THREE.Group | null> {
    let p = this.models.get(id);
    if (!p) {
      p = this.gltf.loadAsync(`${BASE}models/${id}.glb`).then((g) => {
        const root = g.scene;
        root.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          m.castShadow = true;
          m.receiveShadow = true;
          const mats = Array.isArray(m.material) ? m.material : [m.material];
          for (const mat of mats as THREE.MeshStandardMaterial[]) {
            if (mat.map) mat.map.anisotropy = this.anisotropy;
            mat.envMapIntensity = 0.55;
            if (mat.aoMap) mat.aoMapIntensity = 0.9;
          }
        });
        this.loadedModels.set(id, root);
        return root;
      }).catch((e) => { console.warn('model load failed', id, e); return null; });
      this.models.set(id, p);
    }
    return p;
  }

  /** synchronous clone of an already-loaded model (shares geometry and materials) */
  instance(id: string): THREE.Object3D | null {
    const t = this.loadedModels.get(id);
    return t ? t.clone(true) : null;
  }

  modelTemplate(id: string) { return this.loadedModels.get(id) ?? null; }

  private async loadImage(url: string, srgb: boolean, maxSize?: number): Promise<THREE.Texture> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    const blob = await res.blob();
    this.bytesLoaded += blob.size;
    let bmp: ImageBitmap;
    if (maxSize && maxSize < 1024) bmp = await createImageBitmap(blob, { resizeWidth: maxSize, resizeHeight: maxSize, resizeQuality: 'high' });
    else bmp = await createImageBitmap(blob);
    const tex = new THREE.Texture(bmp);
    tex.flipY = false;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.anisotropy = this.anisotropy;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.needsUpdate = true;
    return tex;
  }

  loadSurface(id: string): Promise<SurfaceTextures | null> {
    let p = this.textures.get(id);
    if (!p) {
      const meta = (TEXTURES as Record<string, { arm: boolean }>)[id];
      const size = this.textureScale < 1 ? 512 : undefined;
      p = Promise.all([
        this.loadImage(`${BASE}textures/${id}_diff.webp`, true, size),
        this.loadImage(`${BASE}textures/${id}_nor.webp`, false, size),
        meta?.arm ? this.loadImage(`${BASE}textures/${id}_arm.webp`, false, size ? 256 : undefined) : Promise.resolve(null),
      ]).then(([map, normalMap, arm]) => ({ map, normalMap, arm })).catch((e) => { console.warn('texture load failed', id, e); return null; });
      this.textures.set(id, p);
    }
    return p;
  }

  async preload(models: string[], textures: string[], onProgress?: (f: number) => void) {
    const total = models.length + textures.length;
    let done = 0;
    const tick = () => { done++; onProgress?.(done / Math.max(1, total)); };
    await Promise.all([
      ...models.map((m) => this.loadModel(m).then(tick)),
      ...textures.map((t) => this.loadSurface(t).then(tick)),
    ]);
  }
}

export const assets = new Assets();
