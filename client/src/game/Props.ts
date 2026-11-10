// Client props: meshes, physics proxies, interpolation, ownership and local grab simulation.
import * as THREE from 'three';
import { GRAB, PLAYER } from '../../../shared/constants';
import { MODELS } from '../../../shared/catalog/furniture';
import { VALUABLE_BY_ID } from '../../../shared/catalog/valuables';
import { SPF, type GameEvent, type OwnedPropState, type PropState, type SnapHelper, type SnapProp, type V3 } from '../../../shared/protocol';
import { assets } from '../core/Assets';
import { InterpBuffer } from '../net/Interp';
import type { ClientWorld, PhysProp } from './ClientWorld';

export interface ClientProp {
  id: number;
  def: string;
  kind: PropState['kind'];
  model: string;
  name: string;
  mesh: THREE.Object3D;
  phys: PhysProp | null;
  value: number;
  base: number;
  mass: number;
  mat: string;
  owner: number;
  helpers: number[];
  lp: Record<number, V3>;
  buf: InterpBuffer;
  size: [number, number, number];
  radius: number;
  lastV: THREE.Vector3;
  lastImpact: number;
  glow: number;
  fragile: number;
}

export interface HoldSpec { target: THREE.Vector3; lp: THREE.Vector3; targetQ: THREE.Quaternion; strength: number }

const _p = new THREE.Vector3(), _v = new THREE.Vector3(), _w = new THREE.Vector3(), _r = new THREE.Vector3(), _q = new THREE.Quaternion(), _qi = new THREE.Quaternion(), _f = new THREE.Vector3();

export class Props {
  readonly items = new Map<number, ClientProp>();
  readonly group = new THREE.Group();
  helperTargets = new Map<number, Map<number, THREE.Vector3>>(); // propId → helper netId → target
  onImpact?: (p: ClientProp, speed: number, point: THREE.Vector3) => void;
  myNetId = -1;
  hold: HoldSpec | null = null;
  heldId = -1;

  constructor(readonly world: ClientWorld, scene: THREE.Object3D) { scene.add(this.group); }

