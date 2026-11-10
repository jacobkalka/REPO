// Facility themes. Each map is a procedural facility built from room modules, with its own
// surfaces, lighting, atmosphere, room programme, valuables and monster pool.

export type MapId = 'research' | 'industrial' | 'underground' | 'luxury' | 'practice';

export interface SurfaceDef {
  tex: string;          // texture set id (shared/assets/textures.json)
  scale?: number;       // metres per texture repeat
  tint?: string;        // albedo multiplier
  rough?: number;       // roughness multiplier
  metal?: number;       // metalness override
}

export interface SurfaceSet {
  floor: SurfaceDef;
  wall: SurfaceDef;
  wallLower?: SurfaceDef;   // wainscot / lower band
  lowerHeight?: number;
  ceiling: SurfaceDef;
  trim: string;             // trim colour (baseboards, chair rails, frames)
  trimMetal?: boolean;
}

export type FixtureKind = 'fluorescent' | 'caged' | 'hanging' | 'bulb' | 'chandelier' | 'ceilingLamp' | 'wallSconce' | 'security' | 'floodlight';

export interface LightStyle {
  fixture: FixtureKind;
  color: string;
  intensity: number;      // candela-ish (three.js physical units)
  range: number;
  /** probability that a light is broken (off) at generation */
  broken: number;
  /** probability that a working light flickers */
  flicker: number;
}

export type RoomTypeId =
  | 'lift' | 'corridor' | 'junction' | 'stairs'
  // research
  | 'lab' | 'specimen' | 'office' | 'medical' | 'server' | 'security' | 'storage' | 'electrical' | 'breakroom' | 'archive' | 'vault'
  // industrial
  | 'factory' | 'warehouse' | 'workshop' | 'loading' | 'boiler' | 'control' | 'locker'
  // underground
  | 'tunnel' | 'bunker' | 'pumproom' | 'cellblock' | 'cavern' | 'maintenance' | 'armory'
  // luxury
  | 'lobby' | 'ballroom' | 'dining' | 'library' | 'suite' | 'lounge' | 'gallery' | 'kitchen' | 'study' | 'boardroom';

export interface RoomTypeDef {
  id: RoomTypeId;
  name: string;
  surfaces: string;         // key into theme.surfaceSets
  minTiles: number;
  maxTiles: number;
  weight: number;
  height?: number;          // ceiling height override
  /** loot richness multiplier */
  loot: number;
  /** light style key override */
  light?: string;
  tall?: boolean;
  /** max number of this room type per level */
  max?: number;
}

export interface MapTheme {
  id: MapId;
  name: string;
  tagline: string;
  description: string;
  floors: number;               // number of floors (1-2)
  floorOffset: number;          // index of the lowest floor relative to lift floor (basement: -1)
  targetRooms: [number, number];
  surfaceSets: Record<string, SurfaceSet>;
  lights: Record<string, LightStyle>;
  roomTypes: RoomTypeDef[];
  corridorSurfaces: string;
  corridorLight: string;
  fog: { color: string; density: number };
  ambient: { color: string; intensity: number };
  ambience: string;
  doorStyle: 'wood' | 'metal' | 'security' | 'ornate';
  monsterWeights: Partial<Record<string, number>>;
  hazards: string[];
  pipes: boolean;              // ceiling pipe runs in corridors
  unlockLevel: number;
}

const S = (tex: string, scale = 2.5, extra: Partial<SurfaceDef> = {}): SurfaceDef => ({ tex, scale, ...extra });

