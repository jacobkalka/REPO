// LevelData: the complete, deterministic description of a generated facility.
// Produced identically on server and client from {map, seed, difficulty, crew}.

import type { FixtureKind, MapId, RoomTypeId } from '../catalog/maps';

export interface Vec3 { x: number; y: number; z: number }
export type Axis = 'x' | 'z';
export type Dir = 0 | 1 | 2 | 3; // N(+z) E(+x) S(-z) W(-x)
export const DIRS: readonly [number, number][] = [[0, 1], [1, 0], [0, -1], [-1, 0]];

export interface RoomData {
  id: number;
  type: RoomTypeId;
  name: string;
  floor: number;          // lowest floor the room occupies
  floorsSpanned: number;  // 1 for normal rooms, 2 for stairwells / tall halls under another floor
  tx: number; tz: number; tw: number; td: number; // tile rectangle
  x0: number; z0: number; x1: number; z1: number; // world rectangle (tile edges)
  y: number;              // floor surface height
  height: number;         // ceiling height above y
  surfaces: string;
  sector: number;
  corridor: boolean;
  tall: boolean;
  locked: boolean;
  hidden: boolean;
  dark: boolean;
  doors: number[];
  lights: number[];
  loot: number;
  /** BFS depth from the lift (door hops) */
  depth: number;
  stair?: StairFrame;
  elevator?: { shaft: number };
}

/** Local frame of a stairwell: world = origin + u*right + v*forward */
export interface StairFrame {
  origin: [number, number]; // world x,z of local (0,0)
  right: [number, number];
  forward: [number, number];
  lowerFloor: number;
  upperFloor: number;
}

export type DoorKind = 'arch' | 'hinged' | 'double' | 'security' | 'hidden' | 'shutter';
export type DoorStyle = 'wood' | 'metal' | 'security' | 'ornate' | 'glass' | 'panel';

export interface DoorData {
  id: number;
  rooms: [number, number];
  floor: number;
  x: number; y: number; z: number;
  axis: Axis;             // direction the wall runs
  width: number;
  height: number;
  kind: DoorKind;
  style: DoorStyle;
  lockedBy: number;       // keycard id, -1 if none
  startOpen: boolean;
  hinge: 1 | -1;          // which side the hinge is on
  /** door leaf exists (hinged/double/security/hidden/shutter) */
  leaf: boolean;
}

export interface WallOpening { center: number; width: number; height: number; door: number }

export interface WallData {
  floor: number;
  axis: Axis;
  fixed: number;          // z for axis 'x'; x for axis 'z'
  a: number; b: number;   // extent along the axis
  y: number;              // bottom
  height: number;
  /** room on the negative side of `fixed` and on the positive side (-1 = solid void) */
  neg: number; pos: number;
  openings: WallOpening[];
}

export interface LightData {
  id: number;
  room: number;
  x: number; y: number; z: number;
  fixture: FixtureKind;
  color: string;
  intensity: number;
  range: number;
  /** 'down' spot or 'point' omni */
  type: 'spot' | 'point';
  angle: number;
  broken: boolean;
  flicker: number;        // 0..1 flicker severity
  sector: number;
  rotY: number;
  wall: boolean;
}

export type InteractableKind =
  | 'breaker' | 'lightSwitch' | 'tube' | 'keycard' | 'document' | 'terminal'
  | 'hiddenTrigger' | 'supply' | 'liftLever' | 'elevatorCall' | 'reader' | 'valveWheel';

export interface InteractableData {
  id: number;
  kind: InteractableKind;
  room: number;
  x: number; y: number; z: number;
  rotY: number;
  sector: number;
  target: number;   // door / elevator / room id depending on kind
  data: string;     // document id, keycard id, supply contents
}

export type HazardKind = 'steam' | 'crusher' | 'gas' | 'laser' | 'water' | 'sparks';
export interface HazardData {
  id: number;
  kind: HazardKind;
  room: number;
  x: number; y: number; z: number;  // centre
  hx: number; hy: number; hz: number; // half extents (axis-aligned after rotY)
  rotY: number;
  period: number;
  duty: number;     // fraction of the period it's active
  phase: number;
  damage: number;   // per second (or per hit for crusher)
  sector: number;
}

/** Procedural furniture with exact geometry (colliders + visuals share this) */
export type ProcKind =
  | 'shelf' | 'bench' | 'counter' | 'pedestal' | 'cabinet' | 'crateStack' | 'pallet' | 'machine' | 'tank'
  | 'lockers' | 'bunk' | 'conveyor' | 'serverRack' | 'column' | 'cellBars' | 'bookcase' | 'bar' | 'boiler'
  | 'pipeRun' | 'press' | 'gurney' | 'desk' | 'barrier' | 'liftCar' | 'cargoTube' | 'generator' | 'catwalkRail' | 'beam';

export interface ProcData {
  kind: ProcKind;
  room: number;
  x: number; y: number; z: number;  // base centre (y = floor contact)
  rotY: number;
  w: number; h: number; d: number;
  /** variant / extra parameter (e.g. shelf levels) */
  p: number;
  seed: number;
  solid: boolean;
}

export interface StaticModel {
  model: string;
  room: number;
  x: number; y: number; z: number;  // centre of the model's bounding box
  rotY: number;
  scale: number;
  solid: boolean;
}

export type PropKind = 'valuable' | 'furniture' | 'supply' | 'keycard';
export interface PropSpawn {
  id: number;
  kind: PropKind;
  def: string;      // valuable id or furniture model id
  room: number;
  x: number; y: number; z: number;
  rotY: number;
  value: number;
  mass: number;
}

export interface ValuableSlot { x: number; y: number; z: number; room: number; maxSize: number; floor: boolean }

export interface SpawnPoint { x: number; y: number; z: number; room: number; floor: number; dark: boolean; ceiling: number }

export interface Extraction {
  room: number;
  /** cargo zone (world AABB at floor) */
  zone: { x0: number; z0: number; x1: number; z1: number; y: number };
  lever: Vec3;
  board: Vec3 & { rotY: number };
  /** player must stand in this area to count as aboard */
  aboard: { x0: number; z0: number; x1: number; z1: number; y: number };
  gate: { x: number; z: number; axis: Axis; width: number };
  liftRotY: number;
}

export interface NavLink {
  /** polyline in world coords; first point on floor a, last on floor b */
  points: Vec3[];
  floorA: number;
  floorB: number;
  room: number;
}

export interface ElevatorData {
  id: number;
  room: number;
  x: number; z: number;
  floors: number[];
  size: number;
}

export interface LevelData {
  version: number;
  seed: string;
  map: MapId;
  difficulty: number;
  crew: number;
  quota: number;
  floors: number[];
  rooms: RoomData[];
  doors: DoorData[];
  walls: WallData[];
  lights: LightData[];
  interactables: InteractableData[];
  hazards: HazardData[];
  procs: ProcData[];
  statics: StaticModel[];
  props: PropSpawn[];
  playerSpawns: (Vec3 & { rotY: number })[];
  enemySpawns: SpawnPoint[];
  extraction: Extraction;
  navLinks: NavLink[];
  elevators: ElevatorData[];
  sectors: { id: number; powered: boolean; breaker: number }[];
  keycards: { id: number; door: number; interactable: number }[];
  bounds: { x0: number; z0: number; x1: number; z1: number; y0: number; y1: number };
  totalValue: number;
}

export function floorY(floor: number): number {
  return floor * 6;
}
