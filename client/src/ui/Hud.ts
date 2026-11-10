// In-mission HUD. Built once, updated every frame from MissionClient state.
import * as THREE from 'three';
import { ITEM_BY_ID, type LoadoutSlot } from '../../../shared/catalog/items';
import { DOCUMENT_BY_ID } from '../../../shared/catalog/documents';
import { MONSTERS } from '../../../shared/catalog/monsters';
import { PLAYER } from '../../../shared/constants';
import { PF } from '../../../shared/protocol';
import type { MissionClient } from '../game/MissionClient';
import { keyLabel, type Settings } from '../core/Settings';
import { fmt$, fmtTime, h } from './dom';

const GLYPH: Record<string, string> = { scanner: 'SCN', tracker: 'MTR', prod: 'PRD', radio: 'RAD', medkit: 'MED', battery: 'PWR', flare: 'FLR', stim: 'STM', decoy: 'DCY', defib: 'DFB', glowstick: 'GLO' };

export class Hud {
  readonly el: HTMLElement;
  private crosshair = h('div', { class: 'crosshair dot' }, h('i'));
  private prompt = h('div', { class: 'prompt' });
  private objective = h('div', { class: 'objective panel' });
  private team = h('div', { class: 'team' });
  private vitals = h('div', { class: 'hud-bl' });
  private slots = h('div', { class: 'hud-bc' });
  private held = h('div', { class: 'held panel' });
  private feed = h('div', { class: 'feed' });
  private captions = h('div', { class: 'captions' });
  private banner = h('div', { class: 'banner' });
  private overlay = h('div', { class: 'passive', style: { position: 'absolute', inset: '0' } });
  private radarCanvas = h('canvas', { width: 300, height: 300 }) as HTMLCanvasElement;
  private radar = h('div', { class: 'radar' }, this.radarCanvas);
  private mapCanvas = h('canvas', { width: 1200, height: 800 }) as HTMLCanvasElement;
  private mapPanel = h('div', { class: 'minimap panel' }, h('div', { class: 'row' }, h('div', { class: 'kicker' }, 'Facility map'), h('div', { class: 'spacer' }), h('div', { class: 'kicker' }, 'Explored areas · M to close')), this.mapCanvas);
  private center = h('div', { class: 'center-overlay' });
  private docEl: HTMLElement | null = null;
  private fps = h('div', { class: 'stats-fps' });
  private hp: { bar: HTMLElement; num: HTMLElement; row: HTMLElement } | null = null;
  private st: HTMLElement | null = null;
  private bt: HTMLElement | null = null;
  private last = '';
  showMap = false;
  private projected = new THREE.Vector3();
  captionsList: { text: string; at: number }[] = [];

  constructor(readonly m: MissionClient, readonly settings: Settings, readonly netStats: () => { ping: number; fps: number }) {
    const vital = (cls: string, lbl: string) => { const bar = h('i', { style: { width: '100%' } }); const num = h('span', { class: 'num' }, ''); const row = h('div', { class: 'vital ' + cls }, h('span', { class: 'lbl' }, lbl), h('div', { class: 'bar' }, bar), num); return { bar, num, row }; };
    const hp = vital('hp', 'HP'), st = vital('st', 'STA'), bt = vital('bt', 'PWR');
    this.hp = hp; this.st = st.bar; this.bt = bt.bar;
    this.vitals.append(hp.row, st.row, bt.row);
    this.el = h('div', { class: 'hud' },
      this.overlay, this.crosshair, this.prompt,
      h('div', { class: 'hud-tl' }, this.objective),
      h('div', { class: 'hud-tr' }, this.team),
      this.vitals, this.slots, h('div', { class: 'hud-br' }, this.held),
      this.feed, this.captions, this.banner, this.radar, this.center, this.fps,
    );
    this.radar.style.display = 'none';
    this.mapPanel.style.display = 'none';
    this.el.append(this.mapPanel);
  }

  caption(text: string, dir: string) {
    this.captionsList.push({ text: `[${text} — ${dir}]`, at: performance.now() / 1000 });
    if (this.captionsList.length > 4) this.captionsList.shift();
  }

