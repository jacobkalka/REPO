// Shop items, equipment and cosmetics. Every item has a gameplay function implemented in
// server/src/sim/Equipment.ts (authoritative) and client/src/game/Equipment.ts (presentation).

export type ItemType = 'light' | 'tool' | 'consumable' | 'body' | 'utility' | 'cosmetic';
export type LoadoutSlot = 'light' | 'tool1' | 'tool2' | 'quick1' | 'quick2' | 'quick3' | 'body' | 'utility';

export interface ItemDef {
  id: string;
  name: string;
  type: ItemType;
  price: number;
  unlockLevel: number;
  maxStack?: number;          // consumables
  description: string;
  stats: Record<string, number>;
  icon: string;               // ui glyph key
}

export const ITEMS: ItemDef[] = [
  // --- Lights
  { id: 'light_t1', name: 'Service Torch', type: 'light', price: 0, unlockLevel: 1, icon: 'torch', description: 'Standard-issue torch. Reliable, narrow, and the battery never lasts long enough.', stats: { range: 17, angle: 0.44, intensity: 44, battery: 240 } },
  { id: 'light_t2', name: 'Halogen Torch', type: 'light', price: 1900, unlockLevel: 3, icon: 'torch', description: 'Wider, brighter halogen beam with a longer-life cell.', stats: { range: 22, angle: 0.52, intensity: 70, battery: 360 } },
  { id: 'light_t3', name: 'Arc Lantern', type: 'light', price: 5400, unlockLevel: 8, icon: 'torch', description: 'Arc-discharge lamp. A flood of white light that drives light-shy creatures back twice as fast.', stats: { range: 28, angle: 0.6, intensity: 110, battery: 480, repel: 2 } },
  // --- Tools
  { id: 'scanner', name: 'Appraisal Scanner', type: 'tool', price: 2400, unlockLevel: 2, icon: 'scan', description: 'Emits a pulse that reveals valuables and their worth through walls within 22 m for 6 seconds.', stats: { radius: 22, duration: 6, cooldown: 18, battery: 8 } },
  { id: 'tracker', name: 'Motion Tracker', type: 'tool', price: 3600, unlockLevel: 5, icon: 'radar', description: 'While active, shows anything moving within 26 m on your HUD. Drains battery.', stats: { radius: 26, drain: 1.1 } },
  { id: 'prod', name: 'Shock Prod', type: 'tool', price: 4200, unlockLevel: 6, icon: 'bolt', description: 'Stuns a creature in front of you for 3.5 s. Three charges; each recharges in 30 s.', stats: { range: 2.6, stun: 3.5, charges: 3, recharge: 30 } },
  { id: 'radio', name: 'Field Radio', type: 'tool', price: 1500, unlockLevel: 2, icon: 'radio', description: 'Hold the radio key to transmit to every crew member carrying a radio, anywhere in the facility.', stats: {} },
  // --- Consumables
  { id: 'medkit', name: 'Trauma Kit', type: 'consumable', price: 450, unlockLevel: 1, maxStack: 5, icon: 'med', description: 'Restores 50 health over 2.5 s. Look at a teammate to treat them instead.', stats: { heal: 50, time: 2.5 } },
  { id: 'battery', name: 'Power Cell', type: 'consumable', price: 220, unlockLevel: 1, maxStack: 6, icon: 'cell', description: 'Fully recharges your torch and tools.', stats: {} },
  { id: 'flare', name: 'Road Flare', type: 'consumable', price: 160, unlockLevel: 1, maxStack: 8, icon: 'flare', description: 'Throwable red flare that burns for 75 s. Light-shy creatures keep away from it.', stats: { duration: 75, radius: 7 } },
  { id: 'stim', name: 'Adrenal Stim', type: 'consumable', price: 600, unlockLevel: 3, maxStack: 4, icon: 'stim', description: '20 s of unlimited stamina, +15% speed and 25% damage resistance. You crash afterwards.', stats: { duration: 20, speed: 1.15, resist: 0.25, crash: 8 } },
  { id: 'decoy', name: 'Noise Decoy', type: 'consumable', price: 350, unlockLevel: 2, maxStack: 5, icon: 'decoy', description: 'Throw it. On landing it beeps loudly for 12 s, pulling hunting creatures toward it.', stats: { duration: 12, loudness: 1.0 } },
  { id: 'defib', name: 'Field Defibrillator', type: 'consumable', price: 2600, unlockLevel: 5, maxStack: 2, icon: 'defib', description: 'Revive a fallen teammate at their body with 40 health.', stats: { health: 40, range: 2.2 } },
  { id: 'glowstick', name: 'Glow Stick', type: 'consumable', price: 40, unlockLevel: 1, maxStack: 12, icon: 'glow', description: 'Cheap chemical light. Drop a trail so you can find your way back.', stats: { radius: 3.5 } },
  // --- Body gear
  { id: 'suit_padded', name: 'Padded Coverall', type: 'body', price: 2200, unlockLevel: 3, icon: 'suit', description: 'Reduces all damage taken by 20%.', stats: { resist: 0.2 } },
  { id: 'suit_armored', name: 'Ballistic Vest', type: 'body', price: 5600, unlockLevel: 9, icon: 'vest', description: 'Reduces all damage taken by 35%, but slows you by 5%.', stats: { resist: 0.35, speed: 0.95 } },
  // --- Utility gear
  { id: 'boots_runner', name: 'Runner Boots', type: 'utility', price: 1800, unlockLevel: 2, icon: 'boot', description: '+35% stamina and faster stamina recovery.', stats: { stamina: 1.35, regen: 1.15 } },
  { id: 'soles_quiet', name: 'Quiet Soles', type: 'utility', price: 2600, unlockLevel: 4, icon: 'sole', description: 'Your footsteps make 45% less noise.', stats: { noise: 0.55 } },
  { id: 'harness', name: 'Load Harness', type: 'utility', price: 3200, unlockLevel: 3, icon: 'harness', description: '+35% lifting strength and far less slowdown while carrying.', stats: { strength: 1.35, carrySlow: 0.6 } },
  { id: 'battery_pack', name: 'Extended Cell Pack', type: 'utility', price: 1600, unlockLevel: 2, icon: 'pack', description: '+60% battery capacity for torch and tools.', stats: { battery: 1.6 } },
  { id: 'glove_mk2', name: 'Lift Glove Mk II', type: 'utility', price: 3800, unlockLevel: 4, icon: 'glove', description: '+40% grab strength and +0.6 m reach.', stats: { strength: 1.4, reach: 0.6 } },
];

