// Valuable objects. Each one maps to a CC0 model from shared/assets/models.json.
// mass in kg, value in credits. fragility: 0 (indestructible) .. 1 (shatters at a touch).

import type { MapId } from './maps';

export type ImpactMaterial = 'metal' | 'brass' | 'glass' | 'ceramic' | 'wood' | 'plastic' | 'stone' | 'fabric' | 'electronic' | 'paper';
export type Rarity = 'common' | 'uncommon' | 'rare' | 'legendary';
export type ValuableCategory = 'scientific' | 'electronics' | 'industrial' | 'antique' | 'decorative' | 'artifact' | 'container' | 'tools';

export interface ValuableDef {
  id: string;
  model: string;
  name: string;
  category: ValuableCategory;
  mass: number;
  value: [number, number];
  fragility: number;
  rarity: Rarity;
  themes: Exclude<MapId, 'practice'>[];
  mat: ImpactMaterial;
  /** explodes when destroyed */
  volatile?: boolean;
  /** taking it out of its room summons the Unknown */
  cursed?: boolean;
  /** contains another valuable / supplies when broken open */
  container?: boolean;
  scale?: number;
}

export const RARITY_WEIGHT: Record<Rarity, number> = { common: 10, uncommon: 5, rare: 1.8, legendary: 0.45 };

const R: Exclude<MapId, 'practice'>[] = ['research'];
const I: Exclude<MapId, 'practice'>[] = ['industrial'];
const U: Exclude<MapId, 'practice'>[] = ['underground'];
const L: Exclude<MapId, 'practice'>[] = ['luxury'];
const ALL: Exclude<MapId, 'practice'>[] = ['research', 'industrial', 'underground', 'luxury'];

function v(id: string, name: string, category: ValuableCategory, mass: number, value: [number, number], fragility: number, rarity: Rarity, themes: Exclude<MapId, 'practice'>[], mat: ImpactMaterial, extra: Partial<ValuableDef> = {}): ValuableDef {
  return { id, model: extra.model ?? id, name, category, mass, value, fragility, rarity, themes, mat, ...extra };
}

