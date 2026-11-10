// Developer overlay (?dev=1, F1): stats, net info, physics/nav/AI visualisation, console.
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { NavGrid } from '../../../shared/nav/NavGrid';
import { buildStaticColliders } from '../../../shared/physics/colliders';
import { VALUABLES } from '../../../shared/catalog/valuables';
import { MONSTER_INDEX } from '../../../shared/catalog/monsters';
import type { Engine } from '../core/Engine';
import type { Connection } from '../net/Connection';
import type { MissionClient } from '../game/MissionClient';
import { h } from '../ui/dom';

export class DevTools {
  readonly el: HTMLElement;
  private info = h('pre', { style: { margin: 0, fontFamily: 'var(--font-mono)', fontSize: '11px', lineHeight: 1.45, whiteSpace: 'pre-wrap' } });
  private log = h('div', { style: { fontFamily: 'var(--font-mono)', fontSize: '11px', maxHeight: '140px', overflow: 'auto', color: '#9a9' } });
  private input = h('input', { type: 'text', placeholder: 'command (help)', style: { width: '100%', fontFamily: 'var(--font-mono)', fontSize: '12px' } }) as HTMLInputElement;
  visible = false;
  showPhysics = false;
  showNav = false;
  showAI = true;
  private lines: THREE.LineSegments | null = null;
  private navMesh: THREE.Points | null = null;
  private labels = h('div', { class: 'passive', style: { position: 'absolute', inset: '0', pointerEvents: 'none' } });
  private nav: NavGrid | null = null;
  errors: string[] = [];

