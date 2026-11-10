// Procedural animation: gait cycles, posture blending and state poses per creature type.
import type { Rig } from './CreatureMesh';

export interface AnimInput {
  dt: number;
  t: number;
  speed: number;        // m/s horizontal
  state: string;        // ai state / crew mode
  aux: number;          // windup/sniff/lure flags
  pitch?: number;       // look pitch (crew)
  crouch?: boolean;
  carry?: boolean;
  air?: boolean;
  downed?: boolean;
  dead?: boolean;
  stunned?: boolean;
  lock?: number;        // watcher lock meter 0..1
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export class Animator {
  phase = 0;
  blend: Record<string, number> = {};
  private atkT = 0;

  constructor(readonly rig: Rig, readonly kind: string) {}

  /** smoothly blended scalar */
  private b(key: string, target: number, rate: number, dt: number) {
    const v = this.blend[key] ?? target;
    const n = lerp(v, target, clamp01(rate * dt));
    this.blend[key] = n;
    return n;
  }

  update(a: AnimInput) {
    const r = this.rig;
    r.reset();
    switch (this.kind) {
      case 'crew': this.humanoid(a, 1.0, 0); break;
      case 'stalker': this.humanoid(a, 0.72, 1); break;
      case 'unknown': this.unknown(a); break;
      case 'brute': this.brute(a); break;
      case 'hunter': this.quad(a, 1.6, 0.55); break;
      case 'mimic': this.quad(a, 2.4, 0.4); this.mimicExtra(a); break;
      case 'lurker': this.spider(a, 6); break;
      case 'swarm': this.spider(a, 6, true); break;
      case 'watcher': this.watcher(a); break;
    }
  }

  private humanoid(a: AnimInput, freq: number, style: number) {
    const r = this.rig;
    const sp = a.speed;
    this.phase += sp * a.dt * (style ? 2.3 : 3.1) * freq;
    const run = this.b('run', clamp01((sp - 3.5) / 3), 6, a.dt);
    const amp = this.b('amp', Math.min(0.75, sp * 0.17), 8, a.dt);
    const crouch = this.b('crouch', a.crouch ? 1 : 0, 10, a.dt);
    const carry = this.b('carry', a.carry ? 1 : 0, 8, a.dt);
    const downed = this.b('downed', a.downed || a.dead ? 1 : 0, 5, a.dt);
    const air = this.b('air', a.air ? 1 : 0, 10, a.dt);
    const s = Math.sin(this.phase), c = Math.cos(this.phase);
    // legs
    const legAmp = amp * (1 - air * 0.6);
    r.rot('lThigh', s * legAmp - crouch * 0.95 - air * 0.5, 0, 0.03);
    r.rot('rThigh', -s * legAmp - crouch * 0.95 - air * 0.3, 0, -0.03);
    r.rot('lShin', Math.max(0, -c) * legAmp * 1.3 + crouch * 1.5 + air * 0.8);
    r.rot('rShin', Math.max(0, c) * legAmp * 1.3 + crouch * 1.5 + air * 0.6);
    r.rot('lFoot', -crouch * 0.5);
    r.rot('rFoot', -crouch * 0.5);
    // hips / spine
    const bob = Math.abs(s) * 0.04 * amp - crouch * (style ? 0.2 : 0.42);
    r.offset('hips', 0, bob, 0);
    const lean = -run * 0.22 - (style ? 0.18 + amp * 0.1 : 0) - crouch * 0.25;
    r.rot('spine', lean * 0.5, s * amp * 0.12, 0);
    r.rot('chest', lean * 0.5 - (a.pitch ?? 0) * 0.25, -s * amp * 0.15, 0);
    r.rot('neck', 0);
    r.rot('head', -(a.pitch ?? 0) * 0.55 + (style ? Math.sin(a.t * 7.3) * 0.04 * (a.state === 'chase' ? 3 : 1) : 0), style ? Math.sin(a.t * 0.9) * 0.15 : 0, style ? Math.sin(a.t * 2.1) * 0.08 : 0);
    // arms
    const armSwing = s * amp * (style ? 0.5 : 0.85);
    const reach = carry * 1.15;
    r.rot('lUpper', -armSwing - reach - (style ? 0.1 : 0), 0, 0.12 + (style ? 0.05 : 0) + carry * -0.1);
    r.rot('rUpper', armSwing - reach - (style ? 0.1 : 0), 0, -0.12 - (style ? 0.05 : 0) + carry * 0.1);
    r.rot('lFore', -0.25 - run * 0.6 - carry * 0.25);
    r.rot('rFore', -0.25 - run * 0.6 - carry * 0.25);
    if (style && (a.state === 'attack' || a.aux === 1)) {
      this.atkT += a.dt * 6;
      const w = Math.sin(Math.min(Math.PI, this.atkT));
      r.addRot('rUpper', -2.4 * w, 0, -0.4 * w);
      r.addRot('lUpper', -1.6 * w, 0, 0.3 * w);
      r.addRot('chest', 0.2 * w, -0.4 * w, 0);
    } else this.atkT = 0;
    if (a.stunned) { r.addRot('head', 0.4, Math.sin(a.t * 9) * 0.3, 0); r.addRot('chest', 0.25, 0, 0); }
    // downed: lie prone and crawl
    if (downed > 0.01) {
      r.rot('root', -1.45 * downed, 0, 0);
      r.offset('root', 0, 0.22 * downed, 0);
      const crawl = Math.sin(a.t * 3) * Math.min(1, sp);
      r.addRot('lUpper', -2.6 * downed + crawl * 0.6, 0, 0);
      r.addRot('rUpper', -2.6 * downed - crawl * 0.6, 0, 0);
      r.addRot('head', 1.0 * downed, 0, 0);
      if (a.dead) { r.addRot('lUpper', 1.8, 0, 0.6); r.addRot('rUpper', 1.6, 0, -0.5); r.addRot('lThigh', 0.2, 0, 0.2); }
    }
  }

  private quad(a: AnimInput, freq: number, ampMax: number) {
    const r = this.rig;
    const sp = a.speed;
    this.phase += sp * a.dt * freq * 2.2;
    const amp = this.b('amp', Math.min(ampMax, sp * 0.12), 8, a.dt);
    const s = Math.sin(this.phase), c = Math.cos(this.phase);
    const gallop = clamp01((sp - 3.5) / 3);
    // diagonal pairs (trot), gallop pairs fronts/backs together
    const ph = (o: number) => Math.sin(this.phase + o);
    const lf = ph(0), rb = ph(gallop * 0.6), rf = ph(Math.PI), lb = ph(Math.PI + gallop * 0.6);
    const leg = (pre: string, v: number, front: boolean) => {
      r.rot(pre + 'U', v * amp * (front ? 1 : -1.1));
      r.rot(pre + 'L', (front ? -1 : 1) * Math.max(0, -v) * amp * 1.4);
    };
    leg('lF', lf, true); leg('rF', rf, true); leg('lB', lb, false); leg('rB', rb, false);
    leg('lfl', lf, true); leg('rfl', rf, true); leg('lbl', lb, false); leg('rbl', rb, false);
    const bob = Math.abs(c) * 0.03 * amp * 3;
    r.offset('hips', 0, bob, 0); r.offset('body', 0, bob, 0);
    r.rot('spine', Math.sin(this.phase * 2) * 0.05 * gallop, 0, 0);
    r.rot('chest', -gallop * 0.12 + s * 0.04 * amp, 0, 0);
    r.rot('tail', 0.3 + Math.sin(a.t * 2) * 0.15, Math.sin(a.t * 3.1) * 0.3, 0);
    // head behaviours
    if (a.aux === 2 || a.state === 'sniff') {
      r.rot('neck', 0.55 + Math.sin(a.t * 5) * 0.1, Math.sin(a.t * 2.3) * 0.5, 0);
      r.rot('head', 0.2, Math.sin(a.t * 6) * 0.2, 0);
    } else {
      r.rot('neck', -gallop * 0.2 + Math.sin(a.t * 1.3) * 0.05, 0, 0);
      r.rot('head', 0, Math.sin(a.t * 0.8) * 0.1, 0);
    }
    if (a.state === 'attack' || a.aux === 1) {
      this.atkT += a.dt * 7;
      const w = Math.sin(Math.min(Math.PI, this.atkT));
      r.addRot('chest', -0.3 * w, 0, 0); r.addRot('neck', -0.4 * w, 0, 0);
      r.rot('jaw', 0.7 * w);
    } else { this.atkT = 0; r.rot('jaw', 0.06 + Math.max(0, Math.sin(a.t * 1.7)) * 0.05); }
    if (a.stunned) { r.addRot('neck', 0.5, Math.sin(a.t * 10) * 0.4, 0); }
  }

  private mimicExtra(a: AnimInput) {
    const r = this.rig;
    const sac = r.by.sac;
    if (sac) {
      const pulse = a.aux === 3 ? 1.25 + Math.sin(a.t * 30) * 0.12 : 1 + Math.sin(a.t * 2) * 0.04;
      sac.scale.setScalar(this.b('sac', pulse, 12, a.dt));
    }
    if (a.state === 'lure') { r.rot('head', -0.15 + Math.sin(a.t * 0.7) * 0.08, Math.sin(a.t * 0.4) * 0.5, 0); r.offset('body', 0, -0.12, 0); }
    if (a.state === 'flee') r.rot('head', 0.3);
  }

  private brute(a: AnimInput) {
    const r = this.rig;
    const sp = a.speed;
    this.phase += sp * a.dt * 1.9;
    const amp = this.b('amp', Math.min(0.5, sp * 0.18), 6, a.dt);
    const s = Math.sin(this.phase), c = Math.cos(this.phase);
    r.rot('lThigh', s * amp); r.rot('rThigh', -s * amp);
    r.rot('lShin', Math.max(0, -c) * amp * 1.2); r.rot('rShin', Math.max(0, c) * amp * 1.2);
    r.rot('lUpper', -s * amp * 0.9, 0, 0); r.rot('rUpper', s * amp * 0.9, 0, 0);
    r.rot('lFore', -Math.max(0, s) * amp * 0.6); r.rot('rFore', -Math.max(0, -s) * amp * 0.6);
    r.offset('hips', 0, Math.abs(s) * 0.05 * amp * 2, 0);
    r.rot('chest', Math.sin(a.t * 1.1) * 0.03, s * amp * 0.12, 0);
    r.rot('head', Math.sin(a.t * 0.7) * 0.06, Math.sin(a.t * 0.5) * 0.2, 0);
    const windup = this.b('wind', a.aux === 1 || a.state === 'attack' || a.state === 'smash' ? 1 : 0, 5, a.dt);
    if (windup > 0.01) {
      r.addRot('spine', 0.45 * windup, 0, 0);
      r.addRot('chest', 0.3 * windup, 0, 0);
      r.addRot('lUpper', -2.3 * windup, 0, -0.3 * windup);
      r.addRot('rUpper', -2.3 * windup, 0, 0.3 * windup);
      r.offset('hips', 0, 0.1 * windup, 0.1 * windup);
    }
    if (a.stunned) { r.addRot('chest', -0.2, Math.sin(a.t * 6) * 0.2, 0); }
  }

  private spider(a: AnimInput, legs: number, tiny = false) {
    const r = this.rig;
    const sp = a.speed;
    this.phase += sp * a.dt * (tiny ? 26 : 7);
    const amp = this.b('amp', Math.min(tiny ? 0.6 : 0.4, sp * (tiny ? 0.25 : 0.12)), 10, a.dt);
    const ceiling = this.b('ceil', a.state === 'ambush' ? 1 : 0, 3, a.dt);
    const pin = this.b('pin', a.state === 'pin' ? 1 : 0, 6, a.dt);
    for (let i = 0; i < legs; i++) {
      const tri = (i % 2 === 0) !== (i >= 3) ? 0 : Math.PI;
      const s = Math.sin(this.phase + tri);
      const side = i < 3 ? 1 : -1;
      r.rot(`leg${i}a`, 0, s * amp * 0.6, (Math.max(0, s) * amp * 0.8 - pin * 0.9) * side);
      r.rot(`leg${i}b`, 0, 0, (-Math.max(0, -s) * amp * 0.4 + pin * 1.1 + ceiling * 0.3) * side);
    }
    r.offset('body', 0, Math.sin(this.phase * 2) * 0.01 * amp, 0);
    if (ceiling > 0.01) { r.rot('root', 0, 0, Math.PI * ceiling); r.offset('root', 0, ceiling * 1.25, 0); }
    if (a.state === 'flee' || a.state === 'retreat') r.addRot('body', 0.2, 0, 0);
    if (a.stunned) r.addRot('body', 0, a.t * 8, 0);
  }

  private watcher(a: AnimInput) {
    const r = this.rig;
    const lock = a.lock ?? 0;
    r.rot('stalk', Math.sin(a.t * 0.6) * 0.06, 0, Math.cos(a.t * 0.5) * 0.06);
    r.rot('bulb', Math.sin(a.t * 0.9) * 0.05 + lock * 0.15, 0, 0);
    for (let i = 0; i < 6; i++) r.rot('tendril' + i, Math.sin(a.t * 1.3 + i) * 0.25 * (1 + lock), 0, Math.cos(a.t * 1.1 + i * 2) * 0.2);
    if (a.stunned) r.addRot('bulb', Math.sin(a.t * 12) * 0.3, 0, 0);
  }

  private unknown(a: AnimInput) {
    const r = this.rig;
    r.rot('body', Math.sin(a.t * 0.7) * 0.04, Math.sin(a.t * 0.3) * 0.1, Math.sin(a.t * 0.5) * 0.04);
    r.rot('head', Math.sin(a.t * 0.4) * 0.15, Math.sin(a.t * 0.23) * 0.4, Math.sin(a.t * 1.7) * 0.12);
    r.rot('lArm', -0.2 + Math.sin(a.t * 0.6) * 0.15, 0, 0.1);
    r.rot('rArm', -0.2 + Math.sin(a.t * 0.55 + 1) * 0.15, 0, -0.1);
    r.offset('root', 0, 0.15 + Math.sin(a.t * 0.8) * 0.06, 0);
  }
}
