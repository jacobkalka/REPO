// Salvage Shift client entry point: application state machine and wiring.
import '@fontsource/barlow/400.css';
import '@fontsource/barlow/500.css';
import '@fontsource/barlow/600.css';
import '@fontsource/barlow-condensed/500.css';
import '@fontsource/barlow-condensed/600.css';
import '@fontsource/barlow-condensed/700.css';
import '@fontsource/barlow-condensed/800.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/600.css';
import './ui/styles.css';
import * as THREE from 'three';
import { COSMETIC_BY_ID, ITEM_BY_ID, type CosmeticSlot, type LoadoutSlot } from '../../shared/catalog/items';
import type { MissionInfo, MissionResults, RoomInfo } from '../../shared/protocol';
import type { Profile } from '../../shared/profile';
import { AudioEngine } from './audio/AudioEngine';
import { Engine } from './core/Engine';
import { Input } from './core/Input';
import { Settings } from './core/Settings';
import { DevTools } from './dev/DevTools';
import { MissionClient } from './game/MissionClient';
import { Connection, type ConnStatus } from './net/Connection';
import { VoiceChat } from './net/Voice';
import { h, modal, toast } from './ui/dom';
import { Hud } from './ui/Hud';
import { creditsScreen, equipmentScreen, lobbyScreen, loadingScreen, mainMenu, pauseScreen, playScreen, progressionScreen, resultsScreen, shopScreen, statsScreen, type AppApi } from './ui/Screens';
import { settingsScreen } from './ui/SettingsScreen';
import { MenuScene } from './world/MenuScene';

type View = 'menu' | 'play' | 'multiplayer' | 'lobby' | 'shop' | 'equipment' | 'progression' | 'stats' | 'settings' | 'credits' | 'loading' | 'mission' | 'results';

class App implements AppApi {
  readonly settings = new Settings();
  readonly canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
  readonly uiRoot = document.getElementById('ui-root') as HTMLElement;
  readonly engine: Engine;
  readonly input: Input;
  readonly audio: AudioEngine;
  readonly conn: Connection;
  readonly voice: VoiceChat;
  readonly menuScene: MenuScene;
  readonly dev: DevTools;
  profile: Profile | null = null;
  room: RoomInfo | null = null;
  status: ConnStatus = 'connecting';
  devMode = false;
  chatLog: { name: string; text: string; sys?: boolean }[] = [];
  mission: MissionClient | null = null;
  private hud: Hud | null = null;
  private view: View = 'menu';
  private screenEl: HTMLElement | null = null;
  private overlayEl: HTMLElement | null = null;
  private paused = false;
  private results: MissionResults | null = null;
  private pendingMission: MissionInfo | null = null;
  private pendingState: Parameters<MissionClient['applyFullState']>[0] | null = null;
  private pendingJoin = new URLSearchParams(location.search).get('room');
  private reqId = 1;
  private ice: RTCIceServer[] = [];
  private returnTo: View = 'menu';
  private crewVolumes = new Map<string, { muted: boolean; volume: number }>();

  constructor() {
    this.engine = new Engine(this.canvas, this.settings);
    this.input = new Input(this.canvas, this.settings);
    this.audio = new AudioEngine(this.settings);
    const wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
    this.conn = new Connection(new URLSearchParams(location.search).get('server') ?? wsUrl);
    this.voice = new VoiceChat(this.conn, this.audio, this.settings);
    this.menuScene = new MenuScene(this.engine);
    this.dev = new DevTools(this.engine, this.conn, () => this.mission, () => this.devMode);
    this.uiRoot.append(this.dev.el);
    this.applyUiScale();
    this.settings.onChange((_, ch) => { if (ch.includes('uiScale')) this.applyUiScale(); if (ch.includes('voiceMode')) void this.refreshMic(); if (this.mission && ch.includes('reduceFlicker')) this.mission.pool.reduceFlicker = this.settings.data.reduceFlicker; });
    this.audio.onCaption = (text, dir) => this.hud?.caption(text, dir);
    this.wireConnection();
    this.wireInput();
    this.engine.onUpdate((dt) => this.frame(dt));
    this.engine.start();
    // audio needs a user gesture
    const unlock = () => { this.audio.unlock(); };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    this.conn.connect(this.settings.data.name || '');
    this.show('menu');
    void this.menuScene.load().then(() => { if (!this.mission) this.menuScene.attach(); this.updateMenuCrew(); });
    (window as unknown as Record<string, unknown>).__game = this;
  }

  private applyUiScale() { document.documentElement.style.setProperty('--ui-scale', String(this.settings.data.uiScale)); }

