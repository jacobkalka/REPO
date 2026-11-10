// Creature + crew sculpt definitions (SDF primitives bound to skeleton joints).
// Models face -Z, feet at y = 0.
import type { MonsterId } from '../../../shared/catalog/monsters';
import type { CreatureSpec, Joint, Prim, V } from './SDF';

const mirror = (v: V): V => [-v[0], v[1], v[2]];

class Sculpt {
  joints: Joint[] = [];
  prims: Prim[] = [];
  j(name: string, parent: number, pos: V) { this.joints.push({ name, parent, pos }); return this.joints.length - 1; }
  cap(bone: number, a: V, b: V, r: number, r2: number | undefined, color: string, blend = 0.05, region = 0) { this.prims.push({ kind: 'capsule', a, b, r, r2, bone, color, blend, region }); }
  ell(bone: number, a: V, size: V, color: string, blend = 0.06, region = 0) { this.prims.push({ kind: 'ellipsoid', a, size, r: Math.min(...size), bone, color, blend, region }); }
  box(bone: number, a: V, size: V, r: number, color: string, blend = 0.03, region = 0) { this.prims.push({ kind: 'box', a, size, r, bone, color, blend, region }); }
  hole(bone: number, a: V, size: V, blend = 0.02) { this.prims.push({ kind: 'ellipsoid', a, size, r: Math.min(...size), bone, color: '#000', blend, sub: true }); }
  spec(res: number, noise = 0): CreatureSpec { return { joints: this.joints, prims: this.prims, res, noise }; }
}

/** humanoid skeleton helper; returns joint ids */
function humanoid(s: Sculpt, o: { hip: number; chest: number; neck: number; head: number; shoulderX: number; elbowY: number; handY: number; hipX: number; kneeY: number; hunch?: number; armZ?: number }) {
  const h = o.hunch ?? 0;
  const root = s.j('root', -1, [0, 0, 0]);
  const hips = s.j('hips', root, [0, o.hip, 0]);
  const spine = s.j('spine', hips, [0, (o.hip + o.chest) / 2, -h * 0.3]);
  const chest = s.j('chest', spine, [0, o.chest, -h]);
  const neck = s.j('neck', chest, [0, o.neck, -h * 1.4]);
  const head = s.j('head', neck, [0, o.head, -h * 1.8]);
  const az = o.armZ ?? -h;
  const lU = s.j('lUpper', chest, [o.shoulderX, o.chest + 0.03, az]);
  const lF = s.j('lFore', lU, [o.shoulderX + 0.03, o.elbowY, az]);
  const lH = s.j('lHand', lF, [o.shoulderX + 0.04, o.handY, az]);
  const rU = s.j('rUpper', chest, [-o.shoulderX, o.chest + 0.03, az]);
  const rF = s.j('rFore', rU, [-o.shoulderX - 0.03, o.elbowY, az]);
  const rH = s.j('rHand', rF, [-o.shoulderX - 0.04, o.handY, az]);
  const lT = s.j('lThigh', hips, [o.hipX, o.hip - 0.03, 0]);
  const lS = s.j('lShin', lT, [o.hipX, o.kneeY, 0]);
  const lFt = s.j('lFoot', lS, [o.hipX, 0.08, 0]);
  const rT = s.j('rThigh', hips, [-o.hipX, o.hip - 0.03, 0]);
  const rS = s.j('rShin', rT, [-o.hipX, o.kneeY, 0]);
  const rFt = s.j('rFoot', rS, [-o.hipX, 0.08, 0]);
  return { root, hips, spine, chest, neck, head, lU, lF, lH, rU, rF, rH, lT, lS, lFt, rT, rS, rFt };
}

