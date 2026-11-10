// Remote players and monsters: interpolation + avatars/creatures + their lights.
import * as THREE from 'three';
import { ITEM_BY_ID, type Appearance } from '../../../shared/catalog/items';
import { AI_STATES, MONSTER_INDEX, type MonsterId } from '../../../shared/catalog/monsters';
import { PF, type SnapEnemy, type SnapPlayer } from '../../../shared/protocol';
import { InterpBuffer } from '../net/Interp';
import { CrewAvatar } from '../models/Avatar';
import { MonsterView } from '../models/MonsterView';

export interface RemoteInfo { netId: number; name: string; appearance: Appearance; light: string }

export class RemotePlayer {
  readonly buf = new InterpBuffer();
  readonly avatar: CrewAvatar;
  flags = 0;
  hp = 100;
  pitch = 0;
  hold: THREE.Vector3 | null = null;
  readonly pos = new THREE.Vector3();
  yaw = 0;
  speed = 0;
  readonly tether: THREE.Mesh;
  life: string = 'alive';
  talking = 0;
  lightStats = ITEM_BY_ID.light_t1.stats;
  constructor(readonly info: RemoteInfo, parent: THREE.Object3D) {
    this.avatar = new CrewAvatar(info.appearance, info.name);
    parent.add(this.avatar.group);
    this.tether = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 1, 6, 1, true), new THREE.MeshBasicMaterial({ color: new THREE.Color('#ffb85a').multiplyScalar(2), transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.tether.visible = false;
    parent.add(this.tether);
    this.lightStats = (ITEM_BY_ID[info.light] ?? ITEM_BY_ID.light_t1).stats;
  }
  get torchOn() { return (this.flags & PF.LIGHT) !== 0 && !(this.flags & (PF.DEAD | PF.EXTRACTED)); }
  dispose() { this.avatar.dispose(); this.tether.removeFromParent(); }
}

export class Remotes {
  readonly players = new Map<number, RemotePlayer>();
  readonly enemies = new Map<number, { id: number; type: MonsterId; view: MonsterView; buf: InterpBuffer; state: string; speed: number; aux: number; target: number; pos: THREE.Vector3; yaw: number; stunnedUntil: number }>();
  readonly group = new THREE.Group();
  readonly torches: THREE.SpotLight[] = [];
  myNetId = -1;

  constructor(scene: THREE.Object3D) {
    scene.add(this.group);
    for (let i = 0; i < 3; i++) {
      const l = new THREE.SpotLight(0xfff1d6, 0, 18, 0.45, 0.55, 2);
      this.group.add(l, l.target);
      this.torches.push(l);
    }
  }

  addPlayer(info: RemoteInfo) {
    if (this.players.has(info.netId)) return this.players.get(info.netId)!;
    const r = new RemotePlayer(info, this.group);
    this.players.set(info.netId, r);
    return r;
  }

  removePlayer(netId: number) { this.players.get(netId)?.dispose(); this.players.delete(netId); }

  addEnemy(id: number, type: MonsterId) {
    if (this.enemies.has(id)) return;
    const view = new MonsterView(type);
    this.group.add(view.group);
    view.group.visible = false;
    this.enemies.set(id, { id, type, view, buf: new InterpBuffer(), state: 'idle', speed: 0, aux: 0, target: -1, pos: new THREE.Vector3(), yaw: 0, stunnedUntil: 0 });
  }

  removeEnemy(id: number) { const e = this.enemies.get(id); if (e) { e.view.dispose(); this.enemies.delete(id); } }

  applySnapshot(players: SnapPlayer[], enemies: SnapEnemy[], time: number) {
    for (const s of players) {
      if (s.netId === this.myNetId) continue;
      const r = this.players.get(s.netId);
      if (!r) continue;
      r.buf.push({ t: time, p: new THREE.Vector3(s.p[0], s.p[1], s.p[2]), v: new THREE.Vector3(s.v[0], s.v[1], s.v[2]), yaw: s.yaw, extra: [s.pitch, s.flags, s.hp] });
      r.hold = s.hold ? new THREE.Vector3(s.hold[0], s.hold[1], s.hold[2]) : null;
    }
    const seen = new Set<number>();
    for (const e of enemies) {
      seen.add(e.id);
      const en = this.enemies.get(e.id);
      if (!en) { this.addEnemy(e.id, MONSTER_INDEX[e.type] ?? 'stalker'); continue; }
      en.buf.push({ t: time, p: new THREE.Vector3(e.p[0], e.p[1], e.p[2]), v: new THREE.Vector3(), yaw: e.yaw, extra: [e.state, e.speed, e.aux, e.target] });
    }
    for (const en of this.enemies.values()) if (!seen.has(en.id)) en.view.group.visible = false;
  }