  // ------------------------------------------------------------------------------- networking
  private wireConnection() {
    const c = this.conn;
    c.on('status', (s) => { this.status = s; if (['menu', 'play', 'multiplayer'].includes(this.view)) this.rerender(); if (s === 'reconnecting' && this.mission) this.mission.pushMsg('Connection lost — reconnecting…', 'warn'); });
    c.on('welcome', (m) => {
      this.profile = m.profile;
      this.devMode = m.dev;
      this.ice = m.ice as RTCIceServer[];
      this.voice.ice = this.ice;
      this.voice.myId = m.id;
      if (!this.settings.data.name) this.settings.set('name', m.profile.name);
      else if (this.settings.data.name !== m.profile.name) c.send({ t: 'setName', name: this.settings.data.name });
      if (this.pendingJoin) { const code = this.pendingJoin; this.pendingJoin = null; history.replaceState(null, '', location.pathname); this.join(code); }
      this.rerender();
    });
    c.on('profile', (m) => {
      const before = this.profile;
      this.profile = m.profile;
      if (m.reason?.startsWith('purchase:')) { const id = m.reason.slice(9); toast(`Purchased ${ITEM_BY_ID[id]?.name ?? COSMETIC_BY_ID[id]?.name ?? id}.`, 'good'); this.audio.ui('ui_buy'); }
      if (before && m.profile.level > before.level) { toast(`Level up! You are now level ${m.profile.level}.`, 'good', 5000); this.audio.ui('ui_levelup'); }
      this.mission?.setSuitColor(COSMETIC_BY_ID[m.profile.appearance.suit]?.color ?? '#c8642a');
      if (this.view !== 'mission' && this.view !== 'loading') this.rerender(true);
      this.updateMenuCrew();
    });
    c.on('room', (m) => {
      const prev = this.room;
      this.room = m.room;
      this.voice.setMembers(m.room.members.map((x) => ({ id: x.id, netId: x.netId, connected: x.connected })));
      if (!prev) { this.chatLog = []; void this.refreshMic(); }
      if (m.room.phase === 'lobby' && (this.view === 'results' || ['menu', 'play', 'multiplayer'].includes(this.view))) this.show('lobby');
      else if (this.view === 'lobby') this.rerender();
      this.updateMenuCrew();
    });
    c.on('left', (m) => {
      this.room = null;
      this.voice.stop();
      if (this.mission) this.endMission();
      if (m.reason === 'kicked') toast('You were removed from the crew.', 'error');
      else if (m.reason && m.reason !== 'left') toast(m.reason, 'info');
      this.show('menu');
      this.updateMenuCrew();
    });
    c.on('err', (m) => {
      if (m.code === 'server_restart') { toast(m.msg, 'info', 6000); return; }
      toast(m.msg, 'error');
      this.audio.ui('ui_error');
    });
    c.on('chat', (m) => {
      this.chatLog.push({ name: m.name, text: m.text, sys: m.sys });
      if (this.chatLog.length > 200) this.chatLog.shift();
      if (this.view === 'lobby') this.rerender();
      if (this.mission && !m.sys) this.mission.pushMsg(`${m.name}: ${m.text}`, 'info');
    });
    c.on('mission', (m) => { void this.beginMission(m.info); });
    c.on('mstate', (m) => { if (this.mission?.ready) this.mission.applyFullState(m.state); else this.pendingState = m.state; });
    c.on('ev', (m) => this.mission?.onEvents(m.e));
    c.on('snapshot', (s) => this.mission?.onSnapshot(s));
    c.on('correct', (m) => this.mission?.onCorrect(m.p, m.epoch));
    c.on('grabRes', (m) => this.mission?.onGrabResult(m));
    c.on('results', (m) => {
      this.results = m.results;
      if (this.mission) this.endMission();
      this.show('results');
    });
  }

  private async refreshMic() {
    if (!this.room || this.room.mode === 'solo') return;
    if (this.settings.data.voiceMode === 'off') { this.voice.stopMic(); return; }
    this.audio.unlock();
    const ok = await this.voice.startMic();
    if (!ok && this.voice.micError) toast(`Voice chat unavailable: ${this.voice.micError} Text chat still works.`, 'info', 6000);
  }

