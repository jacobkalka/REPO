// Animated 3D backdrop for menus and the lobby: the lift bay of the depot, with the crew
// standing in the lift car.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { buildPracticeLevel } from '../../../shared/levelgen/practice';
import type { Appearance } from '../../../shared/catalog/items';
import type { Engine } from '../core/Engine';
import { assets } from '../core/Assets';
import { CrewAvatar } from '../models/Avatar';
import { LightPool } from '../render/LightPool';
import { LevelBuilder, type LevelView } from './LevelBuilder';

export class MenuScene {
  readonly root = new THREE.Group();
  private view: LevelView | null = null;
  private pool: LightPool | null = null;
  private avatars = new Map<string, CrewAvatar>();
  private t = 0;
  ready = false;
  private flicker: THREE.PointLight;

  constructor(readonly engine: Engine) {
    this.flicker = new THREE.PointLight('#ffb36b', 0, 9, 2);
    this.root.add(this.flicker);
  }

  async load() {
    const level = buildPracticeLevel();
    const req = LevelBuilder.requirements(level);
    assets.textureScale = this.engine.quality.textureScale;
    await assets.preload(req.models.filter((m) => !/statue|whale|compressor|generator/.test(m)), req.textures);
    this.view = new LevelBuilder(level, this.engine.quality.cones).build();
    this.root.add(this.view.root);
    this.pool = new LightPool(this.root, 6, Math.min(2, this.engine.quality.shadowLights), 1024);
    const e = level.extraction;
    this.cam = new THREE.Vector3((e.aboard.x0 + e.aboard.x1) / 2 + 1.9, e.zone.y + 1.5, e.aboard.z0 - 2.7);
    this.look = new THREE.Vector3((e.aboard.x0 + e.aboard.x1) / 2 - 1.2, e.zone.y + 1.25, (e.aboard.z0 + e.aboard.z1) / 2 + 0.4);
    this.carCenter = new THREE.Vector3((e.aboard.x0 + e.aboard.x1) / 2, e.zone.y, (e.aboard.z0 + e.aboard.z1) / 2);
    this.flicker.position.set(this.cam.x - 1, e.zone.y + 3.6, this.cam.z + 1);
    if (this.view.liftGate) this.view.liftGate.position.y = e.zone.y + 2.7;
    this.ready = true;
  }
  private cam = new THREE.Vector3();
  private look = new THREE.Vector3();
  private carCenter = new THREE.Vector3();

  attach() {
    const s = this.engine.scene;
    s.add(this.root);
    const pmrem = new THREE.PMREMGenerator(this.engine.renderer);
    s.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    s.environmentIntensity = 0.2;
    pmrem.dispose();
    s.fog = new THREE.FogExp2('#0c0a08', 0.05);
    s.background = new THREE.Color('#0c0a08');
  }

  detach() {
    this.root.removeFromParent();
    this.engine.scene.environment = null;
    this.engine.scene.fog = null;
  }

  setCrew(crew: { id: string; name: string; appearance: Appearance }[]) {
    const ids = new Set(crew.map((c) => c.id));
    for (const [id, a] of [...this.avatars]) if (!ids.has(id)) { a.dispose(); this.avatars.delete(id); }
    crew.forEach((c, i) => {
      let a = this.avatars.get(c.id);
      if (!a) { a = new CrewAvatar(c.appearance, c.name); this.avatars.set(c.id, a); this.root.add(a.group); }
      else if (JSON.stringify(a.appearance) !== JSON.stringify(c.appearance)) void a.setAppearance(c.appearance);
      if (a.name !== c.name) a.setName(c.name);
      const offs = [[-0.2, 0.3], [-1.6, -0.3], [1.2, -0.2], [-3.0, 0.4]];
      a.group.position.set(this.carCenter.x + offs[i % 4][0], this.carCenter.y, this.carCenter.z + offs[i % 4][1]);
      a.group.rotation.y = Math.PI + 0.35 - i * 0.18 + Math.PI;
      a.group.userData.idx = i;
    });
  }

  update(dt: number) {
    if (!this.ready || !this.view) return;
    this.t += dt;
    const cam = this.engine.camera;
    cam.position.set(this.cam.x + Math.sin(this.t * 0.07) * 0.35, this.cam.y + Math.sin(this.t * 0.11) * 0.06, this.cam.z + Math.cos(this.t * 0.05) * 0.2);
    cam.lookAt(this.look);
    cam.updateMatrixWorld();
    for (const a of this.avatars.values()) {
      const i = a.group.userData.idx as number;
      a.update({ dt, t: this.t + i * 1.7, speed: 0, state: 'idle', aux: 0, pitch: Math.sin(this.t * 0.4 + i) * 0.08 });
      a.showTag(true, 0.85);
      a.setTorch(true);
    }
    for (const l of this.view.lights) l.enabled = true;
    this.pool?.update(cam, this.view.lights, dt, this.t);
    this.flicker.intensity = 2 + Math.max(0, Math.sin(this.t * 13) * Math.sin(this.t * 3.7)) * 6;
  }
}
