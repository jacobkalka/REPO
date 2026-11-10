// Procedural sound synthesis. Every sound effect in the game is generated here (no recorded
// assets), so all audio is original.

export type Gen = (sr: number) => Float32Array[]; // returns 1 or 2 channels

const TAU = Math.PI * 2;

function rng(seed: number) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) / 4294967296) * 2 - 1; }; }

function buf(sr: number, sec: number) { return new Float32Array(Math.max(1, Math.floor(sr * sec))); }

/** one-pole low-pass in place */
function lowpass(x: Float32Array, sr: number, fc: number) { const a = Math.exp(-TAU * fc / sr); let y = 0; for (let i = 0; i < x.length; i++) { y = (1 - a) * x[i] + a * y; x[i] = y; } return x; }
function highpass(x: Float32Array, sr: number, fc: number) { const a = Math.exp(-TAU * fc / sr); let y = 0, px = 0; for (let i = 0; i < x.length; i++) { y = a * (y + x[i] - px); px = x[i]; x[i] = y; } return x; }
/** RBJ band-pass (constant skirt) */
function bandpass(x: Float32Array, sr: number, f: number, q: number) {
  const w = TAU * f / sr, al = Math.sin(w) / (2 * q), c = Math.cos(w);
  const b0 = al, b2 = -al, a0 = 1 + al, a1 = -2 * c, a2 = 1 - al;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) { const y = (b0 * x[i] + b2 * x2 - a1 * y1 - a2 * y2) / a0; x2 = x1; x1 = x[i]; y2 = y1; y1 = y; x[i] = y; }
  return x;
}
function env(i: number, sr: number, a: number, d: number) { const t = i / sr; return t < a ? t / a : Math.exp(-(t - a) / d); }
function normalize(x: Float32Array, peak = 0.9) { let m = 0; for (const v of x) m = Math.max(m, Math.abs(v)); if (m > 0) for (let i = 0; i < x.length; i++) x[i] *= peak / m; return x; }
function mix(a: Float32Array, b: Float32Array, gb = 1, off = 0) { for (let i = 0; i < b.length && i + off < a.length; i++) a[i + off] += b[i] * gb; return a; }
function noise(sr: number, sec: number, seed = 1) { const r = rng(seed); const x = buf(sr, sec); for (let i = 0; i < x.length; i++) x[i] = r(); return x; }
function brown(sr: number, sec: number, seed = 1) { const r = rng(seed); const x = buf(sr, sec); let v = 0; for (let i = 0; i < x.length; i++) { v = (v + r() * 0.04) * 0.996; x[i] = v * 6; } return x; }
function fadeEdges(x: Float32Array, sr: number, ms = 8) { const n = Math.floor(sr * ms / 1000); for (let i = 0; i < n && i < x.length; i++) { const g = i / n; x[i] *= g; x[x.length - 1 - i] *= g; } return x; }
function shape(x: Float32Array, k: number) { for (let i = 0; i < x.length; i++) x[i] = Math.tanh(x[i] * k); return x; }

/** modal synthesis: sum of exponentially decaying partials */
function modal(sr: number, sec: number, f0: number, ratios: number[], decays: number[], gains: number[], seed = 1, noiseAmt = 0.3) {
  const x = buf(sr, sec);
  const r = rng(seed);
  ratios.forEach((ratio, k) => {
    const f = f0 * ratio * (1 + r() * 0.01), d = decays[k], g = gains[k];
    const ph = r() * TAU;
    for (let i = 0; i < x.length; i++) x[i] += Math.sin(TAU * f * i / sr + ph) * Math.exp(-i / sr / d) * g;
  });
  const n = noise(sr, Math.min(sec, 0.03), seed + 7);
  for (let i = 0; i < n.length; i++) n[i] *= Math.exp(-i / sr / 0.006) * noiseAmt;
  mix(x, n);
  return x;
}