  // ------------------------------------------------------------------------------- input
  private wireInput() {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'F1' && new URLSearchParams(location.search).has('dev')) { e.preventDefault(); this.dev.toggle(); return; }
      if (this.view !== 'mission' || !this.mission) return;
      const m = this.mission;
      const binds = this.settings.data.binds;
      if (m.docOpen && (binds.interact.includes(e.code) || e.code === 'Escape')) { m.docOpen = null; e.preventDefault(); return; }
      if (binds.pause.includes(e.code) || e.code === 'Escape') { e.preventDefault(); if (this.paused) this.resume(); else this.pause(); return; }
      if (binds.map.includes(e.code) && this.hud) { this.hud.showMap = !this.hud.showMap; return; }
      if (binds.chat.includes(e.code) && !this.paused) { e.preventDefault(); this.openChat(); }
    });
    document.addEventListener('pointerlockchange', () => {
      if (this.view === 'mission' && !document.pointerLockElement && !this.paused && !this.chatOpen && !this.mission?.docOpen) this.pause();
    });
    this.canvas.addEventListener('click', () => { if (this.view === 'mission' && !this.paused) this.input.lock(); });
  }

  private chatOpen = false;
  private openChat() {
    if (this.chatOpen) return;
    this.chatOpen = true;
    this.input.unlock();
    this.input.enabled = false;
    const inp = h('input', { type: 'text', maxLength: 200, placeholder: 'Say something to the crew (Enter to send, Esc to cancel)', style: { position: 'absolute', left: '28px', bottom: '160px', width: '420px', zIndex: '30' } }) as HTMLInputElement;
    const close = () => { inp.remove(); this.chatOpen = false; this.input.enabled = true; this.input.lock(); };
    inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { if (inp.value.trim()) this.chat(inp.value); close(); } if (e.key === 'Escape') close(); });
    this.uiRoot.append(inp);
    setTimeout(() => inp.focus(), 0);
  }

  // ------------------------------------------------------------------------------- screens
  private show(v: View) {
    if (v !== 'settings') this.returnTo = this.room && v !== 'menu' ? 'lobby' : 'menu';
    this.view = v;
    this.render();
  }

  private rerender(soft = false) {
    if (this.view === 'mission' || this.view === 'loading') return;
    if (soft && (this.view === 'equipment' || this.view === 'shop') && this.screenEl) {
      const r = (this.screenEl as unknown as { refresh?: () => void }).refresh;
      if (r) { r(); return; }
    }
    this.render();
  }

  private render() {
    this.screenEl?.remove();
    this.screenEl = null;
    const back = () => this.show(this.room ? 'lobby' : 'menu');
    let el: HTMLElement | null = null;
    switch (this.view) {
      case 'menu': el = mainMenu(this, (s) => this.nav(s)); break;
      case 'play': el = playScreen(this, back); break;
      case 'multiplayer': el = playScreen(this, back, 'multi'); break;
      case 'lobby': el = this.room ? lobbyScreen(this, this.room, (s) => this.nav(s)) : mainMenu(this, (s) => this.nav(s)); break;
      case 'shop': el = shopScreen(this, back); break;
      case 'equipment': el = equipmentScreen(this, back); break;
      case 'progression': el = progressionScreen(this, back); break;
      case 'stats': el = statsScreen(this, back); break;
      case 'credits': el = creditsScreen(this, back); break;
      case 'settings': el = this.settingsEl(() => this.show(this.returnTo)); break;
      case 'results': el = this.results ? resultsScreen(this, this.results, () => this.toLobby()) : null; break;
      default: el = null;
    }
    if (el) { this.screenEl = el; this.uiRoot.prepend(el); }
  }

  private settingsEl(back: () => void) {
    return settingsScreen({
      settings: this.settings, input: this.input, back, token: () => this.conn.token, playerId: () => this.profile?.id ?? '', ui: (s) => this.audio.ui(s),
      importToken: (t) => { this.conn.token = t; toast('Profile code saved. Reconnecting…', 'good'); setTimeout(() => location.reload(), 600); },
      micDevices: async () => (await navigator.mediaDevices?.enumerateDevices?.() ?? []).filter((d) => d.kind === 'audioinput'),
      testMic: async () => {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        this.audio.unlock();
        const ctx = this.audio.ctx!;
        const an = ctx.createAnalyser();
        ctx.createMediaStreamSource(s).connect(an);
        const arr = new Uint8Array(an.fftSize);
        let peak = 0;
        for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 50)); an.getByteTimeDomainData(arr); for (const v of arr) peak = Math.max(peak, Math.abs(v - 128) / 128); }
        s.getTracks().forEach((t) => t.stop());
        return peak;
      },
    });
  }

  private nav(s: string) {
    if (s === 'solo') return this.create('solo');
    if (s === 'practice') return this.create('practice');
    this.show(s as View);
  }

  // ------------------------------------------------------------------------------- mission
  private async beginMission(info: MissionInfo) {
    if (this.mission?.info.mid === info.mid) return; // reconnect: state follows in mstate
    if (this.mission) this.endMission();
    this.pendingMission = info;
    this.screenEl?.remove();
    this.screenEl = null;
    this.view = 'loading';
    const ld = loadingScreen();
    this.uiRoot.prepend(ld.el);
    this.menuScene.detach();
    const m = new MissionClient(this.engine, this.input, this.settings, this.conn, this.audio, info, () => this.profile);
    this.mission = m;
    try {
      await m.load((f, l) => ld.set(f, l));
    } catch (e) {
      console.error(e);
      toast('Failed to load the facility. Returning to the lobby.', 'error');
      ld.el.remove();
      this.endMission();
      this.show(this.room ? 'lobby' : 'menu');
      return;
    }
    if (this.mission !== m) { ld.el.remove(); return; }
    m.setSuitColor(COSMETIC_BY_ID[this.profile?.appearance.suit ?? '']?.color ?? '#c8642a');
    if (this.pendingState) { m.applyFullState(this.pendingState); this.pendingState = null; }
    m.voiceLevel = 0;
    this.voice.occlusion = (a, b) => { const d = b.clone().sub(a); const len = d.length(); if (len < 0.5) return false; const hit = m.world.raycast(a, d.normalize(), len - 0.3); return !!hit && hit.kind !== 'prop'; };
    ld.el.remove();
    this.view = 'mission';
    this.hud = new Hud(m, this.settings, () => ({ ping: this.conn.rtt * 1000, fps: this.engine.fps }));
    this.uiRoot.prepend(this.hud.el);
    this.input.enabled = true;
    this.paused = false;
    this.input.lock();
    if (!document.pointerLockElement) {
      // pointer lock needs a click when the mission starts without a gesture
      this.overlayEl = h('div', { class: 'center-overlay start-overlay', style: { background: 'rgba(0,0,0,.35)', cursor: 'pointer' }, onclick: () => { this.overlayEl?.remove(); this.overlayEl = null; this.input.lock(); this.audio.unlock(); } }, h('div', { class: 'h-display', style: { fontSize: '2.2em' } }, 'Click to start your shift'), h('div', { class: 'kicker' }, 'WASD move · Shift sprint · Ctrl crouch · E / hold LMB grab · F torch · Esc pause'));
      this.uiRoot.append(this.overlayEl);
    }
  }

  private endMission() {
    this.input.unlock();
    this.input.enabled = false;
    this.paused = false;
    this.hud?.el.remove();
    this.hud = null;
    this.overlayEl?.remove();
    this.overlayEl = null;
    this.screenEl?.remove();
    this.screenEl = null;
    this.mission?.dispose();
    this.mission = null;
    this.pendingMission = null;
    this.menuScene.attach();
    this.updateMenuCrew();
  }

  private pause() {
    if (!this.mission) return;
    this.paused = true;
    this.input.enabled = false;
    this.input.unlock();
    this.overlayEl?.remove();
    this.overlayEl = pauseScreen(this, { practice: this.mission.info.practice, host: this.isHost() });
    this.uiRoot.append(this.overlayEl);
  }

  resume() {
    this.overlayEl?.remove();
    this.overlayEl = null;
    this.paused = false;
    if (this.view === 'settings') this.view = 'mission';
    this.input.enabled = true;
    this.input.lock();
  }

  openSettings(back: () => void) {
    this.overlayEl?.remove();
    const el = this.settingsEl(() => { el.remove(); this.overlayEl = null; back(); });
    this.overlayEl = el;
    this.uiRoot.append(el);
  }

  abandon() { this.conn.send({ t: 'abandon' }); this.resume(); }
  leaveMission() { this.leave(); }

  // ------------------------------------------------------------------------------- per frame
  private frame(dt: number) {
    const m = this.mission;
    if (m?.ready && this.view === 'mission') {
      // voice: push-to-talk / radio
      const b = this.settings.data.binds;
      this.voice.ptt = this.input.held('pushToTalk');
      const hasRadio = this.mission?.loadoutFor('tool1') === 'radio' || this.mission?.loadoutFor('tool2') === 'radio';
      this.voice.radioHeld = hasRadio && this.input.held('radio');
      void b;
      m.talking = this.voice.transmitting;
      m.radioTx = this.voice.radioHeld;
      m.voiceLevel = this.voice.level;
      m.update(dt);
      const speakers = new Map<string, { pos: THREE.Vector3; alive: boolean; radio: boolean }>();
      const levels = this.voice.levels();
      for (const p of m.info.players) {
        if (p.netId === m.myNetId) continue;
        const r = m.remotes.players.get(p.netId);
        if (!r) continue;
        r.talking = levels.get(p.id) ?? 0;
        speakers.set(p.id, { pos: r.pos, alive: !(r.flags & (1 << 7)), radio: (r.flags & (1 << 10)) !== 0 });
      }
      this.voice.update(dt, this.engine.camera.position, speakers, { alive: m.life === 'alive' || m.life === 'downed', hasRadio });
      this.hud?.update(this.engine.camera);
    } else if (this.menuScene.ready && !m) {
      this.menuScene.update(dt);
      if (this.voice.active) this.voice.update(dt, this.engine.camera.position, new Map(), { alive: false, hasRadio: false });
    }
    this.dev.update();
    this.input.endFrame();
  }

  private updateMenuCrew() {
    if (!this.menuScene.ready) return;
    const crew = this.room ? this.room.members.map((m) => ({ id: m.id, name: m.name, appearance: m.appearance })) : this.profile ? [{ id: this.profile.id, name: this.profile.name, appearance: this.profile.appearance }] : [];
    this.menuScene.setCrew(crew);
  }

  // ------------------------------------------------------------------------------- AppApi
  create(mode: 'coop' | 'solo' | 'practice') { this.audio.unlock(); this.conn.send({ t: 'create', mode }); if (mode !== 'coop') setTimeout(() => this.conn.send({ t: 'start' }), 250); }
  join(code: string) { this.audio.unlock(); this.conn.send({ t: 'join', code: code.toUpperCase() }); }
  leave() {
    const doLeave = () => { this.conn.send({ t: 'leave' }); this.room = null; this.voice.stop(); this.voice.stopMic(); if (this.mission) this.endMission(); this.show('menu'); this.updateMenuCrew(); };
    if (this.mission) doLeave(); else if (this.room && this.room.members.length > 1) modal('Leave lobby', 'Leave this crew?', [{ label: 'Stay' }, { label: 'Leave', kind: 'danger', run: doLeave }]); else doLeave();
  }
  ready(v: boolean) { this.conn.send({ t: 'ready', ready: v }); this.audio.ui('ui_confirm'); }
  kick(id: string) { this.conn.send({ t: 'kick', id }); }
  roomSettings(s: Partial<RoomInfo['settings']>) { this.conn.send({ t: 'settings', ...s }); this.audio.ui('ui_click'); }
  start() { this.conn.send({ t: 'start' }); this.audio.ui('ui_confirm'); }
  chat(text: string) { this.conn.send({ t: 'chat', text }); }
  buy(item: string) { this.conn.send({ t: 'buy', item, req: Date.now() * 10 + (this.reqId++ % 10) }); }
  setLoadout(slot: LoadoutSlot, item: string | null) { if (!this.profile) return; this.conn.send({ t: 'loadout', loadout: { ...this.profile.loadout, [slot]: item } }); this.audio.ui('ui_click'); }
  setAppearance(slot: CosmeticSlot, id: string) { if (!this.profile) return; this.conn.send({ t: 'appearance', appearance: { ...this.profile.appearance, [slot]: id } }); this.audio.ui('ui_click'); }
  setName(name: string) { const n = name.trim().slice(0, 18); if (!n) return; this.settings.set('name', n); this.conn.send({ t: 'setName', name: n }); }
  toLobby() { this.conn.send({ t: 'toLobby' }); this.results = null; this.show(this.room ? 'lobby' : 'menu'); }
  inviteLink(code: string) { return `${location.origin}${location.pathname}?room=${code}`; }
  ui(s: string) { this.audio.ui(s); }
  isHost() { return !!this.room && this.room.hostId === this.profile?.id; }
  crewVoice() { return (this.room?.members ?? []).filter((m) => m.id !== this.profile?.id).map((m) => ({ id: m.id, name: m.name, ...(this.crewVolumes.get(m.id) ?? { muted: false, volume: 1 }) })); }
  setCrewVoice(id: string, muted: boolean, volume: number) { this.crewVolumes.set(id, { muted, volume }); this.voice.setPeer(id, muted, volume); }
}

function boot() {
  const gl = document.createElement('canvas').getContext('webgl2');
  if (!gl) {
    document.getElementById('ui-root')!.append(h('div', { class: 'screen center-overlay' }, h('h2', { class: 'h-display' }, 'WebGL 2 is required'), h('div', { class: 'muted' }, 'Please use a current version of Chrome, Edge, Firefox or Safari with hardware acceleration enabled.')));
    return;
  }
  new App();
}
boot();