// ------------------------------------------------------------------------------------ crew
export function crewSpec(helmet: number): CreatureSpec {
  const s = new Sculpt();
  const J = humanoid(s, { hip: 0.95, chest: 1.38, neck: 1.52, head: 1.64, shoulderX: 0.2, elbowY: 1.16, handY: 0.93, hipX: 0.1, kneeY: 0.5 });
  const SUIT = '#c8642a', DARK = '#26282a', SHELL = '#d9d5c8', PACK = '#4a4f52';
  s.cap(J.chest, [0, 1.43, 0], [0, 1.1, 0.01], 0.17, 0.15, SUIT, 0.08, 1);
  s.ell(J.hips, [0, 0.98, 0], [0.16, 0.13, 0.11], SUIT, 0.08, 1);
  s.cap(J.hips, [0.15, 1.03, 0], [-0.15, 1.03, 0], 0.05, undefined, DARK, 0.02, 2);
  for (const m of [1, -1]) {
    const U = m > 0 ? J.lU : J.rU, F = m > 0 ? J.lF : J.rF, H = m > 0 ? J.lH : J.rH, T = m > 0 ? J.lT : J.rT, S = m > 0 ? J.lS : J.rS, Ft = m > 0 ? J.lFt : J.rFt;
    const X = (v: V): V => (m > 0 ? v : mirror(v));
    s.ell(U, X([0.19, 1.45, 0]), [0.075, 0.055, 0.085], DARK, 0.03, 2);
    s.cap(U, X([0.2, 1.41, 0]), X([0.22, 1.17, 0]), 0.062, 0.055, SUIT, 0.04, 1);
    s.cap(F, X([0.22, 1.16, 0]), X([0.23, 0.98, 0]), 0.052, 0.046, SUIT, 0.03, 1);
    s.ell(H, X([0.235, 0.93, -0.01]), [0.045, 0.065, 0.042], DARK, 0.025, 2);
    s.cap(T, X([0.1, 0.92, 0]), X([0.1, 0.53, 0]), 0.085, 0.066, SUIT, 0.05, 1);
    s.cap(S, X([0.1, 0.5, 0]), X([0.1, 0.15, 0]), 0.064, 0.052, SUIT, 0.03, 1);
    s.ell(S, X([0.1, 0.5, -0.05]), [0.06, 0.06, 0.035], DARK, 0.02, 2);
    s.cap(Ft, X([0.1, 0.085, 0.03]), X([0.1, 0.065, -0.13]), 0.06, 0.055, DARK, 0.03, 2);
  }
  s.cap(J.neck, [0, 1.5, 0], [0, 1.57, 0], 0.058, undefined, DARK, 0.02, 2);
  // backpack + tank
  s.box(J.chest, [0, 1.3, 0.17], [0.14, 0.18, 0.07], 0.035, PACK, 0.03, 4);
  s.cap(J.chest, [0.07, 1.44, 0.22], [0.07, 1.14, 0.22], 0.045, undefined, '#7a7f80', 0.02, 4);
  s.cap(J.chest, [-0.07, 1.44, 0.22], [-0.07, 1.14, 0.22], 0.045, undefined, '#7a7f80', 0.02, 4);
  // helmet styles
  if (helmet === 2) {
    s.ell(J.head, [0, 1.67, 0], [0.17, 0.17, 0.17], SHELL, 0.03, 3);
    s.prims.push({ kind: 'torus', a: [0, 1.53, 0], size: [0.13, 0, 0], r: 0.025, bone: J.head, color: '#8a8f8f', blend: 0.02, region: 2 });
  } else {
    s.ell(J.head, [0, 1.67, 0.005], [0.14, 0.15, 0.155], SHELL, 0.03, 3);
    if (helmet === 1) { s.ell(J.head, [0, 1.74, -0.08], [0.16, 0.025, 0.12], SHELL, 0.02, 3); s.box(J.head, [0, 1.78, -0.15], [0.035, 0.03, 0.025], 0.01, DARK, 0.01, 2); }
    if (helmet === 3) s.cap(J.head, [0, 1.81, -0.12], [0, 1.82, 0.12], 0.025, undefined, DARK, 0.03, 2);
  }
  s.hole(J.head, [0, 1.65, -0.14], [0.1, 0.07, 0.06], 0.02);
  return s.spec(64);
}