// ------------------------------------------------------------------ material impact models
const MAT: Record<string, { f: number; ratios: number[]; decay: number; noise: number; lp: number }> = {
  metal: { f: 420, ratios: [1, 2.32, 4.25, 6.63, 9.38], decay: 0.35, noise: 0.25, lp: 9000 },
  brass: { f: 610, ratios: [1, 2.76, 5.4, 8.93], decay: 0.55, noise: 0.15, lp: 10000 },
  glass: { f: 1700, ratios: [1, 2.32, 3.9, 5.6], decay: 0.18, noise: 0.15, lp: 14000 },
  ceramic: { f: 980, ratios: [1, 2.1, 3.7, 5.2], decay: 0.12, noise: 0.25, lp: 11000 },
  wood: { f: 190, ratios: [1, 2.6, 4.1], decay: 0.06, noise: 0.6, lp: 4000 },
  plastic: { f: 330, ratios: [1, 2.9, 5.1], decay: 0.05, noise: 0.5, lp: 5000 },
  stone: { f: 160, ratios: [1, 2.3, 3.6], decay: 0.05, noise: 0.8, lp: 3000 },
  fabric: { f: 90, ratios: [1, 1.9], decay: 0.03, noise: 1.0, lp: 1400 },
  electronic: { f: 380, ratios: [1, 2.7, 4.9], decay: 0.07, noise: 0.45, lp: 6000 },
  paper: { f: 120, ratios: [1, 2.2], decay: 0.02, noise: 1.0, lp: 2500 },
};

function impact(mat: string, seed: number): Gen {
  const m = MAT[mat] ?? MAT.metal;
  return (sr) => {
    const x = modal(sr, m.decay * 4 + 0.1, m.f, m.ratios, m.ratios.map((_, k) => m.decay / (1 + k * 0.6)), m.ratios.map((_, k) => 1 / (1 + k * 0.8)), seed, m.noise);
    const thump = noise(sr, 0.06, seed + 3);
    lowpass(thump, sr, 260);
    for (let i = 0; i < thump.length; i++) thump[i] *= Math.exp(-i / sr / 0.015) * 3;
    mix(x, thump);
    lowpass(x, sr, m.lp);
    return [fadeEdges(normalize(x, 0.85), sr, 2)];
  };
}

function shatter(seed: number): Gen {
  return (sr) => {
    const x = buf(sr, 1.2);
    const r = rng(seed);
    for (let k = 0; k < 26; k++) {
      const off = Math.floor((Math.abs(r()) ** 2) * sr * 0.7);
      const ping = modal(sr, 0.25, 1800 + Math.abs(r()) * 3800, [1, 2.4, 3.9], [0.06, 0.04, 0.03], [1, 0.5, 0.3], seed + k, 0.4);
      mix(x, ping, 0.4 + Math.abs(r()) * 0.6, off);
    }
    const crash = noise(sr, 0.4, seed + 99);
    highpass(crash, sr, 2500);
    for (let i = 0; i < crash.length; i++) crash[i] *= Math.exp(-i / sr / 0.08);
    mix(x, crash, 1.4);
    return [normalize(x, 0.9)];
  };
}

function footstep(surface: string, seed: number): Gen {
  return (sr) => {
    const x = noise(sr, 0.22, seed);
    const cfg: Record<string, [number, number, number, number]> = { concrete: [1100, 0.9, 0.025, 160], metal: [2400, 2.2, 0.05, 340], tile: [1900, 1.2, 0.02, 220], wood: [600, 1.0, 0.04, 140], carpet: [380, 0.6, 0.02, 90], water: [900, 0.6, 0.09, 120] };
    const [f, q, dec, thumpF] = cfg[surface] ?? cfg.concrete;
    bandpass(x, sr, f, q);
    for (let i = 0; i < x.length; i++) x[i] *= env(i, sr, 0.002, dec);
    const thump = modal(sr, 0.12, thumpF, [1, 1.7], [0.03, 0.02], [1, 0.4], seed, 0);
    mix(x, thump, 0.7);
    if (surface === 'metal') mix(x, modal(sr, 0.3, 780 + (seed % 7) * 40, [1, 2.7, 5.1], [0.12, 0.08, 0.05], [0.5, 0.3, 0.2], seed, 0), 0.35);
    if (surface === 'water') { const sp = noise(sr, 0.22, seed + 5); highpass(sp, sr, 2500); for (let i = 0; i < sp.length; i++) sp[i] *= env(i, sr, 0.01, 0.06); mix(x, sp, 0.8); }
    return [fadeEdges(normalize(x, 0.8), sr, 2)];
  };
}