  constructor(readonly engine: Engine, readonly conn: Connection, readonly mission: () => MissionClient | null, readonly serverDev: () => boolean) {
    const toggle = (label: string, get: () => boolean, set: (v: boolean) => void) => { const b = h('button', { class: 'btn small' + (get() ? ' primary' : ''), onclick: () => { set(!get()); b.classList.toggle('primary', get()); } }, label); return b; };
    this.el = h('div', { style: { position: 'absolute', left: '8px', top: '8px', width: '420px', padding: '10px', background: 'rgba(0,0,0,.82)', border: '1px solid #333', zIndex: '60', display: 'none', pointerEvents: 'auto' } },
      h('div', { class: 'row', style: { marginBottom: '6px', flexWrap: 'wrap', gap: '4px' } }, h('b', { class: 'kicker accent' }, 'DEV'),
        toggle('Physics', () => this.showPhysics, (v) => (this.showPhysics = v)), toggle('Nav grid', () => this.showNav, (v) => { this.showNav = v; if (!v && this.navMesh) { this.navMesh.removeFromParent(); this.navMesh = null; } }), toggle('AI labels', () => this.showAI, (v) => (this.showAI = v))),
      this.info, this.log, this.input);
    this.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { this.run(this.input.value); this.input.value = ''; } e.stopPropagation(); });
    conn.on('dev', (m) => this.print(m.text));
    window.addEventListener('error', (e) => this.errors.push(String(e.message)));
    window.addEventListener('unhandledrejection', (e) => this.errors.push(String((e as PromiseRejectionEvent).reason)));
  }

  print(t: string) { this.log.append(h('div', null, t)); this.log.scrollTop = this.log.scrollHeight; }

  toggle() { this.visible = !this.visible; this.el.style.display = this.visible ? '' : 'none'; if (this.visible) setTimeout(() => this.input.focus(), 10); if (!this.visible) this.clearViz(); }

  run(cmd: string) {
    const [c, ...args] = cmd.trim().split(/\s+/);
    if (!c) return;
    if (c === 'help') { this.print('spawn <valuable|model>, enemy <type>, quota, god, heal, hurt <n>, kill, power [off], event <blackout|surge|lockdown|loot|ambush|equipment|sounds|blackbox>, unknown, clear, end [win], overtime, grant <credits> <xp>, culling, items, monsters'); return; }
    if (c === 'items') { this.print(VALUABLES.map((v) => v.id).join(' ')); return; }
    if (c === 'monsters') { this.print(MONSTER_INDEX.join(' ')); return; }
    if (c === 'culling') { const m = this.mission(); if (m) { m.vis.enabled = !m.vis.enabled; this.print('portal culling ' + m.vis.enabled); } return; }
    if (!this.serverDev()) { this.print('server is not in DEV_MODE; gameplay commands are disabled'); return; }
    this.conn.send({ t: 'dev', cmd: c, args });
    this.print('> ' + cmd);
  }

  private clearViz() { this.lines?.removeFromParent(); this.lines = null; this.navMesh?.removeFromParent(); this.navMesh = null; this.labels.replaceChildren(); }

  update() {
    if (!this.visible) return;
    const e = this.engine, m = this.mission();
    const st = e.stats();
    const bw = this.conn.bandwidth();
    const lines = [
      `FPS ${e.fps.toFixed(0)}  frame ${e.frameMs.toFixed(1)}ms  cpu ${e.cpuMs.toFixed(1)}ms  quality ${e.qualityName}`,
      `draws ${st.calls}  tris ${(st.tris / 1000).toFixed(0)}k  geo ${st.geometries}  tex ${st.textures}  programs ${st.programs}`,
      `net ${this.conn.status}  rtt ${(this.conn.rtt * 1000).toFixed(0)}ms  jitter ${(this.conn.jitter * 1000).toFixed(1)}ms  interp ${(this.conn.interpDelay * 1000).toFixed(0)}ms`,
      `bandwidth ↓${bw.down.toFixed(1)} KB/s ↑${bw.up.toFixed(1)} KB/s  heap ${((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) / 1048576 | 0} MB`,
    ];
    if (m) {
      const p = m.player.pos;
      lines.push(`mission ${m.info.mid} ${m.info.map} d${m.info.difficulty} seed ${m.info.seed}`, `pos ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}  room ${m.vis.roomAt(p)}  visible rooms ${m.vis.visible.size}  props ${m.props.items.size}  enemies ${m.remotes.enemies.size}`,
        `quota ${m.quota.banked}/${m.quota.quota}  lift ${m.lift.state}  life ${m.life}  hp ${m.hp}  focus ${m.focus ? m.focus.kind + '#' + m.focus.id : '-'}`);
      for (const en of m.remotes.enemies.values()) lines.push(`  #${en.id} ${en.type.padEnd(8)} ${en.state.padEnd(11)} spd ${en.speed.toFixed(1)} tgt ${en.target} @ ${en.pos.x.toFixed(0)},${en.pos.z.toFixed(0)}`);
      this.viz(m);
    }
    if (this.errors.length) lines.push(`errors: ${this.errors.slice(-3).join(' | ')}`);
    this.info.textContent = lines.join('\n');
  }

  private viz(m: MissionClient) {
    if (this.showPhysics) {
      const r = m.world.world.debugRender();
      if (!this.lines) { this.lines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ vertexColors: true, depthTest: true })); this.lines.frustumCulled = false; m.root.add(this.lines); }
      this.lines.geometry.setAttribute('position', new THREE.BufferAttribute(r.vertices, 3));
      this.lines.geometry.setAttribute('color', new THREE.BufferAttribute(r.colors, 4));
    } else if (this.lines) { this.lines.removeFromParent(); this.lines = null; }
    if (this.showNav && !this.navMesh) {
      this.nav ??= NavGrid.build(m.level, buildStaticColliders(m.level));
      const pts: number[] = [], cols: number[] = [];
      for (const g of this.nav.floors) for (let k = 0; k < g.walk.length; k++) {
        if (!g.walk[k]) continue;
        const c = this.nav.cellCenter(g, k);
        pts.push(c.x, c.y + 0.05, c.z);
        const cl = Math.min(1, g.clear[k] / 4);
        cols.push(g.door[k] >= 0 ? 1 : 1 - cl, cl, 0.2);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
      this.navMesh = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.12, vertexColors: true }));
      m.root.add(this.navMesh);
    }
    if (!this.labels.isConnected) document.getElementById('ui-root')!.append(this.labels);
    this.labels.replaceChildren();
    if (this.showAI) {
      const cam = this.engine.camera;
      const v = new THREE.Vector3();
      for (const en of m.remotes.enemies.values()) {
        v.copy(en.pos).setY(en.pos.y + 2.4).project(cam);
        if (v.z > 1) continue;
        this.labels.append(h('div', { style: { position: 'absolute', left: `${(v.x * 0.5 + 0.5) * innerWidth}px`, top: `${(-v.y * 0.5 + 0.5) * innerHeight}px`, transform: 'translate(-50%,-100%)', fontFamily: 'var(--font-mono)', fontSize: '11px', color: '#ff8a7a', background: 'rgba(0,0,0,.6)', padding: '1px 4px' } }, `${en.type}:${en.state}`));
      }
      for (const p of m.props.items.values()) {
        if (p.mesh.position.distanceTo(cam.position) > 6) continue;
        v.copy(p.mesh.position).project(cam);
        if (v.z > 1) continue;
        this.labels.append(h('div', { style: { position: 'absolute', left: `${(v.x * 0.5 + 0.5) * innerWidth}px`, top: `${(-v.y * 0.5 + 0.5) * innerHeight}px`, transform: 'translate(-50%,-50%)', fontFamily: 'var(--font-mono)', fontSize: '10px', color: '#9cf', background: 'rgba(0,0,0,.5)', padding: '0 3px' } }, `#${p.id} ${p.def} $${p.value} o${p.owner}`));
      }
    }
  }
}

void RAPIER;