// ------------------------------------------------------------------------------------ monsters
function stalker(): CreatureSpec {
  const s = new Sculpt();
  const J = humanoid(s, { hip: 1.35, chest: 1.98, neck: 2.2, head: 2.34, shoulderX: 0.22, elbowY: 1.52, handY: 1.0, hipX: 0.11, kneeY: 0.72, hunch: 0.16 });
  const SKIN = '#8b9086', DARK = '#4f5450', BONE = '#b5b4a4';
  s.cap(J.chest, [0, 2.04, -0.16], [0, 1.62, -0.04], 0.12, 0.1, SKIN, 0.07);
  s.cap(J.spine, [0, 1.62, -0.04], [0, 1.36, 0], 0.085, 0.09, SKIN, 0.06);
  for (let i = 0; i < 4; i++) for (const m of [1, -1]) s.cap(J.chest, [m * 0.03, 1.94 - i * 0.07, -0.26 + i * 0.015], [m * 0.13, 1.9 - i * 0.07, -0.12], 0.016, 0.012, BONE, 0.025);
  s.ell(J.hips, [0, 1.33, 0], [0.12, 0.09, 0.08], DARK, 0.05);
  for (const m of [1, -1]) {
    const X = (v: V): V => (m > 0 ? v : mirror(v));
    const U = m > 0 ? J.lU : J.rU, F = m > 0 ? J.lF : J.rF, H = m > 0 ? J.lH : J.rH, T = m > 0 ? J.lT : J.rT, S = m > 0 ? J.lS : J.rS, Ft = m > 0 ? J.lFt : J.rFt;
    s.cap(U, X([0.22, 2.0, -0.16]), X([0.25, 1.53, -0.16]), 0.045, 0.036, SKIN, 0.04);
    s.cap(F, X([0.25, 1.52, -0.16]), X([0.27, 1.06, -0.16]), 0.034, 0.028, SKIN, 0.03);
    for (let f = 0; f < 3; f++) s.cap(H, X([0.27, 1.04, -0.16]), X([0.26 + f * 0.025, 0.78, -0.2 + f * 0.04]), 0.012, 0.006, DARK, 0.02);
    s.cap(T, X([0.11, 1.32, 0]), X([0.12, 0.74, 0.02]), 0.06, 0.045, SKIN, 0.05);
    s.cap(S, X([0.12, 0.72, 0.02]), X([0.12, 0.12, 0.04]), 0.042, 0.032, SKIN, 0.03);
    s.cap(Ft, X([0.12, 0.08, 0.05]), X([0.13, 0.03, -0.2]), 0.035, 0.022, DARK, 0.03);
  }
  s.cap(J.neck, [0, 2.15, -0.22], [0, 2.3, -0.27], 0.045, 0.04, SKIN, 0.04);
  s.ell(J.head, [0, 2.42, -0.3], [0.095, 0.17, 0.12], SKIN, 0.04);
  s.hole(J.head, [0, 2.34, -0.41], [0.012, 0.09, 0.05], 0.015);
  s.hole(J.head, [0.045, 2.47, -0.39], [0.03, 0.02, 0.03], 0.02);
  s.hole(J.head, [-0.045, 2.47, -0.39], [0.03, 0.02, 0.03], 0.02);
  return s.spec(72, 0.012);
}

function mimic(): CreatureSpec {
  const s = new Sculpt();
  const root = s.j('root', -1, [0, 0, 0]);
  const body = s.j('body', root, [0, 0.52, 0.02]);
  const head = s.j('head', body, [0, 0.6, -0.36]);
  const sac = s.j('sac', head, [0, 0.4, -0.32]);
  const SKIN = '#43403a', SAC = '#8d5d5a', CLAW = '#cfc6b0';
  s.ell(body, [0, 0.52, 0.06], [0.24, 0.18, 0.32], SKIN, 0.08);
  s.ell(head, [0, 0.6, -0.38], [0.2, 0.1, 0.15], SKIN, 0.07);
  s.ell(sac, [0, 0.4, -0.31], [0.14, 0.13, 0.13], SAC, 0.06);
  for (let i = 0; i < 7; i++) s.hole(head, [-0.12 + i * 0.04, 0.66 + (i % 2) * 0.02, -0.5], [0.014, 0.014, 0.03], 0.01);
  const legs: [string, V, V, V][] = [['fl', [0.18, 0.5, -0.2], [0.27, 0.28, -0.3], [0.28, 0.03, -0.36]], ['bl', [0.18, 0.5, 0.25], [0.28, 0.32, 0.38], [0.26, 0.03, 0.3]]];
  for (const [n, a, b, c] of legs) for (const m of [1, -1]) {
    const X = (v: V): V => (m > 0 ? v : mirror(v));
    const u = s.j((m > 0 ? 'l' : 'r') + n + 'U', body, X(a));
    const l = s.j((m > 0 ? 'l' : 'r') + n + 'L', u, X(b));
    const p = s.j((m > 0 ? 'l' : 'r') + n + 'P', l, X(c));
    s.cap(u, X(a), X(b), 0.07, 0.05, SKIN, 0.05);
    s.cap(l, X(b), X(c), 0.045, 0.03, SKIN, 0.04);
    for (let k = 0; k < 3; k++) s.cap(p, X(c), X([c[0] + (k - 1) * 0.04, 0.01, c[2] - 0.09]), 0.012, 0.004, CLAW, 0.015);
  }
  return s.spec(60, 0.018);
}