  update(dt: number, renderTime: number, t: number, cam: THREE.Camera) {
    // players
    const torchCands: { r: RemotePlayer; d: number }[] = [];
    for (const r of this.players.values()) {
      if (!r.buf.sample(renderTime, dt)) { r.avatar.group.visible = false; continue; }
      const prev = r.pos.clone();
      r.pos.copy(r.buf.out);
      r.speed = dt > 0 ? r.speed * 0.8 + (Math.hypot(r.pos.x - prev.x, r.pos.z - prev.z) / dt) * 0.2 : r.speed;
      r.yaw = r.buf.outYaw;
      [r.pitch, r.flags, r.hp] = r.buf.outExtra.length ? r.buf.outExtra : [0, 0, 100];
      const g = r.avatar.group;
      const gone = (r.flags & PF.EXTRACTED) || r.life === 'left';
      g.visible = !gone;
      g.position.copy(r.pos);
      g.rotation.y = r.yaw;
      r.avatar.update({ dt, t, speed: r.speed, state: 'walk', aux: 0, pitch: r.pitch, crouch: (r.flags & PF.CROUCH) !== 0, carry: (r.flags & PF.HOLDING) !== 0, air: !(r.flags & PF.GROUNDED), downed: (r.flags & PF.DOWNED) !== 0, dead: (r.flags & PF.DEAD) !== 0, stunned: (r.flags & PF.STUNNED) !== 0 });
      r.avatar.setTorch(r.torchOn);
      const d = cam.position.distanceTo(r.pos);
      r.avatar.showTag(d < 18 && !(r.flags & PF.DEAD), Math.max(0, Math.min(0.9, (18 - d) / 8)));
      // tether to the held object
      if (r.hold && (r.flags & PF.HOLDING) && g.visible) {
        const hand = new THREE.Vector3();
        (r.avatar.rig?.by.lHand ?? g).getWorldPosition(hand);
        const len = hand.distanceTo(r.hold);
        r.tether.visible = len < 6;
        r.tether.position.copy(hand).add(r.hold).multiplyScalar(0.5);
        r.tether.scale.set(1, len, 1);
        r.tether.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), r.hold.clone().sub(hand).normalize());
      } else r.tether.visible = false;
      if (r.torchOn && g.visible) torchCands.push({ r, d });
    }
    torchCands.sort((a, b) => a.d - b.d);
    this.torches.forEach((l, i) => {
      const c = torchCands[i];
      if (!c) { l.intensity = 0; return; }
      const r = c.r;
      const eye = new THREE.Vector3(r.pos.x, r.pos.y + (r.flags & PF.CROUCH ? 0.95 : 1.5), r.pos.z);
      (r.avatar.torch).getWorldPosition(eye);
      const dir = new THREE.Vector3(-Math.sin(r.yaw) * Math.cos(r.pitch), Math.sin(r.pitch), -Math.cos(r.yaw) * Math.cos(r.pitch));
      l.position.copy(eye);
      l.target.position.copy(eye).add(dir);
      l.intensity = r.lightStats.intensity * 0.8;
      l.distance = r.lightStats.range;
      l.angle = r.lightStats.angle;
    });
    // enemies
    for (const en of this.enemies.values()) {
      if (!en.buf.samples.length || !en.buf.sample(renderTime, dt)) continue;
      const v = en.view;
      if (!v.rig) continue;
      const prev = en.pos.clone();
      en.pos.copy(en.buf.out);
      en.yaw = en.buf.outYaw;
      const [state, speed, aux, target] = en.buf.outExtra;
      en.state = AI_STATES[state] ?? 'idle';
      en.speed = speed ?? Math.hypot(en.pos.x - prev.x, en.pos.z - prev.z) / Math.max(dt, 1e-3);
      en.aux = aux ?? 0;
      en.target = target ?? -1;
      v.group.visible = true;
      v.group.position.copy(en.pos);
      v.group.rotation.y = en.yaw;
      const gazePitch = en.type === 'watcher' ? -0.55 : 0;
      v.update({ dt, t, speed: en.speed, state: en.state, aux: en.aux, stunned: en.state === 'stunned', lock: en.type === 'watcher' ? Math.min(1, en.aux / 240) : 0 }, en.yaw, gazePitch);
    }
  }

  clear() {
    for (const r of this.players.values()) r.dispose();
    this.players.clear();
    for (const e of this.enemies.values()) e.view.dispose();
    this.enemies.clear();
    this.group.removeFromParent();
    for (const l of this.torches) l.dispose();
  }
}
