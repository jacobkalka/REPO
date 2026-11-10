// Proximity voice chat: WebRTC audio mesh signalled over the game socket, spatialised with
// HRTF panners at each speaker's head. Falls back to an ADPCM relay through the server when
// a peer connection cannot be established (strict NATs without TURN).
import * as THREE from 'three';
import { BIN } from '../../../shared/protocol';
import type { AudioEngine } from '../audio/AudioEngine';
import type { Settings } from '../core/Settings';
import type { Connection } from './Connection';

interface Peer {
  id: string;
  netId: number;
  pc: RTCPeerConnection | null;
  el: HTMLAudioElement | null;
  src: AudioNode | null;
  gain: GainNode;
  panner: PannerNode;
  filter: BiquadFilterNode;
  radio: BiquadFilterNode;
  muted: boolean;
  volume: number;
  relay: boolean;
  level: number;
  analyser: AnalyserNode;
  makingOffer: boolean;
  failTimer: number;
  // relay playback
  nextTime: number;
  adpcm: { pred: number; idx: number };
}

// ---------------------------------------------------------------- IMA ADPCM
const IDX = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];
const STEP = [7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767];
function adpcmEncode(pcm: Int16Array, st: { pred: number; idx: number }): Uint8Array {
  const out = new Uint8Array(4 + Math.ceil(pcm.length / 2));
  const dv = new DataView(out.buffer);
  dv.setInt16(0, st.pred, true); out[2] = st.idx;
  for (let i = 0; i < pcm.length; i++) {
    const step = STEP[st.idx];
    let diff = pcm[i] - st.pred;
    let code = 0;
    if (diff < 0) { code = 8; diff = -diff; }
    let vpdiff = step >> 3;
    if (diff >= step) { code |= 4; diff -= step; vpdiff += step; }
    if (diff >= step >> 1) { code |= 2; diff -= step >> 1; vpdiff += step >> 1; }
    if (diff >= step >> 2) { code |= 1; vpdiff += step >> 2; }
    st.pred = Math.max(-32768, Math.min(32767, st.pred + (code & 8 ? -vpdiff : vpdiff)));
    st.idx = Math.max(0, Math.min(88, st.idx + IDX[code]));
    if (i % 2 === 0) out[4 + (i >> 1)] = code; else out[4 + (i >> 1)] |= code << 4;
  }
  return out;
}
function adpcmDecode(data: Uint8Array, n: number): Float32Array {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let pred = dv.getInt16(0, true), idx = data[2];
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const b = data[4 + (i >> 1)];
    const code = i % 2 === 0 ? b & 15 : b >> 4;
    const step = STEP[idx];
    let vpdiff = step >> 3;
    if (code & 4) vpdiff += step;
    if (code & 2) vpdiff += step >> 1;
    if (code & 1) vpdiff += step >> 2;
    pred = Math.max(-32768, Math.min(32767, pred + (code & 8 ? -vpdiff : vpdiff)));
    idx = Math.max(0, Math.min(88, idx + IDX[code]));
    out[i] = pred / 32768;
  }
  return out;
}

const RELAY_RATE = 16000;
const FRAME = 320; // 20 ms

export class VoiceChat {
  private peers = new Map<string, Peer>();
  private local: MediaStream | null = null;
  private micNode: MediaStreamAudioSourceNode | null = null;
  private micGain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private outStream: MediaStreamAudioDestinationNode | null = null;
  private relayBuf: number[] = [];
  private relayState = { pred: 0, idx: 0 };
  private relaySeq = 0;
  private levelArr = new Uint8Array(256);
  level = 0;
  transmitting = false;
  ice: RTCIceServer[] = [];
  micError = '';
  active = false;
  myId = '';
  private occlTick = 0;
  occlusion: ((a: THREE.Vector3, b: THREE.Vector3) => boolean) | null = null;
  ptt = false;
  radioHeld = false;