  update(cam: THREE.PerspectiveCamera) {
    const m = this.m;
    const s = this.settings.data;
    const now = performance.now() / 1000;
    const mt = m.conn.missionTime();
    this.el.classList.toggle('hc', s.highContrast);
    // crosshair & prompt
    this.crosshair.className = 'crosshair ' + s.crosshair + (m.focus ? ' focus' : '');
    this.crosshair.style.display = s.crosshair === 'none' || m.life !== 'alive' ? 'none' : '';
    const f = m.focus;
    const ikey = keyLabel(s.binds.interact[0]);
    const pkey = f ? (f.hold ? `Hold ${ikey}` : ikey) : '';
    const promptKey = f ? `${f.kind}|${f.label}|${f.sub}|${pkey}|${f.warn}` : '';
    if (promptKey !== this.last) {
      this.last = promptKey;
      this.prompt.className = 'prompt' + (f?.warn ? ' warn' : '');
      this.prompt.replaceChildren(...(f ? [h('div', { class: 'main' }, f.warn && f.kind !== 'inter' ? null : h('span', { class: 'k' }, pkey), f.label), f.sub ? h('div', { class: 'sub' }, f.sub) : null] : []).filter((x): x is HTMLDivElement => !!x));
    }
    // objective / quota
    const q = m.quota;
    const met = q.banked >= q.quota;
    const left = Math.max(0, m.overtimeAt - mt);
    const lines: Node[] = [];
    if (m.info.practice) lines.push(h('div', { class: 'kicker' }, 'Practice facility'), h('div', { class: 'obj-line' }, 'Learn to lift, carry, throw and use your tools. Pull the lift lever to finish.'));
    else {
      lines.push(
        h('div', { class: 'row' }, h('div', { class: 'kicker' }, met ? 'Quota met — return to the lift' : 'Bank the quota'), h('div', { class: 'spacer' }), h('div', { class: 'kicker ' + (m.overtime ? 'danger' : '') }, m.overtime ? 'OVERTIME' : fmtTime(left))),
        h('div', { class: 'q' }, h('span', { class: met ? 'good' : 'accent' }, fmt$(q.banked)), h('span', { class: 'muted' }, ` / ${fmt$(q.quota)}`)),
        h('div', { class: 'qbar' }, h('b', { style: { width: `${Math.min(100, (q.tubed / Math.max(1, q.quota)) * 100)}%` } }), h('i', { style: { width: `${Math.min(100, (q.banked / Math.max(1, q.quota)) * 100)}%`, opacity: 0.85 } })),
        h('div', { class: 'obj-line' }, `In lift ${fmt$(q.inZone)} · Tubes ${fmt$(q.tubed)}`),
      );
      if (m.keys.size) lines.push(h('div', { class: 'obj-line accent' }, `Keycards: ${m.keys.size}`));
    }
    this.objective.className = 'objective panel' + (met ? ' met' : '');
    this.objective.replaceChildren(...lines);
    // team
    const mates: Node[] = [];
    for (const r of m.remotes.players.values()) {
      const down = (r.flags & PF.DOWNED) !== 0, dead = (r.flags & PF.DEAD) !== 0, out = (r.flags & PF.EXTRACTED) !== 0, dc = (r.flags & PF.DISCONNECTED) !== 0;
      mates.push(h('div', { class: 'mate panel' + (down ? ' down' : '') + (dead ? ' dead' : '') },
        h('div', { class: 'n' }, h('span', { class: 'spk' + (r.talking > 0.05 ? ' on' : '') }), r.info.name, dc ? h('span', { class: 'badge' }, 'Lost signal') : down ? h('span', { class: 'badge danger' }, 'Down') : dead ? h('span', { class: 'badge' }, 'KIA') : out ? h('span', { class: 'badge good' }, 'Aboard') : (r.flags & PF.MARKED) ? h('span', { class: 'badge danger' }, 'Marked') : null),
        h('div', { class: 'hb' }, h('i', { style: { width: `${dead ? 0 : r.hp}%`, background: r.hp < 30 ? 'var(--danger)' : '' } }))));
    }
    this.team.replaceChildren(...mates);
    // vitals
    const hpv = Math.max(0, Math.round(m.hp));
    if (this.hp) { this.hp.bar.style.width = `${hpv}%`; this.hp.num.textContent = String(hpv); this.hp.row.classList.toggle('low', hpv < 30); }
    if (this.st) this.st.style.width = `${(m.player.stamina / m.player.staminaMax) * 100}%`;
    if (this.bt) this.bt.style.width = `${m.battery * 100}%`;
    // slots
    const slotEls: Node[] = [];
    for (const [slot, key] of [['quick1', 'slot1'], ['quick2', 'slot2'], ['quick3', 'slot3'], ['tool1', 'tool1'], ['tool2', 'tool2']] as [LoadoutSlot, keyof typeof s.binds][]) {
      const id = m.loadoutFor(slot);
      const it = id ? ITEM_BY_ID[id] : null;
      const count = it?.type === 'consumable' ? m.items[id!] ?? 0 : -1;
      const cool = id === 'scanner' && (m.items.__scanner ?? 0) > 0 ? `${m.items.__scanner}s` : id === 'prod' ? `${m.items.__prod ?? 0}` : '';
      slotEls.push(h('div', { class: 'slot' + (!it ? ' empty' : '') + (count === 0 ? ' empty' : '') + (id === 'tracker' && m.trackerOn ? ' on' : '') + (cool && id === 'scanner' ? ' cool' : '') },
        h('span', { class: 'k' }, keyLabel(s.binds[key][0])), h('span', { class: 'g' }, it ? GLYPH[it.id] ?? it.id.slice(0, 3).toUpperCase() : '—'), it ? h('span', { class: 'nm' }, it.name) : null,
        count >= 0 ? h('span', { class: 'c' }, `×${count}`) : cool ? h('span', { class: 'c' }, cool) : null));
    }
    const torchItem = ITEM_BY_ID[m.loadoutFor('light') ?? 'light_t1'];
    slotEls.push(h('div', { class: 'slot' + (m.torchOn ? ' on' : '') }, h('span', { class: 'k' }, keyLabel(s.binds.light[0])), h('span', { class: 'g' }, 'TRC'), h('span', { class: 'nm' }, torchItem?.name ?? 'Torch'), h('span', { class: 'c' }, `${Math.round(m.battery * 100)}%`)));
    this.slots.replaceChildren(...slotEls);
    // held object
    const hi = m.heldInfo();
    this.held.style.display = hi ? '' : 'none';
    if (hi) {
      const heavy = hi.mass > ((PLAYER.STRENGTH / 9.81) * (1 + hi.helpers));
      this.held.replaceChildren(...[
        h('div', { class: 'kicker' }, hi.role === 'helper' ? 'Helping carry' : hi.helpers ? `Carrying with ${hi.helpers} crew` : 'Carrying'),
        h('div', { class: 'n' }, hi.name),
        hi.base ? h('div', { class: 'v' }, h('span', { class: hi.value < hi.base * 0.6 ? 'danger' : 'accent' }, fmt$(hi.value)), h('span', { class: 'muted' }, hi.value < hi.base ? `  (was ${fmt$(hi.base)})` : '')) : null,
        h('div', { class: 'held hint', style: { padding: 0, minWidth: 0 } }, `${hi.mass} kg${heavy ? ' · too heavy to lift alone' : ''}`),
        h('div', { class: 'hint' }, `${keyLabel(s.binds.drop[0])} drop · RMB throw · ${keyLabel(s.binds.rotate[0])}+mouse rotate · wheel distance`),
      ].filter((x): x is HTMLDivElement => !!x));
    }
    // feed + captions
    this.feed.replaceChildren(...m.messages.slice(-5).map((x) => h('div', { class: 'm ' + x.kind }, x.text)));
    this.captionsList = this.captionsList.filter((c) => now - c.at < 3.5);
    this.captions.replaceChildren(...this.captionsList.map((c) => h('div', { class: 'c' }, c.text)));
    // banners: lift countdown, overtime, start
    let banner: Node[] = [];
    let bcls = 'banner';
    if (mt < m.info.startAt) { banner = [h('div', { class: 'big' }, 'Arriving'), h('div', { class: 'small' }, `Gate opens in ${Math.ceil(m.info.startAt - mt)}`)]; bcls += ' go'; }
    else if (m.lift.state === 'countdown') { const t = Math.ceil(Math.max(0, m.lift.until - mt)); const aboard = m.lift.aboard.length; banner = [h('div', { class: 'big' }, `Departing in ${t}`), h('div', { class: 'small' }, `${aboard}/${m.info.players.length} aboard · anyone outside the lift car is left behind`)]; bcls += ' warn'; }
    else if (m.lift.state === 'departing' || m.lift.state === 'gone') banner = [h('div', { class: 'big' }, m.life === 'extracted' ? 'Lift ascending' : 'The lift has left'), h('div', { class: 'small' }, m.life === 'extracted' ? 'Contract closing…' : 'You were left behind')];
    else if (m.life === 'downed') { const t = Math.max(0, 45 - (now - m.downedSince)); banner = [h('div', { class: 'big' }, 'You are down'), h('div', { class: 'small' }, `A crewmate can revive you · bleed-out ${Math.ceil(t)}s`)]; bcls += ' warn'; }
    else if (m.life === 'dead') banner = [h('div', { class: 'big' }, 'Signal lost'), h('div', { class: 'small' }, m.remotes.players.size ? 'Spectating · click to switch crew member' : 'Waiting for the contract to end')];
    else if (m.pinned) { banner = [h('div', { class: 'big' }, 'Pinned!'), h('div', { class: 'small' }, 'Call your crew — light or force will drive it off')]; bcls += ' warn'; }
    else if (m.marked) { banner = [h('div', { class: 'small danger' }, 'MARKED · every creature knows where you are')]; }
    this.banner.className = bcls;
    this.banner.replaceChildren(...banner);
    // revive progress ring
    this.center.replaceChildren();
    if (m.revive && m.revive.progress < 1) this.center.append(h('div', { class: 'kicker' }, `Reviving ${Math.round(m.revive.progress * 100)}%`), h('div', { class: 'qbar', style: { width: '200px' } }, h('i', { style: { width: `${m.revive.progress * 100}%` } })));
    this.center.classList.toggle('downed-vignette', m.life === 'downed');
    // world overlays
    const w = window.innerWidth, hh = window.innerHeight;
    const items: Node[] = [];
    const proj = (p: THREE.Vector3): [number, number] | null => { this.projected.copy(p).project(cam); if (this.projected.z > 1 || this.projected.z < -1) return null; return [(this.projected.x * 0.5 + 0.5) * w, (-this.projected.y * 0.5 + 0.5) * hh]; };
    for (const p of m.popups) { const sp = proj(p.pos.clone().add(new THREE.Vector3(0, 0.3 + (now - p.at) * 0.4, 0))); if (sp) items.push(h('div', { class: 'popup', style: { left: sp[0] + 'px', top: sp[1] + 'px', color: p.color, opacity: String(1 - (now - p.at) / 1.6) } }, p.text)); }
    for (const t of m.scanTargets()) { const sp = proj(t.pos); if (sp) items.push(h('div', { class: 'tagw', style: { left: sp[0] + 'px', top: sp[1] + 'px' } }, t.text)); }
    for (const pg of m.pings) { const sp = proj(pg.p); if (sp) items.push(h('div', { class: 'pingw', 'data-d': `${Math.round(pg.p.distanceTo(cam.position))} m`, style: { left: sp[0] + 'px', top: sp[1] + 'px', opacity: String(Math.max(0, 1 - (now - pg.at) / 8)) } })); }
    this.overlay.replaceChildren(...items);
    // tracker radar
    this.radar.style.display = m.trackerOn && m.battery > 0 ? '' : 'none';
    if (m.trackerOn) this.drawRadar(cam);
    // map
    this.mapPanel.style.display = this.showMap ? '' : 'none';
    if (this.showMap) this.drawMap();
    // document
    if (m.docOpen && !this.docEl) {
      const d = DOCUMENT_BY_ID[m.docOpen];
      if (d) { this.docEl = h('div', { class: 'center-overlay', style: { pointerEvents: 'auto', background: 'rgba(0,0,0,.55)' } }, h('div', { class: 'doc' }, h('h3', null, d.title), h('div', null, d.body), h('div', { class: 'kicker', style: { color: '#6a6455' } }, `Press ${keyLabel(s.binds.interact[0])} or Esc to close`))); this.el.append(this.docEl); }
    } else if (!m.docOpen && this.docEl) { this.docEl.remove(); this.docEl = null; }
    const ns = this.netStats();
    this.fps.textContent = s.showFps ? `${Math.round(ns.fps)} FPS · ${Math.round(ns.ping)} ms` : '';
  }