function brute(): CreatureSpec {
  const s = new Sculpt();
  const root = s.j('root', -1, [0, 0, 0]);
  const hips = s.j('hips', root, [0, 1.05, 0.25]);
  const spine = s.j('spine', hips, [0, 1.45, 0.05]);
  const chest = s.j('chest', spine, [0, 1.85, -0.15]);
  const head = s.j('head', chest, [0, 1.92, -0.58]);
  const SKIN = '#5e5249', PLATE = '#2c2723', FIST = '#4a403a';
  s.ell(chest, [0, 1.8, -0.15], [0.62, 0.55, 0.5], SKIN, 0.15);
  s.ell(spine, [0, 1.38, 0.08], [0.45, 0.42, 0.42], SKIN, 0.15);
  s.ell(hips, [0, 1.05, 0.28], [0.38, 0.3, 0.32], SKIN, 0.12);
  s.ell(head, [0, 1.9, -0.6], [0.2, 0.17, 0.2], SKIN, 0.1);
  s.ell(head, [0, 1.8, -0.72], [0.16, 0.08, 0.12], PLATE, 0.05);
  for (let i = 0; i < 5; i++) s.box(i < 3 ? chest : spine, [0, 2.3 - i * 0.2, 0.05 + i * 0.12], [0.32 - i * 0.03, 0.06, 0.16], 0.04, PLATE, 0.05);
  for (const m of [1, -1]) {
    const X = (v: V): V => (m > 0 ? v : mirror(v));
    const sh = s.j((m > 0 ? 'l' : 'r') + 'Upper', chest, X([0.6, 1.95, -0.15]));
    const el = s.j((m > 0 ? 'l' : 'r') + 'Fore', sh, X([0.78, 1.2, -0.35]));
    const fi = s.j((m > 0 ? 'l' : 'r') + 'Hand', el, X([0.78, 0.2, -0.45]));
    s.cap(sh, X([0.55, 1.98, -0.15]), X([0.78, 1.2, -0.35]), 0.2, 0.17, SKIN, 0.1);
    s.cap(el, X([0.78, 1.2, -0.35]), X([0.79, 0.3, -0.45]), 0.26, 0.22, SKIN, 0.08);
    s.ell(fi, X([0.79, 0.2, -0.47]), [0.24, 0.2, 0.26], FIST, 0.06);
    s.box(sh, X([0.66, 2.1, -0.1]), [0.18, 0.08, 0.2], 0.05, PLATE, 0.05);
    const th = s.j((m > 0 ? 'l' : 'r') + 'Thigh', hips, X([0.35, 1.0, 0.3]));
    const kn = s.j((m > 0 ? 'l' : 'r') + 'Shin', th, X([0.42, 0.55, 0.22]));
    const ft = s.j((m > 0 ? 'l' : 'r') + 'Foot', kn, X([0.44, 0.08, 0.3]));
    s.cap(th, X([0.33, 1.0, 0.3]), X([0.42, 0.55, 0.22]), 0.19, 0.15, SKIN, 0.08);
    s.cap(kn, X([0.42, 0.55, 0.22]), X([0.44, 0.12, 0.32]), 0.14, 0.12, SKIN, 0.06);
    s.ell(ft, X([0.44, 0.07, 0.24]), [0.13, 0.07, 0.2], FIST, 0.04);
  }
  return s.spec(64, 0.022);
}