function creak(seed: number, base: number, dur: number, metal: boolean): Gen {
  return (sr) => {
    const x = buf(sr, dur);
    const r = rng(seed);
    let ph = 0;
    let f = base;
    for (let i = 0; i < x.length; i++) {
      const t = i / sr;
      f += (base * (1 + 0.4 * Math.sin(t * 3.1 + seed)) - f) * 0.001 + r() * 3;
      ph += TAU * f / sr;
      const stick = Math.max(0, Math.sin(TAU * (18 + 10 * Math.sin(t * 2)) * t)) ** 6;
      x[i] = (Math.sin(ph) + 0.5 * Math.sin(ph * 2.03) + 0.3 * Math.sin(ph * 3.7)) * (0.4 + stick) * Math.min(1, t * 12) * Math.min(1, (dur - t) * 6);
    }
    bandpass(x, sr, metal ? base * 3 : base * 2, 1.2);
    if (metal) mix(x, modal(sr, dur, base * 1.5, [1, 2.4, 4.1], [0.4, 0.3, 0.2], [0.2, 0.1, 0.05], seed, 0), 0.6);
    return [normalize(x, 0.7)];
  };
}

function slam(seed: number, metal: boolean): Gen {
  return (sr) => {
    const x = modal(sr, 0.9, metal ? 140 : 95, [1, 2.2, 3.1, 4.7], [0.25, 0.14, 0.09, 0.05], [1, 0.6, 0.35, 0.2], seed, 0.9);
    lowpass(x, sr, metal ? 4500 : 2200);
    const rattle = noise(sr, 0.35, seed + 4);
    bandpass(rattle, sr, metal ? 3200 : 1200, 2);
    for (let i = 0; i < rattle.length; i++) rattle[i] *= Math.exp(-i / sr / 0.07) * (1 + Math.sin(i / sr * 80));
    mix(x, rattle, 0.4);
    return [normalize(x, 0.95)];
  };
}

function tone(freqs: number[], dur: number, type: 'sine' | 'square' | 'saw' = 'sine', att = 0.005, dec = 0.15): Gen {
  return (sr) => {
    const x = buf(sr, dur);
    freqs.forEach((f, k) => {
      const start = Math.floor((k * dur * sr) / freqs.length) * (freqs.length > 1 ? 1 : 0);
      for (let i = start; i < x.length; i++) {
        const t = (i - start) / sr;
        const ph = TAU * f * t;
        const s = type === 'sine' ? Math.sin(ph) : type === 'square' ? Math.sign(Math.sin(ph)) * 0.5 : ((ph / TAU) % 1) * 2 - 1;
        x[i] += s * (t < att ? t / att : Math.exp(-(t - att) / dec)) * 0.6;
      }
    });
    return [fadeEdges(normalize(x, 0.6), sr, 3)];
  };
}

/** formant-filtered growl / scream for creatures */
function vocal(seed: number, f0: number, f1: number, dur: number, formants: number[], rough: number, gain = 0.9): Gen {
  return (sr) => {
    const r = rng(seed);
    const src = buf(sr, dur);
    let ph = 0;
    for (let i = 0; i < src.length; i++) {
      const t = i / sr;
      const f = f0 + (f1 - f0) * Math.min(1, t / dur) + Math.sin(t * 31 + seed) * f0 * 0.04 + r() * f0 * rough * 0.1;
      ph += TAU * f / sr;
      const saw = ((ph / TAU) % 1) * 2 - 1;
      src[i] = saw * (0.7 + 0.3 * Math.sin(t * 9)) + r() * rough;
    }
    const out = buf(sr, dur);
    formants.forEach((fm, k) => { const c = Float32Array.from(src); bandpass(c, sr, fm, 6 + k * 2); mix(out, c, 1 / (1 + k * 0.5)); });
    for (let i = 0; i < out.length; i++) { const t = i / sr; out[i] *= Math.min(1, t * 20) * Math.min(1, (dur - t) * 5); }
    shape(out, 2.2);
    return [normalize(out, gain)];
  };
}