  private drawRadar(cam: THREE.PerspectiveCamera) {
    const g = this.radarCanvas.getContext('2d')!;
    const S = 300, R = 26;
    g.clearRect(0, 0, S, S);
    g.strokeStyle = 'rgba(127,183,126,.25)';
    for (const r of [0.33, 0.66, 1]) { g.beginPath(); g.arc(S / 2, S / 2, (S / 2) * r - 2, 0, 6.29); g.stroke(); }
    const sweep = (performance.now() / 1000) % 2 / 2 * Math.PI * 2;
    g.fillStyle = 'rgba(127,183,126,.08)'; g.beginPath(); g.moveTo(S / 2, S / 2); g.arc(S / 2, S / 2, S / 2, sweep - 0.5, sweep); g.fill();
    const yaw = this.m.player.yaw;
    const me = this.m.player.pos;
    const plot = (p: THREE.Vector3, color: string, size: number) => {
      const dx = p.x - me.x, dz = p.z - me.z;
      const d = Math.hypot(dx, dz);
      if (d > R) return;
      const lx = dx * Math.cos(yaw) - dz * Math.sin(yaw), lz = dx * Math.sin(yaw) + dz * Math.cos(yaw);
      g.fillStyle = color; g.beginPath(); g.arc(S / 2 + (lx / R) * (S / 2), S / 2 + (lz / R) * (S / 2), size, 0, 6.29); g.fill();
    };
    for (const e of this.m.remotes.enemies.values()) if (e.speed > 0.3 || e.type === 'watcher') plot(e.pos, '#e8574a', 6);
    for (const r of this.m.remotes.players.values()) if (r.speed > 0.3) plot(r.pos, '#7fdc8a', 5);
    g.fillStyle = '#e8e4da'; g.beginPath(); g.moveTo(S / 2, S / 2 - 8); g.lineTo(S / 2 - 6, S / 2 + 6); g.lineTo(S / 2 + 6, S / 2 + 6); g.fill();
    void cam;
  }

