// Snapshot interpolation buffers. Remote entities render at renderTime (server time minus an
// adaptive delay) using Hermite interpolation of positions (with velocities) and slerp.
import * as THREE from 'three';

export interface Sample { t: number; p: THREE.Vector3; v: THREE.Vector3; q?: THREE.Quaternion; yaw?: number; extra?: number[] }

const _a = new THREE.Vector3(), _b = new THREE.Vector3();

export class InterpBuffer {
  samples: Sample[] = [];
  readonly out = new THREE.Vector3();
  readonly outQ = new THREE.Quaternion();
  outYaw = 0;
  outExtra: number[] = [];
  /** visual error offset that decays (ownership hand-off smoothing) */
  readonly err = new THREE.Vector3();
  readonly errQ = new THREE.Quaternion();
  private errQActive = false;

  push(s: Sample) {
    const last = this.samples[this.samples.length - 1];
    if (last && s.t <= last.t) return;
    this.samples.push(s);
    if (this.samples.length > 40) this.samples.shift();
  }

  clear() { this.samples.length = 0; }

  latest(): Sample | undefined { return this.samples[this.samples.length - 1]; }

  /** start smoothing from a current visual pose to whatever the buffer produces next */
  blendFrom(p: THREE.Vector3, q?: THREE.Quaternion) {
    this.sample(this.samples.length ? this.samples[this.samples.length - 1].t : 0);
    this.err.copy(p).sub(this.out);
    if (q) { this.errQ.copy(this.outQ).invert().premultiply(q); this.errQActive = true; }
  }

  sample(t: number, dt = 0) {
    const s = this.samples;
    if (!s.length) return false;
    if (t <= s[0].t) { this.copyFrom(s[0]); }
    else if (t >= s[s.length - 1].t) {
      const l = s[s.length - 1];
      const ex = Math.min(t - l.t, 0.25);
      this.out.copy(l.p).addScaledVector(l.v, ex);
      if (l.q) this.outQ.copy(l.q);
      this.outYaw = l.yaw ?? 0;
      this.outExtra = l.extra ?? [];
    } else {
      let i = s.length - 2;
      while (i > 0 && s[i].t > t) i--;
      const a = s[i], b = s[i + 1];
      const span = Math.max(1e-4, b.t - a.t);
      const k = (t - a.t) / span;
      // cubic Hermite
      const k2 = k * k, k3 = k2 * k;
      const h00 = 2 * k3 - 3 * k2 + 1, h10 = k3 - 2 * k2 + k, h01 = -2 * k3 + 3 * k2, h11 = k3 - k2;
      _a.copy(a.v).multiplyScalar(span);
      _b.copy(b.v).multiplyScalar(span);
      if (b.p.distanceToSquared(a.p) > 25) this.out.copy(k < 0.5 ? a.p : b.p); // teleport: don't smear
      else this.out.copy(a.p).multiplyScalar(h00).addScaledVector(_a, h10).addScaledVector(b.p, h01).addScaledVector(_b, h11);
      if (a.q && b.q) this.outQ.copy(a.q).slerp(b.q, k);
      if (a.yaw !== undefined && b.yaw !== undefined) {
        let d = b.yaw - a.yaw;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        this.outYaw = a.yaw + d * k;
      }
      this.outExtra = (k < 0.5 ? a.extra : b.extra) ?? [];
    }
    // drop samples that are far in the past
    while (s.length > 3 && s[1].t < t - 1) s.shift();
    if (dt > 0) {
      const decay = Math.exp(-dt / 0.12);
      this.err.multiplyScalar(decay);
      if (this.errQActive) { this.errQ.slerp(new THREE.Quaternion(), 1 - decay); if (1 - Math.abs(this.errQ.w) < 1e-5) this.errQActive = false; }
    }
    this.out.add(this.err);
    if (this.errQActive) this.outQ.premultiply(this.errQ);
    return true;
  }

  private copyFrom(a: Sample) {
    this.out.copy(a.p);
    if (a.q) this.outQ.copy(a.q);
    this.outYaw = a.yaw ?? 0;
    this.outExtra = a.extra ?? [];
  }
}
