// Menu screens: main menu, play, lobby, loading, results, shop, equipment, progression,
// statistics, credits, pause.
import { ACHIEVEMENTS } from '../../../shared/catalog/achievements';
import { DIFFICULTIES } from '../../../shared/catalog/difficulty';
import { COSMETICS, ITEMS, SLOT_TYPES, type CosmeticSlot, type ItemDef, type LoadoutSlot } from '../../../shared/catalog/items';
import { MAP_LIST } from '../../../shared/catalog/maps';
import { MONSTER_LIST } from '../../../shared/catalog/monsters';
import { GAME_VERSION, xpForLevel } from '../../../shared/constants';
import type { MissionResults, RoomInfo } from '../../../shared/protocol';
import type { Profile } from '../../../shared/profile';
import type { ConnStatus } from '../net/Connection';
import { fmt$, fmtTime, h, LOGO_SVG, modal, toast } from './dom';

export interface AppApi {
  profile: Profile | null;
  room: RoomInfo | null;
  status: ConnStatus;
  devMode: boolean;
  chatLog: { name: string; text: string; sys?: boolean }[];
  create(mode: 'coop' | 'solo' | 'practice'): void;
  join(code: string): void;
  leave(): void;
  ready(v: boolean): void;
  kick(id: string): void;
  roomSettings(s: Partial<RoomInfo['settings']>): void;
  start(): void;
  chat(text: string): void;
  buy(item: string): void;
  setLoadout(slot: LoadoutSlot, item: string | null): void;
  setAppearance(slot: CosmeticSlot, id: string): void;
  setName(name: string): void;
  toLobby(): void;
  inviteLink(code: string): string;
  ui(sound: string): void;
  openSettings(back: () => void): void;
  resume(): void;
  abandon(): void;
  leaveMission(): void;
  isHost(): boolean;
  crewVoice(): { id: string; name: string; muted: boolean; volume: number }[];
  setCrewVoice(id: string, muted: boolean, volume: number): void;
}

const ICONS: Record<string, string> = { torch: 'TRC', scan: 'SCN', radar: 'MTR', bolt: 'PRD', radio: 'RAD', med: 'MED', cell: 'PWR', flare: 'FLR', stim: 'STM', decoy: 'DCY', defib: 'DFB', glow: 'GLO', suit: 'PAD', vest: 'VST', boot: 'RUN', sole: 'QUT', harness: 'HRN', pack: 'CEL', glove: 'GLV' };

function header(title: string, kicker: string, back: () => void, api: AppApi, extra?: Node) {
  return h('div', { class: 'page-head' },
    h('button', { class: 'btn small', onclick: () => { api.ui('ui_click'); back(); } }, '← Back'),
    h('div', { class: 'col', style: { gap: '2px' } }, h('div', { class: 'kicker' }, kicker), h('h2', { class: 'h-display' }, title)),
    h('div', { class: 'spacer' }),
    extra ?? null,
    api.profile ? h('div', { class: 'stat-chip', style: { alignItems: 'flex-end' } }, h('div', { class: 'v accent' }, fmt$(api.profile.currency)), h('div', { class: 'k' }, 'Credits')) : null,
  );
}

// ------------------------------------------------------------------------------- main menu
export function mainMenu(api: AppApi, nav: (screen: string) => void): HTMLElement {
  const p = api.profile;
  const item = (i: number, label: string, to: string, major = false) => h('button', { class: 'menu-item' + (major ? ' major' : ''), onmouseenter: () => api.ui('ui_hover'), onclick: () => { api.ui('ui_click'); nav(to); } }, h('span', { class: 'idx' }, String(i).padStart(2, '0')), label);
  const nameInput = h('input', { type: 'text', value: p?.name ?? '', maxLength: 18, placeholder: 'Callsign', style: { width: '170px' } }) as HTMLInputElement;
  nameInput.addEventListener('change', () => api.setName(nameInput.value));
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') nameInput.blur(); });
  return h('div', { class: 'screen menu scrim' },
    h('div', { class: 'logo', html: '' },
      h('div', { html: LOGO_SVG }),
      h('h1', null, 'Salvage', h('br'), h('span', null, 'Shift')),
      h('div', { class: 'tag' }, 'Greyline Recovery Co. · Contract salvage'),
    ),
    h('nav', { class: 'menu-list' },
      item(1, 'Play', 'play', true),
      item(2, 'Multiplayer', 'multiplayer'),
      item(3, 'Solo', 'solo'),
      item(4, 'Practice', 'practice'),
      item(5, 'Equipment', 'equipment'),
      item(6, 'Shop', 'shop'),
      item(7, 'Progression', 'progression'),
      item(8, 'Statistics', 'stats'),
      item(9, 'Settings', 'settings'),
      item(10, 'Credits', 'credits'),
    ),
    h('div', { class: 'menu-footer' },
      h('div', { class: 'col', style: { gap: '4px' } }, h('div', { class: 'kicker' }, 'Callsign'), nameInput),
      p ? h('div', { class: 'stat-chip' }, h('div', { class: 'v' }, `LV ${p.level}`), h('div', { class: 'k' }, 'Level')) : null,
      p ? h('div', { class: 'stat-chip' }, h('div', { class: 'v accent' }, fmt$(p.currency)), h('div', { class: 'k' }, 'Credits')) : null,
      p ? h('div', { class: 'stat-chip' }, h('div', { class: 'v' }, String(p.stats.successes)), h('div', { class: 'k' }, 'Contracts')) : null,
      h('div', { class: 'spacer' }),
      h('div', { class: 'conn ' + api.status }, h('i'), api.status === 'online' ? 'Connected' : api.status === 'offline' ? 'Offline' : 'Connecting…'),
      h('div', { class: 'kicker' }, `v${GAME_VERSION}`),
    ),
  );
}