  private drawMap() {
    const m = this.m;
    const L = m.level;
    const c = this.mapCanvas;
    const g = c.getContext('2d')!;
    const b = L.bounds;
    const full = m.conn.missionTime() < m.mapUntil;
    const floor = Math.round(m.player.pos.y / 6);
    const sc = Math.min(c.width / (b.x1 - b.x0 + 4), c.height / (b.z1 - b.z0 + 4));
    const X = (x: number) => (x - b.x0 + 2) * sc, Z = (z: number) => (b.z1 - z + 2) * sc;
    g.fillStyle = '#0a0b0c'; g.fillRect(0, 0, c.width, c.height);
    for (const r of L.rooms) {
      if (r.floor !== floor && !(r.floorsSpanned > 1 && r.floor + 1 === floor)) continue;
      if (!full && !m.visited.has(r.id)) continue;
      g.fillStyle = r.type === 'lift' ? 'rgba(127,183,126,.35)' : r.corridor ? 'rgba(232,228,218,.08)' : 'rgba(232,228,218,.14)';
      g.fillRect(X(r.x0) + 1, Z(r.z1) + 1, (r.x1 - r.x0) * sc - 2, (r.z1 - r.z0) * sc - 2);
      if (!r.corridor && r.type !== 'stairs') { g.fillStyle = 'rgba(232,228,218,.55)'; g.font = '12px "JetBrains Mono", monospace'; g.fillText(r.name.toUpperCase(), X(r.x0) + 6, Z(r.z1) + 16); }
      if (r.stair) { g.fillStyle = '#e0a030'; g.fillText('STAIRS', X(r.x0) + 6, Z(r.z1) + 16); }
    }
    if (full) for (const p of m.props.items.values()) if (p.kind === 'valuable' && Math.abs(p.mesh.position.y - floor * 6) < 4) { g.fillStyle = '#e0a030'; g.fillRect(X(p.mesh.position.x) - 2, Z(p.mesh.position.z) - 2, 4, 4); }
    for (const it of L.interactables) if (it.kind === 'tube' && (full || m.visited.has(it.room))) { g.fillStyle = '#7fa6b7'; g.fillRect(X(it.x) - 4, Z(it.z) - 4, 8, 8); }
    for (const r of m.remotes.players.values()) { g.fillStyle = '#7fdc8a'; g.beginPath(); g.arc(X(r.pos.x), Z(r.pos.z), 5, 0, 6.29); g.fill(); }
    g.fillStyle = '#e8e4da'; g.beginPath(); g.arc(X(m.player.pos.x), Z(m.player.pos.z), 6, 0, 6.29); g.fill();
    g.strokeStyle = '#e8e4da'; g.beginPath(); g.moveTo(X(m.player.pos.x), Z(m.player.pos.z)); g.lineTo(X(m.player.pos.x - Math.sin(m.player.yaw) * 4), Z(m.player.pos.z - Math.cos(m.player.yaw) * 4)); g.stroke();
    g.fillStyle = 'rgba(232,228,218,.6)'; g.font = '14px "JetBrains Mono", monospace'; g.fillText(`FLOOR ${floor >= 0 ? floor : 'B' + -floor}${full ? ' · SCHEMATIC' : ''}`, 14, c.height - 14);
    void MONSTERS;
  }
}