  add(s: PropState) {
    if (this.items.has(s.id)) this.remove(s.id);
    const val = VALUABLE_BY_ID[s.def];
    const model = val ? val.model : s.def;
    const info = MODELS[model];
    const mesh = assets.instance(model) ?? new THREE.Mesh(new THREE.BoxGeometry(...((info?.size ?? [0.3, 0.3, 0.3]) as [number, number, number])), new THREE.MeshStandardMaterial({ color: '#777' }));
    mesh.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; o.userData.prop = s.id; } });
    mesh.userData.prop = s.id;
    mesh.position.set(s.p[0], s.p[1], s.p[2]);
    mesh.quaternion.set(s.q[0], s.q[1], s.q[2], s.q[3]);
    this.group.add(mesh);
    const phys = this.world.addProp(s.id, s.def, s.p, s.q);
    const size = (info?.size ?? [0.3, 0.3, 0.3]) as [number, number, number];
    const p: ClientProp = {
      id: s.id, def: s.def, kind: s.kind, model, name: val?.name ?? (info?.name ?? s.def).replace(/_/g, ' '), mesh, phys, value: s.value, base: s.base, mass: s.mass,
      mat: val?.mat ?? phys?.mat ?? 'plastic', owner: s.owner, helpers: s.helpers ?? [], lp: {}, buf: new InterpBuffer(), size, radius: Math.max(size[0], size[2]) / 2,
      lastV: new THREE.Vector3(), lastImpact: 0, glow: 0, fragile: val?.fragility ?? 0,
    };
    p.buf.push({ t: -1, p: new THREE.Vector3(...s.p), v: new THREE.Vector3(), q: new THREE.Quaternion(...s.q) });
    this.items.set(s.id, p);
    return p;
  }

  remove(id: number) {
    const p = this.items.get(id);
    if (!p) return null;
    p.mesh.removeFromParent();
    this.world.removeProp(id);
    this.items.delete(id);
    if (this.heldId === id) { this.heldId = -1; this.hold = null; }
    return p;
  }

  applySnapshot(props: SnapProp[], time: number) {
    for (const s of props) {
      const p = this.items.get(s.id);
      if (!p || p.owner === this.myNetId) continue;
      p.buf.push({ t: time, p: new THREE.Vector3(s.p[0], s.p[1], s.p[2]), v: (s.flags & SPF.ASLEEP) ? new THREE.Vector3() : new THREE.Vector3(s.v[0], s.v[1], s.v[2]), q: new THREE.Quaternion(s.q[0], s.q[1], s.q[2], s.q[3]) });
    }
  }

  applyHelpers(h: SnapHelper[]) {
    this.helperTargets.clear();
    for (const x of h) {
      let m = this.helperTargets.get(x.prop);
      if (!m) { m = new Map(); this.helperTargets.set(x.prop, m); }
      m.set(x.netId, new THREE.Vector3(x.t[0], x.t[1], x.t[2]));
    }
  }

  onOwn(e: Extract<GameEvent, { k: 'own' }>) {
    const p = this.items.get(e.id);
    if (!p) return;
    const wasMine = p.owner === this.myNetId;
    p.owner = e.owner;
    p.helpers = e.helpers;
    p.lp = e.lp;
    const mine = e.owner === this.myNetId;
    if (mine && !wasMine) {
      // take over simulation from the current visual pose
      if (p.phys) {
        const b = p.phys.body;
        b.setTranslation({ x: p.mesh.position.x, y: p.mesh.position.y, z: p.mesh.position.z }, true);
        b.setRotation(p.mesh.quaternion, true);
        this.world.setDynamic(p.id, true);
        const last = p.buf.latest();
        b.setLinvel(last ? { x: last.v.x, y: last.v.y, z: last.v.z } : { x: 0, y: 0, z: 0 }, true);
        b.setAngvel({ x: 0, y: 0, z: 0 }, true);
        p.lastV.copy(last?.v ?? new THREE.Vector3());
      }
    } else if (!mine && wasMine) {
      this.world.setDynamic(p.id, false);
      p.buf.clear();
      p.buf.push({ t: -1, p: p.mesh.position.clone(), v: new THREE.Vector3(), q: p.mesh.quaternion.clone() });
    }
  }

  /** pose for blending at ownership loss */
  update(dt: number, renderTime: number) {
    for (const p of this.items.values()) {
      if (p.owner === this.myNetId && p.phys) {
        const t = p.phys.body.translation(), r = p.phys.body.rotation();
        p.mesh.position.set(t.x, t.y, t.z);
        p.mesh.quaternion.set(r.x, r.y, r.z, r.w);
      } else {
        if (p.buf.samples.length === 1 && p.buf.samples[0].t === -1) {
          const s = p.buf.samples[0];
          p.mesh.position.copy(s.p); if (s.q) p.mesh.quaternion.copy(s.q);
        } else if (p.buf.sample(renderTime, dt)) {
          p.mesh.position.copy(p.buf.out);
          p.mesh.quaternion.copy(p.buf.outQ);
        }
        this.world.setKinematicPose(p.id, p.mesh.position.x, p.mesh.position.y, p.mesh.position.z, p.mesh.quaternion);
      }
    }
  }

  /** spring forces for props I own (my hold + helpers' holds); called every physics step */
  simulate(h: number, myStrength: number) {
    for (const p of this.items.values()) {
      if (p.owner !== this.myNetId || !p.phys) continue;
      const b = p.phys.body;
      const holds: HoldSpec[] = [];
      if (this.hold && this.heldId === p.id) holds.push(this.hold);
      const helpers = this.helperTargets.get(p.id);
      if (helpers) for (const [netId, target] of helpers) {
        const lp = p.lp[netId];
        if (lp) holds.push({ target, lp: new THREE.Vector3(lp[0], lp[1], lp[2]), targetQ: new THREE.Quaternion(), strength: PLAYER.STRENGTH });
      }
      if (!holds.length) continue;
      const m = p.mass;
      const t = b.translation(), r = b.rotation(), lv = b.linvel(), av = b.angvel();
      _q.set(r.x, r.y, r.z, r.w);
      _v.set(lv.x, lv.y, lv.z);
      _w.set(av.x, av.y, av.z);
      let totalStrength = 0;
      for (const hs of holds) totalStrength += hs.strength;
      // each holder pulls its grab point toward its target; gravity compensation is shared
      for (const hs of holds) {
        _r.copy(hs.lp).applyQuaternion(_q);                 // grab point offset from centre
        _p.set(t.x, t.y, t.z).add(_r);                     // grab point world
        const pv = _f.copy(_w).cross(_r).add(_v);          // velocity of the grab point
        const k = GRAB.STIFFNESS, c = 2 * Math.sqrt(k) * GRAB.DAMPING;
        const ax = k * (hs.target.x - _p.x) - c * pv.x;
        const ay = k * (hs.target.y - _p.y) - c * pv.y;
        const az = k * (hs.target.z - _p.z) - c * pv.z;
        const share = hs.strength / totalStrength;
        let fx = m * ax, fy = m * ay + m * 9.81 * share, fz = m * az;
        const fl = Math.hypot(fx, fy, fz);
        if (fl > hs.strength) { const s = hs.strength / fl; fx *= s; fy *= s; fz *= s; }
        b.applyImpulseAtPoint({ x: fx * h, y: fy * h, z: fz * h }, { x: _p.x, y: _p.y, z: _p.z }, true);
      }
      // orientation hold from the primary holder
      const primary = this.hold && this.heldId === p.id ? this.hold : null;
      if (primary) {
        _qi.copy(_q).invert();
        const qe = primary.targetQ.clone().multiply(_qi);
        if (qe.w < 0) { qe.x = -qe.x; qe.y = -qe.y; qe.z = -qe.z; qe.w = -qe.w; }
        const angle = 2 * Math.acos(Math.min(1, qe.w));
        const sinH = Math.sqrt(Math.max(1e-9, 1 - qe.w * qe.w));
        const axis = _f.set(qe.x / sinH, qe.y / sinH, qe.z / sinH);
        const kr = GRAB.ANG_STIFFNESS, cr = 2 * Math.sqrt(kr) * GRAB.ANG_DAMPING;
        const rad = Math.max(0.1, p.radius);
        const I = m * rad * rad * 0.4;
        const tx = I * (kr * axis.x * angle - cr * _w.x), ty = I * (kr * axis.y * angle - cr * _w.y), tz = I * (kr * axis.z * angle - cr * _w.z);
        const tl = Math.hypot(tx, ty, tz), tmax = primary.strength * rad * 0.6;
        const s = tl > tmax ? tmax / tl : 1;
        if (angle > 1e-3 || _w.lengthSq() > 1e-4) b.applyTorqueImpulse({ x: tx * s * h, y: ty * s * h, z: tz * s * h }, true);
      }
      void myStrength;
    }
  }

  /** after a physics step: detect impacts on props I simulate */
  detectImpacts(now: number) {
    for (const p of this.items.values()) {
      if (p.owner !== this.myNetId || !p.phys) continue;
      const v = p.phys.body.linvel();
      _v.set(v.x, v.y, v.z);
      const dv = _v.distanceTo(p.lastV);
      p.lastV.copy(_v);
      if (dv > 2.4 && now - p.lastImpact > 0.15) {
        p.lastImpact = now;
        const t = p.phys.body.translation();
        this.onImpact?.(p, dv, new THREE.Vector3(t.x, t.y, t.z));
      }
    }
  }

  ownedStates(): OwnedPropState[] {
    const out: OwnedPropState[] = [];
    for (const p of this.items.values()) {
      if (p.owner !== this.myNetId || !p.phys) continue;
      const b = p.phys.body;
      const t = b.translation(), r = b.rotation(), v = b.linvel(), w = b.angvel();
      out.push({ id: p.id, p: [t.x, t.y, t.z], q: [r.x, r.y, r.z, r.w], v: [v.x, v.y, v.z], w: [w.x, w.y, w.z] });
    }
    return out;
  }

  clear() { for (const id of [...this.items.keys()]) this.remove(id); this.group.removeFromParent(); }
}