// ------------------------------------------------------------------------------- play
export function playScreen(api: AppApi, back: () => void, focus: 'all' | 'multi' = 'all'): HTMLElement {
  const code = h('input', { type: 'text', placeholder: 'ROOM CODE', maxLength: 8, style: { fontFamily: 'var(--font-mono)', letterSpacing: '.3em', textTransform: 'uppercase', fontSize: '1.2em', width: '220px' } }) as HTMLInputElement;
  const join = () => { const c = code.value.trim().toUpperCase(); if (c.length < 4) { toast('Enter the room code your crew shared.', 'error'); return; } api.join(c); };
  code.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
  const online = api.status === 'online';
  const card = (title: string, desc: string, action: Node) => h('div', { class: 'card panel', style: { padding: '20px 22px', gap: '12px' } }, h('div', { class: 'title' }, title), h('div', { class: 'desc' }, desc), action);
  return h('div', { class: 'screen page scrim-full' },
    header(focus === 'multi' ? 'Multiplayer' : 'Play', 'Choose your shift', back, api),
    !online ? h('div', { class: 'panel', style: { padding: '12px 16px' } }, h('span', { class: 'danger' }, 'Not connected to the game server. '), 'Missions, progress and the shop need a server connection. Reconnecting automatically…') : null,
    h('div', { class: 'grid', style: { gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' } },
      card('Create crew', 'Open a private lobby for up to four players. Share the room code or invite link with friends anywhere on the internet.', h('button', { class: 'btn primary', disabled: !online, onclick: () => api.create('coop') }, 'Create lobby')),
      card('Join crew', 'Enter the room code from your host.', h('div', { class: 'row' }, code, h('button', { class: 'btn primary', disabled: !online, onclick: join }, 'Join'))),
      focus === 'all' ? card('Solo contract', 'Take a contract alone. Quota and creature presence are scaled for one salvager.', h('button', { class: 'btn', disabled: !online, onclick: () => api.create('solo') }, 'Start solo')) : null,
      focus === 'all' ? card('Practice facility', 'A safe training hall: movement, physics handling, co-op lifting, doors, power, cargo tubes and every tool. No creatures, no rewards.', h('button', { class: 'btn', disabled: !online, onclick: () => api.create('practice') }, 'Enter practice')) : null,
    ),
  );
}

// ------------------------------------------------------------------------------- lobby
export function lobbyScreen(api: AppApi, room: RoomInfo, nav: (s: string) => void): HTMLElement {
  const me = room.members.find((m) => m.id === api.profile?.id);
  const isHost = room.hostId === api.profile?.id;
  const hostLevel = room.members.find((m) => m.host)?.level ?? 1;
  const allReady = room.members.filter((m) => !m.host && m.connected).every((m) => m.ready);
  const suitColor = (id: string) => COSMETICS.find((c) => c.id === id)?.color ?? '#c8642a';
  const slots = [];
  for (let i = 0; i < room.maxPlayers; i++) {
    const m = room.members[i];
    if (!m) { slots.push(h('div', { class: 'member empty' }, h('div'), h('div', null, 'Open slot'), h('div'), h('div'))); continue; }
    slots.push(h('div', { class: 'member' },
      h('div', { class: 'avatar', style: { background: suitColor(m.appearance.suit) } }, m.name.slice(0, 1).toUpperCase()),
      h('div', { class: 'col', style: { gap: '2px' } },
        h('div', { class: 'name' }, m.name, m.host ? h('span', { class: 'badge accent', style: { marginLeft: '8px' } }, 'Host') : null, m.id === api.profile?.id ? h('span', { class: 'badge', style: { marginLeft: '6px' } }, 'You') : null),
        h('div', { class: 'meta' }, `LV ${m.level} · ${m.connected ? `${m.ping} ms` : 'connection lost'}`)),
      m.host ? h('span', { class: 'ready-pill on' }, 'Host') : h('span', { class: 'ready-pill' + (m.ready ? ' on' : '') }, m.ready ? 'Ready' : 'Not ready'),
      isHost && !m.host ? h('button', { class: 'btn small danger', onclick: () => modal('Remove crew member', `Remove ${m.name} from the lobby?`, [{ label: 'Cancel' }, { label: 'Remove', kind: 'danger', run: () => api.kick(m.id) }]) }, 'Kick') : h('div'),
    ));
  }
  const link = api.inviteLink(room.code);
  const chatIn = h('input', { type: 'text', placeholder: 'Message the crew…', maxLength: 200, style: { flex: 1 } }) as HTMLInputElement;
  chatIn.addEventListener('keydown', (e) => { if (e.key === 'Enter' && chatIn.value.trim()) { api.chat(chatIn.value); chatIn.value = ''; } });
  const log = h('div', { class: 'chat-log scroll' }, ...api.chatLog.slice(-60).map((c) => c.sys ? h('div', { class: 'sys' }, c.text) : h('div', null, h('b', null, c.name + ': '), c.text)));
  setTimeout(() => (log.scrollTop = log.scrollHeight), 0);
  const maps = h('div', { class: 'map-pick' },
    h('button', { class: 'map-opt' + (room.settings.map === 'random' ? ' sel' : ''), disabled: !isHost || room.mode === 'practice', onclick: () => api.roomSettings({ map: 'random' }) }, h('div', { class: 'n' }, 'Random'), h('div', { class: 't' }, 'Any unlocked facility')),
    ...MAP_LIST.map((m) => h('button', { class: 'map-opt' + (room.settings.map === m.id ? ' sel' : ''), disabled: !isHost || room.mode === 'practice' || (m.unlockLevel > hostLevel && !api.devMode), title: m.description, onclick: () => api.roomSettings({ map: m.id }) },
      h('div', { class: 'n' }, m.name), h('div', { class: 't' }, m.unlockLevel > hostLevel && !api.devMode ? `Unlocks at host level ${m.unlockLevel}` : m.tagline))),
  );
  const diffs = h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '6px' } }, ...DIFFICULTIES.map((d) => h('button', { class: 'btn small' + (room.settings.difficulty === d.index ? ' primary' : ''), disabled: !isHost || room.mode === 'practice' || (d.unlockLevel > hostLevel && !api.devMode), title: d.description, onclick: () => api.roomSettings({ difficulty: d.index }) }, d.name)));
  const dDef = DIFFICULTIES[room.settings.difficulty];
  return h('div', { class: 'screen page scrim-full' },
    h('div', { class: 'page-head' },
      h('div', { class: 'col', style: { gap: '2px' } }, h('div', { class: 'kicker' }, room.mode === 'practice' ? 'Practice lobby' : room.mode === 'solo' ? 'Solo contract' : 'Crew lobby'), h('h2', { class: 'h-display' }, room.mode === 'practice' ? 'Practice' : 'Crew room')),
      h('div', { class: 'spacer' }),
      room.streak ? h('div', { class: 'stat-chip', style: { alignItems: 'flex-end' } }, h('div', { class: 'v accent' }, `×${room.streak}`), h('div', { class: 'k' }, 'Contract streak')) : null,
      h('button', { class: 'btn small', onclick: () => nav('equipment') }, 'Equipment'),
      h('button', { class: 'btn small', onclick: () => nav('shop') }, 'Shop'),
      h('button', { class: 'btn small', onclick: () => nav('settings') }, 'Settings'),
      h('button', { class: 'btn small danger', onclick: () => api.leave() }, 'Leave lobby'),
    ),
    h('div', { class: 'lobby' },
      h('div', { class: 'col', style: { minHeight: 0 } },
        room.mode === 'coop' ? h('div', { class: 'code-box panel' },
          h('div', { class: 'col', style: { gap: '4px' } }, h('div', { class: 'kicker' }, 'Room code'), h('div', { class: 'code' }, room.code)),
          h('div', { class: 'spacer' }),
          h('div', { class: 'col', style: { gap: '6px' } },
            h('button', { class: 'btn small', onclick: () => { navigator.clipboard?.writeText(room.code).then(() => toast('Room code copied.', 'good')).catch(() => toast(room.code)); } }, 'Copy code'),
            h('button', { class: 'btn small', onclick: () => { navigator.clipboard?.writeText(link).then(() => toast('Invite link copied. Send it to your crew.', 'good')).catch(() => toast(link)); } }, 'Copy invite link'))) : null,
        h('div', { class: 'panel' }, ...slots),
        h('div', { class: 'panel chat', style: { minHeight: '160px' } }, log, h('div', { class: 'row', style: { padding: '8px', borderTop: '1px solid var(--line)' } }, chatIn)),
      ),
      h('div', { class: 'col', style: { minHeight: 0 } },
        h('div', { class: 'panel col', style: { padding: '16px' } },
          h('div', { class: 'kicker' }, 'Facility'), maps,
          room.mode !== 'practice' ? h('div', { class: 'kicker', style: { marginTop: '6px' } }, 'Difficulty') : null, room.mode !== 'practice' ? diffs : null,
          room.mode !== 'practice' ? h('div', { class: 'muted', style: { fontSize: '.85em' } }, `${dDef.description} Rewards ×${dDef.rewardMult.toFixed(2)}.`) : null,
          room.mode === 'coop' ? h('div', { class: 'row', style: { marginTop: '6px' } }, h('button', { class: 'toggle' + (room.settings.voiceNoise ? ' on' : ''), disabled: !isHost, onclick: () => api.roomSettings({ voiceNoise: !room.settings.voiceNoise }) }), h('div', { class: 'col', style: { gap: 0 } }, h('div', null, 'Creatures hear voice chat'), h('small', { class: 'muted' }, 'Talking loudly makes noise in the facility'))) : null,
          !isHost ? h('div', { class: 'muted', style: { fontSize: '.85em' } }, 'The host chooses the facility and difficulty.') : null,
        ),
        h('div', { class: 'spacer' }),
        h('div', { class: 'panel col', style: { padding: '16px' } },
          room.phase === 'results' && room.lastResult ? h('div', { class: 'muted' }, `Last contract: ${room.lastResult.success ? 'success' : 'failed'} · ${fmt$(room.lastResult.value)}`) : null,
          isHost
            ? h('button', { class: 'btn primary', style: { fontSize: '1.3em', padding: '.8em' }, disabled: room.phase !== 'lobby' || (!allReady && room.members.length > 1), onclick: () => api.start() }, room.mode === 'practice' ? 'Enter practice facility' : allReady || room.members.length === 1 ? 'Start contract' : 'Waiting for crew to ready up')
            : h('button', { class: 'btn ' + (me?.ready ? '' : 'primary'), style: { fontSize: '1.3em', padding: '.8em' }, onclick: () => api.ready(!me?.ready) }, me?.ready ? 'Not ready' : 'Ready up'),
        ),
      ),
    ),
  );
}

