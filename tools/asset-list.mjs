// Curated list of CC0 assets fetched from Poly Haven (https://polyhaven.com, CC0 1.0).
// Every asset listed here is public-domain (CC0); see CREDITS in README.md.
//
// tex:  maximum texture edge after processing (smaller for small objects to save VRAM)
// tris: triangle budget after simplification (meshoptimizer)

const V = (id, tex = 512, tris = 9000) => ({ id, role: 'valuable', tex, tris });
const F = (id, tex = 512, tris = 9000) => ({ id, role: 'furniture', tex, tris });
const L = (id, tex = 256, tris = 4000) => ({ id, role: 'fixture', tex, tris });
const D = (id, tex = 256, tris = 4000) => ({ id, role: 'decor', tex, tris });

export const MODELS = [
  // --- Research complex valuables
  V('vintage_microscope'), V('industrial_microscope'), V('bunsen_burner', 256, 5000), V('chemistry_set', 512, 9000),
  V('retro_multimeter', 256, 5000), V('vintage_spacecraft_instrument'), V('circuit_board', 256, 4000), V('classic_laptop', 512, 6000),
  V('old_gas_mask', 512, 7000), V('binoculars', 256, 6000), V('magnifying_glass_01', 256, 4000), V('vintage_radio_transceiver', 512, 9000),
  V('medical_box', 256, 3000), V('metal_detector', 256, 6000),
  // --- Industrial valuables
  V('Drill_01', 256, 3000), V('pipe_wrench', 256, 4000), V('brass_blowtorch', 256, 6000), V('metal_toolbox', 512, 6000),
  V('metal_tool_chest', 512, 8000), V('portable_generator', 512, 10000), V('power_box_01', 512, 8000), V('propane_tank', 256, 4000),
  V('old_military_compressor', 512, 12000), V('bench_vice_01', 256, 3000), V('old_drill_press', 512, 10000), V('small_oil_can_01', 256, 5000),
  V('portable_searchlight', 512, 8000), V('metal_jerrycan', 512, 6000), V('ratchet_wrench', 256, 4000), V('adjustable_wrench', 256, 3000),
  // --- Underground valuables
  V('old_military_crate', 512, 6000), V('ammo_box', 256, 4000), V('vintage_flashlight', 256, 5000), V('signal_flashlight', 256, 5000),
  V('portable_cassette_player', 256, 6000), V('cigarette_case', 256, 4000), V('pocket_watch', 256, 6000), V('seadogs_compass', 256, 6000),
  V('vintage_binocular', 256, 7000), V('Lantern_01', 512, 9000), V('treasure_chest', 1024, 14000),
  // --- Luxury valuables
  V('brass_vase_01', 512, 8000), V('brass_vase_02', 512, 5000), V('brass_vase_03', 256, 2600), V('antique_ceramic_vase_01', 512, 7000),
  V('ceramic_vase_01', 256, 2600), V('ceramic_vase_03', 256, 2800), V('marble_bust_01', 512, 9000), V('bronze_whale_statue', 512, 3800),
  V('bronze_shark_statue', 512, 6000), V('horse_statue_01', 512, 9000), V('gothic_statue', 512, 9000), V('chess_set', 512, 12000),
  V('brass_candleholders', 512, 9000), V('brass_goblets', 256, 6000), V('mantel_clock_01', 512, 9000), V('vintage_grandfather_clock_01', 1024, 12000),
  V('ornate_mirror_01', 512, 9000), V('fancy_picture_frame_01', 512, 1000), V('Camera_01', 512, 9000), V('vintage_video_camera', 512, 9000),
  V('filmstrip_projector_8mm', 512, 10000), V('tea_set_01', 512, 10000), V('wine_bottles_01', 512, 9000), V('carved_wooden_elephant', 256, 2800),
  V('vintage_pocket_watch', 256, 4200), V('vintage_suitcase', 512, 8000), V('Ukulele_01', 512, 7000), V('boombox', 512, 8000),
  V('cassette_player', 256, 4800), V('Television_01', 512, 2000), V('vintage_oil_lamp', 256, 6000), V('CashRegister_01', 512, 8000),
  V('alarm_clock_01', 256, 6000), V('vintage_telephone_wall_clock', 512, 8000),

  // --- Furniture / large props
  F('steel_frame_shelves_01', 512, 4400), F('steel_frame_shelves_03', 512, 8400), F('worn_metal_rack', 512, 6400), F('metal_office_desk', 512, 7000),
  F('SchoolChair_01', 512, 5000), F('SchoolDesk_01', 512, 4200), F('modern_arm_chair_01', 512, 9000), F('Sofa_01', 512, 4200),
  F('ArmChair_01', 512, 5600), F('ClassicConsole_01', 512, 7600), F('GothicCabinet_01', 512, 10000), F('CoffeeTable_01', 512, 8000),
  F('dining_table', 512, 1100), F('dining_chair_02', 512, 9000), F('wooden_bookshelf_worn', 512, 10000), F('drawer_cabinet', 512, 10000),
  F('industrial_storage_cart', 512, 9000), F('tool_cart', 512, 10000), F('Barrel_01', 512, 2700), F('barrel_03', 512, 1500),
  F('cardboard_box_01', 512, 4000), F('wooden_crate_01', 512, 6600), F('wooden_crate_02', 512, 5200), F('plastic_crate_03', 512, 8000),
  F('industrial_pastic_container', 512, 7200), F('metal_trash_can', 512, 8000), F('WetFloorSign_01', 256, 300), F('korean_fire_extinguisher_01', 256, 6000),
  F('hand_truck', 512, 8000), F('old_bed_frame', 512, 12000), F('wheelchair_01', 512, 12000), F('vintage_cabinet_01', 512, 12000),
  F('GothicCommode_01', 512, 4000), F('side_table_01', 512, 2800), F('utility_box_01', 512, 4400), F('utility_box_02', 512, 6300),
  F('standing_chalkboard_01', 512, 2400), F('wooden_military_crate', 512, 8000), F('metal_stool_01', 256, 6000), F('round_wooden_table_01', 512, 8000),
  F('wooden_display_shelves_01', 512, 3200), F('mid_century_lounge_chair', 512, 6200), F('gothic_coffee_table', 512, 10000), F('portable_welding_cart', 512, 10000),
  F('exterior_aircon_unit', 512, 9000), F('old_tyre', 256, 2900),

  // --- Light fixtures (visual housings for the dynamic light system)
  L('mounted_fluorescent_lights', 256, 6000), L('caged_hanging_light', 256, 6000), L('hanging_industrial_lamp', 256, 5000),
  L('industrial_wall_lamp', 256, 4500), L('industrial_caged_sconce', 256, 6000), L('Chandelier_02', 512, 12000),
  L('modern_ceiling_lamp_01', 256, 5600), L('industrial_wall_sconce', 256, 6000), L('security_light', 256, 4700),

  // --- Decor / clutter (no gameplay value)
  D('fire_alarm', 256, 2700), D('security_camera_01', 256, 6000), D('hanging_picture_frame_02', 256, 3700), D('dartboard', 256, 4000),
  D('clipboard', 256, 3000), D('office_notepads', 256, 700), D('stationery_supplies', 256, 4400), D('decorative_book_set_01', 512, 9000),
  D('book_encyclopedia_set_01', 512, 9000), D('throw_pillows_01', 256, 4000), D('ceiling_fan', 512, 8000), D('lifebuoy', 256, 6000),
  D('cement_bag', 256, 900), D('trashbag', 256, 4500), D('rubber_boots', 256, 6000), D('plastic_bottle_gallon', 256, 5000),
  D('can_rusted', 256, 3500), D('binder_notebook', 256, 5000), D('wooden_lantern_01', 256, 6000), D('lightbulb_01', 256, 2000),
];

