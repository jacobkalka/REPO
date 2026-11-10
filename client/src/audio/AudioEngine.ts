// Web Audio engine: buses, spatial voices (HRTF), occlusion, reverb, ambience, music director.
import * as THREE from 'three';
import type { Settings } from '../core/Settings';
import { SOUNDS, type Gen } from './Synth';

export type Bus = 'sfx' | 'ambience' | 'music' | 'voice' | 'ui';

export interface PlayOpts { pos?: THREE.Vector3; volume?: number; rate?: number; bus?: Bus; loop?: boolean; ref?: number; maxDist?: number; occlude?: boolean; caption?: string }

interface Voice { src: AudioBufferSourceNode; gain: GainNode; panner: PannerNode | null; filter: BiquadFilterNode | null; pos: THREE.Vector3 | null; occlude: boolean; started: number; vol: number }

const CAPTIONS: Record<string, string> = {
  stalker_scream: 'Shrieking', stalker_groan: 'Low groaning', mimic_shriek: 'Piercing shriek', brute_roar: 'Deep roar', brute_slam: 'Ground slam',
  lurker_drop: 'Something drops', lurker_chitter: 'Chittering', watcher_shriek: 'High-pitched wail', swarm_chitter: 'Skittering swarm', hunter_howl: 'Howl',
  hunter_sniff: 'Sniffing', unknown_drone: 'Low drone', door_smash: 'Door smashed', alarm: 'Alarm', lift_alarm: 'Lift alarm', crusher: 'Press slams',
  distant_scream: 'Distant scream', distant_bang: 'Distant bang', metal_groan: 'Metal groaning', valuable_chime: 'Chime', decoy_beep: 'Decoy beeping',
};

