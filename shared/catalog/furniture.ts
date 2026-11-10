// Physical properties for furniture / clutter models. dynamic = movable physics prop.
import type { ImpactMaterial } from './valuables';
import MODEL_MANIFEST from '../assets/models.json';

export interface ModelInfo { role: string; size: [number, number, number]; hull: number[]; tris: number; bytes: number; name: string }
export const MODELS = MODEL_MANIFEST as unknown as Record<string, ModelInfo>;

export interface FurnitureDef { mass: number; mat: ImpactMaterial; dynamic: boolean; friction?: number }

export const FURNITURE: Record<string, FurnitureDef> = {
  SchoolChair_01: { mass: 6, mat: 'metal', dynamic: true },
  SchoolDesk_01: { mass: 14, mat: 'wood', dynamic: true },
  modern_arm_chair_01: { mass: 16, mat: 'fabric', dynamic: true },
  dining_chair_02: { mass: 7, mat: 'wood', dynamic: true },
  metal_stool_01: { mass: 4, mat: 'metal', dynamic: true },
  Barrel_01: { mass: 28, mat: 'metal', dynamic: true },
  barrel_03: { mass: 32, mat: 'metal', dynamic: true },
  cardboard_box_01: { mass: 3, mat: 'paper', dynamic: true },
  wooden_crate_01: { mass: 12, mat: 'wood', dynamic: true },
  wooden_crate_02: { mass: 16, mat: 'wood', dynamic: true },
  plastic_crate_03: { mass: 2.5, mat: 'plastic', dynamic: true },
  industrial_pastic_container: { mass: 5, mat: 'plastic', dynamic: true },
  WetFloorSign_01: { mass: 1.2, mat: 'plastic', dynamic: true },
  korean_fire_extinguisher_01: { mass: 9, mat: 'metal', dynamic: true },
  hand_truck: { mass: 14, mat: 'metal', dynamic: true, friction: 0.25 },
  wheelchair_01: { mass: 16, mat: 'metal', dynamic: true, friction: 0.15 },
  industrial_storage_cart: { mass: 45, mat: 'metal', dynamic: true, friction: 0.06 },
  tool_cart: { mass: 38, mat: 'metal', dynamic: true, friction: 0.08 },
  side_table_01: { mass: 8, mat: 'wood', dynamic: true },
  old_tyre: { mass: 9, mat: 'fabric', dynamic: true },
  wooden_military_crate: { mass: 24, mat: 'wood', dynamic: true },
  metal_trash_can: { mass: 30, mat: 'metal', dynamic: false },
  // static furniture
  metal_office_desk: { mass: 60, mat: 'metal', dynamic: false },
  Sofa_01: { mass: 60, mat: 'fabric', dynamic: false },
  ArmChair_01: { mass: 30, mat: 'fabric', dynamic: false },
  ClassicConsole_01: { mass: 50, mat: 'wood', dynamic: false },
  GothicCabinet_01: { mass: 120, mat: 'wood', dynamic: false },
  CoffeeTable_01: { mass: 25, mat: 'wood', dynamic: false },
  dining_table: { mass: 70, mat: 'wood', dynamic: false },
  wooden_bookshelf_worn: { mass: 80, mat: 'wood', dynamic: false },
  drawer_cabinet: { mass: 70, mat: 'metal', dynamic: false },
  old_bed_frame: { mass: 60, mat: 'metal', dynamic: false },
  vintage_cabinet_01: { mass: 110, mat: 'wood', dynamic: false },
  GothicCommode_01: { mass: 60, mat: 'wood', dynamic: false },
  utility_box_01: { mass: 50, mat: 'metal', dynamic: false },
  utility_box_02: { mass: 70, mat: 'metal', dynamic: false },
  standing_chalkboard_01: { mass: 20, mat: 'wood', dynamic: false },
  round_wooden_table_01: { mass: 35, mat: 'wood', dynamic: false },
  wooden_display_shelves_01: { mass: 40, mat: 'wood', dynamic: false },
  mid_century_lounge_chair: { mass: 25, mat: 'fabric', dynamic: false },
  gothic_coffee_table: { mass: 40, mat: 'wood', dynamic: false },
  portable_welding_cart: { mass: 60, mat: 'metal', dynamic: false },
  exterior_aircon_unit: { mass: 90, mat: 'metal', dynamic: false },
  steel_frame_shelves_03: { mass: 80, mat: 'metal', dynamic: false },
  worn_metal_rack: { mass: 50, mat: 'metal', dynamic: false },
};

export function modelSize(model: string): [number, number, number] {
  return MODELS[model]?.size ?? [0.5, 0.5, 0.5];
}