function clicks(seed: number, dur: number, rate: number, f: number): Gen {
  return (sr) => {
    const x = buf(sr, dur);
    const r = rng(seed);
    let t = 0;
    while (t < dur) {
      const click = modal(sr, 0.03, f * (0.7 + Math.abs(r()) * 0.6), [1, 2.3], [0.006, 0.004], [1, 0.5], seed + Math.floor(t * 1000), 0.8);
      mix(x, click, 0.5 + Math.abs(r()) * 0.5, Math.floor(t * sr));
      t += (1 / rate) * (0.3 + Math.abs(r()) * 1.4);
    }
    return [normalize(x, 0.7)];
  };
}

function sweep(f0: number, f1: number, dur: number, noiseAmt = 0, lp = 8000): Gen {
  return (sr) => {
    const x = buf(sr, dur);
    let ph = 0;
    const r = rng(7);
    for (let i = 0; i < x.length; i++) { const t = i / sr; const f = f0 * Math.pow(f1 / f0, t / dur); ph += TAU * f / sr; x[i] = Math.sin(ph) * (1 - noiseAmt) + r() * noiseAmt; x[i] *= Math.min(1, t * 30) * Math.min(1, (dur - t) * 8); }
    lowpass(x, sr, lp);
    return [normalize(x, 0.7)];
  };
}

function siren(dur: number, f0: number, f1: number, rate: number): Gen {
  return (sr) => {
    const x = buf(sr, dur);
    let ph = 0;
    for (let i = 0; i < x.length; i++) { const t = i / sr; const f = f0 + (f1 - f0) * (0.5 + 0.5 * Math.sin(TAU * rate * t)); ph += TAU * f / sr; x[i] = (Math.sin(ph) + 0.3 * Math.sign(Math.sin(ph))) * Math.min(1, t * 20) * Math.min(1, (dur - t) * 10); }
    lowpass(x, sr, 3500);
    return [normalize(x, 0.6)];
  };
}

/** looping ambience beds (stereo, seamless by crossfading the ends) */
function ambience(kind: string): Gen {
  return (sr) => {
    const dur = 12;
    const L = buf(sr, dur), R = buf(sr, dur);
    const r = rng(kind.length * 97);
    const drone = (f: number, g: number, wob: number) => { for (let i = 0; i < L.length; i++) { const t = i / sr; const v = Math.sin(TAU * f * t + Math.sin(TAU * 0.07 * t) * wob) * g; L[i] += v; R[i] += Math.sin(TAU * f * 1.003 * t + Math.sin(TAU * 0.05 * t) * wob) * g; } };
    const bed = brown(sr, dur, 11), bed2 = brown(sr, dur, 23);
    lowpass(bed, sr, kind === 'industrial' ? 220 : 140); lowpass(bed2, sr, kind === 'industrial' ? 220 : 140);
    mix(L, bed, 0.9); mix(R, bed2, 0.9);
    if (kind === 'research') { drone(120, 0.05, 0.2); drone(240, 0.02, 0.1); drone(60, 0.06, 0.1); const hiss = noise(sr, dur, 3); bandpass(hiss, sr, 3000, 0.7); mix(L, hiss, 0.02); mix(R, hiss, 0.02); }
    if (kind === 'industrial') { drone(48, 0.12, 0.3); drone(96, 0.05, 0.5); for (let i = 0; i < L.length; i++) { const t = i / sr; const thud = Math.max(0, Math.sin(TAU * 0.9 * t)) ** 30 * Math.sin(TAU * 55 * t) * 0.25; L[i] += thud; R[i] += thud * 0.8; } }
    if (kind === 'underground') { drone(36, 0.12, 0.4); drone(72.5, 0.04, 0.6); for (let k = 0; k < 14; k++) { const drip = modal(sr, 0.25, 1400 + Math.abs(r()) * 1800, [1, 1.5], [0.04, 0.03], [1, 0.4], k, 0.05); const off = Math.floor(Math.abs(r()) * (L.length - drip.length)); mix(k % 2 ? L : R, drip, 0.12 + Math.abs(r()) * 0.1, off); } }
    if (kind === 'luxury') { drone(55, 0.07, 0.2); drone(82.4, 0.03, 0.3); for (let k = 0; k < 12; k++) { const tick = modal(sr, 0.08, 2200, [1, 2.7], [0.01, 0.006], [1, 0.3], k, 0.3); mix(L, tick, 0.03, Math.floor((k + 0.5) * sr)); mix(R, tick, 0.025, Math.floor((k + 0.5) * sr)); } for (let k = 0; k < 3; k++) { const c = creak(k + 5, 180 + k * 40, 1.2, false)(sr)[0]; mix(k % 2 ? L : R, c, 0.05, Math.floor(Math.abs(r()) * (L.length - c.length))); } }
    // seamless loop: crossfade the last second into the first
    const n = sr;
    for (let i = 0; i < n; i++) { const g = i / n; L[i] = L[i] * g + L[L.length - n + i] * (1 - g); R[i] = R[i] * g + R[R.length - n + i] * (1 - g); }
    const Lc = L.slice(0, L.length - n), Rc = R.slice(0, R.length - n);
    normalize(Lc, 0.5); normalize(Rc, 0.5);
    return [Lc, Rc];
  };
}