function lurker(): CreatureSpec {
  const s = new Sculpt();
  const root = s.j('root', -1, [0, 0, 0]);
  const body = s.j('body', root, [0, 0.62, 0]);
  const BODY = '#141416', LEG = '#1c1b1e', MARK = '#5a1c18';
  s.ell(body, [0, 0.62, 0.05], [0.22, 0.17, 0.3], BODY, 0.06);
  s.ell(body, [0, 0.66, -0.25], [0.12, 0.1, 0.12], BODY, 0.05);
  s.ell(body, [0, 0.79, 0.08], [0.1, 0.03, 0.16], MARK, 0.03);
  for (let i = 0; i < 6; i++) {
    const side = i < 3 ? 1 : -1;
    const k = i % 3;
    const z = -0.15 + k * 0.16;
    const out: V = [side * 0.16, 0.62, z];
    const knee: V = [side * 0.62, 1.0, z + (k - 1) * 0.15];
    const foot: V = [side * 1.0, 0.02, z + (k - 1) * 0.35];
    const c = s.j('leg' + i + 'a', body, out);
    const f = s.j('leg' + i + 'b', c, knee);
    const t = s.j('leg' + i + 'c', f, foot);
    s.cap(c, out, knee, 0.04, 0.03, LEG, 0.03);
    s.cap(f, knee, foot, 0.028, 0.008, LEG, 0.02);
    void t;
  }
  return s.spec(64, 0.006);
}

function watcher(): CreatureSpec {
  const s = new Sculpt();
  const root = s.j('root', -1, [0, 1.4, 0]);
  const stalk = s.j('stalk', root, [0, 1.0, 0]);
  const bulb = s.j('bulb', stalk, [0, 0.55, 0]);
  const FLESH = '#6c5a58', DARK = '#3a2e2e';
  s.cap(root, [0, 1.45, 0], [0, 1.0, 0], 0.09, 0.06, DARK, 0.06);
  s.ell(root, [0, 1.42, 0], [0.22, 0.05, 0.22], DARK, 0.08);
  s.cap(stalk, [0, 1.0, 0], [0, 0.65, 0], 0.06, 0.1, FLESH, 0.06);
  s.ell(bulb, [0, 0.5, 0], [0.27, 0.22, 0.27], FLESH, 0.08);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const t = s.j('tendril' + i, bulb, [Math.cos(a) * 0.18, 0.35, Math.sin(a) * 0.18]);
    s.cap(t, [Math.cos(a) * 0.18, 0.35, Math.sin(a) * 0.18], [Math.cos(a) * 0.26, 0.02, Math.sin(a) * 0.26], 0.025, 0.006, DARK, 0.04);
  }
  return s.spec(56, 0.015);
}

function swarm(): CreatureSpec {
  const s = new Sculpt();
  const root = s.j('root', -1, [0, 0, 0]);
  const body = s.j('body', root, [0, 0.1, 0]);
  const SH = '#2b2420', SPOT = '#a88a3a';
  s.ell(body, [0, 0.1, 0.06], [0.08, 0.06, 0.1], SH, 0.03);
  s.ell(body, [0, 0.11, -0.06], [0.06, 0.05, 0.06], SH, 0.03);
  s.ell(body, [0, 0.1, -0.13], [0.04, 0.035, 0.04], SPOT, 0.02);
  for (let i = 0; i < 6; i++) {
    const side = i < 3 ? 1 : -1, k = i % 3;
    const a: V = [side * 0.05, 0.1, -0.06 + k * 0.06];
    const b: V = [side * 0.14, 0.12, -0.08 + k * 0.08];
    const c: V = [side * 0.19, 0.0, -0.1 + k * 0.1];
    const u = s.j('leg' + i + 'a', body, a);
    const l = s.j('leg' + i + 'b', u, b);
    s.cap(u, a, b, 0.012, 0.01, SH, 0.012);
    s.cap(l, b, c, 0.01, 0.004, SH, 0.01);
  }
  return s.spec(36, 0.004);
}