// ------------------------------------------------------------------------------- loading
const TIPS = [
  'Heavy objects drag along the floor if you can\'t lift them. Grab them together with a crewmate.',
  'Fragile valuables lose value every time they bump into something. Carry them slowly.',
  'Small items can go up the pneumatic cargo tubes, which bank their value instantly. They need power.',
  'Running is loud. Crouching is nearly silent.',
  'Some creatures are drawn to sound. Some to light. Learn which is which.',
  'The quota is the minimum. Staying past the contract window invites something worse.',
  'If a crewmate goes down, hold interact on them to get them back up.',
  'Keycards for locked vaults are always somewhere you can reach.',
  'Press G to ping a location for your crew.',
];
export function loadingScreen(): { el: HTMLElement; set: (f: number, label: string) => void } {
  const bar = h('i', { style: { width: '0%' } });
  const label = h('div', { class: 'kicker' }, 'Preparing');
  const tip = h('div', { class: 'tip' }, TIPS[Math.floor(Math.random() * TIPS.length)]);
  const el = h('div', { class: 'screen loading' }, h('div', { html: LOGO_SVG, style: { width: '40px', opacity: .8 } }), label, h('div', { class: 'bar' }, bar), tip);
  return { el, set: (f, l) => { bar.style.width = `${Math.round(f * 100)}%`; label.textContent = l; } };
}