function music(kind: 'tension' | 'chase'): Gen {
  return (sr) => {
    const dur = kind === 'chase' ? 4.8 : 9.6; // 100 bpm bars
    const L = buf(sr, dur), R = buf(sr, dur);
    if (kind === 'tension') {
      const notes = [55, 58.27, 82.41, 87.31];
      notes.forEach((f, k) => { for (let i = 0; i < L.length; i++) { const t = i / sr; const g = 0.12 * (0.5 + 0.5 * Math.sin(TAU * t / dur + k)); L[i] += Math.sin(TAU * f * t) * g * (k % 2 ? 0.6 : 1); R[i] += Math.sin(TAU * f * 1.004 * t) * g * (k % 2 ? 1 : 0.6); } });
      const sh = noise(sr, dur, 5); bandpass(sh, sr, 5200, 3); for (let i = 0; i < sh.length; i++) sh[i] *= 0.04 * (0.5 + 0.5 * Math.sin(TAU * i / sr / dur * 2)); mix(L, sh); mix(R, sh);
    } else {
      const beat = 0.6;
      for (let b = 0; b < 8; b++) {
        const kick = modal(sr, 0.4, 52, [1, 1.6], [0.12, 0.05], [1, 0.3], b, 0.4);
        shape(kick, 1.5);
        mix(L, kick, 0.9, Math.floor(b * beat * sr)); mix(R, kick, 0.9, Math.floor(b * beat * sr));
        if (b % 2) { const sn = noise(sr, 0.2, b + 9); bandpass(sn, sr, 1800, 0.8); for (let i = 0; i < sn.length; i++) sn[i] *= Math.exp(-i / sr / 0.05); mix(L, sn, 0.35, Math.floor((b * beat + 0.3) * sr)); mix(R, sn, 0.3, Math.floor((b * beat + 0.3) * sr)); }
      }
      for (let i = 0; i < L.length; i++) { const t = i / sr; const v = Math.sin(TAU * 41.2 * t) * 0.18 * (0.6 + 0.4 * Math.sin(TAU * t / 0.6)); L[i] += v; R[i] += v; }
    }
    normalize(L, 0.55); normalize(R, 0.55);
    return [L, R];
  };
}

