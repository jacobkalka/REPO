// Client-side mission: builds the facility, predicts the local player, applies server state,
// handles interaction / carrying / equipment, drives lights, audio and HUD state.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { getTheme } from '../../../shared/catalog/maps';
import { ITEM_BY_ID, type LoadoutSlot } from '../../../shared/catalog/items';
import { VALUABLE_BY_ID } from '../../../shared/catalog/valuables';
import { DOCUMENT_BY_ID } from '../../../shared/catalog/documents';
import { MONSTERS } from '../../../shared/catalog/monsters';
import { GRAB, MISSION, NET, PLAYER } from '../../../shared/constants';
import { doorLeaves, doorOpenTarget, leafPose, stepDoorValue, swingAway } from '../../../shared/doors';
import { generateLevel } from '../../../shared/levelgen/generate';
import { buildPracticeLevel } from '../../../shared/levelgen/practice';
import type { LevelData } from '../../../shared/levelgen/types';
import { buildStaticColliders } from '../../../shared/physics/colliders';
import { BinWriter, encodeClientState, PF, type GameEvent, type LiftState, type MissionInfo, type MissionStateFull, type PlacedLight, type QuotaState, type Snapshot, type V3 } from '../../../shared/protocol';
import type { Profile } from '../../../shared/profile';
import type { AudioEngine } from '../audio/AudioEngine';
import { assets } from '../core/Assets';
import type { Engine } from '../core/Engine';
import type { Input } from '../core/Input';
import type { Settings } from '../core/Settings';
import type { Connection } from '../net/Connection';
import { RoomVisibility } from '../render/Culling';
import { LightPool, type VirtualLight } from '../render/LightPool';
import { materials, canvasTex } from '../render/Materials';
import { LevelBuilder, type LevelView } from '../world/LevelBuilder';
import { ClientWorld, initClientPhysics } from './ClientWorld';
import { LocalPlayer } from './LocalPlayer';
import { Props, type ClientProp } from './Props';
import { Remotes } from './Remotes';

export interface Focus { kind: 'prop' | 'door' | 'inter' | 'player' | 'body'; id: number; dist: number; label: string; sub?: string; hold?: boolean; warn?: boolean }
export interface HudMsg { text: string; kind: string; at: number }
export interface Popup { pos: THREE.Vector3; text: string; at: number; color: string }

const tmpV = new THREE.Vector3();

export class MissionClient {
  level!: LevelData;
  view!: LevelView;
  world!: ClientWorld;
  player!: LocalPlayer;
  props!: Props;
  remotes!: Remotes;
  pool!: LightPool;
  vis!: RoomVisibility;
  readonly root = new THREE.Group();
  torch!: THREE.SpotLight;
  torchOn = false;
  private torchFlicker = 0;
  private viewmodel = new THREE.Group();
  private vmTorch = new THREE.Group();
  private vmLeft = new THREE.Group();
  private tether!: THREE.Mesh;
  private hemi!: THREE.HemisphereLight;
  private placedLights: THREE.PointLight[] = [];
  private placed = new Map<number, PlacedLight & { obj: THREE.Object3D }>();
  private writer = new BinWriter(1024);
  private sendAcc = 0;
  private seq = 0;
  myNetId = -1;
  info: MissionInfo;
  // shared state
  quota: QuotaState = { quota: 0, inZone: 0, tubed: 0, banked: 0 };
  lift: LiftState = { state: 'locked', until: 0, aboard: [] };
  sectors = new Map<number, boolean>();
  roomSwitch = new Map<number, boolean>();
  keys = new Set<number>();
  items: Record<string, number> = {};
  battery = 1;
  hp = 100;
  life: string = 'alive';
  marked = 0;
  pinned = false;
  overtimeAt = 0;
  overtime = false;
  mapUntil = 0;
  scan: { until: number; p: THREE.Vector3; r: number } | null = null;
  trackerOn = false;
  messages: HudMsg[] = [];
  popups: Popup[] = [];
  captions: { text: string; at: number }[] = [];
  pings: { p: THREE.Vector3; at: number; by: number }[] = [];
  revive: { id: number; progress: number; at: number } | null = null;
  docOpen: string | null = null;
  docsRead = new Set<string>();
  visited = new Set<number>();
  hazardsOff = new Set<number>();
  surgeUntil = 0;
  lockdownUntil = 0;
  focus: Focus | null = null;
  damageFlash = 0;
  downedSince = 0;
  spectating = -1;
  readonly startedAt = performance.now();
  // grab state
  private grabReq = 0;
  private holding: { id: number; role: 'owner' | 'helper'; dist: number; lp: THREE.Vector3; relQ: THREE.Quaternion } | null = null;
  private pendingGrab = -1;
  rotating = false;
  private stepVoice = 0;
  private hazardLoops = new Map<number, ReturnType<AudioEngine['play']>>();
  private reqCounter = 1;
  private lastVoiceSent = 0;
  private interactHoldT = 0;
  ready = false;
  private gateY = 0;
  onLeave?: () => void;

  constructor(readonly engine: Engine, readonly input: Input, readonly settings: Settings, readonly conn: Connection, readonly audio: AudioEngine, info: MissionInfo, readonly profile: () => Profile | null) {
    this.info = info;
  }