const T = (id, arm = 512) => ({ id, arm });

// Surface material sets (albedo + normal at 1024, packed AO/rough/metal at `arm` px)
export const TEXTURES = [
  // research
  T('floor_tiles_06'), T('tiled_floor_001'), T('worn_tile_floor'), T('white_plaster_02'), T('plaster_grey_04'),
  T('ceiling_interior'), T('interior_tiles'), T('painted_concrete'),
  // industrial
  T('hangar_concrete_floor'), T('concrete_floor_painted'), T('anti_slip_concrete'), T('metal_plate'), T('factory_wall'),
  T('corrugated_iron_02'), T('concrete_wall_008'), T('rusty_metal_02'), T('painted_metal_shutter'), T('blue_metal_plate'),
  T('metal_grate_rusty'),
  // underground
  T('damaged_concrete_floor'), T('concrete_floor_worn_001'), T('dirty_concrete'), T('concrete_wall_003'), T('preconcrete_wall_001'),
  T('cracked_concrete_wall'), T('brick_wall_13'), T('castle_brick_07'),
  // luxury
  T('herringbone_parquet'), T('marble_01'), T('dirty_carpet'), T('patterned_plaster_wall'), T('beige_wall_001'),
  T('wood_cabinet_worn_long'), T('dark_wood'), T('white_stucco'), T('velour_velvet'),
  // shared / depot
  T('rusty_metal_03'), T('green_metal_rust'), T('metal_plate_02'), T('rust_coarse_01'), T('garage_floor'), T('concrete_wall_001'),
];