// ------------------------------------------------------------------ catalogue
export const SOUNDS: Record<string, Gen | Gen[]> = {
  ...Object.fromEntries(['concrete', 'metal', 'tile', 'wood', 'carpet', 'water'].map((s) => ['step_' + s, [1, 2, 3, 4].map((k) => footstep(s, k * 31 + s.length))])),
  ...Object.fromEntries(Object.keys(MAT).map((m) => ['impact_' + m, [1, 2, 3].map((k) => impact(m, k * 17 + m.length))])),
  ...Object.fromEntries(Object.keys(MAT).map((m) => ['shatter_' + m, [shatter(m.length * 5)]])),
  door_open_wood: creak(3, 140, 0.9, false), door_close_wood: slam(4, false), door_open_metal: creak(5, 95, 0.8, true), door_close_metal: slam(6, true),
  door_open_panel: creak(7, 120, 0.7, true), door_close_panel: slam(8, true), door_open_ornate: creak(9, 160, 1.1, false), door_close_ornate: slam(10, false),
  door_open_glass: creak(11, 200, 0.5, false), door_close_glass: slam(12, false),
  door_open_security: sweep(70, 140, 1.1, 0.3, 1500), door_close_security: slam(13, true), door_smash: (sr) => { const a = slam(14, true)(sr)[0]; const b = shatter(15)(sr)[0]; mix(a, b, 0.6); return [normalize(a, 0.95)]; },
  switch: tone([1800], 0.05, 'square', 0.001, 0.01), lever: (sr) => [normalize(mix(modal(sr, 0.5, 220, [1, 2.7, 4.4], [0.15, 0.08, 0.05], [1, 0.5, 0.3], 3, 0.7), creak(21, 90, 0.4, true)(sr)[0], 0.4), 0.9)],
  valve: creak(22, 70, 1.0, true), pickup: tone([880, 1320], 0.18, 'sine', 0.002, 0.05), crate_open: (sr) => [normalize(mix(impact('plastic', 41)(sr)[0], creak(23, 260, 0.3, false)(sr)[0], 0.5), 0.8)],
  keycard_ok: tone([1046, 1568], 0.25, 'square', 0.002, 0.08), keycard_denied: tone([220, 196], 0.35, 'square', 0.002, 0.1), denied: tone([196], 0.2, 'square', 0.002, 0.08),
  terminal: tone([660, 990, 1320, 990], 0.5, 'square', 0.001, 0.04), secret: (sr) => [normalize(mix(creak(24, 55, 2.2, false)(sr)[0], brown(sr, 2.2, 9), 0.5), 0.8)],
  power_on: sweep(40, 220, 1.6, 0.1, 2000), power_off: sweep(220, 30, 1.4, 0.15, 1800), tube_send: sweep(300, 2400, 1.2, 0.7, 6000), tube_empty: sweep(200, 300, 0.4, 0.5, 2000),
  scanner: sweep(500, 2400, 0.7, 0.05, 9000), prod_hit: (sr) => { const x = noise(sr, 0.5, 31); bandpass(x, sr, 4200, 1.2); for (let i = 0; i < x.length; i++) x[i] *= Math.max(0, Math.sin(i / sr * 600)) * Math.exp(-i / sr / 0.2); return [normalize(x, 0.9)]; },
  prod_miss: (sr) => { const x = noise(sr, 0.25, 32); bandpass(x, sr, 5000, 2); for (let i = 0; i < x.length; i++) x[i] *= Math.exp(-i / sr / 0.06); return [normalize(x, 0.6)]; },
  defib: (sr) => [normalize(mix(sweep(200, 3000, 0.6, 0, 8000)(sr)[0], slam(33, false)(sr)[0], 0.8, Math.floor(0.6 * sr)), 0.9)],
  decoy_beep: tone([1760], 0.12, 'square', 0.001, 0.04), alarm: siren(2.4, 600, 1100, 1.4), lift_alarm: siren(2, 420, 620, 2.2), lift_depart: (sr) => [normalize(mix(brown(sr, 4, 4), sweep(45, 90, 4, 0.2, 400)(sr)[0], 1), 0.9)],
  overtime_bell: tone([392, 392 * 1.5, 392], 2.4, 'sine', 0.005, 0.9), valuable_chime: tone([1318, 1975, 2637], 1.2, 'sine', 0.002, 0.35), ping: tone([1400, 1900], 0.3, 'sine', 0.002, 0.1),
  cough: vocal(44, 160, 120, 0.35, [600, 1200, 2400], 0.8, 0.7), stinger: (sr) => { const x = vocal(45, 60, 50, 1.6, [300, 800, 2500], 0.5, 0.8)(sr)[0]; mix(x, sweep(3000, 200, 1.6, 0.4, 7000)(sr)[0], 0.5); return [normalize(x, 0.85)]; },
  distant_scream: (sr) => { const x = vocal(46, 520, 380, 2.0, [900, 1800, 3200], 0.5, 0.8)(sr)[0]; lowpass(x, sr, 1800); return [normalize(x, 0.6)]; },
  distant_bang: (sr) => { const x = slam(47, true)(sr)[0]; lowpass(x, sr, 900); return [normalize(x, 0.7)]; }, distant_crash: (sr) => { const x = shatter(48)(sr)[0]; lowpass(x, sr, 2000); return [normalize(x, 0.6)]; },
  metal_groan: creak(49, 45, 3.0, true), crusher: (sr) => [normalize(mix(slam(50, true)(sr)[0], sweep(80, 40, 0.8, 0.5, 600)(sr)[0], 0.7), 0.95)],
  steam: (sr) => { const x = noise(sr, 1.6, 51); highpass(x, sr, 1200); for (let i = 0; i < x.length; i++) x[i] *= Math.min(1, i / sr * 20) * Math.min(1, (1.6 - i / sr) * 3); return [normalize(x, 0.6)]; },
  sparks: clicks(52, 0.8, 40, 3500), gas: (sr) => { const x = noise(sr, 3, 53); bandpass(x, sr, 900, 0.5); return [normalize(x, 0.3)]; }, cursed: (sr) => { const x = vocal(54, 40, 32, 3.5, [200, 500, 1400], 0.3, 0.8)(sr)[0]; return [x]; },
  // creatures
  stalker_scream: vocal(61, 420, 280, 1.3, [700, 1500, 2900], 0.6), stalker_groan: vocal(62, 85, 70, 1.8, [380, 900, 2100], 0.4, 0.7), stalker_hurt: vocal(63, 300, 200, 0.5, [600, 1300], 0.6), stalker_death: vocal(64, 200, 60, 2, [500, 1100], 0.6),
  mimic_shriek: (sr) => { const x = vocal(65, 900, 1400, 1.6, [1500, 3000, 4800], 0.9, 0.95)(sr)[0]; return [x]; }, mimic_hurt: vocal(66, 600, 400, 0.4, [1200, 2400], 0.8), mimic_death: vocal(67, 500, 120, 1.2, [900, 2000], 0.8),
  brute_roar: vocal(68, 70, 55, 2.0, [250, 600, 1400], 0.9), brute_grunt: vocal(69, 60, 55, 0.6, [200, 500], 0.6, 0.7), brute_slam: (sr) => { const x = slam(70, false)(sr)[0]; mix(x, brown(sr, 0.9, 71), 1.2); lowpass(x, sr, 700); return [normalize(x, 0.95)]; }, brute_hurt: vocal(72, 90, 70, 0.7, [300, 700], 0.8),
  lurker_drop: (sr) => [normalize(mix(clicks(73, 0.5, 60, 2800)(sr)[0], noise(sr, 0.5, 74), 0.4), 0.8)], lurker_chitter: clicks(75, 0.6, 50, 3200), lurker_hiss: (sr) => { const x = noise(sr, 0.9, 76); bandpass(x, sr, 5500, 1); for (let i = 0; i < x.length; i++) x[i] *= Math.min(1, i / sr * 10) * Math.exp(-i / sr / 0.5); return [normalize(x, 0.7)]; }, lurker_death: clicks(77, 1.2, 80, 2200), lurker_hurt: clicks(78, 0.3, 90, 3000),
  watcher_shriek: (sr) => { const x = buf(sr, 2.2); for (let k = 0; k < 5; k++) { const f = 1200 + k * 317; for (let i = 0; i < x.length; i++) x[i] += Math.sin(TAU * f * (1 + Math.sin(i / sr * 7 + k) * 0.01) * i / sr) * 0.2 * Math.min(1, i / sr * 4) * Math.min(1, (2.2 - i / sr) * 2); } return [normalize(x, 0.8)]; },
  watcher_phase: sweep(2000, 200, 1.4, 0.6, 5000), watcher_hurt: tone([900, 700], 0.4, 'saw', 0.002, 0.1),
  swarm_chitter: clicks(79, 1.0, 90, 4200), swarm_bite: clicks(80, 0.12, 120, 2500), swarm_scatter: clicks(81, 0.7, 140, 3800), swarm_death: (sr) => [normalize(mix(impact('wood', 82)(sr)[0], clicks(83, 0.2, 100, 3000)(sr)[0], 0.6), 0.8)], swarm_hurt: clicks(84, 0.1, 100, 3500),
  hunter_howl: vocal(85, 300, 520, 2.2, [700, 1600, 2800], 0.5), hunter_sniff: (sr) => { const x = buf(sr, 1.1); for (let k = 0; k < 4; k++) { const n = noise(sr, 0.12, 86 + k); bandpass(n, sr, 1500, 1); for (let i = 0; i < n.length; i++) n[i] *= Math.sin(Math.PI * i / n.length); mix(x, n, 1, Math.floor(k * 0.25 * sr)); } return [normalize(x, 0.7)]; }, hunter_hurt: vocal(87, 400, 300, 0.4, [800, 1800], 0.7),
  unknown_drone: (sr) => { const x = buf(sr, 4); for (let i = 0; i < x.length; i++) { const t = i / sr; x[i] = (Math.sin(TAU * 27.5 * t) + Math.sin(TAU * 41.2 * t + Math.sin(t)) * 0.6 + Math.sin(TAU * 55 * t * (1 + 0.003 * Math.sin(t * 3))) * 0.4) * Math.min(1, t) * Math.min(1, (4 - t)); } return [normalize(x, 0.8)]; },
  unknown_take: (sr) => { const x = sweep(1800, 40, 2.0, 0.4, 6000)(sr)[0]; mix(x, vocal(88, 50, 30, 2, [200, 600], 0.4, 0.8)(sr)[0], 0.8); return [normalize(x, 0.95)]; },
  // player / ui
  hurt: (sr) => { const x = slam(90, false)(sr)[0]; lowpass(x, sr, 600); return [normalize(x, 0.7)]; }, heartbeat: (sr) => { const x = buf(sr, 0.9); mix(x, modal(sr, 0.2, 48, [1, 1.5], [0.05, 0.03], [1, 0.3], 91, 0), 1); mix(x, modal(sr, 0.2, 44, [1, 1.5], [0.05, 0.03], [1, 0.3], 92, 0), 0.7, Math.floor(0.22 * sr)); return [normalize(x, 0.8)]; },
  jump: (sr) => { const x = noise(sr, 0.15, 93); bandpass(x, sr, 500, 0.8); for (let i = 0; i < x.length; i++) x[i] *= Math.exp(-i / sr / 0.05); return [normalize(x, 0.3)]; }, torch_click: tone([2600], 0.03, 'square', 0.0005, 0.006),
  ui_hover: tone([1600], 0.04, 'sine', 0.001, 0.015), ui_click: tone([900], 0.06, 'square', 0.001, 0.02), ui_confirm: tone([660, 990], 0.2, 'sine', 0.002, 0.06), ui_error: tone([180, 160], 0.25, 'square', 0.002, 0.08),
  ui_buy: tone([1046, 1318, 1568], 0.45, 'sine', 0.002, 0.15), ui_levelup: tone([523, 659, 784, 1046], 1.0, 'sine', 0.004, 0.3), radio_on: (sr) => { const x = noise(sr, 0.12, 94); bandpass(x, sr, 2400, 1.5); return [normalize(x, 0.4)]; },
  amb_research: ambience('research'), amb_industrial: ambience('industrial'), amb_underground: ambience('underground'), amb_luxury: ambience('luxury'),
  mus_tension: music('tension'), mus_chase: music('chase'),
};