export const MAPS: Record<Exclude<MapId, 'practice'>, MapTheme> = {
  research: {
    id: 'research',
    name: 'Kestrel Research Complex',
    tagline: 'Laboratories sealed mid-experiment.',
    description: 'A two-level biomedical research site. Clean white labs above, flooded specimen storage below. Lights fail in sections; the security wing is still locked down.',
    floors: 2,
    floorOffset: -1,
    targetRooms: [26, 34],
    surfaceSets: {
      lab: { floor: S('tiled_floor_001', 2), wall: S('white_plaster_02', 3), wallLower: S('interior_tiles', 1.6), lowerHeight: 1.35, ceiling: S('ceiling_interior', 2.4), trim: '#c9ccc8' },
      clean: { floor: S('floor_tiles_06', 2.2), wall: S('plaster_grey_04', 3, { tint: '#e8ebe8' }), ceiling: S('ceiling_interior', 2.4), trim: '#8f9895' },
      worn: { floor: S('worn_tile_floor', 2.2), wall: S('plaster_grey_04', 3, { tint: '#c9cbc4' }), wallLower: S('painted_concrete', 2.5, { tint: '#7d8f8a' }), lowerHeight: 1.1, ceiling: S('ceiling_interior', 2.4, { tint: '#b9b9b0' }), trim: '#5b625f' },
      utility: { floor: S('painted_concrete', 3), wall: S('concrete_wall_008', 3), ceiling: S('painted_concrete', 3, { tint: '#9a9a96' }), trim: '#3d4241', trimMetal: true },
      vault: { floor: S('metal_plate_02', 2, { metal: 0.8 }), wall: S('blue_metal_plate', 2.5), ceiling: S('painted_concrete', 3, { tint: '#7c8486' }), trim: '#2d3334', trimMetal: true },
    },
    lights: {
      main: { fixture: 'fluorescent', color: '#e9f2ff', intensity: 26, range: 13, broken: 0.22, flicker: 0.16 },
      dim: { fixture: 'fluorescent', color: '#d7f0e8', intensity: 16, range: 11, broken: 0.35, flicker: 0.25 },
      security: { fixture: 'security', color: '#ff5a3c', intensity: 9, range: 10, broken: 0.05, flicker: 0.1 },
    },
    roomTypes: [
      { id: 'lab', name: 'Laboratory', surfaces: 'lab', minTiles: 4, maxTiles: 12, weight: 5, loot: 1.3 },
      { id: 'specimen', name: 'Specimen Storage', surfaces: 'worn', minTiles: 4, maxTiles: 9, weight: 2, loot: 1.2, light: 'dim' },
      { id: 'office', name: 'Research Office', surfaces: 'clean', minTiles: 2, maxTiles: 6, weight: 3, loot: 0.9 },
      { id: 'medical', name: 'Medical Bay', surfaces: 'lab', minTiles: 4, maxTiles: 9, weight: 2, loot: 1.0 },
      { id: 'server', name: 'Server Room', surfaces: 'utility', minTiles: 2, maxTiles: 6, weight: 1.5, loot: 1.1, light: 'dim' },
      { id: 'security', name: 'Security Office', surfaces: 'utility', minTiles: 2, maxTiles: 4, weight: 1, loot: 0.8, light: 'security', max: 1 },
      { id: 'storage', name: 'Supply Storage', surfaces: 'utility', minTiles: 2, maxTiles: 9, weight: 2.5, loot: 1.0, light: 'dim' },
      { id: 'electrical', name: 'Electrical Room', surfaces: 'utility', minTiles: 2, maxTiles: 4, weight: 1.2, loot: 0.6, light: 'dim', max: 2 },
      { id: 'breakroom', name: 'Break Room', surfaces: 'worn', minTiles: 2, maxTiles: 6, weight: 1.2, loot: 0.6 },
      { id: 'archive', name: 'Records Archive', surfaces: 'worn', minTiles: 4, maxTiles: 9, weight: 1, loot: 0.9, light: 'dim' },
      { id: 'vault', name: 'Sample Vault', surfaces: 'vault', minTiles: 2, maxTiles: 4, weight: 0, loot: 2.6, light: 'security' },
    ],
    corridorSurfaces: 'worn',
    corridorLight: 'dim',
    fog: { color: '#0b0f10', density: 0.045 },
    ambient: { color: '#9fb6c4', intensity: 0.05 },
    ambience: 'research',
    doorStyle: 'metal',
    monsterWeights: { stalker: 3, mimic: 2, lurker: 2, watcher: 2, swarm: 1.5, hunter: 1.5, brute: 1 },
    hazards: ['gas', 'laser', 'sparks'],
    pipes: false,
    unlockLevel: 1,
  },
  industrial: {
    id: 'industrial',
    name: 'Varga Processing Plant',
    tagline: 'The machines never finished their last shift.',
    description: 'A sprawling processing plant: cavernous factory floors, warehouses stacked with crates, and maintenance tunnels under live machinery. Steam lines still burst without warning.',
    floors: 1,
    floorOffset: 0,
    targetRooms: [24, 32],
    surfaceSets: {
      factory: { floor: S('hangar_concrete_floor', 4), wall: S('corrugated_iron_02', 2.5), wallLower: S('concrete_wall_008', 3), lowerHeight: 2.2, ceiling: S('factory_wall', 4), trim: '#4a3f2b', trimMetal: true },
      warehouse: { floor: S('concrete_floor_painted', 4), wall: S('factory_wall', 3.5), wallLower: S('concrete_wall_008', 3), lowerHeight: 1.6, ceiling: S('corrugated_iron_02', 3), trim: '#6b5a2a', trimMetal: true },
      shop: { floor: S('anti_slip_concrete', 3), wall: S('concrete_wall_008', 3, { tint: '#b8b1a3' }), wallLower: S('painted_metal_shutter', 2, { tint: '#7f8a6f' }), lowerHeight: 1.2, ceiling: S('rusty_metal_02', 3), trim: '#3a3a33', trimMetal: true },
      office: { floor: S('garage_floor', 3), wall: S('beige_wall_001', 3), wallLower: S('blue_metal_plate', 2), lowerHeight: 1.0, ceiling: S('painted_concrete', 3, { tint: '#a39f95' }), trim: '#2e3a40' },
      grime: { floor: S('metal_plate', 2, { metal: 0.85 }), wall: S('rusty_metal_02', 2.5), ceiling: S('rusty_metal_03', 3), trim: '#3b2c22', trimMetal: true },
    },
    lights: {
      main: { fixture: 'hanging', color: '#ffc98a', intensity: 34, range: 16, broken: 0.2, flicker: 0.12 },
      dim: { fixture: 'caged', color: '#ffb36b', intensity: 18, range: 11, broken: 0.3, flicker: 0.2 },
      flood: { fixture: 'floodlight', color: '#fff1d6', intensity: 60, range: 24, broken: 0.25, flicker: 0.08 },
    },
    roomTypes: [
      { id: 'factory', name: 'Factory Floor', surfaces: 'factory', minTiles: 12, maxTiles: 30, weight: 3, loot: 1.2, tall: true, light: 'flood', height: 7.5, max: 3 },
      { id: 'warehouse', name: 'Warehouse', surfaces: 'warehouse', minTiles: 9, maxTiles: 24, weight: 3, loot: 1.3, tall: true, light: 'flood', height: 7.0, max: 3 },
      { id: 'workshop', name: 'Workshop', surfaces: 'shop', minTiles: 4, maxTiles: 9, weight: 3, loot: 1.2 },
      { id: 'loading', name: 'Loading Dock', surfaces: 'warehouse', minTiles: 6, maxTiles: 12, weight: 1.2, loot: 1.0, max: 2, light: 'flood', tall: true, height: 6.5 },
      { id: 'boiler', name: 'Boiler Room', surfaces: 'grime', minTiles: 4, maxTiles: 9, weight: 1.5, loot: 0.9, light: 'dim', max: 2 },
      { id: 'control', name: 'Control Room', surfaces: 'office', minTiles: 2, maxTiles: 6, weight: 1.5, loot: 1.1 },
      { id: 'locker', name: 'Locker Room', surfaces: 'office', minTiles: 2, maxTiles: 4, weight: 1.2, loot: 0.7 },
      { id: 'electrical', name: 'Substation', surfaces: 'grime', minTiles: 2, maxTiles: 4, weight: 1, loot: 0.6, light: 'dim', max: 2 },
      { id: 'storage', name: 'Parts Storage', surfaces: 'shop', minTiles: 2, maxTiles: 6, weight: 2, loot: 1.0, light: 'dim' },
      { id: 'office', name: 'Foreman Office', surfaces: 'office', minTiles: 2, maxTiles: 4, weight: 1.5, loot: 0.9 },
      { id: 'vault', name: 'Payroll Safe Room', surfaces: 'grime', minTiles: 2, maxTiles: 4, weight: 0, loot: 2.6, light: 'dim' },
    ],
    corridorSurfaces: 'shop',
    corridorLight: 'dim',
    fog: { color: '#100c08', density: 0.035 },
    ambient: { color: '#c9a37a', intensity: 0.05 },
    ambience: 'industrial',
    doorStyle: 'metal',
    monsterWeights: { brute: 3, hunter: 2.5, stalker: 2, swarm: 2, mimic: 1.5, watcher: 1, lurker: 1 },
    hazards: ['steam', 'crusher', 'sparks'],
    pipes: true,
    unlockLevel: 2,
  },
  underground: {
    id: 'underground',
    name: 'Site 9 Deep Storage',
    tagline: 'Two hundred metres of concrete and silence.',
    description: 'A cold-war era bunker complex. Bare bulbs, flooded pump rooms and locked armouries. Most of it has been dark for decades, and something has been living in the dark.',
    floors: 2,
    floorOffset: -1,
    targetRooms: [26, 34],
    surfaceSets: {
      tunnel: { floor: S('damaged_concrete_floor', 3), wall: S('concrete_wall_003', 3), wallLower: S('preconcrete_wall_001', 3, { tint: '#8c8a5c' }), lowerHeight: 1.0, ceiling: S('concrete_wall_003', 3, { tint: '#8d8d88' }), trim: '#2b2b27' },
      bunker: { floor: S('concrete_floor_worn_001', 3), wall: S('preconcrete_wall_001', 3), ceiling: S('concrete_wall_003', 3, { tint: '#77776f' }), trim: '#3a3a33', trimMetal: true },
      brick: { floor: S('dirty_concrete', 3), wall: S('brick_wall_13', 2.2), ceiling: S('cracked_concrete_wall', 3), trim: '#2a2420' },
      old: { floor: S('dirty_concrete', 3), wall: S('castle_brick_07', 2.5), ceiling: S('cracked_concrete_wall', 3, { tint: '#6c6a63' }), trim: '#221f1b' },
      steel: { floor: S('metal_plate', 2, { metal: 0.85 }), wall: S('green_metal_rust', 2.5), ceiling: S('rusty_metal_03', 3), trim: '#1f2621', trimMetal: true },
    },
    lights: {
      main: { fixture: 'bulb', color: '#ffd29a', intensity: 14, range: 10, broken: 0.35, flicker: 0.25 },
      wall: { fixture: 'wallSconce', color: '#ffc27a', intensity: 12, range: 9, broken: 0.4, flicker: 0.3 },
      green: { fixture: 'caged', color: '#c9ffcf', intensity: 14, range: 10, broken: 0.3, flicker: 0.2 },
    },
    roomTypes: [
      { id: 'bunker', name: 'Barracks', surfaces: 'bunker', minTiles: 4, maxTiles: 9, weight: 2.5, loot: 1.0 },
      { id: 'storage', name: 'Deep Storage', surfaces: 'bunker', minTiles: 4, maxTiles: 12, weight: 3, loot: 1.3, light: 'green' },
      { id: 'pumproom', name: 'Pump Room', surfaces: 'steel', minTiles: 4, maxTiles: 9, weight: 1.5, loot: 0.9, max: 2 },
      { id: 'cellblock', name: 'Holding Cells', surfaces: 'old', minTiles: 4, maxTiles: 9, weight: 1.5, loot: 1.0, light: 'wall' },
      { id: 'maintenance', name: 'Maintenance Bay', surfaces: 'steel', minTiles: 2, maxTiles: 6, weight: 2, loot: 1.0 },
      { id: 'armory', name: 'Armoury', surfaces: 'steel', minTiles: 2, maxTiles: 6, weight: 1.2, loot: 1.6, max: 2 },
      { id: 'cavern', name: 'Excavation', surfaces: 'old', minTiles: 9, maxTiles: 20, weight: 1, loot: 1.4, tall: true, height: 5.6, light: 'wall', max: 2 },
      { id: 'archive', name: 'Map Room', surfaces: 'brick', minTiles: 2, maxTiles: 6, weight: 1.2, loot: 1.1 },
      { id: 'electrical', name: 'Generator Room', surfaces: 'steel', minTiles: 2, maxTiles: 4, weight: 1, loot: 0.6, max: 2 },
      { id: 'office', name: 'Command Post', surfaces: 'brick', minTiles: 2, maxTiles: 6, weight: 1.5, loot: 1.0 },
      { id: 'vault', name: 'Strongroom', surfaces: 'steel', minTiles: 2, maxTiles: 4, weight: 0, loot: 2.8 },
    ],
    corridorSurfaces: 'tunnel',
    corridorLight: 'main',
    fog: { color: '#07080a', density: 0.055 },
    ambient: { color: '#8b9080', intensity: 0.035 },
    ambience: 'underground',
    doorStyle: 'metal',
    monsterWeights: { lurker: 3, hunter: 2.5, swarm: 2.5, stalker: 2, mimic: 2, watcher: 1, brute: 1.5 },
    hazards: ['water', 'steam', 'sparks'],
    pipes: true,
    unlockLevel: 4,
  },
  luxury: {
    id: 'luxury',
    name: 'The Aldermere',
    tagline: 'A grand hotel that closed its doors with the guests still inside.',
    description: 'A two-storey luxury hotel and private gallery. Ballrooms, suites and wood-panelled studies full of fragile, priceless things, and long dark service corridors behind the walls.',
    floors: 2,
    floorOffset: 0,
    targetRooms: [26, 34],
    surfaceSets: {
      grand: { floor: S('marble_01', 3), wall: S('patterned_plaster_wall', 2.5, { tint: '#d8cdb8' }), wallLower: S('wood_cabinet_worn_long', 2), lowerHeight: 1.1, ceiling: S('white_stucco', 3, { tint: '#ddd6c8' }), trim: '#5a3d24' },
      parquet: { floor: S('herringbone_parquet', 2.5), wall: S('beige_wall_001', 3, { tint: '#d9ccb3' }), wallLower: S('wood_cabinet_worn_long', 2), lowerHeight: 1.0, ceiling: S('white_stucco', 3), trim: '#4b301c' },
      carpet: { floor: S('dirty_carpet', 2.5, { tint: '#9a6060' }), wall: S('patterned_plaster_wall', 2.5, { tint: '#b9a98a' }), wallLower: S('dark_wood', 2), lowerHeight: 0.95, ceiling: S('white_stucco', 3, { tint: '#cfc6b2' }), trim: '#3a2516' },
      study: { floor: S('herringbone_parquet', 2.5, { tint: '#b28c6c' }), wall: S('dark_wood', 2), ceiling: S('white_stucco', 3, { tint: '#b7ae9c' }), trim: '#2b1a0f' },
      service: { floor: S('worn_tile_floor', 2.2), wall: S('beige_wall_001', 3, { tint: '#bdb5a3' }), wallLower: S('painted_concrete', 2.5, { tint: '#6e7a6d' }), lowerHeight: 1.0, ceiling: S('painted_concrete', 3, { tint: '#9c9891' }), trim: '#474b45' },
    },
    lights: {
      main: { fixture: 'chandelier', color: '#ffd9a8', intensity: 30, range: 14, broken: 0.25, flicker: 0.15 },
      lamp: { fixture: 'ceilingLamp', color: '#ffcf96', intensity: 18, range: 11, broken: 0.3, flicker: 0.15 },
      sconce: { fixture: 'wallSconce', color: '#ffc47d', intensity: 10, range: 8, broken: 0.35, flicker: 0.25 },
      service: { fixture: 'fluorescent', color: '#f4efe0', intensity: 16, range: 10, broken: 0.35, flicker: 0.25 },
    },
    roomTypes: [
      { id: 'lobby', name: 'Grand Lobby', surfaces: 'grand', minTiles: 12, maxTiles: 24, weight: 1.5, loot: 1.1, tall: true, height: 7, max: 1 },
      { id: 'ballroom', name: 'Ballroom', surfaces: 'grand', minTiles: 12, maxTiles: 24, weight: 1.5, loot: 1.3, tall: true, height: 7, max: 1 },
      { id: 'gallery', name: 'Gallery', surfaces: 'parquet', minTiles: 6, maxTiles: 16, weight: 2, loot: 1.6 },
      { id: 'dining', name: 'Dining Hall', surfaces: 'parquet', minTiles: 6, maxTiles: 12, weight: 1.5, loot: 1.2 },
      { id: 'library', name: 'Library', surfaces: 'study', minTiles: 4, maxTiles: 12, weight: 1.5, loot: 1.3 },
      { id: 'suite', name: 'Guest Suite', surfaces: 'carpet', minTiles: 4, maxTiles: 9, weight: 3, loot: 1.1, light: 'lamp' },
      { id: 'lounge', name: 'Smoking Lounge', surfaces: 'carpet', minTiles: 4, maxTiles: 9, weight: 1.5, loot: 1.1, light: 'lamp' },
      { id: 'study', name: 'Private Study', surfaces: 'study', minTiles: 2, maxTiles: 6, weight: 2, loot: 1.3, light: 'lamp' },
      { id: 'boardroom', name: 'Boardroom', surfaces: 'parquet', minTiles: 4, maxTiles: 9, weight: 1.2, loot: 1.0, light: 'lamp' },
      { id: 'kitchen', name: 'Kitchen', surfaces: 'service', minTiles: 4, maxTiles: 9, weight: 1.2, loot: 0.7, light: 'service', max: 2 },
      { id: 'storage', name: 'Linen Store', surfaces: 'service', minTiles: 2, maxTiles: 4, weight: 1.2, loot: 0.8, light: 'service' },
      { id: 'electrical', name: 'Service Plant', surfaces: 'service', minTiles: 2, maxTiles: 4, weight: 1, loot: 0.5, light: 'service', max: 2 },
      { id: 'vault', name: 'Hotel Vault', surfaces: 'study', minTiles: 2, maxTiles: 4, weight: 0, loot: 3.0, light: 'lamp' },
    ],
    corridorSurfaces: 'carpet',
    corridorLight: 'sconce',
    fog: { color: '#0d0a08', density: 0.04 },
    ambient: { color: '#c8a888', intensity: 0.045 },
    ambience: 'luxury',
    doorStyle: 'ornate',
    monsterWeights: { mimic: 3, stalker: 3, watcher: 2.5, lurker: 1.5, hunter: 1.5, brute: 1.5, swarm: 1 },
    hazards: ['sparks', 'laser'],
    pipes: false,
    unlockLevel: 6,
  },
};

export const MAP_LIST = Object.values(MAPS);

export function getTheme(id: MapId): MapTheme {
  if (id === 'practice') return MAPS.industrial;
  return MAPS[id];
}