// ------------------------------------------------------------------------------- results
export function resultsScreen(api: AppApi, r: MissionResults, cont: () => void): HTMLElement {
  const me = r.players.find((p) => p.id === api.profile?.id);
  const prof = api.profile;
  const isHost = api.isHost();
  const xpNeed = prof ? xpForLevel(prof.level) : 1;
  const xpBar = h('i', { style: { width: '0%' } });
  setTimeout(() => { if (prof) xpBar.style.width = `${Math.min(100, (prof.xp / xpNeed) * 100)}%`; }, 80);
  const cell = (k: string, v: string, cls = '') => h('div', { class: 'res-cell panel' }, h('div', { class: 'kicker' }, k), h('div', { class: 'v ' + cls }, v));
  return h('div', { class: 'screen results scrim-full' },
    h('div', { class: 'res-head' },
      h('div', { class: 'col', style: { gap: '6px' } }, h('div', { class: 'kicker' }, MAP_LIST.find((m) => m.id === r.map)?.name ?? 'Practice facility'), h('h2', { class: 'h-display ' + (r.success ? 'ok' : 'fail') }, r.success ? 'Contract complete' : 'Contract failed'), h('div', { class: 'muted' }, r.reason)),
      h('div', { class: 'spacer' }),
      h('button', { class: 'btn primary', style: { fontSize: '1.2em' }, onclick: () => cont() }, isHost ? 'Continue to lobby' : 'Continue'),
    ),
    h('div', { class: 'res-grid' },
      cell('Extracted', fmt$(r.extracted), 'accent'), cell('Cargo tubes', fmt$(r.tubed)), cell('Quota', fmt$(r.quota)), cell('Value lost', fmt$(r.lostValue), 'danger'), cell('Time', fmtTime(r.duration)),
      cell('Streak', r.success ? `×${r.streak}` : 'Reset'),
      me ? cell('You earned', fmt$(me.earned), 'good') : null, me ? cell('XP', `+${me.xp}`) : null,
    ),
    r.bonus.length ? h('div', { class: 'panel', style: { padding: '12px 16px' } }, h('div', { class: 'kicker' }, 'Objectives'), ...r.bonus.map((b) => h('div', { class: 'row' }, h('span', { class: 'good' }, '✓ ' + b.label), h('span', { class: 'spacer' }), h('span', { class: 'mono' }, '+' + fmt$(b.amount))))) : null,
    h('div', { class: 'panel scroll', style: { flex: 1, minHeight: 0 } },
      h('table', { class: 'res-table' },
        h('thead', null, h('tr', null, ...['Crew', 'Status', 'Delivered', 'Items', 'Revives', 'Damage taken', 'Earned', 'XP', 'Level'].map((t) => h('th', null, t)))),
        h('tbody', null, ...r.players.map((p) => h('tr', null,
          h('td', { class: 'n' }, p.name), h('td', { class: p.state === 'extracted' ? 'good' : p.state === 'left' ? 'muted' : 'danger' }, p.state === 'extracted' ? 'Extracted' : p.state === 'dead' ? 'Lost' : p.state === 'left' ? 'Left' : 'Left behind'),
          h('td', null, fmt$(p.delivered)), h('td', null, String(p.items)), h('td', null, String(p.revives)), h('td', null, String(p.damageTaken)), h('td', { class: 'accent' }, fmt$(p.earned)), h('td', null, `+${p.xp}`),
          h('td', null, p.levelAfter > p.levelBefore ? h('span', { class: 'accent' }, `${p.levelBefore} → ${p.levelAfter}`) : String(p.levelAfter))))),
      ),
    ),
    prof ? h('div', { class: 'col', style: { gap: '6px' } }, h('div', { class: 'row' }, h('div', { class: 'kicker' }, `Level ${prof.level}`), h('div', { class: 'spacer' }), h('div', { class: 'kicker' }, `${prof.xp} / ${xpNeed} XP`)), h('div', { class: 'xpbar' }, xpBar)) : null,
    me?.newAchievements.length ? h('div', { class: 'panel', style: { padding: '12px 16px' } }, h('div', { class: 'kicker' }, 'Achievements unlocked'), ...me.newAchievements.map((a) => { const d = ACHIEVEMENTS.find((x) => x.id === a); return h('div', { class: 'row' }, h('span', { class: 'accent' }, '★ ' + (d?.name ?? a)), h('span', { class: 'muted' }, d?.description ?? ''), h('span', { class: 'spacer' }), h('span', { class: 'mono' }, d ? '+' + fmt$(d.reward) : '')); })) : null,
  );
}