function hunter(): CreatureSpec {
  const s = new Sculpt();
  const root = s.j('root', -1, [0, 0, 0]);
  const hips = s.j('hips', root, [0, 0.85, 0.45]);
  const spine = s.j('spine', hips, [0, 0.95, 0.0]);
  const chest = s.j('chest', spine, [0, 1.0, -0.35]);
  const neck = s.j('neck', chest, [0, 1.08, -0.6]);
  const head = s.j('head', neck, [0, 1.1, -0.82]);
  const jaw = s.j('jaw', head, [0, 1.03, -0.9]);
  const SKIN = '#6e6258', RIB = '#a99c8a', FIN = '#8a5f58', TEETH = '#ddd2b8';
  s.ell(chest, [0, 0.98, -0.32], [0.2, 0.24, 0.3], SKIN, 0.08);
  s.cap(spine, [0, 0.98, -0.1], [0, 0.88, 0.45], 0.13, 0.15, SKIN, 0.1);
  for (let i = 0; i < 5; i++) for (const m of [1, -1]) s.cap(chest, [m * 0.03, 1.15, -0.5 + i * 0.08], [m * 0.19, 0.84, -0.44 + i * 0.08], 0.014, 0.012, RIB, 0.02);
  s.cap(neck, [0, 1.05, -0.55], [0, 1.1, -0.78], 0.09, 0.08, SKIN, 0.05);
  s.cap(head, [0, 1.12, -0.78], [0, 1.08, -1.08], 0.1, 0.055, SKIN, 0.05);
  s.cap(jaw, [0, 1.02, -0.86], [0, 0.99, -1.06], 0.06, 0.035, SKIN, 0.03);
  for (let i = 0; i < 6; i++) { s.cap(head, [-0.04 + (i % 2) * 0.08, 1.06, -0.9 - i * 0.03], [-0.04 + (i % 2) * 0.08, 1.02, -0.9 - i * 0.03], 0.008, 0.003, TEETH, 0.005); }
  for (const m of [1, -1]) {
    const X = (v: V): V => (m > 0 ? v : mirror(v));
    s.ell(head, X([0.13, 1.2, -0.78]), [0.02, 0.13, 0.09], FIN, 0.03);
    const legs: [string, number, V, V, V][] = [['F', chest, [0.17, 0.95, -0.35], [0.2, 0.5, -0.3], [0.2, 0.04, -0.4]], ['B', hips, [0.17, 0.85, 0.45], [0.21, 0.4, 0.58], [0.2, 0.04, 0.45]]];
    for (const [n, parent, a, b, c] of legs) {
      const u = s.j((m > 0 ? 'l' : 'r') + n + 'U', parent, X(a));
      const l = s.j((m > 0 ? 'l' : 'r') + n + 'L', u, X(b));
      const p = s.j((m > 0 ? 'l' : 'r') + n + 'P', l, X(c));
      s.cap(u, X(a), X(b), 0.08, 0.05, SKIN, 0.06);
      s.cap(l, X(b), X(c), 0.045, 0.035, SKIN, 0.04);
      s.ell(p, X([c[0], 0.035, c[2] - 0.04]), [0.05, 0.03, 0.08], SKIN, 0.03);
    }
  }
  const tail = s.j('tail', hips, [0, 0.85, 0.62]);
  s.cap(tail, [0, 0.86, 0.6], [0, 0.6, 1.0], 0.05, 0.015, SKIN, 0.04);
  return s.spec(64, 0.016);
}

function unknown(): CreatureSpec {
  const s = new Sculpt();
  const root = s.j('root', -1, [0, 0, 0]);
  const body = s.j('body', root, [0, 1.2, 0]);
  const chest = s.j('chest', body, [0, 2.2, 0]);
  const head = s.j('head', chest, [0, 2.65, -0.05]);
  const C = '#0a0a0c';
  s.ell(root, [0, 0.4, 0], [0.42, 0.45, 0.42], C, 0.2);
  s.cap(body, [0, 0.5, 0], [0, 2.3, 0], 0.3, 0.2, C, 0.2);
  s.ell(head, [0, 2.68, -0.05], [0.13, 0.22, 0.14], C, 0.08);
  for (const m of [1, -1]) {
    const X = (v: V): V => (m > 0 ? v : mirror(v));
    const u = s.j((m > 0 ? 'l' : 'r') + 'Arm', chest, X([0.24, 2.3, 0]));
    const l = s.j((m > 0 ? 'l' : 'r') + 'Hand', u, X([0.34, 1.2, -0.05]));
    s.cap(u, X([0.24, 2.3, 0]), X([0.34, 1.25, -0.05]), 0.07, 0.05, C, 0.1);
    s.cap(l, X([0.34, 1.25, -0.05]), X([0.35, 0.8, -0.08]), 0.04, 0.012, C, 0.04);
  }
  return s.spec(52, 0.03);
}

export const MONSTER_SPECS: Record<MonsterId, () => CreatureSpec> = { stalker, mimic, brute, lurker, watcher, swarm, hunter, unknown };
