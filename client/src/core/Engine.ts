// Renderer, scenes, cameras, post-processing, main loop with frame limiting.
import * as THREE from 'three';
import { PostFX } from '../render/PostFX';
import type { Quality, Settings } from './Settings';

export interface QualityProfile {
  shadows: boolean;
  shadowMapSize: number;
  shadowLights: number;     // how many pooled lights cast shadows
  poolSize: number;         // pooled dynamic lights
  maxPixelRatio: number;
  anisotropy: number;
  textureScale: number;     // 1 = full res textures, 0.5 = half
  cones: boolean;           // volumetric light cones
  particles: number;        // particle budget multiplier
  lodBias: number;
}

export const QUALITY: Record<Quality, QualityProfile> = {
  low: { shadows: true, shadowMapSize: 512, shadowLights: 0, poolSize: 6, maxPixelRatio: 1, anisotropy: 2, textureScale: 0.5, cones: false, particles: 0.4, lodBias: 0.6 },
  medium: { shadows: true, shadowMapSize: 1024, shadowLights: 1, poolSize: 8, maxPixelRatio: 1, anisotropy: 4, textureScale: 1, cones: true, particles: 0.7, lodBias: 0.8 },
  high: { shadows: true, shadowMapSize: 1024, shadowLights: 3, poolSize: 11, maxPixelRatio: 1.5, anisotropy: 8, textureScale: 1, cones: true, particles: 1, lodBias: 1 },
  ultra: { shadows: true, shadowMapSize: 2048, shadowLights: 4, poolSize: 14, maxPixelRatio: 2, anisotropy: 16, textureScale: 1, cones: true, particles: 1.3, lodBias: 1.3 },
};

export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(78, 16 / 9, 0.05, 160);
  readonly viewScene = new THREE.Scene();
  readonly viewCamera = new THREE.PerspectiveCamera(62, 16 / 9, 0.01, 10);
  readonly post: PostFX;
  quality: QualityProfile;
  qualityName: Quality;
  private running = false;
  private lastFrame = 0;
  private frameAcc = 0;
  private updateFns: ((dt: number, t: number) => void)[] = [];
  fps = 0;
  frameMs = 0;
  cpuMs = 0;
  private fpsFrames = 0;
  private fpsTime = 0;
  private channel = new MessageChannel();
  width = 1;
  height = 1;

  constructor(readonly canvas: HTMLCanvasElement, readonly settings: Settings) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false, depth: true, alpha: false, preserveDrawingBuffer: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.setClearColor(0x050607, 1);
    this.renderer.info.autoReset = false; // accumulate across post-processing passes
    this.qualityName = settings.data.quality;
    this.quality = QUALITY[this.qualityName];
    this.scene.background = new THREE.Color(0x050607);
    this.viewScene.add(this.viewCamera);
    this.post = new PostFX(this.renderer, this.scene, this.camera, this.viewScene, this.viewCamera);
    this.resize();
    this.post.configure(this.qualityName, this.width, this.height);
    window.addEventListener('resize', () => this.resize());
    settings.onChange((s, changed) => {
      if (changed.includes('quality')) this.setQuality(s.quality);
      if (changed.some((c) => c === 'renderScale' || c === 'resolution')) this.resize();
      if (changed.includes('fov')) { this.camera.fov = s.fov; this.camera.updateProjectionMatrix(); }
      if (changed.includes('brightness')) this.renderer.toneMappingExposure = s.brightness;
    });
    this.camera.fov = settings.data.fov;
    this.renderer.toneMappingExposure = settings.data.brightness;
    this.channel.port1.onmessage = () => this.frame(performance.now());
  }

  get maxAnisotropy() { return Math.min(this.renderer.capabilities.getMaxAnisotropy(), this.quality.anisotropy); }

  setQuality(q: Quality) {
    this.qualityName = q;
    this.quality = QUALITY[q];
    this.resize();
    this.post.configure(q, this.width, this.height);
    this.onQuality?.(q);
  }
  onQuality?: (q: Quality) => void;

  resize() {
    const s = this.settings.data;
    const cssW = window.innerWidth, cssH = window.innerHeight;
    let pr = Math.min(window.devicePixelRatio || 1, this.quality.maxPixelRatio) * s.renderScale;
    if (s.resolution !== 'native') {
      const [rw] = s.resolution.split('x').map(Number);
      pr = Math.min(pr, rw / cssW);
    }
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(cssW, cssH, false);
    this.width = Math.max(1, Math.floor(cssW * pr));
    this.height = Math.max(1, Math.floor(cssH * pr));
    this.camera.aspect = cssW / cssH;
    this.camera.updateProjectionMatrix();
    this.viewCamera.aspect = cssW / cssH;
    this.viewCamera.updateProjectionMatrix();
    this.post.setSize(this.width, this.height);
  }

  onUpdate(fn: (dt: number, t: number) => void) { this.updateFns.push(fn); }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    this.schedule();
  }

  private schedule() {
    if (!this.running) return;
    if (this.settings.data.vsync || document.hidden) requestAnimationFrame((t) => this.frame(t));
    else this.channel.port2.postMessage(0); // uncapped loop (browsers still present at display refresh)
  }

  private frame(now: number) {
    if (!this.running) return;
    const limit = this.settings.data.fpsLimit;
    const elapsed = now - this.lastFrame;
    if (limit > 0 && elapsed < 1000 / limit - 0.5) { this.schedule(); return; }
    const dt = Math.min(0.1, elapsed / 1000);
    this.lastFrame = now;
    const t0 = performance.now();
    this.renderer.info.reset();
    for (const fn of this.updateFns) fn(dt, now / 1000);
    this.post.render(dt);
    this.cpuMs = performance.now() - t0;
    this.frameMs = this.frameMs * 0.9 + elapsed * 0.1;
    this.fpsFrames++;
    this.fpsTime += elapsed;
    if (this.fpsTime >= 500) { this.fps = (this.fpsFrames * 1000) / this.fpsTime; this.fpsFrames = 0; this.fpsTime = 0; }
    void this.frameAcc;
    this.schedule();
  }

  stats() {
    const i = this.renderer.info;
    return { calls: i.render.calls, tris: i.render.triangles, geometries: i.memory.geometries, textures: i.memory.textures, programs: i.programs?.length ?? 0 };
  }
}