// ------------------------------------------------------------------------------- shop
export function shopScreen(api: AppApi, back: () => void): HTMLElement {
  const p = api.profile;
  let tab: 'gear' | 'supplies' | 'cosmetics' = 'gear';
  const body = h('div', { class: 'grid scroll', style: { flex: 1, minHeight: 0 } });
  const tabs = h('div', { class: 'tabs' });
  const render = () => {
    tabs.replaceChildren(...(['gear', 'supplies', 'cosmetics'] as const).map((t) => h('button', { class: 'tab' + (t === tab ? ' active' : ''), onclick: () => { tab = t; render(); } }, t === 'gear' ? 'Tools & gear' : t === 'supplies' ? 'Supplies' : 'Cosmetics')));
    body.replaceChildren();
    if (!p) return;
    if (tab === 'cosmetics') {
      for (const c of COSMETICS) {
        const owned = p.owned.includes(c.id) || (c.achievement && p.achievements[c.achievement]);
        const locked = p.level < c.unlockLevel;
        const ach = c.achievement ? ACHIEVEMENTS.find((a) => a.id === c.achievement) : null;
        body.append(h('div', { class: 'card panel' + (owned ? ' owned' : locked ? ' locked' : '') },
          h('div', { class: 'row' }, c.color ? h('div', { class: 'swatch', style: { background: c.color } }) : h('div', { class: 'icon-glyph' }, c.slot.slice(0, 3).toUpperCase()), h('div', { class: 'col', style: { gap: 0 } }, h('div', { class: 'title' }, c.name), h('div', { class: 'kicker' }, c.slot))),
          h('div', { class: 'desc' }, ach ? `Unlocked by the achievement "${ach.name}".` : 'Visible to your crew in the lobby and in the field.'),
          h('div', { class: 'foot' }, owned ? h('span', { class: 'badge good' }, 'Owned') : ach ? h('span', { class: 'badge' }, 'Achievement') : locked ? h('span', { class: 'badge' }, `Level ${c.unlockLevel}`) : h('span', { class: 'price' }, fmt$(c.price)),
            !owned && !ach ? h('button', { class: 'btn small primary', disabled: locked || p.currency < c.price, onclick: () => api.buy(c.id) }, 'Buy') : null)));
      }
      return;
    }
    const list = ITEMS.filter((i) => (tab === 'supplies' ? i.type === 'consumable' : i.type !== 'consumable') && i.price > 0);
    for (const it of list) body.append(itemCard(api, it, p));
  };
  render();
  return h('div', { class: 'screen page scrim-full' }, header('Company store', 'Greyline field equipment', back, api), tabs, body);
}

function itemCard(api: AppApi, it: ItemDef, p: Profile) {
  const owned = it.type !== 'consumable' && p.owned.includes(it.id);
  const count = p.inventory[it.id] ?? 0;
  const locked = p.level < it.unlockLevel;
  const full = it.type === 'consumable' && count >= (it.maxStack ?? 1);
  return h('div', { class: 'card panel' + (owned ? ' owned' : locked ? ' locked' : '') },
    h('div', { class: 'row' }, h('div', { class: 'icon-glyph' }, ICONS[it.icon] ?? 'ITM'), h('div', { class: 'col', style: { gap: 0 } }, h('div', { class: 'title' }, it.name), h('div', { class: 'kicker' }, it.type === 'consumable' ? `Supply · carrying ${count}/${it.maxStack}` : it.type))),
    h('div', { class: 'desc' }, it.description),
    h('div', { class: 'foot' },
      owned ? h('span', { class: 'badge good' }, 'Owned') : locked ? h('span', { class: 'badge' }, `Level ${it.unlockLevel}`) : h('span', { class: 'price' }, fmt$(it.price)),
      !owned ? h('button', { class: 'btn small primary', disabled: locked || full || p.currency < it.price, onclick: () => api.buy(it.id) }, full ? 'Full' : 'Buy') : null));
}