  // =================================================================== loading
  async load(onProgress: (f: number, label: string) => void) {
    const info = this.info;
    this.myNetId = info.players.find((p) => p.id === this.conn.playerId)?.netId ?? -1;
    onProgress(0.02, 'Generating facility');
    this.level = info.practice ? buildPracticeLevel() : generateLevel({ map: info.map, seed: info.seed, difficulty: info.difficulty, crew: info.crew, streak: info.streak });
    await initClientPhysics();
    onProgress(0.08, 'Loading assets');
    const req = LevelBuilder.requirements(this.level);
    assets.textureScale = this.engine.quality.textureScale;
    assets.anisotropy = this.engine.maxAnisotropy;
    await assets.preload(req.models, req.textures, (f) => onProgress(0.08 + f * 0.7, 'Loading assets'));
    onProgress(0.8, 'Building facility');
    await new Promise((r) => setTimeout(r, 0));
    const scene = this.engine.scene;
    const theme = getTheme(this.level.map);
    // environment & atmosphere
    const pmrem = new THREE.PMREMGenerator(this.engine.renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.22;
    pmrem.dispose();
    scene.fog = new THREE.FogExp2(theme.fog.color, theme.fog.density);
    scene.background = new THREE.Color(theme.fog.color);
    this.hemi = new THREE.HemisphereLight(theme.ambient.color, '#080706', theme.ambient.intensity * 6);
    this.root.add(this.hemi);
    // facility
    this.view = new LevelBuilder(this.level, this.engine.quality.cones).build();
    this.root.add(this.view.root);
    scene.add(this.root);
    // physics
    this.world = new ClientWorld(buildStaticColliders(this.level));
    for (const d of this.level.doors) if (d.leaf) this.world.addDoor(d);
    this.player = new LocalPlayer(this.world);
    const idx = info.players.findIndex((p) => p.netId === this.myNetId);
    const sp = this.level.playerSpawns[Math.max(0, idx) % this.level.playerSpawns.length];
    this.player.teleport(sp.x, sp.y, sp.z);
    this.player.yaw = sp.rotY;
    this.player.onStep = (k) => this.footstep(k);
    this.player.onLand = (v) => this.audio.play('step_' + this.surfaceAt(this.player.pos), { pos: this.player.pos.clone(), volume: Math.min(1, v / 8) + 0.3, rate: 0.8 });
    this.player.onJump = () => this.audio.play('jump', { volume: 0.5 });
    this.props = new Props(this.world, this.root);
    this.props.myNetId = this.myNetId;
    this.props.onImpact = (p, speed, pt) => this.localImpact(p, speed, pt);
    this.remotes = new Remotes(this.root);
    this.remotes.myNetId = this.myNetId;
    const lightFor = (pid: string) => (pid === this.conn.playerId ? this.profile()?.loadout.light ?? 'light_t1' : 'light_t1');
    for (const p of info.players) if (p.netId !== this.myNetId) this.remotes.addPlayer({ netId: p.netId, name: p.name, appearance: p.appearance, light: lightFor(p.id) });
    // lights
    const q = this.engine.quality;
    this.pool = new LightPool(this.root, q.poolSize, q.shadowLights, q.shadowMapSize);
    this.pool.reduceFlicker = this.settings.data.reduceFlicker;
    this.vis = new RoomVisibility(this.level, this.view.rooms, this.view.doors);
    this.buildTorch();
    for (let i = 0; i < 3; i++) { const l = new THREE.PointLight('#ff5a3a', 0, 8, 2); this.root.add(l); this.placedLights.push(l); }
    for (const s of this.level.sectors) this.sectors.set(s.id, s.powered);
    this.quota.quota = info.quota;
    onProgress(0.92, 'Preparing creatures');
    await this.audio.prewarm(['step_concrete', 'step_metal', 'step_tile', 'impact_metal', 'impact_wood', 'door_open_metal', 'door_close_metal', 'pickup', 'switch']);
    this.audio.startAmbience(this.level.map);
    this.audio.occlusionTest = (a, b) => { const d = tmpV.copy(b).sub(a); const len = d.length(); if (len < 0.5) return false; d.divideScalar(len); const h = this.world.raycast(a, d, len - 0.3); return !!h && h.kind !== 'prop'; };
    this.ready = true;
    onProgress(1, 'Ready');
  }

  private buildTorch() {
    const cookie = canvasTex(256, 256, (g) => {
      const grd = g.createRadialGradient(128, 128, 0, 128, 128, 128);
      grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.18, 'rgba(255,250,240,0.95)'); grd.addColorStop(0.32, 'rgba(200,190,170,0.55)');
      grd.addColorStop(0.42, 'rgba(235,225,205,0.7)'); grd.addColorStop(0.55, 'rgba(120,110,95,0.35)'); grd.addColorStop(0.85, 'rgba(40,36,30,0.12)'); grd.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = '#000'; g.fillRect(0, 0, 256, 256); g.fillStyle = grd; g.fillRect(0, 0, 256, 256);
      for (let i = 0; i < 900; i++) { g.fillStyle = `rgba(0,0,0,${Math.random() * 0.06})`; g.fillRect(Math.random() * 256, Math.random() * 256, 3, 3); }
    }, true, false);
    this.torch = new THREE.SpotLight('#fff1d6', 0, 18, 0.44, 0.5, 2);
    this.torch.castShadow = true;
    this.torch.shadow.mapSize.set(this.engine.quality.shadowMapSize, this.engine.quality.shadowMapSize);
    this.torch.shadow.bias = -0.0005;
    this.torch.shadow.normalBias = 0.03;
    this.torch.shadow.camera.near = 0.2;
    this.torch.map = cookie;
    this.root.add(this.torch, this.torch.target);
    // first-person hands: sleeve + gloved fist around the torch grip (right), free glove (left)
    const suit = new THREE.MeshStandardMaterial({ color: '#c8642a', roughness: 0.8 });
    const glove = new THREE.MeshStandardMaterial({ color: '#1e1f20', roughness: 0.75 });
    const mkArm = (g: THREE.Group, side: number) => {
      const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.05, 0.34, 14), suit);
      sleeve.rotation.x = Math.PI / 2 - 0.12; sleeve.position.set(0.01 * side, -0.035, 0.17);
      const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.046, 0.046, 0.05, 14), glove);
      cuff.rotation.x = Math.PI / 2 - 0.12; cuff.position.set(0.01 * side, -0.02, 0.01);
      const fist = new THREE.Mesh(new THREE.SphereGeometry(0.045, 14, 10), glove);
      fist.scale.set(1.0, 0.85, 1.35); fist.position.set(0, 0, -0.04);
      g.add(sleeve, cuff, fist);
    };
    mkArm(this.vmTorch, 1);
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.021, 0.024, 0.19, 14), new THREE.MeshStandardMaterial({ color: '#2a2b2c', roughness: 0.35, metalness: 0.8 }));
    body.rotation.x = Math.PI / 2; body.position.set(0, 0.012, -0.11);
    const head = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.024, 0.05, 16), new THREE.MeshStandardMaterial({ color: '#1c1d1e', roughness: 0.3, metalness: 0.9 }));
    head.rotation.x = Math.PI / 2; head.position.set(0, 0.012, -0.215);
    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.027, 18), new THREE.MeshBasicMaterial({ color: '#fff1d6' }));
    lens.position.set(0, 0.012, -0.241); lens.rotation.y = Math.PI; lens.name = 'lens';
    this.vmTorch.add(body, head, lens);
    mkArm(this.vmLeft, -1);
    for (const g of [this.vmTorch, this.vmLeft]) g.traverse((o) => { (o as THREE.Mesh).castShadow = false; });
    this.vmTorch.position.set(0.17, -0.17, -0.3);
    this.vmLeft.position.set(-0.22, -0.3, -0.26);
    this.viewmodel.add(this.vmTorch, this.vmLeft);
    this.root.add(this.viewmodel);
    this.tether = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 1, 6, 1, true), new THREE.MeshBasicMaterial({ color: new THREE.Color('#ffb85a').multiplyScalar(2), transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.tether.visible = false;
    this.root.add(this.tether);
    const p = this.profile();
    if (p) { const c = (globalThis as unknown as { __suitColor?: string }).__suitColor; void c; }
  }

  setSuitColor(color: string) {
    this.vmTorch.traverse((o) => { const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial; if (m && m.color && m.roughness === 0.8) m.color.set(color); });
    this.vmLeft.traverse((o) => { const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial; if (m && m.color && m.roughness === 0.8) m.color.set(color); });
  }

  // =================================================================== net in
  applyFullState(s: MissionStateFull) {
    for (const id of [...this.props.items.keys()]) this.props.remove(id);
    for (const p of s.props) this.props.add(p);
    for (const p of s.props) if (p.owner >= 0) this.props.onOwn({ k: 'own', id: p.id, owner: p.owner, helpers: p.helpers, lp: {} });
    for (const d of s.doors) {
      const dv = this.view.doors[d.id];
      if (!dv) continue;
      dv.open = d.open; dv.locked = d.locked;
      if (d.broken && !dv.broken) this.breakDoor(d.id, false);
      dv.target = d.open ? doorOpenTarget(dv.data, 1) : 0;
      dv.value = dv.target;
      if (dv.reader) dv.reader.color.set(d.locked ? '#ff4a3a' : '#7dff9a');
      if (dv.data.kind === 'hidden') dv.revealed = d.open;
    }
    for (const it of s.inters) this.setInter(it.id, it.state);
    for (const x of s.sectors) this.sectors.set(x.id, x.on);
    for (const r of s.lightsOff) this.roomSwitch.set(r, false);
    this.keys = new Set(s.keys);
    this.quota = s.quota;
    this.lift = s.lift;
    for (const e of s.enemies) this.remotes.addEnemy(e.id, e.type);
    for (const l of s.placed) this.addPlaced(l);
    this.hazardsOff = new Set(s.hazardsOff);
    this.overtimeAt = s.overtimeAt;
    this.mapUntil = s.mapUntil;
    this.docsRead = new Set(s.docsRead);
    for (const p of s.players) if (p.netId === this.myNetId) { this.hp = p.hp; this.life = p.state; this.battery = p.battery; }
    this.conn.resetClock();
  }

  onSnapshot(s: Snapshot) {
    if (!this.ready) return;
    this.props.applySnapshot(s.props, s.time);
    this.props.applyHelpers(s.helpers);
    this.remotes.applySnapshot(s.players, s.enemies, s.time);
    for (const p of s.players) {
      if (p.netId !== this.myNetId) continue;
      this.hp = p.hp;
      this.pinned = (p.flags & PF.PINNED) !== 0;
      this.player.pinned = this.pinned;
      this.player.stunned = (p.flags & PF.STUNNED) !== 0;
      this.marked = (p.flags & PF.MARKED) ? 1 : 0;
    }
    for (const m of s.movers) {
      if (m.id === 60000) this.gateY = m.value;
      else if (m.id >= 61000) { const h = this.level.hazards[m.id - 61000]; const a = this.view.anims.find((x) => x.kind === 'press' && h && Math.hypot(x.obj.position.x - h.x, x.obj.position.z - h.z) < 0.5); if (a) a.data = m.value; }
    }
    this.player.frozen = this.conn.missionTime() < this.info.startAt - 0.2 || this.life === 'dead' || this.life === 'extracted';
  }

  onEvents(evs: GameEvent[]) {
    if (!this.ready) return;
    const now = performance.now() / 1000;
    for (const e of evs) {
      switch (e.k) {
        case 'prop+': this.props.add(e.p); break;
        case 'prop-': {
          const p = this.props.items.get(e.id);
          if (p && (e.why === 'broken' || e.why === 'crushed' || e.why === 'exploded')) this.popups.push({ pos: p.mesh.position.clone(), text: e.why === 'broken' ? 'BROKEN' : e.why === 'crushed' ? 'CRUSHED' : 'DESTROYED', at: now, color: '#d1493b' });
          if (p && e.why === 'tube') this.popups.push({ pos: p.mesh.position.clone(), text: '+$' + p.value.toLocaleString(), at: now, color: '#7fb77e' });
          if (this.holding?.id === e.id) this.holding = null;
          this.props.remove(e.id);
          break;
        }
        case 'val': {
          const p = this.props.items.get(e.id);
          if (p) { p.value = e.v; this.popups.push({ pos: new THREE.Vector3(...e.p), text: '-$' + e.dmg.toLocaleString(), at: now, color: '#d1493b' }); }
          break;
        }
        case 'own': {
          this.props.onOwn(e);
          if (this.holding?.id === e.id) {
            const mine = e.owner === this.myNetId || e.helpers.includes(this.myNetId);
            if (!mine) this.dropLocal();
            else this.holding.role = e.owner === this.myNetId ? 'owner' : 'helper';
          }
          break;
        }
        case 'door': this.onDoor(e); break;
        case 'inter': this.setInter(e.id, e.state); break;
        case 'power': this.sectors.set(e.sector, e.on); break;
        case 'light': this.roomSwitch.set(e.room, e.on); break;
        case 'dmg':
          if (e.target === this.myNetId) {
            this.hp = e.hp;
            if (e.amount > 0) { this.damageFlash = Math.min(1, this.damageFlash + 0.35 + e.amount / 80); this.player.trauma = Math.min(1, this.player.trauma + 0.25 + e.amount / 120); this.audio.play('hurt', { volume: 0.7 }); }
            if (e.kb) this.player.impulse(e.kb);
          }
          break;
        case 'life':
          if (e.id === this.myNetId) {
            this.life = e.state;
            this.player.life = e.state;
            if (e.state === 'downed') { this.downedSince = now; this.dropLocal(); }
            if (e.state === 'alive') this.hp = e.hp;
            if (e.state === 'dead') { this.dropLocal(); this.torchOn = false; }
          }
          { const r = this.remotes.players.get(e.id); if (r) r.life = e.state; }
          break;
        case 'heal': if (e.id === this.myNetId) this.hp = e.hp; break;
        case 'enemy+': this.remotes.addEnemy(e.id, e.type); break;
        case 'enemy-': this.remotes.removeEnemy(e.id); break;
        case 'eatk': break;
        case 'sfx': this.audio.play(e.s, { pos: new THREE.Vector3(...e.p), volume: e.v, rate: e.r && e.r > 0 && e.s.startsWith('impact_') ? Math.max(0.55, Math.min(1.5, 1.4 - Math.log10(Math.max(0.2, e.r)) * 0.35)) : 1, ref: e.e ? 6 : 1.6, maxDist: e.e ? 90 : 45 }); break;
        case 'quota': this.quota = e.q; break;
        case 'lift': this.lift = e.l; break;
        case 'msg': this.pushMsg(e.text, e.kind); break;
        case 'director':
          if (e.name === 'surge') this.surgeUntil = now + ((e.until ?? 0) - this.conn.missionTime());
          if (e.name === 'lockdown') this.lockdownUntil = now + ((e.until ?? 0) - this.conn.missionTime());
          if (e.name === 'torch' && e.data === this.myNetId) this.torchFlicker = 4;
          break;
        case 'mark': if (e.id === this.myNetId) this.marked = 1; break;
        case 'pin': if (e.id === this.myNetId) { this.pinned = e.by >= 0; this.player.pinned = this.pinned; if (this.pinned) this.dropLocal(); } break;
        case 'items': if (e.id === this.myNetId) { this.items = e.items; this.battery = e.battery; if (e.battery <= 0.001 && this.torchOn) { this.torchOn = false; this.pushMsg('Torch battery depleted.', 'warn'); } } break;
        case 'keys': this.keys = new Set(e.keys); break;
        case 'doc': this.docsRead.add(e.doc); if (e.by === this.myNetId) this.docOpen = e.doc; break;
        case 'scan': if (e.by === this.myNetId) this.scan = { until: now + (e.until - this.conn.missionTime()), p: new THREE.Vector3(...e.p), r: e.r }; break;
        case 'placed': this.addPlaced(e.l); break;
        case 'placed-': this.removePlaced(e.id); break;
        case 'map': this.mapUntil = e.until; break;
        case 'hazard': if (e.on) this.hazardsOff.delete(e.id); else this.hazardsOff.add(e.id); break;
        case 'stun': { const en = this.remotes.enemies.get(e.id); if (en) en.stunnedUntil = now + 3; break; }
        case 'boom': if (e.r > 0) { const d = this.player.pos.distanceTo(new THREE.Vector3(...e.p)); this.player.trauma = Math.min(1, this.player.trauma + Math.max(0, 1 - d / 14)); this.audio.play('distant_bang', { pos: new THREE.Vector3(...e.p), volume: 1, ref: 8 }); } else { const d = this.player.pos.distanceTo(new THREE.Vector3(...e.p)); this.player.trauma = Math.min(1, this.player.trauma + Math.max(0, 0.7 - d / 12)); } break;
        case 'overtime': this.overtime = true; break;
        case 'use': if (e.id === this.myNetId && e.item === 'stim') this.stimUntil = now + 20; break;
        case 'revive': this.revive = { id: e.id, progress: e.progress, at: now }; break;
        case 'impulse': if (e.id === this.myNetId) this.player.impulse(e.v); break;
        case 'tube': break;
        case 'ping': this.pings.push({ p: new THREE.Vector3(...e.p), at: now, by: e.by }); this.audio.play('ping', { pos: new THREE.Vector3(...e.p), volume: 0.6, occlude: false }); break;
        default:
      }
    }
  }
  private stimUntil = 0;

  pushMsg(text: string, kind: string) {
    this.messages.push({ text, kind, at: performance.now() / 1000 });
    if (this.messages.length > 6) this.messages.shift();
  }

  private onDoor(e: Extract<GameEvent, { k: 'door' }>) {
    const dv = this.view.doors[e.id];
    if (!dv) return;
    dv.locked = e.locked;
    if (dv.reader) dv.reader.color.set(e.locked ? '#ff4a3a' : '#7dff9a');
    if (e.broken && !dv.broken) { this.breakDoor(e.id, !!e.smash); return; }
    if (e.open !== dv.open) {
      dv.open = e.open;
      let from: [number, number] = [this.player.pos.x, this.player.pos.z];
      const r = this.remotes.players.get(e.by);
      if (r) from = [r.pos.x, r.pos.z];
      else if (e.by < 0) {
        // opened by a creature or system: find the nearest creature
        let best = Infinity;
        for (const en of this.remotes.enemies.values()) { const d = Math.hypot(en.pos.x - dv.data.x, en.pos.z - dv.data.z); if (d < best) { best = d; from = [en.pos.x, en.pos.z]; } }
      }
      dv.target = e.open ? doorOpenTarget(dv.data, swingAway(dv.data, from)) : 0;
      dv.fast = e.by < 0;
      if (dv.data.kind === 'hidden' && e.open) dv.revealed = true;
    }
  }

  private breakDoor(id: number, smash: boolean) {
    const dv = this.view.doors[id];
    dv.broken = true; dv.open = true;
    for (const l of dv.leaves) {
      if (smash) {
        // fling the leaf as debris (visual only)
        const m = l.mesh;
        const vel = new THREE.Vector3((Math.random() - 0.5) * 3, 2.5, (Math.random() - 0.5) * 3);
        const spin = new THREE.Vector3(Math.random() * 3, Math.random() * 3, Math.random() * 3);
        const t0 = performance.now();
        const tick = () => {
          const t = (performance.now() - t0) / 1000;
          if (t > 1.4) { m.visible = false; return; }
          vel.y -= 9.8 * 0.016;
          m.position.addScaledVector(vel, 0.016);
          if (m.position.y < dv.data.y + 0.1) { m.position.y = dv.data.y + 0.1; vel.multiplyScalar(0.4); }
          m.rotation.x += spin.x * 0.016; m.rotation.z += spin.z * 0.016;
          requestAnimationFrame(tick);
        };
        tick();
      } else l.mesh.visible = false;
    }
    this.world.removeDoor(id);
  }

  private setInter(id: number, state: number) {
    const iv = this.view.inters[id];
    if (!iv) return;
    iv.state = state;
    const k = iv.data.kind;
    if (k === 'keycard' || k === 'document') iv.obj.visible = k === 'document' ? true : state === 0;
    if (k === 'supply' && iv.parts.lid) iv.parts.lid.rotation.x = state ? -1.9 : 0;
    if (k === 'breaker' && iv.parts.lever) iv.parts.lever.rotation.x = state ? -0.6 : 0.6;
    if (k === 'breaker' && iv.led) iv.led.color.set(state ? '#7dff9a' : '#ff4a3a');
    if (k === 'lightSwitch' && iv.parts.toggle) iv.parts.toggle.rotation.x = state ? -0.4 : 0.4;
    if (k === 'valveWheel' && iv.parts.wheel) iv.parts.wheel.rotation.z = state ? 2.4 : 0;
    if (k === 'hiddenTrigger' && iv.parts.handle) iv.parts.handle.rotation.z = state ? 1.2 : 0;
  }

  private addPlaced(l: PlacedLight) {
    if (this.placed.has(l.id)) return;
    const color = l.kind === 'flare' ? '#ff4a2a' : l.kind === 'glowstick' ? '#7dff8a' : '#ffb340';
    const obj = new THREE.Mesh(new THREE.SphereGeometry(0.03, 8, 6), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(3) }));
    obj.position.set(...l.p);
    this.root.add(obj);
    this.placed.set(l.id, { ...l, obj });
  }

  private removePlaced(id: number) { const p = this.placed.get(id); if (p) { p.obj.removeFromParent(); this.placed.delete(id); } }

  // =================================================================== interaction
  private reach() { const g = ITEM_BY_ID[this.profile()?.loadout.utility ?? '']; return PLAYER.REACH + (g?.stats.reach ?? 0); }
  private strength() {
    const p = this.profile();
    let s = 1;
    for (const slot of ['body', 'utility'] as LoadoutSlot[]) { const it = ITEM_BY_ID[p?.loadout[slot] ?? '']; if (it?.stats.strength) s *= it.stats.strength; }
    return s;
  }

  private computeFocus(): Focus | null {
    if (this.life !== 'alive' || this.pinned) return null;
    const eye = this.player.eyePos;
    const dir = this.player.forward;
    const reach = this.reach();
    let best: Focus | null = null;
    const hit = this.world.raycast(eye, dir, reach + 0.6, this.holding?.id ?? -1);
    const wallDist = hit && hit.kind !== 'prop' ? hit.toi : Infinity;
    if (hit && hit.kind === 'prop' && hit.toi <= reach + 0.4) {
      const p = this.props.items.get(hit.id);
      if (p) {
        const heldByOther = p.owner >= 0 && p.owner !== this.myNetId;
        const v = VALUABLE_BY_ID[p.def];
        best = { kind: 'prop', id: p.id, dist: hit.toi, label: heldByOther ? `Help carry ${p.name}` : `Grab ${p.name}`, sub: v ? `$${p.value.toLocaleString()} · ${p.mass} kg${p.mass > (PLAYER.STRENGTH * this.strength()) / 9.81 ? ' · needs help' : ''}` : `${p.mass} kg` };
        this.lpHit = this.toLocal(p, hit.point);
      }
    }
    if (hit && hit.kind === 'door' && hit.toi <= 2.9) {
      const dv = this.view.doors[hit.id];
      if (dv && dv.revealed && !dv.broken) {
        const locked = dv.locked;
        const has = locked && this.keys.has(dv.data.lockedBy);
        const lock = this.lockdownUntil > performance.now() / 1000;
        best = { kind: 'door', id: hit.id, dist: hit.toi, label: locked ? (has ? 'Unlock with keycard' : 'Locked') : dv.open ? 'Close door' : 'Open door', sub: locked && !has ? 'Requires a security keycard' : lock && locked ? 'Security lockdown' : undefined, warn: locked && !has };
      }
    }
    // interactables (screen-space nearest within reach, not behind walls)
    for (const iv of this.view.inters) {
      if (!iv.obj.visible && iv.data.kind !== 'document') continue;
      const p = iv.obj.getWorldPosition(tmpV);
      const d = p.distanceTo(eye);
      if (d > 2.7 || d > wallDist + 0.25) continue;
      const to = p.clone().sub(eye).normalize();
      const dot = to.dot(dir);
      if (dot < 0.95 - 0.06 / Math.max(0.4, d)) continue;
      if (best && best.dist < d - 0.05) continue;
      const f = this.interFocus(iv.data.id, d);
      if (f) best = f;
    }
    // downed / dead teammates
    for (const r of this.remotes.players.values()) {
      const downed = (r.flags & PF.DOWNED) !== 0, dead = (r.flags & PF.DEAD) !== 0;
      if (!downed && !dead) continue;
      const d = r.pos.distanceTo(this.player.pos);
      if (d > (dead ? 2.6 : PLAYER.REVIVE_RANGE + 0.3)) continue;
      const to = r.pos.clone().add(new THREE.Vector3(0, 0.3, 0)).sub(eye).normalize();
      if (to.dot(dir) < 0.75) continue;
      if (downed) best = { kind: 'player', id: r.info.netId, dist: d, label: `Revive ${r.info.name}`, sub: 'Hold to revive', hold: true };
      else if (this.slotOf('defib')) best = { kind: 'body', id: r.info.netId, dist: d, label: `Defibrillate ${r.info.name}`, sub: `Use [${this.keyFor(this.slotOf('defib')!)}]` };
    }
    return best;
  }

  private lpHit = new THREE.Vector3();

  private toLocal(p: ClientProp, point: { x: number; y: number; z: number }) {
    const inv = p.mesh.quaternion.clone().invert();
    return new THREE.Vector3(point.x, point.y, point.z).sub(p.mesh.position).applyQuaternion(inv);
  }

  private interFocus(id: number, d: number): Focus | null {
    const iv = this.view.inters[id];
    const it = iv.data;
    const powered = this.sectors.get(it.sector) ?? true;
    switch (it.kind) {
      case 'breaker': return { kind: 'inter', id, dist: d, label: iv.state ? `Cut power (Sector ${it.target})` : `Restore power (Sector ${it.target})`, sub: iv.state ? undefined : 'Breaker tripped' };
      case 'lightSwitch': return { kind: 'inter', id, dist: d, label: 'Light switch', sub: powered ? undefined : 'No power' };
      case 'tube': return { kind: 'inter', id, dist: d, label: 'Send cargo tube', sub: powered ? `Items up to ${MISSION.TUBE_MAX_KG} kg in the intake` : 'No power in this sector', warn: !powered };
      case 'keycard': return iv.state ? null : { kind: 'inter', id, dist: d, label: 'Take security keycard' };
      case 'document': return { kind: 'inter', id, dist: d, label: 'Read document', sub: DOCUMENT_BY_ID[it.data]?.title };
      case 'terminal': return { kind: 'inter', id, dist: d, label: 'Download facility schematic' };
      case 'hiddenTrigger': return iv.state ? null : { kind: 'inter', id, dist: d, label: 'Examine' };
      case 'supply': return iv.state ? null : { kind: 'inter', id, dist: d, label: 'Open supply cache' };
      case 'valveWheel': return { kind: 'inter', id, dist: d, label: iv.state ? 'Open valve' : 'Close valve', sub: 'Shuts off the nearby hazard' };
      case 'liftLever': {
        const st = this.lift.state;
        return { kind: 'inter', id, dist: d, label: st === 'countdown' ? 'Cancel departure' : this.info.practice ? 'Finish practice' : 'Pull departure lever', sub: st === 'locked' && !this.info.practice ? `Quota not met: $${this.quota.banked.toLocaleString()} / $${this.quota.quota.toLocaleString()}` : undefined, warn: st === 'locked' && !this.info.practice };
      }
      default: return null;
    }
  }

  private interact(f: Focus) {
    const req = this.reqCounter++;
    if (f.kind === 'prop') return this.grab(f.id);
    if (f.kind === 'door') { this.conn.send({ t: 'interact', target: f.id, kind: 'door', req }); return; }
    if (f.kind === 'inter') {
      const iv = this.view.inters[f.id];
      if (iv.data.kind === 'document') this.docOpen = iv.data.data;
      this.conn.send({ t: 'interact', target: f.id, kind: 'inter', req });
      this.audio.play('switch', { pos: iv.obj.getWorldPosition(new THREE.Vector3()), volume: 0.4 });
    }
  }

  // =================================================================== grabbing
  private grab(id: number) {
    const p = this.props.items.get(id);
    if (!p || this.pendingGrab >= 0) return;
    this.pendingGrab = id;
    this.grabReq = this.reqCounter++;
    const lp = this.lpHit.clone();
    // grab near the centre for small items, at the hit point for large ones
    if (p.radius < 0.35) lp.multiplyScalar(0.3);
    this.conn.send({ t: 'grab', prop: id, lp: [lp.x, lp.y, lp.z], req: this.grabReq });
    this.audio.play('pickup', { volume: 0.25, rate: 0.8 });
    this.pendingLp = lp;
  }
  private pendingLp = new THREE.Vector3();

  onGrabResult(r: { prop: number; ok: boolean; role: 'owner' | 'helper' | 'none'; req: number }) {
    if (r.req !== this.grabReq) return;
    this.pendingGrab = -1;
    if (!r.ok) return;
    const p = this.props.items.get(r.prop);
    if (!p) return;
    const yawQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.player.yaw);
    const relQ = yawQ.clone().invert().multiply(p.mesh.quaternion);
    const dist = Math.min(GRAB.MAX_DIST, Math.max(GRAB.MIN_DIST + p.radius, this.player.eyePos.distanceTo(p.mesh.position)));
    this.holding = { id: r.prop, role: r.role === 'owner' ? 'owner' : 'helper', dist, lp: this.pendingLp.clone(), relQ };
    this.props.heldId = r.prop;
    this.world.heldId = r.prop;
  }

  private dropLocal() {
    this.holding = null;
    this.props.heldId = -1;
    this.props.hold = null;
    this.world.heldId = -1;
    this.rotating = false;
  }

  private release(thrown: boolean) {
    const h = this.holding;
    if (!h) return;
    const p = this.props.items.get(h.id);
    if (p && h.role === 'owner' && p.phys) {
      const b = p.phys.body;
      if (thrown) {
        const dir = this.player.forward;
        const sp = Math.min(GRAB.MAX_THROW_SPEED, (PLAYER.THROW_IMPULSE * 6 * this.strength()) / Math.max(0.6, Math.pow(p.mass, 0.75)));
        const lv = b.linvel();
        b.setLinvel({ x: lv.x * 0.3 + dir.x * sp, y: lv.y * 0.3 + dir.y * sp + 1, z: lv.z * 0.3 + dir.z * sp }, true);
        this.audio.play('jump', { volume: 0.5, rate: 1.4 });
      }
      const t = b.translation(), r = b.rotation(), v = b.linvel(), w = b.angvel();
      this.conn.send({ t: 'release', prop: h.id, p: [t.x, t.y, t.z], q: [r.x, r.y, r.z, r.w], v: [v.x, v.y, v.z], w: [w.x, w.y, w.z], thrown });
    } else this.conn.send({ t: 'release', prop: h.id, p: [0, 0, 0], q: [0, 0, 0, 1], v: [0, 0, 0], w: [0, 0, 0], thrown: false });
    this.dropLocal();
  }

  private holdTarget(): THREE.Vector3 {
    const h = this.holding!;
    return this.player.eyePos.addScaledVector(this.player.forward, h.dist);
  }

  private updateHold(dt: number) {
    const h = this.holding;
    if (!h) { this.props.hold = null; this.tether.visible = false; return; }
    const p = this.props.items.get(h.id);
    if (!p) { this.dropLocal(); return; }
    // distance (wheel) and rotation (R + mouse)
    if (this.input.wheel) h.dist = Math.max(GRAB.MIN_DIST + p.radius * 0.5, Math.min(GRAB.MAX_DIST, h.dist - this.input.wheel * 0.18));
    this.rotating = this.input.held('rotate');
    if (this.rotating) {
      const k = 0.006 * this.settings.data.sensitivity;
      const qy = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.input.mouseDX * k);
      const qx = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), this.input.mouseDY * k);
      h.relQ.premultiply(qy).premultiply(qx);
    }
    const target = this.holdTarget();
    // keep the object out of the camera
    const minD = Math.max(0.55, p.radius + 0.45);
    if (target.distanceTo(this.player.eyePos) < minD) target.copy(this.player.eyePos).addScaledVector(this.player.forward, minD);
    const yawQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.player.yaw);
    const targetQ = yawQ.multiply(h.relQ);
    this.props.hold = h.role === 'owner' ? { target, lp: h.lp, targetQ, strength: PLAYER.STRENGTH * this.strength() } : null;
    // let go if the object is torn away (stuck behind geometry)
    const gp = h.lp.clone().applyQuaternion(p.mesh.quaternion).add(p.mesh.position);
    if (gp.distanceTo(target) > 2.6 + (p.helpers.length ? 2 : 0)) { this.release(false); return; }
    // tether
    const hand = this.vmLeft.getWorldPosition(new THREE.Vector3());
    const len = hand.distanceTo(gp);
    this.tether.visible = true;
    this.tether.position.copy(hand).add(gp).multiplyScalar(0.5);
    this.tether.scale.set(1, len, 1);
    this.tether.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), gp.clone().sub(hand).normalize());
    void dt;
  }

  private localImpact(p: ClientProp, speed: number, pt: THREE.Vector3) {
    // report to the server, which validates and applies value damage
    let enemy: number | undefined;
    for (const en of this.remotes.enemies.values()) {
      const def = MONSTERS[en.type];
      if (Math.hypot(en.pos.x - pt.x, en.pos.z - pt.z) < def.radius + p.radius + 0.3 && pt.y > en.pos.y - 0.3 && pt.y < en.pos.y + def.height + 0.3) { enemy = en.id; break; }
    }
    this.conn.send({ t: 'impact', prop: p.id, speed, enemy });
    this.audio.play('impact_' + p.mat, { pos: pt, volume: Math.min(1, speed / 9), rate: Math.max(0.55, Math.min(1.5, 1.4 - Math.log10(Math.max(0.2, p.mass)) * 0.35)) });
  }

  // =================================================================== equipment
  slotOf(item: string): LoadoutSlot | null {
    const lo = this.profile()?.loadout;
    if (!lo) return null;
    const slots = this.info.practice ? { tool1: 'scanner', tool2: 'prod', quick1: 'medkit', quick2: 'flare', quick3: 'decoy' } as Record<string, string> : lo as unknown as Record<string, string>;
    for (const [k, v] of Object.entries(slots)) if (v === item) return k as LoadoutSlot;
    return null;
  }

  loadoutFor(slot: LoadoutSlot): string | null {
    if (this.info.practice) return ({ tool1: 'scanner', tool2: 'prod', quick1: 'medkit', quick2: 'flare', quick3: 'decoy' } as Record<string, string>)[slot] ?? this.profile()?.loadout[slot] ?? null;
    return this.profile()?.loadout[slot] ?? null;
  }

  keyFor(slot: LoadoutSlot) { return ({ quick1: '1', quick2: '2', quick3: '3', tool1: '4', tool2: '5', light: 'F', body: '', utility: '' } as Record<string, string>)[slot] ?? ''; }

  private useSlot(slot: LoadoutSlot) {
    const item = this.loadoutFor(slot);
    if (!item) return;
    const req = this.reqCounter++;
    const eye = this.player.eyePos, f = this.player.forward;
    const aim: [number, number, number, number, number, number] = [eye.x, eye.y, eye.z, f.x, f.y, f.z];
    if (item === 'tracker') { this.trackerOn = !this.trackerOn; this.audio.play('torch_click', { volume: 0.4 }); return; }
    if (item === 'radio') { this.pushMsg('Hold the radio key to transmit to crew with radios.', 'info'); return; }
    let target: number | undefined;
    if (item === 'medkit' || item === 'defib') {
      for (const r of this.remotes.players.values()) {
        const d = r.pos.distanceTo(this.player.pos);
        if (d > 2.6) continue;
        if (r.pos.clone().add(new THREE.Vector3(0, 1, 0)).sub(eye).normalize().dot(f) > 0.8) target = r.info.netId;
      }
      if (item === 'defib' && target === undefined) { this.pushMsg('Look at a fallen teammate to use the defibrillator.', 'info'); return; }
    }
    this.conn.send({ t: 'use', slot, req, aim, target });
  }

  // =================================================================== frame
  update(dt: number) {
    if (!this.ready) return;
    const now = performance.now() / 1000;
    const inp = this.input;
    const s = this.settings.data;
    const alive = this.life === 'alive';
    // look & movement
    this.player.life = this.life as never;
    this.player.look(inp, s, this.rotating);
    const held = this.holding ? this.props.items.get(this.holding.id) : null;
    const gearSpeed = (() => { const it = ITEM_BY_ID[this.profile()?.loadout.body ?? '']; return it?.stats.speed ?? 1; })();
    const gearStam = (() => { const it = ITEM_BY_ID[this.profile()?.loadout.utility ?? '']; return { st: it?.stats.stamina ?? 1, rg: it?.stats.regen ?? 1, cs: it?.stats.carrySlow ?? 1 }; })();
    if (this.life !== 'dead' && this.life !== 'extracted') {
      this.player.update(dt, inp, s, { speed: gearSpeed, stamina: gearStam.st, regen: gearStam.rg, carryMass: held && this.holding?.role === 'owner' ? held.mass / (1 + held.helpers.length) : held ? held.mass * 0.3 : 0, strength: this.strength(), carrySlow: gearStam.cs, stim: now < this.stimUntil, crash: now > this.stimUntil && now < this.stimUntil + 8 && this.stimUntil > 0 });
    }
    // interaction
    this.focus = this.computeFocus();
    if (alive && !this.pinned) {
      if (this.holding) {
        if (inp.justPressed('drop') || inp.justPressed('interact') || inp.mouseReleased(0) && this.grabbedWithMouse) this.release(false);
        else if (inp.mousePressed(2)) this.release(true);
      } else if (this.focus) {
        if (this.focus.hold) {
          if (inp.held('interact') || inp.mouseHeld(0)) { this.interactHoldT += dt; if (this.interactHoldT > 0.2) { this.interactHoldT = 0; this.conn.send({ t: 'interact', target: this.focus.id, kind: 'player', req: this.reqCounter++, hold: true }); } }
          else this.interactHoldT = 0;
        } else if (inp.justPressed('interact') || inp.mousePressed(0)) { this.grabbedWithMouse = inp.mousePressed(0); this.interact(this.focus); }
      }
      if (inp.justPressed('light')) this.toggleTorch();
      for (const [a, slot] of [['slot1', 'quick1'], ['slot2', 'quick2'], ['slot3', 'quick3'], ['tool1', 'tool1'], ['tool2', 'tool2']] as const) if (inp.justPressed(a)) this.useSlot(slot);
      if (inp.justPressed('ping')) { const hit = this.world.raycast(this.player.eyePos, this.player.forward, 30); if (hit) this.conn.send({ t: 'mark', p: [hit.point.x, hit.point.y, hit.point.z] }); }
    } else if (this.holding) this.release(false);
    this.updateHold(dt);
    // physics for props I simulate
    this.world.step(dt, (h) => this.props.simulate(h, this.strength()));
    this.props.detectImpacts(now);
    // doors
    for (const dv of this.view.doors) {
      if (!dv.leaves.length || dv.broken) continue;
      if (dv.value !== dv.target) {
        dv.value = stepDoorValue(dv.data, dv.value, dv.target, dt, dv.fast);
        this.world.setDoor(dv.data, dv.value);
      }
      const leaves = doorLeaves(dv.data);
      dv.leaves.forEach((l, i) => { const p = leafPose(dv.data, leaves[i], dv.value); l.mesh.position.set(p.x, p.y, p.z); l.mesh.rotation.y = p.yaw; });
    }
    // remote entities
    const rt = this.conn.renderTime();
    this.props.update(dt, rt);
    this.remotes.update(dt, rt, now, this.engine.camera);
    // spectator / camera
    const cam = this.engine.camera;
    if (this.debugCam) { cam.position.set(this.debugCam[0], this.debugCam[1], this.debugCam[2]); cam.rotation.set(this.debugCam[4], this.debugCam[3], 0, 'YXZ'); }
    else if ((this.life === 'dead' || this.life === 'extracted') && this.remotes.players.size) this.spectate(cam, dt);
    else { cam.position.copy(this.player.camPos); cam.quaternion.copy(this.player.camQuat); }
    const baseFov = s.fov + this.player.fovOffset;
    if (Math.abs(cam.fov - baseFov) > 0.05) { cam.fov += (baseFov - cam.fov) * Math.min(1, dt * 8); cam.updateProjectionMatrix(); }
    cam.updateMatrixWorld();
    // viewmodel follows the camera with sway
    this.viewmodel.position.copy(cam.position);
    this.viewmodel.quaternion.copy(cam.quaternion);
    this.viewmodel.visible = alive && !this.pinned;
    const sway = Math.sin(now * 1.6) * 0.004;
    this.vmTorch.position.set(0.17 + sway, -0.17 + Math.sin(now * 2.1) * 0.003 + (this.player.sprinting ? -0.025 : 0), -0.3);
    this.vmLeft.position.set(-0.2, this.holding ? -0.16 : -0.34, this.holding ? -0.4 : -0.24);
    this.vmLeft.visible = !!this.holding;
    this.vmLeft.rotation.x = this.holding ? 0.25 : 0;
    // visibility + lighting
    const visible = this.vis.update(cam);
    for (const r of visible) this.visited.add(r);
    this.cullDynamic(cam, visible);
    this.updateLights(cam, visible, dt, now);
    this.updateTorch(cam, now);
    // anims (press heads, gate)
    for (const a of this.view.anims) if (a.kind === 'press') { const top = a.obj.userData.top as number, bottom = a.obj.userData.bottom as number; const target = a.data ? bottom : top; a.obj.position.y += (target - a.obj.position.y) * Math.min(1, dt * (a.data ? 20 : 1.2)); }
    if (this.view.liftGate) {
      const departing = this.lift.state === 'departing' || this.lift.state === 'gone';
      this.view.liftGate.position.y = this.level.extraction.zone.y + this.gateY * 2.7;
      this.view.liftGate.visible = true;
      if (departing) this.liftDepart(dt);
    }
    if (this.view.ledMesh) (this.view.ledMesh.material as THREE.MeshBasicMaterial).color.setScalar(0.6 + 0.4 * Math.sin(now * 3));
    for (const l of this.view.lights) if (l.cone) (l.cone.material as THREE.ShaderMaterial).uniforms.time.value = now;
    this.updatePlaced(now);
    this.updateBoard();
    this.hazardAudio();
    // audio
    this.audio.setListener(cam);
    let threat = 0;
    for (const en of this.remotes.enemies.values()) {
      const d = en.pos.distanceTo(this.player.pos);
      const chasing = en.target === this.myNetId && (en.state === 'chase' || en.state === 'attack');
      threat = Math.max(threat, chasing ? 1 - d / 40 : Math.max(0, 0.5 - d / 40));
    }
    this.audio.threat = Math.max(0, Math.min(1, threat));
    this.audio.update(dt);
    // effects decay
    this.damageFlash = Math.max(0, this.damageFlash - dt * 1.6);
    const grade = this.engine.post.grade.uniforms;
    grade.damage.value = this.damageFlash + (this.hp < 30 && alive ? 0.25 + 0.1 * Math.sin(now * 5) : 0);
    grade.marked.value = this.marked;
    grade.downed.value = this.life === 'downed' ? 1 : 0;
    grade.cb.value = { off: 0, deuter: 1, protan: 2, tritan: 3 }[s.colorblind];
    // net out
    this.sendAcc += dt;
    if (this.sendAcc >= 1 / NET.CLIENT_SEND_HZ) { this.sendAcc = 0; this.sendState(); }
    // cleanup timers
    this.popups = this.popups.filter((p) => now - p.at < 1.6);
    this.messages = this.messages.filter((m) => now - m.at < 9);
    this.pings = this.pings.filter((p) => now - p.at < 8);
    if (this.scan && now > this.scan.until) this.scan = null;
    if (this.revive && now - this.revive.at > 0.8) this.revive = null;
  }
  private grabbedWithMouse = false;
  /** dev-only free camera [x, y, z, yaw, pitch] for visual inspection */
  debugCam: number[] | null = null;

  private sendState() {
    const p = this.player;
    let flags = p.flags;
    if (this.torchOn) flags |= PF.LIGHT;
    if (this.holding) flags |= PF.HOLDING;
    if (this.trackerOn) flags |= PF.TRACKER;
    if (this.talking) flags |= PF.TALKING;
    if (this.radioTx) flags |= PF.RADIO;
    const hold = this.holding ? this.holdTarget() : null;
    const help = this.holding?.role === 'helper' && hold ? { prop: this.holding.id, t: [hold.x, hold.y, hold.z] as V3 } : null;
    const buf = encodeClientState(this.writer, {
      seq: this.seq++, p: [p.pos.x, p.pos.y, p.pos.z], v: [p.vel.x, p.vel.y, p.vel.z], yaw: p.yaw, pitch: p.pitch, flags, anim: 0, epoch: p.epoch,
      owned: this.props.ownedStates(), help, hold: hold ? [hold.x, hold.y, hold.z] : null,
    });
    this.conn.sendBin(buf);
    if (this.talking && this.voiceLevel > 0.15 && performance.now() - this.lastVoiceSent > 300) { this.lastVoiceSent = performance.now(); this.conn.send({ t: 'voice', level: this.voiceLevel }); }
  }
  talking = false;
  radioTx = false;
  voiceLevel = 0;

  onCorrect(p: V3, epoch: number) { this.player.applyCorrection(p, epoch); }

  private toggleTorch() {
    if (!this.torchOn && this.battery <= 0.001) { this.pushMsg('No battery. Use a power cell.', 'warn'); return; }
    this.torchOn = !this.torchOn;
    this.audio.play('torch_click', { volume: 0.5 });
  }

  private updateTorch(cam: THREE.Camera, now: number) {
    const stats = (ITEM_BY_ID[this.profile()?.loadout.light ?? 'light_t1'] ?? ITEM_BY_ID.light_t1).stats;
    const on = this.torchOn && this.life === 'alive';
    let k = on ? 1 : 0;
    if (on && this.battery < 0.15) k *= 0.55 + 0.45 * Math.abs(Math.sin(now * 13 + Math.sin(now * 3)));
    if (on && this.torchFlicker > 0) { this.torchFlicker -= 1 / 60; k *= Math.random() > 0.5 ? 1 : 0.1; }
    if (on && this.surgeUntil > now) k *= 0.7 + Math.random() * 0.3;
    const off = new THREE.Vector3(0.2, -0.16, -0.25).applyQuaternion(cam.quaternion);
    this.torch.position.copy(cam.position).add(off);
    this.torch.target.position.copy(cam.position).addScaledVector(new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion), 8);
    this.torch.intensity = stats.intensity * k;
    this.torch.distance = stats.range;
    this.torch.angle = stats.angle;
    this.torch.shadow.camera.far = stats.range;
    const lens = this.vmTorch.getObjectByName('lens') as THREE.Mesh | undefined;
    if (lens) (lens.material as THREE.MeshBasicMaterial).color.set(k > 0.2 ? '#fff6e0' : '#2a2a2a');
  }

  private cullTick = 0;
  /** hide props / creatures / crew in rooms that portal culling rejected, and tiny props far away */
  private cullDynamic(cam: THREE.Camera, visible: Set<number>) {
    const full = (this.cullTick++ % 4) === 0;
    for (const p of this.props.items.values()) {
      if (full || p.mesh.userData.room === undefined) p.mesh.userData.room = this.vis.roomAt(p.mesh.position);
      const room = p.mesh.userData.room as number;
      const far = p.mesh.position.distanceTo(cam.position) > Math.min(45, 9 + Math.max(...p.size) * 22);
      p.mesh.visible = (room < 0 || visible.has(room)) && !far;
    }
    for (const en of this.remotes.enemies.values()) { const room = this.vis.roomAt(en.pos); if (room >= 0 && !visible.has(room)) en.view.group.visible = false; }
    for (const r of this.remotes.players.values()) { const room = this.vis.roomAt(r.pos); if (room >= 0 && !visible.has(room)) r.avatar.group.visible = false; }
  }

  private updateLights(cam: THREE.Camera, visible: Set<number>, dt: number, now: number) {
    const cands: VirtualLight[] = [];
    const surge = this.surgeUntil > now;
    for (const v of this.view.lights) {
      const room = this.level.rooms[v.room];
      v.enabled = (this.sectors.get(room?.sector ?? 0) ?? true) && this.roomSwitch.get(v.room) !== false;
      v.surge = surge ? 1 : 0;
      if (visible.has(v.room)) cands.push(v);
      else if (v.cone) v.cone.visible = false;
    }
    // the Visitor disturbs lights near it
    this.pool.disturbances = [...this.remotes.enemies.values()].filter((e) => e.type === 'unknown').map((e) => e.pos);
    this.pool.update(cam, cands, dt, now);
    // ambient dims when power is out where the player is
    const room = this.vis.roomAt(this.player.pos);
    const lit = room >= 0 && (this.sectors.get(this.level.rooms[room].sector) ?? true);
    const theme = getTheme(this.level.map);
    this.hemi.intensity += ((lit ? theme.ambient.intensity * 6 : theme.ambient.intensity * 2.5) * this.settings.data.brightness - this.hemi.intensity) * Math.min(1, dt * 2);
  }

  private updatePlaced(now: number) {
    const ps = [...this.placed.values()];
    for (const p of ps) {
      const prop = [...this.props.items.values()].find((x) => x.kind === 'thrown' && x.mesh.position.distanceTo(new THREE.Vector3(...p.p)) < 3);
      if (prop) p.obj.position.copy(prop.mesh.position);
    }
    ps.sort((a, b) => a.obj.position.distanceTo(this.player.pos) - b.obj.position.distanceTo(this.player.pos));
    this.placedLights.forEach((l, i) => {
      const p = ps[i];
      if (!p || p.kind === 'decoy') { l.intensity = 0; return; }
      l.position.copy(p.obj.position).add(new THREE.Vector3(0, 0.15, 0));
      l.color.set(p.kind === 'flare' ? '#ff4a2a' : '#6dff8a');
      l.intensity = p.kind === 'flare' ? 9 + Math.sin(now * 23) * 2 + Math.random() * 2 : 2.2;
      l.distance = p.kind === 'flare' ? 9 : 4;
    });
  }

  private boardKey = '';
  private updateBoard() {
    const b = this.view.board;
    if (!b) return;
    const q = this.quota;
    const key = `${q.banked}|${q.quota}|${this.lift.state}|${Math.ceil(Math.max(0, this.lift.until - this.conn.missionTime()))}`;
    if (key === this.boardKey) return;
    this.boardKey = key;
    const g = b.ctx;
    g.fillStyle = '#050605'; g.fillRect(0, 0, 512, 192);
    const met = q.banked >= q.quota;
    g.fillStyle = met ? '#7fdc8a' : '#e0a030';
    g.font = '600 26px "JetBrains Mono", monospace';
    g.fillText(this.info.practice ? 'PRACTICE MODE' : 'SALVAGE BANKED', 24, 40);
    g.font = '700 64px "JetBrains Mono", monospace';
    g.fillText('$' + q.banked.toLocaleString(), 24, 108);
    g.font = '500 24px "JetBrains Mono", monospace';
    g.fillStyle = '#9a9a8e';
    g.fillText(this.info.practice ? 'PULL THE LEVER TO FINISH' : `QUOTA $${q.quota.toLocaleString()}`, 24, 146);
    const st = this.lift.state;
    g.fillStyle = st === 'countdown' ? '#ff5a3a' : met ? '#7fdc8a' : '#6a6a60';
    g.fillText(st === 'countdown' ? `DEPARTING IN ${Math.ceil(Math.max(0, this.lift.until - this.conn.missionTime()))}` : met ? 'READY TO DEPART' : 'DEPARTURE LOCKED', 24, 178);
    for (let y = 0; y < 192; y += 3) { g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(0, y, 512, 1); }
    b.tex.needsUpdate = true;
  }

  private liftT = 0;
  private liftDepart(dt: number) {
    // cinematic: the car and everyone aboard rise out of the bay
    this.liftT += dt;
    const lift = this.view.rooms[this.level.extraction.room];
    void lift;
    if (this.life === 'extracted') { this.player.pos.y += dt * Math.min(2, this.liftT * 0.8); this.player.trauma = Math.max(this.player.trauma, 0.15); }
  }

  private hazardAudio() {
    const mt = this.conn.missionTime();
    for (const h of this.level.hazards) {
      if (h.kind !== 'steam' && h.kind !== 'gas' && h.kind !== 'sparks') continue;
      const hv = this.view.hazards[h.id];
      const powered = this.sectors.get(h.sector) ?? true;
      const phase = ((mt + h.phase) % h.period) / h.period;
      const active = !this.hazardsOff.has(h.id) && phase < h.duty && (h.kind !== 'sparks' || powered);
      const near = this.player.pos.distanceTo(new THREE.Vector3(h.x, h.y, h.z)) < 18;
      const v = this.hazardLoops.get(h.id);
      if (active && near && !v) this.hazardLoops.set(h.id, this.audio.play(h.kind, { pos: new THREE.Vector3(h.x, h.y + 0.5, h.z), volume: 0.8, loop: h.kind === 'gas' }));
      else if ((!active || !near) && v) { this.audio.stopVoice(v); this.hazardLoops.delete(h.id); }
      if (hv) hv.on = active;
      if (hv?.obj.userData.beams) (hv.obj.userData.beams as THREE.Object3D).visible = active;
    }
  }

  private spectate(cam: THREE.PerspectiveCamera, dt: number) {
    const list = [...this.remotes.players.values()].filter((r) => !(r.flags & (PF.DEAD | PF.EXTRACTED)) && r.life !== 'left');
    if (!list.length) return;
    if (this.input.mousePressed(0) || this.input.justPressed('jump')) this.spectating = (this.spectating + 1) % list.length;
    const r = list[Math.max(0, this.spectating) % list.length];
    const back = new THREE.Vector3(Math.sin(r.yaw), 0, Math.cos(r.yaw)).multiplyScalar(2.6);
    const want = r.pos.clone().add(new THREE.Vector3(0, 2.1, 0)).add(back);
    // don't go through walls
    const from = r.pos.clone().add(new THREE.Vector3(0, 1.6, 0));
    const dir = want.clone().sub(from);
    const len = dir.length();
    const hit = this.world.raycast(from, dir.normalize(), len);
    if (hit) want.copy(from).addScaledVector(dir, Math.max(0.3, hit.toi - 0.25));
    cam.position.lerp(want, Math.min(1, dt * 6));
    cam.lookAt(from);
  }

  private footstep(k: number) {
    const s = this.surfaceAt(this.player.pos);
    const quiet = ITEM_BY_ID[this.profile()?.loadout.utility ?? '']?.stats.noise ?? 1;
    this.stepVoice++;
    this.audio.play('step_' + s, { pos: this.player.pos.clone(), volume: (0.25 + k * 0.55) * quiet, ref: 1.2, occlude: false });
  }

  surfaceAt(p: THREE.Vector3): string {
    const room = this.vis?.roomAt(p) ?? -1;
    const r = this.level.rooms[room];
    if (!r) return 'concrete';
    if (r.stair) return 'metal';
    for (const h of this.level.hazards) if (h.kind === 'water' && Math.abs(p.x - h.x) < h.hx && Math.abs(p.z - h.z) < h.hz) return 'water';
    const set = getTheme(this.level.map).surfaceSets[r.surfaces];
    const tex = set?.floor.tex ?? '';
    if (/metal|grate|plate/.test(tex)) return 'metal';
    if (/tile|marble|terrazzo/.test(tex)) return 'tile';
    if (/parquet|wood|plank/.test(tex)) return 'wood';
    if (/carpet/.test(tex)) return 'carpet';
    return 'concrete';
  }

  /** valuables visible to the scanner (for HUD tags) */
  scanTargets(): { pos: THREE.Vector3; text: string }[] {
    if (!this.scan) return [];
    const out: { pos: THREE.Vector3; text: string }[] = [];
    for (const p of this.props.items.values()) {
      if (p.kind !== 'valuable' || p.mesh.position.distanceTo(this.scan.p) > this.scan.r) continue;
      out.push({ pos: p.mesh.position.clone().add(new THREE.Vector3(0, p.size[1] / 2 + 0.15, 0)), text: `$${p.value.toLocaleString()}` });
    }
    return out;
  }

  heldInfo(): { name: string; value: number; mass: number; base: number; helpers: number; role: string } | null {
    if (!this.holding) return null;
    const p = this.props.items.get(this.holding.id);
    if (!p) return null;
    return { name: p.name, value: p.value, mass: p.mass, base: p.base, helpers: p.helpers.length, role: this.holding.role };
  }

  dispose() {
    this.ready = false;
    this.audio.stopAmbience();
    for (const v of this.hazardLoops.values()) this.audio.stopVoice(v);
    this.props?.clear();
    this.remotes?.clear();
    this.pool?.dispose();
    this.view?.dispose();
    this.root.removeFromParent();
    this.world?.free();
    this.engine.scene.environment = null;
    this.engine.scene.fog = null;
    this.engine.post.grade.uniforms.damage.value = 0;
    this.engine.post.grade.uniforms.downed.value = 0;
    this.engine.post.grade.uniforms.marked.value = 0;
  }
}

void materials;
