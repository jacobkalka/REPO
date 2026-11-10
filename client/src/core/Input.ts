// Keyboard + mouse input with rebindable actions and pointer lock.
import { ACTIONS, type Action, type Settings } from './Settings';

export class Input {
  private down = new Set<string>();
  private pressed = new Set<string>();
  private released = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  wheel = 0;
  locked = false;
  /** when false, gameplay input is ignored (menus, chat) */
  enabled = false;
  private capture: ((code: string) => void) | null = null;
  readonly el: HTMLElement;

  constructor(el: HTMLElement, private settings: Settings) {
    this.el = el;
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('mousedown', (e) => this.onMouse(e, true));
    window.addEventListener('mouseup', (e) => this.onMouse(e, false));
    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    window.addEventListener('wheel', (e) => { if (this.locked) { this.wheel += Math.sign(e.deltaY); e.preventDefault(); } }, { passive: false });
    window.addEventListener('blur', () => this.clearAll());
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.el;
      if (!this.locked) this.clearAll();
    });
    window.addEventListener('contextmenu', (e) => { if (this.locked) e.preventDefault(); });
  }

  private onKey(e: KeyboardEvent, isDown: boolean) {
    if (this.capture && isDown) { e.preventDefault(); const c = this.capture; this.capture = null; c(e.code); return; }
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') && e.code !== 'Escape') return;
    if (this.locked && (e.code === 'Tab' || e.code === 'Space' || e.code.startsWith('Arrow') || (e.ctrlKey && (e.code === 'KeyW' || e.code === 'KeyS' || e.code === 'KeyD')))) e.preventDefault();
    this.setCode(e.code, isDown, e.repeat);
  }

  private onMouse(e: MouseEvent, isDown: boolean) {
    const code = 'Mouse' + e.button;
    if (this.capture && isDown && this.locked) { const c = this.capture; this.capture = null; c(code); return; }
    if (!this.locked) return;
    this.setCode(code, isDown, false);
  }

  private setCode(code: string, isDown: boolean, repeat: boolean) {
    if (isDown) { if (!this.down.has(code) && !repeat) this.pressed.add(code); this.down.add(code); }
    else { if (this.down.has(code)) this.released.add(code); this.down.delete(code); }
  }

  clearAll() { this.down.clear(); this.pressed.clear(); this.released.clear(); this.mouseDX = 0; this.mouseDY = 0; }

  /** capture the next key / mouse button for rebinding */
  captureNext(fn: (code: string) => void) { this.capture = fn; }
  cancelCapture() { this.capture = null; }

  private binds(a: Action) { return this.settings.data.binds[a] ?? []; }
  held(a: Action) { return this.enabled && this.binds(a).some((c) => this.down.has(c)); }
  justPressed(a: Action) { return this.enabled && this.binds(a).some((c) => this.pressed.has(c)); }
  justReleased(a: Action) { return this.enabled && this.binds(a).some((c) => this.released.has(c)); }
  rawPressed(code: string) { return this.pressed.has(code); }
  mouseHeld(button: number) { return this.enabled && this.down.has('Mouse' + button); }
  mousePressed(button: number) { return this.enabled && this.pressed.has('Mouse' + button); }
  mouseReleased(button: number) { return this.enabled && this.released.has('Mouse' + button); }

  /** end of frame */
  endFrame() { this.pressed.clear(); this.released.clear(); this.mouseDX = 0; this.mouseDY = 0; this.wheel = 0; }

  lock() {
    if (document.pointerLockElement === this.el) return;
    const p = this.el.requestPointerLock?.({ unadjustedMovement: true } as never) as unknown as Promise<void> | undefined;
    if (p && typeof p.catch === 'function') p.catch(() => { try { this.el.requestPointerLock(); } catch { /* ignore */ } });
  }

  unlock() { if (document.pointerLockElement) document.exitPointerLock(); }

  /** returns actions that share a key (for the conflict warning in settings) */
  conflicts(): Map<string, Action[]> {
    const byKey = new Map<string, Action[]>();
    for (const a of Object.keys(ACTIONS) as Action[]) for (const k of this.binds(a)) { const l = byKey.get(k) ?? []; l.push(a); byKey.set(k, l); }
    for (const [k, v] of [...byKey]) if (v.length < 2) byKey.delete(k);
    return byKey;
  }
}
