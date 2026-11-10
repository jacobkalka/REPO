import { ACTIONS, DEFAULT_SETTINGS, keyLabel, type Action, type Settings, type SettingsData } from '../core/Settings';
import type { Input } from '../core/Input';
import { h, modal, toast } from './dom';

export interface SettingsDeps { settings: Settings; input: Input; back: () => void; token: () => string | null; importToken: (t: string) => void; playerId: () => string; ui: (s: string) => void; micDevices: () => Promise<MediaDeviceInfo[]>; testMic: () => Promise<number> }

export function settingsScreen(d: SettingsDeps): HTMLElement {
  const s = d.settings;
  let tab = 'graphics';
  const tabs = h('div', { class: 'tabs' });
  const body = h('div', { class: 'settings-list scroll', style: { flex: 1, minHeight: 0, paddingRight: '8px' } });
  const row = (label: string, hint: string | null, ctl: Node) => h('div', { class: 'setting' }, h('div', { class: 'lbl' }, h('span', null, label), hint ? h('small', null, hint) : null), h('div', { class: 'ctl' }, ctl));
  const toggle = <K extends keyof SettingsData>(k: K) => { const b = h('button', { class: 'toggle' + (s.data[k] ? ' on' : ''), onclick: () => { s.set(k, !s.data[k] as SettingsData[K]); b.classList.toggle('on', !!s.data[k]); d.ui('ui_click'); } }); return b; };
  const slider = <K extends keyof SettingsData>(k: K, min: number, max: number, step: number, fmt: (v: number) => string = (v) => `${Math.round(v * 100)}%`) => {
    const val = h('span', { class: 'val' }, fmt(Number(s.data[k])));
    const r = h('input', { type: 'range', min, max, step, value: Number(s.data[k]) }) as HTMLInputElement;
    r.addEventListener('input', () => { s.set(k, Number(r.value) as SettingsData[K]); val.textContent = fmt(Number(r.value)); });
    return h('div', { class: 'row', style: { width: '100%' } }, r, val);
  };
  const select = <K extends keyof SettingsData>(k: K, opts: [string, string][]) => {
    const el = h('select', { onchange: (e: Event) => { const v = (e.target as HTMLSelectElement).value; s.set(k, (typeof s.data[k] === 'number' ? Number(v) : v) as SettingsData[K]); d.ui('ui_click'); } }, ...opts.map(([v, l]) => h('option', { value: v, selected: String(s.data[k]) === v }, l)));
    return el;
  };
  const render = () => {
    tabs.replaceChildren(...[['graphics', 'Graphics'], ['audio', 'Audio'], ['controls', 'Controls'], ['access', 'Accessibility'], ['profile', 'Profile']].map(([id, l]) => h('button', { class: 'tab' + (tab === id ? ' active' : ''), onclick: () => { tab = id; render(); } }, l)));
    body.replaceChildren();
    if (tab === 'graphics') {
      const fs = h('button', { class: 'toggle' + (document.fullscreenElement ? ' on' : ''), onclick: async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); } catch { toast('Fullscreen is not available here.', 'error'); } setTimeout(() => fs.classList.toggle('on', !!document.fullscreenElement), 100); } });
      body.append(
        row('Quality preset', 'Shadows, ambient occlusion, bloom, light count, texture detail', select('quality', [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['ultra', 'Ultra']])),
        row('Resolution', 'Internal render resolution', select('resolution', [['native', 'Native'], ['1920x1080', '1920 × 1080'], ['1600x900', '1600 × 900'], ['1280x720', '1280 × 720']])),
        row('Render scale', 'Lower for higher frame rates', slider('renderScale', 0.5, 1, 0.05)),
        row('Fullscreen', null, fs),
        row('VSync', 'Off renders uncapped; browsers still present at your display refresh rate', toggle('vsync')),
        row('Frame-rate limit', null, select('fpsLimit', [['0', 'Unlimited'], ['30', '30'], ['60', '60'], ['90', '90'], ['120', '120'], ['144', '144']])),
        row('Field of view', null, slider('fov', 60, 105, 1, (v) => `${Math.round(v)}°`)),
        row('Brightness', null, slider('brightness', 0.6, 1.6, 0.05)),
        row('Show frame rate', null, toggle('showFps')),
      );
    } else if (tab === 'audio') {
      const devSel = h('select', { onchange: (e: Event) => s.set('micDevice', (e.target as HTMLSelectElement).value) }, h('option', { value: '' }, 'System default')) as HTMLSelectElement;
      d.micDevices().then((list) => { for (const dev of list) devSel.append(h('option', { value: dev.deviceId, selected: dev.deviceId === s.data.micDevice }, dev.label || 'Microphone')); }).catch(() => {});
      const meter = h('i', { style: { display: 'block', height: '100%', width: '0%', background: 'var(--good)' } });
      const testBtn = h('button', { class: 'btn small', onclick: async () => { try { const lvl = await d.testMic(); meter.style.width = `${Math.min(100, lvl * 300)}%`; toast(lvl > 0.02 ? 'Microphone is working.' : 'No input detected. Check your microphone.', lvl > 0.02 ? 'good' : 'error'); } catch { toast('Microphone access was denied. Voice chat stays off; you can still hear others and use text chat.', 'error', 6000); } } }, 'Test mic');
      body.append(
        row('Master volume', null, slider('masterVolume', 0, 1, 0.01)),
        row('Effects', null, slider('sfxVolume', 0, 1, 0.01)),
        row('Ambience', null, slider('ambienceVolume', 0, 1, 0.01)),
        row('Music', null, slider('musicVolume', 0, 1, 0.01)),
        row('Voice chat volume', null, slider('voiceVolume', 0, 2, 0.01)),
        row('Voice mode', 'Push-to-talk uses the push-to-talk key', select('voiceMode', [['open', 'Open mic'], ['ptt', 'Push to talk'], ['off', 'Microphone off']])),
        row('Open-mic threshold', 'Below this level your mic stays silent', slider('voiceThreshold', 0.02, 0.4, 0.01)),
        row('Microphone gain', null, slider('micGain', 0.2, 3, 0.05)),
        row('Microphone', null, devSel),
        row('Microphone test', null, h('div', { class: 'row', style: { width: '100%' } }, h('div', { style: { flex: 1, height: '6px', background: 'var(--line-2)' } }, meter), testBtn)),
        row('Dispatcher voice', 'Reads dispatcher messages aloud (system speech)', toggle('dispatcherVoice')),
      );
    } else if (tab === 'controls') {
      body.append(
        row('Mouse sensitivity', null, slider('sensitivity', 0.2, 3, 0.05, (v) => v.toFixed(2))),
        row('Invert Y axis', null, toggle('invertY')),
        row('Toggle crouch', 'Press once instead of holding', toggle('toggleCrouch')),
        row('Toggle sprint', null, toggle('toggleSprint')),
        h('div', { class: 'kicker', style: { margin: '16px 0 6px' } }, 'Key bindings — click to rebind, Esc to cancel. Mouse: hold LMB to carry, RMB to throw, wheel to change distance.'),
      );
      const conflicts = d.input.conflicts();
      for (const a of Object.keys(ACTIONS) as Action[]) {
        const keys = s.data.binds[a] ?? [];
        const caps = [0, 1].map((i) => {
          const code = keys[i] ?? '';
          const cap = h('button', { class: 'keycap' + (code && conflicts.has(code) ? ' conflict' : ''), title: code && conflicts.has(code) ? `Also bound to: ${conflicts.get(code)!.filter((x) => x !== a).map((x) => ACTIONS[x]).join(', ')}` : '' }, code ? keyLabel(code) : '—');
          cap.addEventListener('click', () => {
            cap.classList.add('capturing'); cap.textContent = '…';
            d.input.captureNext((c) => {
              const next = [...(s.data.binds[a] ?? [])];
              if (c === 'Escape' && a !== 'pause') { render(); return; }
              if (c === 'Backspace' || c === 'Delete') next.splice(i, 1); else next[i] = c;
              s.set('binds', { ...s.data.binds, [a]: next.filter(Boolean) });
              render();
            });
          });
          return cap;
        });
        body.append(row(ACTIONS[a], null, h('div', { class: 'row' }, ...caps)));
      }
      body.append(h('div', { class: 'row', style: { marginTop: '12px' } }, h('button', { class: 'btn small', onclick: () => { s.resetBinds(); render(); } }, 'Reset key bindings')));
    } else if (tab === 'access') {
      body.append(
        row('Subtitles for important sounds', 'Shows captions with direction', toggle('subtitles')),
        row('Colour-blind filter', null, select('colorblind', [['off', 'Off'], ['deuter', 'Deuteranopia'], ['protan', 'Protanopia'], ['tritan', 'Tritanopia']])),
        row('Interface scale', null, slider('uiScale', 0.8, 1.4, 0.05)),
        row('Head bob', null, slider('headBob', 0, 1.5, 0.05)),
        row('Camera shake', null, slider('cameraShake', 0, 1.5, 0.05)),
        row('Reduce light flicker', 'Softens strobing lights (photosensitivity)', toggle('reduceFlicker')),
        row('Crosshair', null, select('crosshair', [['dot', 'Dot'], ['cross', 'Cross'], ['none', 'None']])),
        row('High-contrast prompts', null, toggle('highContrast')),
      );
    } else {
      const name = h('input', { type: 'text', value: s.data.name, maxLength: 18 }) as HTMLInputElement;
      const codeBox = h('input', { type: 'text', value: '••••••••••••', readOnly: true, style: { width: '100%', fontFamily: 'var(--font-mono)' } }) as HTMLInputElement;
      body.append(
        row('Player ID', null, h('span', { class: 'mono muted' }, d.playerId() || '—')),
        row('Recovery code', 'Your progress is tied to this secret code. Keep it to restore your profile on another browser or device.', h('div', { class: 'col', style: { width: '100%' } }, codeBox,
          h('div', { class: 'row' },
            h('button', { class: 'btn small', onclick: () => { codeBox.value = d.token() ?? ''; } }, 'Reveal'),
            h('button', { class: 'btn small', onclick: () => { const t = d.token(); if (t) navigator.clipboard?.writeText(t).then(() => toast('Recovery code copied. Store it somewhere safe.', 'good')); } }, 'Copy')))),
        row('Restore a profile', 'Paste a recovery code from another device', h('button', { class: 'btn small', onclick: () => {
          const inp = h('input', { type: 'text', placeholder: 'Recovery code', style: { width: '100%', fontFamily: 'var(--font-mono)' } }) as HTMLInputElement;
          modal('Restore profile', inp, [{ label: 'Cancel' }, { label: 'Restore', kind: 'primary', run: () => { if (inp.value.trim().length > 20) d.importToken(inp.value.trim()); else toast('That code looks incomplete.', 'error'); } }]);
          setTimeout(() => inp.focus(), 50);
        } }, 'Enter code')),
        row('Reset all settings', 'Restores default graphics, audio, controls and accessibility', h('button', { class: 'btn small danger', onclick: () => modal('Reset settings', 'Restore every setting to its default value?', [{ label: 'Cancel' }, { label: 'Reset', kind: 'danger', run: () => { const nm = s.data.name; s.patch({ ...structuredClone(DEFAULT_SETTINGS), name: nm }); render(); } }]) }, 'Reset')),
      );
      void name;
    }
  };
  render();
  return h('div', { class: 'screen page scrim-full' },
    h('div', { class: 'page-head' }, h('button', { class: 'btn small', onclick: () => { d.input.cancelCapture(); d.back(); } }, '← Back'), h('div', { class: 'col', style: { gap: '2px' } }, h('div', { class: 'kicker' }, 'Options'), h('h2', { class: 'h-display' }, 'Settings'))),
    tabs, body,
  );
}