export class AudioEngine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private buses = {} as Record<Bus, GainNode>;
  private reverb!: ConvolverNode;
  private reverbSend!: GainNode;
  private cache = new Map<string, AudioBuffer[]>();
  private voices: Voice[] = [];
  private listenerPos = new THREE.Vector3();
  occlusionTest: ((from: THREE.Vector3, to: THREE.Vector3) => boolean) | null = null;
  onCaption: ((text: string, dir: string) => void) | null = null;
  private occlusionTick = 0;
  private amb: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private music: Record<string, { src: AudioBufferSourceNode; gain: GainNode }> = {};
  threat = 0;
  private listenerYaw = 0;

  constructor(readonly settings: Settings) {
    settings.onChange(() => this.applyVolumes());
  }

  /** must be called from a user gesture */
  unlock() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctx({ latencyHint: 'interactive' });
      const ctx = this.ctx;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.2;
      this.master = ctx.createGain();
      this.master.connect(comp).connect(ctx.destination);
      for (const b of ['sfx', 'ambience', 'music', 'voice', 'ui'] as Bus[]) { const g = ctx.createGain(); g.connect(this.master); this.buses[b] = g; }
      this.reverb = ctx.createConvolver();
      this.reverbSend = ctx.createGain();
      this.reverbSend.gain.value = 0.28;
      this.reverbSend.connect(this.reverb).connect(this.buses.sfx);
      this.setReverb(2.2, 0.5);
      this.applyVolumes();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  get ready() { return !!this.ctx && this.ctx.state === 'running'; }

  applyVolumes() {
    if (!this.ctx) return;
    const s = this.settings.data;
    this.master.gain.value = s.masterVolume;
    this.buses.sfx.gain.value = s.sfxVolume;
    this.buses.ambience.gain.value = s.ambienceVolume;
    this.buses.music.gain.value = s.musicVolume;
    this.buses.voice.gain.value = s.voiceVolume;
    this.buses.ui.gain.value = s.sfxVolume;
  }

  busNode(b: Bus) { return this.buses[b]; }

  /** generated impulse response: decaying stereo noise */
  setReverb(seconds: number, damp: number) {
    if (!this.ctx) return;
    const sr = this.ctx.sampleRate;
    const n = Math.floor(sr * seconds);
    const ir = this.ctx.createBuffer(2, n, sr);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        const r = Math.random() * 2 - 1;
        lp = lp + (r - lp) * (1 - damp * Math.min(1, t / seconds + 0.2));
        d[i] = lp * Math.pow(1 - t / seconds, 3) * (i < sr * 0.004 ? i / (sr * 0.004) : 1);
      }
    }
    this.reverb.buffer = ir;
  }

  private buffers(id: string): AudioBuffer[] | null {
    if (!this.ctx) return null;
    let b = this.cache.get(id);
    if (b) return b;
    const g = SOUNDS[id];
    if (!g) return null;
    const gens: Gen[] = Array.isArray(g) ? g : [g];
    const sr = this.ctx.sampleRate;
    b = gens.map((gen) => {
      const chans = gen(sr);
      const ab = this.ctx!.createBuffer(chans.length, chans[0].length, sr);
      chans.forEach((c, i) => ab.copyToChannel(c as Float32Array<ArrayBuffer>, i));
      return ab;
    });
    this.cache.set(id, b);
    return b;
  }

  /** synthesize common sounds ahead of time (spread over frames) */
  async prewarm(ids: string[]) {
    for (const id of ids) { this.buffers(id); await new Promise((r) => setTimeout(r, 0)); }
  }

  setListener(cam: THREE.Camera) {
    if (!this.ctx) return;
    const l = this.ctx.listener;
    const p = cam.position;
    this.listenerPos.copy(p);
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const u = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    this.listenerYaw = Math.atan2(-f.x, -f.z);
    const t = this.ctx.currentTime;
    if (l.positionX) {
      l.positionX.setTargetAtTime(p.x, t, 0.02); l.positionY.setTargetAtTime(p.y, t, 0.02); l.positionZ.setTargetAtTime(p.z, t, 0.02);
      l.forwardX.setTargetAtTime(f.x, t, 0.02); l.forwardY.setTargetAtTime(f.y, t, 0.02); l.forwardZ.setTargetAtTime(f.z, t, 0.02);
      l.upX.setTargetAtTime(u.x, t, 0.02); l.upY.setTargetAtTime(u.y, t, 0.02); l.upZ.setTargetAtTime(u.z, t, 0.02);
    } else { l.setPosition(p.x, p.y, p.z); l.setOrientation(f.x, f.y, f.z, u.x, u.y, u.z); }
  }

  play(id: string, o: PlayOpts = {}): Voice | null {
    if (!this.ctx || this.ctx.state !== 'running') return null;
    const bufs = this.buffers(id);
    if (!bufs?.length) return null;
    const ctx = this.ctx;
    if (o.pos && !o.loop) {
      const d = o.pos.distanceTo(this.listenerPos);
      if (d > (o.maxDist ?? 45)) return null;
    }
    // voice limit: drop the oldest quiet one
    if (this.voices.length > 48) { const v = this.voices.shift(); try { v?.src.stop(); } catch { /* ignore */ } }
    const src = ctx.createBufferSource();
    src.buffer = bufs[Math.floor(Math.random() * bufs.length)];
    src.playbackRate.value = (o.rate ?? 1) * (0.96 + Math.random() * 0.08);
    src.loop = !!o.loop;
    const gain = ctx.createGain();
    gain.gain.value = o.volume ?? 1;
    let panner: PannerNode | null = null;
    let filter: BiquadFilterNode | null = null;
    let node: AudioNode = src;
    if (o.pos) {
      filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 20000;
      panner = ctx.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'inverse';
      panner.refDistance = o.ref ?? 1.6;
      panner.maxDistance = o.maxDist ?? 45;
      panner.rolloffFactor = 1.1;
      panner.positionX.value = o.pos.x; panner.positionY.value = o.pos.y; panner.positionZ.value = o.pos.z;
      node.connect(filter); filter.connect(panner); node = panner;
      if (o.occlude !== false && this.occlusionTest && this.occlusionTest(this.listenerPos, o.pos)) filter.frequency.value = 900;
    }
    node.connect(gain);
    gain.connect(this.buses[o.bus ?? 'sfx']);
    if (o.pos && (o.bus ?? 'sfx') === 'sfx') { const send = ctx.createGain(); send.gain.value = 0.6; gain.connect(send).connect(this.reverbSend); }
    src.start();
    const v: Voice = { src, gain, panner, filter, pos: o.pos?.clone() ?? null, occlude: o.occlude !== false, started: ctx.currentTime, vol: o.volume ?? 1 };
    this.voices.push(v);
    src.onended = () => { const i = this.voices.indexOf(v); if (i >= 0) this.voices.splice(i, 1); try { gain.disconnect(); } catch { /* ignore */ } };
    const cap = o.caption ?? CAPTIONS[id];
    if (cap && o.pos && this.settings.data.subtitles) this.onCaption?.(cap, this.direction(o.pos));
    return v;
  }

  direction(p: THREE.Vector3): string {
    const a = Math.atan2(-(p.x - this.listenerPos.x), -(p.z - this.listenerPos.z)) - this.listenerYaw;
    const d = Math.atan2(Math.sin(a), Math.cos(a));
    if (Math.abs(d) < 0.5) return 'ahead';
    if (Math.abs(d) > 2.6) return 'behind';
    return d > 0 ? 'left' : 'right';
  }

  stopVoice(v: Voice | null, fade = 0.15) {
    if (!v || !this.ctx) return;
    v.gain.gain.setTargetAtTime(0, this.ctx.currentTime, fade / 3);
    try { v.src.stop(this.ctx.currentTime + fade); } catch { /* ignore */ }
  }

  moveVoice(v: Voice | null, p: THREE.Vector3) { if (v?.panner) { v.pos?.copy(p); v.panner.positionX.value = p.x; v.panner.positionY.value = p.y; v.panner.positionZ.value = p.z; } }

  /** per-frame: occlusion updates, ambience, music director */
  update(dt: number) {
    if (!this.ctx) return;
    this.occlusionTick -= dt;
    if (this.occlusionTick <= 0 && this.occlusionTest) {
      this.occlusionTick = 0.15;
      for (const v of this.voices) {
        if (!v.pos || !v.filter || !v.occlude) continue;
        const occ = this.occlusionTest(this.listenerPos, v.pos);
        v.filter.frequency.setTargetAtTime(occ ? 900 : 20000, this.ctx.currentTime, 0.08);
      }
    }
    // music layers follow the threat level
    const t = this.ctx.currentTime;
    const ten = this.music.mus_tension, ch = this.music.mus_chase;
    if (ten) ten.gain.gain.setTargetAtTime(this.threat > 0.15 ? 0.25 + this.threat * 0.5 : 0.08, t, 1.5);
    if (ch) ch.gain.gain.setTargetAtTime(this.threat > 0.65 ? (this.threat - 0.5) * 1.6 : 0, t, 0.8);
  }

  startAmbience(map: string) {
    if (!this.ctx) return;
    this.stopAmbience();
    const id = 'amb_' + (map === 'practice' ? 'industrial' : map);
    const b = this.buffers(id);
    if (!b) return;
    const src = this.ctx.createBufferSource();
    src.buffer = b[0]; src.loop = true;
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    gain.gain.setTargetAtTime(0.85, this.ctx.currentTime, 2);
    src.connect(gain).connect(this.buses.ambience);
    src.start();
    this.amb = { src, gain };
    for (const m of ['mus_tension', 'mus_chase']) {
      const mb = this.buffers(m);
      if (!mb) continue;
      const s = this.ctx.createBufferSource();
      s.buffer = mb[0]; s.loop = true;
      const g = this.ctx.createGain();
      g.gain.value = 0;
      s.connect(g).connect(this.buses.music);
      s.start();
      this.music[m] = { src: s, gain: g };
    }
    const rev: Record<string, [number, number]> = { research: [1.8, 0.45], industrial: [3.2, 0.35], underground: [3.6, 0.3], luxury: [2.4, 0.55], practice: [2.8, 0.4] };
    const [sec, damp] = rev[map] ?? [2.2, 0.5];
    this.setReverb(sec, damp);
  }

  stopAmbience() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    if (this.amb) { this.amb.gain.gain.setTargetAtTime(0, t, 0.5); try { this.amb.src.stop(t + 2); } catch { /* ignore */ } this.amb = null; }
    for (const k of Object.keys(this.music)) { const m = this.music[k]; m.gain.gain.setTargetAtTime(0, t, 0.5); try { m.src.stop(t + 2); } catch { /* ignore */ } }
    this.music = {};
  }

  ui(id: string) { this.play(id, { bus: 'ui', volume: 0.5 }); }
}