// ------------------------------------------------------------------------------- equipment
export function equipmentScreen(api: AppApi, back: () => void): HTMLElement {
  const p = api.profile;
  if (!p) return h('div', { class: 'screen page scrim-full' }, header('Equipment', 'Loadout', back, api), h('div', { class: 'muted' }, 'Connecting…'));
  let sel: LoadoutSlot | CosmeticSlot = 'light';
  const left = h('div', { class: 'col', style: { width: '340px', flex: 'none' } });
  const right = h('div', { class: 'grid scroll', style: { flex: 1, minHeight: 0 } });
  const SLOT_NAMES: Record<string, string> = { light: 'Torch', tool1: 'Tool 1 [4]', tool2: 'Tool 2 [5]', quick1: 'Quick 1 [1]', quick2: 'Quick 2 [2]', quick3: 'Quick 3 [3]', body: 'Body', utility: 'Utility', suit: 'Suit colour', helmet: 'Helmet', visor: 'Visor', patch: 'Patch' };
  const render = () => {
    const pr = api.profile!;
    const slotBtn = (s: LoadoutSlot | CosmeticSlot) => {
      const isCos = ['suit', 'helmet', 'visor', 'patch'].includes(s);
      const val = isCos ? pr.appearance[s as CosmeticSlot] : pr.loadout[s as LoadoutSlot];
      const name = isCos ? COSMETICS.find((c) => c.id === val)?.name : val ? ITEMS.find((i) => i.id === val)?.name : 'Empty';
      return h('button', { class: 'card panel' + (sel === s ? ' selected' : ''), style: { cursor: 'pointer', padding: '10px 12px', textAlign: 'left' }, onclick: () => { sel = s; render(); } },
        h('div', { class: 'kicker' }, SLOT_NAMES[s]), h('div', { class: 'row' }, h('div', { style: { fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: '1.1em', textTransform: 'uppercase', letterSpacing: '.04em' } }, name ?? 'Empty'), (s as string).startsWith('quick') && val ? h('span', { class: 'badge' }, `×${pr.inventory[val as string] ?? 0}`) : null));
    };
    left.replaceChildren(h('div', { class: 'kicker' }, 'Loadout'), ...(Object.keys(SLOT_TYPES) as LoadoutSlot[]).map(slotBtn), h('div', { class: 'kicker', style: { marginTop: '10px' } }, 'Appearance'), ...(['suit', 'helmet', 'visor', 'patch'] as CosmeticSlot[]).map(slotBtn));
    right.replaceChildren();
    if (['suit', 'helmet', 'visor', 'patch'].includes(sel)) {
      for (const c of COSMETICS.filter((c) => c.slot === sel)) {
        const owned = pr.owned.includes(c.id) || (c.achievement && pr.achievements[c.achievement]);
        const on = pr.appearance[sel as CosmeticSlot] === c.id;
        right.append(h('div', { class: 'card panel' + (on ? ' selected' : owned ? '' : ' locked') }, h('div', { class: 'row' }, c.color ? h('div', { class: 'swatch', style: { background: c.color } }) : h('div', { class: 'icon-glyph' }, c.slot.slice(0, 3).toUpperCase()), h('div', { class: 'title' }, c.name)),
          h('div', { class: 'foot' }, on ? h('span', { class: 'badge accent' }, 'Equipped') : owned ? h('button', { class: 'btn small', onclick: () => api.setAppearance(sel as CosmeticSlot, c.id) }, 'Equip') : h('span', { class: 'badge' }, 'Locked — see shop'))));
      }
      return;
    }
    const type = SLOT_TYPES[sel as LoadoutSlot];
    const opts = ITEMS.filter((i) => i.type === type);
    if (sel !== 'light') right.append(h('div', { class: 'card panel' }, h('div', { class: 'title' }, 'Empty slot'), h('div', { class: 'desc' }, 'Leave this slot free.'), h('div', { class: 'foot' }, h('span'), h('button', { class: 'btn small', onclick: () => api.setLoadout(sel as LoadoutSlot, null) }, 'Clear'))));
    for (const it of opts) {
      const have = it.type === 'consumable' ? (pr.inventory[it.id] ?? 0) > 0 : pr.owned.includes(it.id);
      const on = pr.loadout[sel as LoadoutSlot] === it.id;
      right.append(h('div', { class: 'card panel' + (on ? ' selected' : have ? '' : ' locked') },
        h('div', { class: 'row' }, h('div', { class: 'icon-glyph' }, ICONS[it.icon] ?? 'ITM'), h('div', { class: 'col', style: { gap: 0 } }, h('div', { class: 'title' }, it.name), it.type === 'consumable' ? h('div', { class: 'kicker' }, `carrying ${pr.inventory[it.id] ?? 0}`) : null)),
        h('div', { class: 'desc' }, it.description),
        h('div', { class: 'foot' }, on ? h('span', { class: 'badge accent' }, 'Equipped') : have ? h('button', { class: 'btn small', onclick: () => api.setLoadout(sel as LoadoutSlot, it.id) }, 'Equip') : h('span', { class: 'badge' }, it.type === 'consumable' ? 'None — buy in shop' : 'Not owned'))));
    }
  };
  render();
  const el = h('div', { class: 'screen page scrim-full' }, header('Equipment', 'Loadout & appearance', back, api), h('div', { class: 'page-body' }, h('div', { class: 'scroll', style: { width: '340px', flex: 'none' } }, left), right));
  (el as unknown as { refresh: () => void }).refresh = render;
  return el;
}