export const VALUABLES: ValuableDef[] = [
  // ---------------- Research
  v('vintage_microscope', 'Brass Field Microscope', 'scientific', 3.2, [900, 1700], 0.55, 'uncommon', R, 'brass'),
  v('industrial_microscope', 'Inspection Microscope', 'scientific', 7.5, [1400, 2600], 0.5, 'uncommon', R, 'metal'),
  v('bunsen_burner', 'Bunsen Burner', 'scientific', 0.9, [160, 380], 0.3, 'common', R, 'metal'),
  v('chemistry_set', 'Glassware Rack', 'scientific', 4.5, [1800, 3400], 0.95, 'rare', R, 'glass'),
  v('retro_multimeter', 'Analogue Multimeter', 'electronics', 1.4, [300, 700], 0.45, 'common', ['research', 'industrial'], 'electronic'),
  v('vintage_spacecraft_instrument', 'Flight Telemetry Unit', 'scientific', 6.0, [2800, 5200], 0.6, 'rare', R, 'electronic'),
  v('circuit_board', 'Prototype Logic Board', 'electronics', 0.8, [600, 1300], 0.65, 'common', R, 'electronic'),
  v('classic_laptop', 'Field Terminal', 'electronics', 3.8, [1100, 2100], 0.6, 'uncommon', R, 'electronic'),
  v('old_gas_mask', 'Respirator Rig', 'artifact', 2.1, [250, 600], 0.2, 'common', ['research', 'underground'], 'fabric'),
  v('binoculars', 'Rangefinder Binoculars', 'scientific', 1.1, [400, 800], 0.5, 'common', ['research', 'underground'], 'metal'),
  v('magnifying_glass_01', 'Loupe', 'scientific', 0.3, [120, 300], 0.7, 'common', ['research', 'luxury'], 'glass'),
  v('vintage_radio_transceiver', 'Shortwave Transceiver', 'electronics', 14, [2200, 4200], 0.45, 'uncommon', ['research', 'underground'], 'electronic'),
  v('medical_box', 'Trauma Case', 'container', 2.8, [350, 750], 0.2, 'common', ['research', 'underground'], 'plastic'),
  v('metal_detector', 'Ground Survey Scanner', 'electronics', 3.4, [900, 1800], 0.4, 'uncommon', ['research', 'underground'], 'electronic'),

  // ---------------- Industrial
  v('Drill_01', 'Cordless Drill', 'tools', 1.7, [180, 420], 0.25, 'common', I, 'plastic'),
  v('pipe_wrench', 'Pipe Wrench', 'tools', 2.2, [80, 220], 0.02, 'common', I, 'metal'),
  v('brass_blowtorch', 'Brass Blowtorch', 'tools', 1.6, [380, 760], 0.25, 'common', I, 'brass'),
  v('metal_toolbox', 'Mechanic Toolbox', 'tools', 9, [500, 1100], 0.1, 'common', I, 'metal'),
  v('metal_tool_chest', 'Rolling Tool Chest', 'tools', 38, [1600, 3000], 0.15, 'uncommon', I, 'metal'),
  v('portable_generator', 'Portable Generator', 'industrial', 46, [3200, 5600], 0.3, 'rare', ['industrial', 'underground'], 'metal'),
  v('power_box_01', 'Junction Controller', 'electronics', 12, [1400, 2600], 0.45, 'uncommon', I, 'electronic'),
  v('propane_tank', 'Propane Cylinder', 'industrial', 16, [300, 600], 0.35, 'common', ['industrial', 'underground'], 'metal', { volatile: true }),
  v('old_military_compressor', 'Field Compressor', 'industrial', 72, [5200, 8600], 0.2, 'rare', ['industrial', 'underground'], 'metal'),
  v('bench_vice_01', 'Bench Vice', 'tools', 11, [260, 520], 0.02, 'common', I, 'metal'),
  v('old_drill_press', 'Pillar Drill', 'industrial', 64, [3800, 6400], 0.15, 'rare', I, 'metal'),
  v('small_oil_can_01', 'Brass Oil Can', 'tools', 0.7, [140, 330], 0.15, 'common', I, 'brass'),
  v('portable_searchlight', 'Sealed Searchlight', 'electronics', 2.6, [450, 900], 0.55, 'common', ['industrial', 'underground'], 'glass'),
  v('metal_jerrycan', 'Fuel Can (full)', 'industrial', 18, [220, 480], 0.2, 'common', ['industrial', 'underground'], 'metal', { volatile: true }),
  v('ratchet_wrench', 'Torque Ratchet', 'tools', 0.9, [160, 340], 0.02, 'common', I, 'metal'),
  v('adjustable_wrench', 'Adjustable Spanner', 'tools', 0.6, [60, 160], 0.02, 'common', I, 'metal'),

  // ---------------- Underground
  v('old_military_crate', 'Sealed Munitions Crate', 'container', 42, [2600, 4800], 0.1, 'uncommon', U, 'wood'),
  v('ammo_box', 'Ammunition Can', 'container', 6.5, [420, 880], 0.05, 'common', U, 'metal'),
  v('vintage_flashlight', 'Signal Lamp', 'electronics', 1.3, [240, 520], 0.4, 'common', U, 'metal'),
  v('signal_flashlight', 'Morse Torch', 'electronics', 0.6, [180, 400], 0.4, 'common', U, 'metal'),
  v('portable_cassette_player', 'Field Recorder', 'electronics', 0.7, [300, 720], 0.55, 'common', ['underground', 'luxury'], 'electronic'),
  v('cigarette_case', 'Engraved Cigarette Case', 'antique', 0.25, [600, 1300], 0.1, 'uncommon', ['underground', 'luxury'], 'metal'),
  v('pocket_watch', "Officer's Pocket Watch", 'antique', 0.15, [900, 1900], 0.5, 'uncommon', ['underground', 'luxury'], 'brass'),
  v('seadogs_compass', 'Brass Compass', 'antique', 0.6, [700, 1500], 0.5, 'uncommon', U, 'brass'),
  v('vintage_binocular', 'Naval Binoculars', 'antique', 1.2, [800, 1600], 0.5, 'uncommon', U, 'brass'),
  v('Lantern_01', 'Hurricane Lantern', 'antique', 1.1, [260, 560], 0.6, 'common', ['underground', 'luxury'], 'glass'),
  v('treasure_chest', 'Iron-bound Strongbox', 'container', 55, [9000, 16000], 0.1, 'legendary', ['underground', 'luxury'], 'wood'),

  // ---------------- Luxury
  v('brass_vase_01', 'Tall Brass Urn', 'decorative', 4.2, [1300, 2400], 0.3, 'uncommon', L, 'brass'),
  v('brass_vase_02', 'Brass Amphora', 'decorative', 3.1, [900, 1800], 0.3, 'common', L, 'brass'),
  v('brass_vase_03', 'Brass Bud Vase', 'decorative', 0.8, [280, 600], 0.3, 'common', L, 'brass'),
  v('antique_ceramic_vase_01', 'Glazed Dynasty Vase', 'antique', 3.6, [4200, 7800], 1.0, 'rare', L, 'ceramic'),
  v('ceramic_vase_01', 'Celadon Vase', 'decorative', 1.9, [800, 1500], 0.95, 'common', L, 'ceramic'),
  v('ceramic_vase_03', 'Slender Porcelain Vase', 'decorative', 1.2, [650, 1300], 1.0, 'common', L, 'ceramic'),
  v('marble_bust_01', 'Marble Bust', 'antique', 34, [6200, 10400], 0.4, 'rare', L, 'stone'),
  v('bronze_whale_statue', 'Bronze Whale', 'decorative', 95, [11000, 17000], 0.05, 'legendary', L, 'brass'),
  v('bronze_shark_statue', 'Bronze Shark', 'decorative', 38, [4200, 7600], 0.05, 'rare', L, 'brass'),
  v('horse_statue_01', 'Jade Horse Figurine', 'artifact', 1.4, [1600, 3200], 0.85, 'uncommon', L, 'stone'),
  v('gothic_statue', 'Weeping Saint', 'artifact', 160, [18000, 30000], 0.35, 'legendary', ['luxury', 'underground'], 'stone', { cursed: true }),
  v('chess_set', 'Ivory Chess Set', 'antique', 3.4, [1800, 3600], 0.45, 'uncommon', L, 'wood'),
  v('brass_candleholders', 'Candelabra Pair', 'decorative', 6.5, [1500, 2900], 0.3, 'uncommon', L, 'brass'),
  v('brass_goblets', 'Goblet Service', 'decorative', 2.2, [700, 1500], 0.35, 'common', L, 'brass'),
  v('mantel_clock_01', 'Mantel Clock', 'antique', 3.2, [1400, 2800], 0.7, 'uncommon', L, 'wood'),
  v('vintage_grandfather_clock_01', 'Longcase Clock', 'antique', 68, [8800, 14200], 0.6, 'rare', L, 'wood'),
  v('ornate_mirror_01', 'Gilded Mirror', 'decorative', 9, [3000, 5600], 1.0, 'rare', L, 'glass'),
  v('fancy_picture_frame_01', 'Oil Portrait', 'artifact', 5, [2400, 6200], 0.55, 'uncommon', L, 'wood'),
  v('Camera_01', 'Rangefinder Camera', 'electronics', 0.9, [700, 1500], 0.6, 'common', ['luxury', 'research'], 'metal'),
  v('vintage_video_camera', '8mm Cine Camera', 'electronics', 1.4, [900, 1800], 0.6, 'uncommon', L, 'metal'),
  v('filmstrip_projector_8mm', 'Film Projector', 'electronics', 7, [1500, 2900], 0.55, 'uncommon', L, 'metal'),
  v('tea_set_01', 'Porcelain Tea Service', 'decorative', 3.8, [1600, 3200], 1.0, 'uncommon', L, 'ceramic'),
  v('wine_bottles_01', 'Vintage Reserve Wine', 'decorative', 4.4, [1200, 2600], 1.0, 'uncommon', L, 'glass'),
  v('carved_wooden_elephant', 'Carved Elephant', 'decorative', 0.4, [200, 480], 0.15, 'common', L, 'wood'),
  v('vintage_pocket_watch', 'Gold Pocket Watch', 'antique', 0.12, [1300, 2600], 0.5, 'uncommon', L, 'brass'),
  v('vintage_suitcase', 'Steamer Luggage', 'container', 14, [700, 1600], 0.1, 'common', L, 'fabric'),
  v('Ukulele_01', 'Koa Ukulele', 'decorative', 0.6, [300, 700], 0.6, 'common', L, 'wood'),
  v('boombox', 'Chrome Boombox', 'electronics', 5.5, [450, 950], 0.45, 'common', ['luxury', 'industrial'], 'electronic'),
  v('cassette_player', 'Tape Deck', 'electronics', 0.8, [180, 420], 0.5, 'common', L, 'plastic'),
  v('Television_01', 'Walnut Television', 'electronics', 16, [700, 1500], 0.85, 'common', L, 'glass'),
  v('vintage_oil_lamp', 'Crystal Oil Lamp', 'antique', 2.2, [600, 1300], 0.9, 'common', L, 'glass'),
  v('CashRegister_01', 'Brass Cash Register', 'antique', 24, [2400, 4400], 0.3, 'uncommon', ['luxury', 'industrial'], 'brass'),
  v('alarm_clock_01', 'Twin-bell Clock', 'decorative', 0.6, [140, 340], 0.45, 'common', ALL, 'metal'),
  v('vintage_telephone_wall_clock', 'Switchboard Clock', 'antique', 4.5, [1100, 2200], 0.6, 'uncommon', L, 'wood'),
  // event-only (never placed by the generator: no themes)
  v('black_box', 'Flight Recorder', 'electronics', 9, [3600, 5400], 0.2, 'legendary', [], 'metal', { model: 'power_box_01' }),
];

export const VALUABLE_BY_ID: Record<string, ValuableDef> = Object.fromEntries(VALUABLES.map((x) => [x.id, x]));

export function valuablesForTheme(theme: Exclude<MapId, 'practice'>): ValuableDef[] {
  return VALUABLES.filter((x) => x.themes.includes(theme));
}

/** Physical material properties used for colliders */
export const MATERIAL_PHYS: Record<ImpactMaterial, { friction: number; restitution: number }> = {
  metal: { friction: 0.55, restitution: 0.18 },
  brass: { friction: 0.5, restitution: 0.2 },
  glass: { friction: 0.4, restitution: 0.12 },
  ceramic: { friction: 0.5, restitution: 0.1 },
  wood: { friction: 0.7, restitution: 0.15 },
  plastic: { friction: 0.6, restitution: 0.25 },
  stone: { friction: 0.75, restitution: 0.05 },
  fabric: { friction: 0.9, restitution: 0.02 },
  electronic: { friction: 0.6, restitution: 0.12 },
  paper: { friction: 0.9, restitution: 0.02 },
};
