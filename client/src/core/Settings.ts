// Persistent player settings (localStorage), with defaults and validation.

export type Quality = 'low' | 'medium' | 'high' | 'ultra';

export const ACTIONS = {
  forward: 'Move forward', back: 'Move back', left: 'Strafe left', right: 'Strafe right',
  jump: 'Jump', sprint: 'Sprint', crouch: 'Crouch', interact: 'Interact / pick up', drop: 'Drop held object',
  rotate: 'Rotate held object (hold)', light: 'Toggle torch', slot1: 'Quick slot 1', slot2: 'Quick slot 2', slot3: 'Quick slot 3',
  tool1: 'Tool slot 1', tool2: 'Tool slot 2', inventory: 'Equipment overview', ping: 'Ping location', pushToTalk: 'Push to talk',
  radio: 'Radio transmit', chat: 'Text chat', pause: 'Pause menu', map: 'Facility map',
} as const;
export type Action = keyof typeof ACTIONS;

export const DEFAULT_BINDS: Record<Action, string[]> = {
  forward: ['KeyW', 'ArrowUp'], back: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'],
  jump: ['Space'], sprint: ['ShiftLeft'], crouch: ['ControlLeft', 'KeyC'], interact: ['KeyE'], drop: ['KeyQ'],
  rotate: ['KeyR'], light: ['KeyF'], slot1: ['Digit1'], slot2: ['Digit2'], slot3: ['Digit3'], tool1: ['Digit4'], tool2: ['Digit5'],
  inventory: ['Tab'], ping: ['KeyG'], pushToTalk: ['KeyV'], radio: ['KeyB'], chat: ['Enter'], pause: ['Escape'], map: ['KeyM'],
};

export interface SettingsData {
  quality: Quality;
  renderScale: number;     // 0.5 .. 1.0 (x devicePixelRatio cap)
  resolution: 'native' | '1920x1080' | '1600x900' | '1280x720';
  vsync: boolean;
  fpsLimit: number;        // 0 = unlimited
  fov: number;
  sensitivity: number;
  invertY: boolean;
  masterVolume: number;
  sfxVolume: number;
  musicVolume: number;
  ambienceVolume: number;
  voiceVolume: number;
  micGain: number;
  voiceMode: 'open' | 'ptt' | 'off';
  voiceThreshold: number;
  micDevice: string;
  binds: Record<Action, string[]>;
  headBob: number;
  cameraShake: number;
  subtitles: boolean;
  colorblind: 'off' | 'deuter' | 'protan' | 'tritan';
  uiScale: number;
  toggleCrouch: boolean;
  toggleSprint: boolean;
  crosshair: 'dot' | 'cross' | 'none';
  highContrast: boolean;
  reduceFlicker: boolean;
  brightness: number;
  dispatcherVoice: boolean;
  showFps: boolean;
  name: string;
}

export const DEFAULT_SETTINGS: SettingsData = {
  quality: 'high', renderScale: 1, resolution: 'native', vsync: true, fpsLimit: 0, fov: 78, sensitivity: 1, invertY: false,
  masterVolume: 0.85, sfxVolume: 0.9, musicVolume: 0.55, ambienceVolume: 0.7, voiceVolume: 1, micGain: 1, voiceMode: 'open', voiceThreshold: 0.12, micDevice: '',
  binds: DEFAULT_BINDS, headBob: 1, cameraShake: 1, subtitles: true, colorblind: 'off', uiScale: 1, toggleCrouch: false, toggleSprint: false,
  crosshair: 'dot', highContrast: false, reduceFlicker: false, brightness: 1, dispatcherVoice: false, showFps: false, name: '',
};

const KEY = 'salvage.settings.v1';

export class Settings {
  data: SettingsData;
  private listeners = new Set<(s: SettingsData, changed: (keyof SettingsData)[]) => void>();

  constructor() {
    this.data = structuredClone(DEFAULT_SETTINGS);
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<SettingsData>;
        this.data = { ...this.data, ...parsed, binds: { ...DEFAULT_BINDS, ...(parsed.binds ?? {}) } };
      } else this.data.quality = Settings.autoQuality();
    } catch { /* storage unavailable: defaults */ }
  }

  /** pick a starting preset from the GPU and core count */
  static autoQuality(): Quality {
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2');
      if (!gl) return 'low';
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const r = (ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) as string;
      if (/swiftshader|llvmpipe|software/i.test(r)) return 'low';
      if (/intel|mali|adreno|powervr|apple m1/i.test(r) && !/arc/i.test(r)) return 'medium';
      return navigator.hardwareConcurrency >= 8 ? 'high' : 'medium';
    } catch { return 'medium'; }
  }

  set<K extends keyof SettingsData>(key: K, value: SettingsData[K]) {
    this.data[key] = value;
    this.save();
    for (const l of this.listeners) l(this.data, [key]);
  }

  patch(p: Partial<SettingsData>) {
    Object.assign(this.data, p);
    this.save();
    for (const l of this.listeners) l(this.data, Object.keys(p) as (keyof SettingsData)[]);
  }

  resetBinds() { this.set('binds', structuredClone(DEFAULT_BINDS)); }

  onChange(fn: (s: SettingsData, changed: (keyof SettingsData)[]) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  save() {
    try { localStorage.setItem(KEY, JSON.stringify(this.data)); } catch { /* ignore */ }
  }
}

export function keyLabel(code: string): string {
  if (!code) return '—';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  const map: Record<string, string> = {
    Space: 'Space', ShiftLeft: 'L Shift', ShiftRight: 'R Shift', ControlLeft: 'L Ctrl', ControlRight: 'R Ctrl', AltLeft: 'L Alt', AltRight: 'R Alt',
    Escape: 'Esc', Enter: 'Enter', Tab: 'Tab', Backspace: 'Bksp', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    Mouse0: 'LMB', Mouse1: 'MMB', Mouse2: 'RMB', Mouse3: 'Mouse 4', Mouse4: 'Mouse 5', CapsLock: 'Caps', Backquote: '`',
  };
  return map[code] ?? code.replace(/^Numpad/, 'Num ');
}