// ------------------------------------------------------------------------------- progression
export function progressionScreen(api: AppApi, back: () => void): HTMLElement {
  const p = api.profile;
  if (!p) return h('div', { class: 'screen page scrim-full' }, header('Progression', 'Career', back, api));
  const need = xpForLevel(p.level);
  const unlocks = [...ITEMS.filter((i) => i.unlockLevel > 1).map((i) => ({ lvl: i.unlockLevel, name: i.name, kind: 'Equipment' })), ...MAP_LIST.filter((m) => m.unlockLevel > 1).map((m) => ({ lvl: m.unlockLevel, name: m.name, kind: 'Facility' })), ...DIFFICULTIES.filter((d) => d.unlockLevel > 1).map((d) => ({ lvl: d.unlockLevel, name: d.name, kind: 'Difficulty' }))].sort((a, b) => a.lvl - b.lvl);
  return h('div', { class: 'screen page scrim-full' },
    header('Progression', 'Career', back, api),
    h('div', { class: 'page-body' },
      h('div', { class: 'col', style: { width: '380px', flex: 'none' } },
        h('div', { class: 'panel col', style: { padding: '18px' } },
          h('div', { class: 'row' }, h('div', { class: 'h-display', style: { fontSize: '3em' } }, `LV ${p.level}`), h('div', { class: 'spacer' }), h('div', { class: 'kicker' }, `${p.xp} / ${need} XP`)),
          h('div', { class: 'xpbar' }, h('i', { style: { width: `${Math.min(100, (p.xp / need) * 100)}%` } })),
          h('div', { class: 'muted', style: { fontSize: '.85em' } }, 'Earn XP by completing contracts, banking salvage, reviving crew and recovering documents. Every level pays a bonus.')),
        h('div', { class: 'panel col scroll', style: { padding: '14px', flex: 1, minHeight: 0 } }, h('div', { class: 'kicker' }, 'Unlocks'),
          ...unlocks.map((u) => h('div', { class: 'row', style: { opacity: p.level >= u.lvl ? 0.55 : 1 } }, h('span', { class: 'mono', style: { width: '48px' } }, `LV ${u.lvl}`), h('span', null, u.name), h('span', { class: 'spacer' }), h('span', { class: 'badge' + (p.level >= u.lvl ? ' good' : '') }, p.level >= u.lvl ? 'Unlocked' : u.kind)))),
      ),
      h('div', { class: 'col grow', style: { minHeight: 0 } },
        h('div', { class: 'kicker' }, `Achievements · ${Object.keys(p.achievements).length} / ${ACHIEVEMENTS.length}`),
        h('div', { class: 'grid scroll', style: { flex: 1, minHeight: 0 } }, ...ACHIEVEMENTS.map((a) => {
          const got = p.achievements[a.id];
          return h('div', { class: 'card panel' + (got ? ' owned' : ' locked') }, h('div', { class: 'title' }, (got ? '★ ' : '') + a.name), h('div', { class: 'desc' }, a.description), h('div', { class: 'foot' }, h('span', { class: 'price' }, `+${fmt$(a.reward)}`), got ? h('span', { class: 'badge good' }, new Date(got).toLocaleDateString()) : h('span', { class: 'badge' }, 'Locked')));
        })),
      ),
    ),
  );
}

// ------------------------------------------------------------------------------- statistics
export function statsScreen(api: AppApi, back: () => void): HTMLElement {
  const p = api.profile;
  if (!p) return h('div', { class: 'screen page scrim-full' }, header('Statistics', 'Service record', back, api));
  const s = p.stats;
  const cell = (k: string, v: string) => h('div', { class: 'res-cell panel' }, h('div', { class: 'kicker' }, k), h('div', { class: 'v' }, v));
  return h('div', { class: 'screen page scrim-full' },
    header('Statistics', 'Service record', back, api),
    h('div', { class: 'res-grid' },
      cell('Contracts', String(s.missions)), cell('Successful', String(s.successes)), cell('Failed', String(s.failures)), cell('Extractions', String(s.extractions)),
      cell('Value recovered', fmt$(s.valueRecovered)), cell('Best haul', fmt$(s.bestHaul)), cell('Objects delivered', String(s.objectsCollected)), cell('Heaviest item', `${s.heaviestItem} kg`),
      cell('Time in the field', fmtTime(s.playtime)), cell('Creatures encountered', String(s.enemiesEncountered)), cell('Crew revived', String(s.teammatesRescued)), cell('Times downed', String(s.downs)),
      cell('Deaths', String(s.deaths)), cell('Documents', String(s.documentsRead)), cell('Power restored', String(s.powerRestored)), cell('Tube shipments', String(s.tubesSent)),
      cell('Creatures stunned', String(s.stuns)), cell('Best streak', String(s.bestStreak)), cell('Fastest success', s.fastestSuccess ? fmtTime(s.fastestSuccess) : '—'), cell('Highest difficulty', s.highestDifficulty >= 0 ? DIFFICULTIES[s.highestDifficulty].name : '—'),
    ),
    h('div', { class: 'kicker' }, 'Recent contracts'),
    h('div', { class: 'panel scroll', style: { flex: 1, minHeight: 0 } }, h('table', { class: 'res-table' },
      h('thead', null, h('tr', null, ...['Date', 'Facility', 'Difficulty', 'Crew', 'Result', 'Salvage', 'Earned', 'XP'].map((t) => h('th', null, t)))),
      h('tbody', null, ...p.missionLog.map((m) => h('tr', null, h('td', null, new Date(m.at).toLocaleString()), h('td', { class: 'n' }, MAP_LIST.find((x) => x.id === m.map)?.name ?? m.map), h('td', null, DIFFICULTIES[m.difficulty]?.name ?? ''), h('td', null, String(m.crew)), h('td', { class: m.success ? 'good' : 'danger' }, m.success ? 'Success' : 'Failed'), h('td', null, fmt$(m.value)), h('td', { class: 'accent' }, fmt$(m.earned)), h('td', null, `+${m.xp}`)))),
    )),
  );
}