  constructor(readonly conn: Connection, readonly audio: AudioEngine, readonly settings: Settings) {
    conn.on('rtc', (m) => void this.onSignal(m.from, m.data as SignalData));
    conn.on('voiceData', (buf) => this.onRelay(buf));
  }

  get ctx() { return this.audio.ctx; }

  async startMic(): Promise<boolean> {
    if (this.local || this.settings.data.voiceMode === 'off') return !!this.local;
    const ctx = this.ctx;
    if (!ctx) return false;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone access needs a secure (https) connection.');
      this.local = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: this.settings.data.micDevice || undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      this.micNode = ctx.createMediaStreamSource(this.local);
      this.micGain = ctx.createGain();
      this.micGain.gain.value = 0;
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 512;
      this.micNode.connect(this.analyser);
      this.outStream = ctx.createMediaStreamDestination();
      this.micNode.connect(this.micGain).connect(this.outStream);
      try {
        await ctx.audioWorklet.addModule(new URL('./voice-worklet.js', import.meta.url));
        this.worklet = new AudioWorkletNode(ctx, 'salvage-capture');
        this.micGain.connect(this.worklet);
        this.worklet.port.onmessage = (e) => this.onCapture(e.data as Float32Array);
      } catch (e) { console.warn('voice worklet unavailable; relay fallback disabled', e); }
      this.micError = '';
      for (const p of this.peers.values()) this.attachLocal(p);
      return true;
    } catch (e) {
      this.micError = (e as Error).message || 'Microphone unavailable';
      return false;
    }
  }

  stopMic() {
    this.local?.getTracks().forEach((t) => t.stop());
    this.local = null;
    this.micNode?.disconnect(); this.micGain?.disconnect(); this.worklet?.disconnect();
    this.micNode = null; this.micGain = null; this.worklet = null;
  }

  /** members of the room changed */
  setMembers(members: { id: string; netId: number; connected: boolean }[]) {
    this.active = true;
    const want = new Set(members.filter((m) => m.id !== this.myId && m.connected).map((m) => m.id));
    for (const id of [...this.peers.keys()]) if (!want.has(id)) this.closePeer(id);
    for (const m of members) if (want.has(m.id) && !this.peers.has(m.id)) this.openPeer(m.id, m.netId);
    for (const m of members) { const p = this.peers.get(m.id); if (p) p.netId = m.netId; }
  }

  private openPeer(id: string, netId: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 20000;
    const radio = ctx.createBiquadFilter(); radio.type = 'allpass';
    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF'; panner.distanceModel = 'inverse'; panner.refDistance = 2.2; panner.maxDistance = 40; panner.rolloffFactor = 1.25;
    const analyser = ctx.createAnalyser(); analyser.fftSize = 256;
    filter.connect(radio).connect(panner).connect(gain).connect(this.audio.busNode('voice'));
    const p: Peer = { id, netId, pc: null, el: null, src: null, gain, panner, filter, radio, muted: false, volume: 1, relay: false, level: 0, analyser, makingOffer: false, failTimer: 0, nextTime: 0, adpcm: { pred: 0, idx: 0 } };
    this.peers.set(id, p);
    this.createPc(p);
  }

  private createPc(p: Peer) {
    if (typeof RTCPeerConnection === 'undefined') { p.relay = true; return; }
    const pc = new RTCPeerConnection({ iceServers: this.ice });
    p.pc = pc;
    pc.onicecandidate = (e) => { if (e.candidate) this.conn.send({ t: 'rtc', to: p.id, data: { ice: e.candidate.toJSON() } }); };
    pc.ontrack = (e) => {
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      // Chrome only feeds remote WebRTC audio into Web Audio if an element is playing it
      const el = new Audio();
      el.srcObject = stream; el.muted = true; void el.play().catch(() => {});
      p.el = el;
      const src = this.ctx!.createMediaStreamSource(stream);
      src.connect(p.filter);
      src.connect(p.analyser);
      p.src = src;
    };
    pc.onnegotiationneeded = async () => {
      try { p.makingOffer = true; await pc.setLocalDescription(); this.conn.send({ t: 'rtc', to: p.id, data: { sdp: pc.localDescription } }); }
      catch (e) { console.warn('rtc offer failed', e); } finally { p.makingOffer = false; }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') { p.relay = true; console.info('voice: falling back to server relay for', p.id); }
      if (pc.connectionState === 'connected') { p.relay = false; clearTimeout(p.failTimer); }
    };
    p.failTimer = window.setTimeout(() => { if (pc.connectionState !== 'connected') p.relay = true; }, 9000);
    this.attachLocal(p);
    if (!this.local) pc.addTransceiver('audio', { direction: 'recvonly' });
  }

  private attachLocal(p: Peer) {
    if (!p.pc || !this.outStream) return;
    const track = this.outStream.stream.getAudioTracks()[0];
    if (!track) return;
    const sender = p.pc.getSenders().find((s) => s.track?.kind === 'audio');
    if (sender) void sender.replaceTrack(track);
    else p.pc.addTrack(track, this.outStream.stream);
  }

  private async onSignal(from: string, data: SignalData) {
    const p = this.peers.get(from);
    if (!p?.pc) return;
    const pc = p.pc;
    const polite = this.myId > from; // perfect negotiation
    try {
      if (data.sdp) {
        const collision = data.sdp.type === 'offer' && (p.makingOffer || pc.signalingState !== 'stable');
        if (collision && !polite) return;
        await pc.setRemoteDescription(data.sdp);
        if (data.sdp.type === 'offer') { await pc.setLocalDescription(); this.conn.send({ t: 'rtc', to: from, data: { sdp: pc.localDescription } }); }
      } else if (data.ice) { try { await pc.addIceCandidate(data.ice); } catch { /* ignore late candidates */ } }
    } catch (e) { console.warn('rtc signal error', e); }
  }

  private closePeer(id: string) {
    const p = this.peers.get(id);
    if (!p) return;
    clearTimeout(p.failTimer);
    p.pc?.close();
    if (p.el) { p.el.srcObject = null; }
    p.src?.disconnect();
    p.gain.disconnect();
    this.peers.delete(id);
  }

  // ------------------------------------------------------------ relay fallback
  private onCapture(frame: Float32Array) {
    if (!this.ctx || ![...this.peers.values()].some((p) => p.relay) || !this.transmitting) { this.relayBuf.length = 0; return; }
    const ratio = this.ctx.sampleRate / RELAY_RATE;
    for (let i = 0; i < frame.length; i += ratio) this.relayBuf.push(frame[Math.floor(i)]);
    while (this.relayBuf.length >= FRAME) {
      const chunk = this.relayBuf.splice(0, FRAME);
      const pcm = new Int16Array(FRAME);
      for (let i = 0; i < FRAME; i++) pcm[i] = Math.max(-32768, Math.min(32767, chunk[i] * 32767));
      const enc = adpcmEncode(pcm, this.relayState);
      const out = new Uint8Array(4 + enc.length);
      out[0] = BIN.VOICE; out[1] = 0; out[2] = this.relaySeq & 255; out[3] = (this.relaySeq++ >> 8) & 255;
      out.set(enc, 4);
      this.conn.sendBin(out);
    }
  }

  private onRelay(buf: ArrayBuffer) {
    const u8 = new Uint8Array(buf);
    const netId = u8[1];
    const p = [...this.peers.values()].find((x) => x.netId === netId);
    if (!p || !this.ctx || !p.relay) return;
    const pcm = adpcmDecode(u8.subarray(4), FRAME);
    const ab = this.ctx.createBuffer(1, FRAME, RELAY_RATE);
    ab.copyToChannel(pcm as Float32Array<ArrayBuffer>, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = ab;
    src.connect(p.filter);
    const now = this.ctx.currentTime;
    if (p.nextTime < now + 0.03 || p.nextTime > now + 0.4) p.nextTime = now + 0.08; // jitter buffer
    src.start(p.nextTime);
    p.nextTime += FRAME / RELAY_RATE;
    let e = 0; for (const v of pcm) e += v * v;
    p.level = Math.max(p.level * 0.8, Math.sqrt(e / FRAME) * 3);
  }

  // ------------------------------------------------------------ per frame
  update(dt: number, listener: THREE.Vector3, speakers: Map<string, { pos: THREE.Vector3; alive: boolean; radio: boolean }>, me: { alive: boolean; hasRadio: boolean }) {
    const s = this.settings.data;
    // local level and gate
    if (this.analyser && this.micGain && this.ctx) {
      this.analyser.getByteTimeDomainData(this.levelArr);
      let sum = 0;
      for (const v of this.levelArr) { const x = (v - 128) / 128; sum += x * x; }
      const rms = Math.sqrt(sum / this.levelArr.length) * s.micGain;
      this.level = this.level * 0.7 + rms * 0.3;
      const open = s.voiceMode === 'open' ? this.level > s.voiceThreshold * 0.35 : s.voiceMode === 'ptt' ? this.ptt || this.radioHeld : false;
      this.transmitting = open || (this.radioHeld && s.voiceMode !== 'off');
      this.micGain.gain.setTargetAtTime(this.transmitting ? s.micGain : 0, this.ctx.currentTime, 0.03);
    } else this.transmitting = false;
    this.occlTick -= dt;
    const doOccl = this.occlTick <= 0;
    if (doOccl) this.occlTick = 0.3;
    for (const p of this.peers.values()) {
      const sp = speakers.get(p.id);
      if (!this.ctx) continue;
      const t = this.ctx.currentTime;
      // routing rules: the dead hear everyone; the living can't hear the dead
      let vol = p.muted ? 0 : p.volume;
      let radio = false;
      if (sp) {
        if (!sp.alive && me.alive) vol = 0;
        if (sp.radio && me.hasRadio && me.alive && sp.alive) radio = true;
        const pos = radio || !me.alive ? listener : sp.pos;
        p.panner.positionX.setTargetAtTime(pos.x, t, 0.05); p.panner.positionY.setTargetAtTime(pos.y + (radio ? 0 : 1.5), t, 0.05); p.panner.positionZ.setTargetAtTime(pos.z, t, 0.05);
        if (doOccl && this.occlusion && !radio && me.alive) p.filter.frequency.setTargetAtTime(this.occlusion(listener, sp.pos.clone().setY(sp.pos.y + 1.5)) ? 1400 : 20000, t, 0.1);
      }
      p.radio.type = radio ? 'bandpass' : 'allpass';
      p.radio.frequency.value = 1800; p.radio.Q.value = radio ? 1.1 : 0.0001;
      p.gain.gain.setTargetAtTime(vol * (radio ? 1.6 : 1), t, 0.08);
      if (!p.relay) {
        const arr = new Uint8Array(p.analyser.fftSize);
        p.analyser.getByteTimeDomainData(arr);
        let sum = 0; for (const v of arr) { const x = (v - 128) / 128; sum += x * x; }
        p.level = Math.sqrt(sum / arr.length) * 3;
      } else p.level *= 0.9;
    }
  }

  levels(): Map<string, number> { const m = new Map<string, number>(); for (const p of this.peers.values()) m.set(p.id, p.level); return m; }
  peerList() { return [...this.peers.values()].map((p) => ({ id: p.id, muted: p.muted, volume: p.volume, relay: p.relay, connected: p.pc?.connectionState === 'connected' })); }
  setPeer(id: string, muted: boolean, volume: number) { const p = this.peers.get(id); if (p) { p.muted = muted; p.volume = volume; } }

  stop() { for (const id of [...this.peers.keys()]) this.closePeer(id); this.active = false; }
}

type SignalData = { sdp?: RTCSessionDescriptionInit; ice?: RTCIceCandidateInit };
