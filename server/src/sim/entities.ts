import type RAPIER from '@dimforge/rapier3d-compat';
import type { DoorData } from '../../../shared/levelgen/types';
import type { LeafSpec } from '../../../shared/doors';
import type { PlayerLife, V3, Q4 } from '../../../shared/protocol';
import type { Loadout } from '../../../shared/catalog/items';
import type { ImpactMaterial } from '../../../shared/catalog/valuables';
import type { Member } from '../lobby/Room';

export interface GearEffects {
  resist: number; speed: number; noise: number; strength: number; reach: number; stamina: number; battery: number;
}

export class MPlayer {
  netId: number;
  id: string;
  name: string;
  member: Member;
  pos: V3 = [0, 0, 0];
  vel: V3 = [0, 0, 0];
  yaw = 0;
  pitch = 0;
  flags = 0;
  anim = 0;
  hold: V3 | null = null;
  lastStateAt = 0;
  epoch = 0;
  // validation
  accepted: V3 = [0, 0, 0];
  moveBudget = 3;
  upBudget = 2;
  airTop = 0;
  wasGrounded = true;
  violations = 0;
  // body
  body: RAPIER.RigidBody | null = null;
  // health & life
  hp = 100;
  life: PlayerLife = 'alive';
  bleedUntil = 0;
  deathPos: V3 | null = null;
  invulnUntil = 0;
  god = false;
  // equipment
  loadout: Loadout;
  items: Record<string, number> = {};       // persistent consumables available this mission
  found: Record<string, number> = {};       // supplies found in the facility (mission only)
  gear: GearEffects = { resist: 0, speed: 1, noise: 1, strength: 1, reach: 0, stamina: 1, battery: 1 };
  battery = 240;
  batteryMax = 240;
  scannerReadyAt = 0;
  prodCharges = 3;
  prodRecharge: number[] = [];
  stimUntil = 0;
  crashUntil = 0;
  healUntil = 0;
  healPerSec = 0;
  markedUntil = 0;
  pinnedBy = -1;
  stunnedUntil = 0;
  useCounter = 0;
  lastNoiseAt = 0;
  lastVoiceAt = 0;
  lastPingAt = -9;
  lastImpactReport = new Map<number, number>();
  // carrying
  owned = -1;
  helping = -1;
  // revive progress (reviver netId → seconds)
  reviveProgress = new Map<number, { t: number; at: number }>();
  // summary stats
  delivered = 0;
  itemsDelivered = 0;
  revives = 0;
  downs = 0;
  died = false;
  docs = 0;
  power = 0;
  tubes = 0;
  stuns = 0;
  heaviest = 0;
  spotted = false;
  seen = new Set<number>();
  damageTaken = 0;
  coCarry3 = false;
  connected = true;

  constructor(member: Member, loadout: Loadout) {
    this.member = member;
    this.netId = member.netId;
    this.id = member.id;
    this.name = member.name;
    this.loadout = loadout;
  }

  get alive() { return this.life === 'alive'; }
  get eye(): V3 { const crouch = (this.flags & 1) !== 0; return [this.pos[0], this.pos[1] + (this.life === 'downed' ? 0.5 : crouch ? 0.98 : 1.62), this.pos[2]]; }
  countOf(item: string) { return (this.found[item] ?? 0) + (this.items[item] ?? 0); }
}

export interface HolderInfo { netId: number; lp: V3; target: V3 | null; since: number }

export class MProp {
  id: number;
  def: string;
  kind: 'valuable' | 'furniture' | 'thrown';
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  mass: number;
  base: number;
  value: number;
  fragility: number;
  mat: ImpactMaterial;
  volatile: boolean;
  cursed: boolean;
  radius: number;
  halfHeight: number;
  owner: number = -1;            // netId
  ownerSince = 0;
  helpers = new Map<number, HolderInfo>();
  lps = new Map<number, V3>();
  lastHolder = -1;
  maxHolders = 0;
  removed = false;
  sentAsleep = false;
  forceSend = true;
  lastVel: V3 = [0, 0, 0];
  skipImpact = 0;
  invalidPoses = 0;
  lastImpactAt = 0;
  damaged = false;
  spawn: V3;
  room: number;
  thrownItem: string | null = null;
  thrownBy = -1;
  activeAt = 0;
  expireAt = 0;
  lightId = -1;
  cursedTriggered = false;
  pose: { p: V3; q: Q4; v: V3; w: V3 } | null = null;

  constructor(init: { id: number; def: string; kind: MProp['kind']; body: RAPIER.RigidBody; collider: RAPIER.Collider; mass: number; base: number; value: number; fragility: number; mat: ImpactMaterial; volatile: boolean; cursed: boolean; radius: number; halfHeight: number; spawn: V3; room: number }) {
    this.id = init.id; this.def = init.def; this.kind = init.kind; this.body = init.body; this.collider = init.collider;
    this.mass = init.mass; this.base = init.base; this.value = init.value; this.fragility = init.fragility; this.mat = init.mat;
    this.volatile = init.volatile; this.cursed = init.cursed; this.radius = init.radius; this.halfHeight = init.halfHeight;
    this.spawn = init.spawn; this.room = init.room;
  }

  get held() { return this.owner >= 0; }
  position(): V3 { const t = this.body.translation(); return [t.x, t.y, t.z]; }
}

export class MDoor {
  data: DoorData;
  open = false;
  locked: boolean;
  broken = false;
  revealed: boolean;
  value = 0;          // current angle / fraction
  target = 0;
  fast = false;
  leaves: { spec: LeafSpec; body: RAPIER.RigidBody }[] = [];
  lastToggle = 0;

  constructor(data: DoorData) {
    this.data = data;
    this.locked = data.lockedBy >= 0;
    this.revealed = data.kind !== 'hidden';
  }

  get passable() { return this.broken || !this.data.leaf || (this.open && Math.abs(this.value - this.target) < 0.4); }
}