// ------------------------------------------------------------------------------- credits
export function creditsScreen(api: AppApi, back: () => void): HTMLElement {
  const sec = (t: string, ...lines: (string | Node)[]) => h('div', { class: 'col', style: { gap: '4px', marginBottom: '18px' } }, h('div', { class: 'kicker accent' }, t), ...lines.map((l) => (typeof l === 'string' ? h('div', null, l) : l)));
  return h('div', { class: 'screen page scrim-full' },
    header('Credits', 'Salvage Shift', back, api),
    h('div', { class: 'scroll', style: { flex: 1, maxWidth: '760px' } },
      sec('Game', 'Salvage Shift — an original cooperative horror extraction game.', 'Design, engineering, creature sculpting, procedural audio and UI built for this project.'),
      sec('Creatures', ...MONSTER_LIST.map((m) => `${m.name} (${m.codename.toLowerCase()})`)),
      sec('3D models & textures', 'Environment textures and prop models from Poly Haven (polyhaven.com), released under CC0 1.0 (public domain). Thank you to the Poly Haven team and contributors.'),
      sec('Audio', 'All sound effects, ambience and music are synthesised procedurally at runtime.'),
      sec('Technology', 'Three.js (MIT) · Rapier physics by Dimforge (Apache-2.0) · ws (MIT) · Vite (MIT) · meshoptimizer (MIT) · glTF-Transform (MIT).'),
      sec('Fonts', 'Barlow & Barlow Condensed by Jeremy Tribby, JetBrains Mono by JetBrains — SIL Open Font License 1.1.'),
    ),
  );
}

// ------------------------------------------------------------------------------- pause
export function pauseScreen(api: AppApi, opts: { practice: boolean; host: boolean }): HTMLElement {
  const crew = api.crewVoice();
  const main = h('div', { class: 'pause-main' },
    h('div', { class: 'kicker' }, 'Crew'),
    h('div', { class: 'panel', style: { maxWidth: '640px', marginTop: '10px' } }, crew.length ? crew.map((c) => {
      const vol = h('input', { type: 'range', min: 0, max: 2, step: 0.05, value: c.volume, style: { width: '160px' } }) as HTMLInputElement;
      vol.addEventListener('input', () => api.setCrewVoice(c.id, c.muted, Number(vol.value)));
      return h('div', { class: 'member' }, h('div'), h('div', { class: 'name' }, c.name), h('div', { class: 'row' }, h('span', { class: 'kicker' }, 'Voice'), vol), h('button', { class: 'btn small' + (c.muted ? ' danger' : ''), onclick: (e: Event) => { c.muted = !c.muted; api.setCrewVoice(c.id, c.muted, Number(vol.value)); (e.target as HTMLElement).textContent = c.muted ? 'Unmute' : 'Mute'; } }, c.muted ? 'Unmute' : 'Mute'));
    }) : h('div', { class: 'member empty' }, h('div'), h('div', null, 'No other crew members'), h('div'), h('div'))),
  );
  return h('div', { class: 'screen pause' },
    h('div', { class: 'pause-side' },
      h('div', { class: 'kicker' }, 'Paused'), h('h2', { class: 'h-display', style: { fontSize: '3em' } }, 'Shift on hold'),
      h('div', { class: 'muted', style: { fontSize: '.85em' } }, 'The facility keeps running while you are in this menu.'),
      h('button', { class: 'btn primary', onclick: () => api.resume() }, 'Resume'),
      h('button', { class: 'btn', onclick: () => api.openSettings(() => api.resume()) }, 'Settings'),
      opts.host ? h('button', { class: 'btn danger', onclick: () => modal(opts.practice ? 'End practice' : 'Abandon contract', opts.practice ? 'Return the crew to the lobby?' : 'Abandon the contract for the whole crew? Salvage already sent up the tubes is still paid at half rate.', [{ label: 'Cancel' }, { label: opts.practice ? 'End practice' : 'Abandon', kind: 'danger', run: () => api.abandon() }]) }, opts.practice ? 'End practice (crew)' : 'Abandon contract (crew)') : null,
      h('button', { class: 'btn danger', onclick: () => modal('Leave mission', 'Leave this mission? You will not be paid for it.', [{ label: 'Cancel' }, { label: 'Leave', kind: 'danger', run: () => api.leaveMission() }]) }, 'Leave mission'),
      h('div', { class: 'spacer' }),
    ),
    main,
  );
}