export const ITEM_BY_ID: Record<string, ItemDef> = Object.fromEntries(ITEMS.map((i) => [i.id, i]));

export const SLOT_TYPES: Record<LoadoutSlot, ItemType> = {
  light: 'light', tool1: 'tool', tool2: 'tool', quick1: 'consumable', quick2: 'consumable', quick3: 'consumable', body: 'body', utility: 'utility',
};

export type Loadout = Record<LoadoutSlot, string | null>;

export const DEFAULT_LOADOUT: Loadout = { light: 'light_t1', tool1: null, tool2: null, quick1: 'medkit', quick2: 'flare', quick3: null, body: null, utility: null };

// ---------------------------------------------------------------- Cosmetics
export type CosmeticSlot = 'suit' | 'helmet' | 'visor' | 'patch';
export interface CosmeticDef {
  id: string;
  slot: CosmeticSlot;
  name: string;
  price: number;
  unlockLevel: number;
  /** unlocked only through an achievement */
  achievement?: string;
  color?: string;
  style?: number;
}

export const COSMETICS: CosmeticDef[] = [
  { id: 'suit_orange', slot: 'suit', name: 'Hi-Vis Orange', price: 0, unlockLevel: 1, color: '#c8642a' },
  { id: 'suit_navy', slot: 'suit', name: 'Coverall Navy', price: 0, unlockLevel: 1, color: '#2c3a52' },
  { id: 'suit_olive', slot: 'suit', name: 'Olive Drab', price: 400, unlockLevel: 2, color: '#4f5a3a' },
  { id: 'suit_yellow', slot: 'suit', name: 'Hazmat Yellow', price: 600, unlockLevel: 3, color: '#c9a92c' },
  { id: 'suit_white', slot: 'suit', name: 'Clean-room White', price: 900, unlockLevel: 5, color: '#d6d8d4' },
  { id: 'suit_rust', slot: 'suit', name: 'Rust Red', price: 900, unlockLevel: 6, color: '#7a3226' },
  { id: 'suit_graphite', slot: 'suit', name: 'Graphite', price: 1400, unlockLevel: 8, color: '#2a2b2d' },
  { id: 'suit_teal', slot: 'suit', name: 'Survey Teal', price: 1400, unlockLevel: 10, color: '#2d6a6a' },
  { id: 'suit_gold', slot: 'suit', name: 'Company Gold', price: 0, unlockLevel: 1, achievement: 'millionaire', color: '#b08a3a' },
  { id: 'helm_standard', slot: 'helmet', name: 'Standard Shell', price: 0, unlockLevel: 1, style: 0 },
  { id: 'helm_miner', slot: 'helmet', name: "Miner's Cap", price: 800, unlockLevel: 3, style: 1 },
  { id: 'helm_dome', slot: 'helmet', name: 'Diver Dome', price: 1800, unlockLevel: 7, style: 2 },
  { id: 'helm_crest', slot: 'helmet', name: 'Ridge Crest', price: 2400, unlockLevel: 12, style: 3 },
  { id: 'visor_clear', slot: 'visor', name: 'Clear', price: 0, unlockLevel: 1, color: '#9fb4c0' },
  { id: 'visor_amber', slot: 'visor', name: 'Amber', price: 300, unlockLevel: 2, color: '#c98a2a' },
  { id: 'visor_smoke', slot: 'visor', name: 'Smoke', price: 300, unlockLevel: 2, color: '#2c2f33' },
  { id: 'visor_cobalt', slot: 'visor', name: 'Cobalt', price: 600, unlockLevel: 4, color: '#2a4fa0' },
  { id: 'visor_rose', slot: 'visor', name: 'Rose', price: 600, unlockLevel: 6, color: '#b0566e' },
  { id: 'visor_void', slot: 'visor', name: 'Void', price: 0, unlockLevel: 1, achievement: 'unknown', color: '#050507' },
  { id: 'patch_none', slot: 'patch', name: 'No Patch', price: 0, unlockLevel: 1, style: 0 },
  { id: 'patch_company', slot: 'patch', name: 'Greyline Logo', price: 0, unlockLevel: 1, style: 1 },
  { id: 'patch_hazard', slot: 'patch', name: 'Hazard Stripe', price: 250, unlockLevel: 2, style: 2 },
  { id: 'patch_skull', slot: 'patch', name: 'Skull', price: 750, unlockLevel: 5, style: 3 },
  { id: 'patch_star', slot: 'patch', name: 'Service Star', price: 0, unlockLevel: 1, achievement: 'streak5', style: 4 },
  { id: 'patch_medic', slot: 'patch', name: 'Medic Cross', price: 0, unlockLevel: 1, achievement: 'medic', style: 5 },
];

export const COSMETIC_BY_ID: Record<string, CosmeticDef> = Object.fromEntries(COSMETICS.map((c) => [c.id, c]));

export interface Appearance { suit: string; helmet: string; visor: string; patch: string }
export const DEFAULT_APPEARANCE: Appearance = { suit: 'suit_orange', helmet: 'helm_standard', visor: 'visor_clear', patch: 'patch_company' };
export const FREE_COSMETICS = COSMETICS.filter((c) => c.price === 0 && !c.achievement).map((c) => c.id);
