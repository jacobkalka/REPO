// Local first-person controller (client-predicted, server-validated) + camera rig.
import * as THREE from 'three';
import { COLLISION, groups, PLAYER } from '../../../shared/constants';
import { PF, type PlayerLife } from '../../../shared/protocol';
import type { Input } from '../core/Input';
import type { SettingsData } from '../core/Settings';
import { RAPIER, type ClientWorld } from './ClientWorld';

export interface MoveModifiers { speed: number; stamina: number; regen: number; carryMass: number; strength: number; carrySlow: number; stim: boolean; crash: boolean }

export class LocalPlayer {
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  grounded = true;
  crouching = false;
  sprinting = false;
  private crouchToggle = false;
  private sprintToggle = false;
  stamina: number = PLAYER.STAMINA_MAX;
  staminaMax: number = PLAYER.STAMINA_MAX;
  private staminaDelay = 0;
  private exhausted = false;
  private eye: number = PLAYER.EYE_HEIGHT;
  private height: number = PLAYER.HEIGHT;
  private bobPhase = 0;
  private bobAmp = 0;
  private landDip = 0;
  private fallSpeed = 0;
  trauma = 0;
  private fovKick = 0;
  life: PlayerLife = 'alive';
  hp = 100;
  pinned = false;
  stunned = false;
  frozen = true;             // before mission start
  readonly camPos = new THREE.Vector3();
  readonly camQuat = new THREE.Quaternion();
  onStep?: (intensity: number) => void;
  onLand?: (speed: number) => void;
  onJump?: () => void;
  private stepAcc = 0;
  private euler = new THREE.Euler(0, 0, 0, 'YXZ');
  epoch = 0;

  constructor(readonly world: ClientWorld) {}

  get flags(): number {
    let f = 0;
    if (this.crouching) f |= PF.CROUCH;
    if (this.sprinting) f |= PF.SPRINT;
    if (this.grounded) f |= PF.GROUNDED;
    return f;
  }

  get eyePos(): THREE.Vector3 { return new THREE.Vector3(this.pos.x, this.pos.y + this.eye, this.pos.z); }

  get forward(): THREE.Vector3 {
    return new THREE.Vector3(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
  }

  teleport(x: number, y: number, z: number) {
    this.pos.set(x, y, z);
    this.vel.set(0, 0, 0);
    this.syncBody(true);
  }

  private syncBody(hard = false) {
    const hh = (this.height - 2 * PLAYER.RADIUS) / 2;
    const c = { x: this.pos.x, y: this.pos.y + PLAYER.RADIUS + hh, z: this.pos.z };
    if (hard) this.world.playerBody.setTranslation(c, true);
    this.world.playerBody.setNextKinematicTranslation(c);
  }

  look(input: Input, s: SettingsData, rotateHeld: boolean) {
    if (rotateHeld) return;
    const k = 0.0022 * s.sensitivity;
    this.yaw -= input.mouseDX * k;
    this.pitch -= input.mouseDY * k * (s.invertY ? -1 : 1);
    this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch));
  }

  update(dt: number, input: Input, s: SettingsData, mods: MoveModifiers) {
    const downed = this.life === 'downed';
    const canMove = !this.frozen && !this.pinned && !this.stunned && (this.life === 'alive' || downed);
    // crouch / sprint (hold or toggle)
    if (s.toggleCrouch) { if (input.justPressed('crouch')) this.crouchToggle = !this.crouchToggle; } else this.crouchToggle = input.held('crouch');
    const wantCrouch = (this.crouchToggle || downed) && canMove;
    if (s.toggleSprint) { if (input.justPressed('sprint')) this.sprintToggle = !this.sprintToggle; } else this.sprintToggle = input.held('sprint');
    const fwd = (input.held('forward') ? 1 : 0) - (input.held('back') ? 1 : 0);
    const str = (input.held('right') ? 1 : 0) - (input.held('left') ? 1 : 0);
    const moving = canMove && (fwd !== 0 || str !== 0);
    // stand-up headroom check
    if (!wantCrouch && this.crouching) {
      if (this.headroom(PLAYER.HEIGHT)) this.crouching = false;
    } else if (wantCrouch) this.crouching = true;
    const targetH = downed ? 0.6 : this.crouching ? PLAYER.CROUCH_HEIGHT : PLAYER.HEIGHT;
    if (Math.abs(targetH - this.height) > 0.01) {
      this.height += (targetH - this.height) * Math.min(1, dt * 12);
      this.setCapsule(this.height);
    }
    const targetEye = downed ? 0.45 : this.crouching ? PLAYER.CROUCH_EYE_HEIGHT : PLAYER.EYE_HEIGHT;
    this.eye += (targetEye - this.eye) * Math.min(1, dt * 12);
    // stamina
    const canSprint = this.sprintToggle && moving && fwd > 0 && !this.crouching && !downed && (!this.exhausted || mods.stim) && !mods.crash;
    this.sprinting = canSprint && this.grounded;
    if (this.sprinting && !mods.stim) { this.stamina -= PLAYER.STAMINA_DRAIN * dt; this.staminaDelay = 0.9; }
    else { this.staminaDelay -= dt; if (this.staminaDelay <= 0) this.stamina += PLAYER.STAMINA_REGEN * mods.regen * dt; }
    this.staminaMax = PLAYER.STAMINA_MAX * mods.stamina;
    this.stamina = Math.max(0, Math.min(this.staminaMax, this.stamina));
    if (this.stamina <= 0.5) this.exhausted = true;
    if (this.exhausted && this.stamina > this.staminaMax * 0.3) this.exhausted = false;
    // carry slowdown: heavy loads relative to strength slow you down
    const carryRatio = Math.min(1.6, mods.carryMass / Math.max(1, (mods.strength * PLAYER.STRENGTH) / 9.81));
    const carryFactor = Math.max(0.35, 1 - carryRatio * 0.45 * mods.carrySlow);
    let maxSpeed = downed ? PLAYER.DOWNED_SPEED : this.crouching ? PLAYER.CROUCH_SPEED : this.sprinting ? PLAYER.SPRINT_SPEED : PLAYER.RUN_SPEED;
    maxSpeed *= mods.speed * (downed ? 1 : carryFactor) * (mods.stim ? 1.15 : 1) * (mods.crash ? 0.7 : 1);
    // wish direction
    const sinY = Math.sin(this.yaw), cosY = Math.cos(this.yaw);
    let wx = -sinY * fwd + cosY * str, wz = -cosY * fwd - sinY * str;
    const wl = Math.hypot(wx, wz);
    if (wl > 0) { wx /= wl; wz /= wl; }
    const accel = this.grounded ? PLAYER.ACCEL_GROUND : PLAYER.ACCEL_AIR;
    const tx = moving ? wx * maxSpeed : 0, tz = moving ? wz * maxSpeed : 0;
    const dvx = tx - this.vel.x, dvz = tz - this.vel.z;
    const dvl = Math.hypot(dvx, dvz);
    const maxDv = (moving ? accel : this.grounded ? PLAYER.FRICTION * Math.max(2, Math.hypot(this.vel.x, this.vel.z)) : PLAYER.ACCEL_AIR * 0.3) * dt;
    if (dvl > 0) { const k = Math.min(1, maxDv / dvl); this.vel.x += dvx * k; this.vel.z += dvz * k; }
    // jump
    if (canMove && !downed && this.grounded && input.justPressed('jump') && this.stamina >= PLAYER.STAMINA_JUMP_COST && !this.crouching) {
      this.vel.y = PLAYER.JUMP_VELOCITY * (carryRatio > 1 ? 0.6 : 1);
      this.stamina -= PLAYER.STAMINA_JUMP_COST;
      this.staminaDelay = 0.9;
      this.grounded = false;
      this.onJump?.();
    }
    this.vel.y = Math.max(-PLAYER.MAX_FALL_SPEED, this.vel.y - PLAYER.GRAVITY * dt);
    if (!canMove && this.grounded) { this.vel.x *= 0.7; this.vel.z *= 0.7; }
    // move with the character controller
    const desired = { x: this.vel.x * dt, y: this.vel.y * dt, z: this.vel.z * dt };
    const wasGrounded = this.grounded;
    const prevVy = this.vel.y;
    this.world.kcc.computeColliderMovement(this.world.playerCollider, desired, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, groups(0xffff, COLLISION.STATIC | COLLISION.DOOR | COLLISION.PROP), this.world.blocksPlayer);
    const mv = this.world.kcc.computedMovement();
    this.grounded = this.world.kcc.computedGrounded();
    this.pos.x += mv.x; this.pos.y += mv.y; this.pos.z += mv.z;
    if (dt > 0) {
      // lose velocity into walls
      const ax = mv.x / dt, az = mv.z / dt;
      if (Math.abs(ax) < Math.abs(this.vel.x) - 0.05) this.vel.x = ax;
      if (Math.abs(az) < Math.abs(this.vel.z) - 0.05) this.vel.z = az;
      if (mv.y > desired.y + 1e-4 && this.vel.y < 0) this.vel.y = 0;      // landed / blocked below
      if (mv.y < desired.y - 1e-4 && this.vel.y > 0) this.vel.y = 0;      // head hit
    }
    if (this.grounded) {
      if (!wasGrounded && prevVy < -3) { this.landDip = Math.min(0.12, -prevVy * 0.012); this.onLand?.(-prevVy); this.trauma = Math.min(1, this.trauma + Math.max(0, -prevVy - 7) * 0.05); }
      if (this.vel.y < 0) this.vel.y = -1.0;
    }
    this.fallSpeed = this.vel.y;
    this.syncBody();
    // camera rig
    const hspeed = Math.hypot(this.vel.x, this.vel.z);
    this.bobAmp += ((this.grounded ? Math.min(1, hspeed / PLAYER.SPRINT_SPEED) : 0) - this.bobAmp) * Math.min(1, dt * 8);
    const prev = Math.sin(this.bobPhase * 2);
    this.bobPhase += hspeed * dt * (this.crouching ? 2.6 : 1.85);
    const cur = Math.sin(this.bobPhase * 2);
    this.stepAcc += hspeed * dt;
    if (this.grounded && hspeed > 0.8 && prev > -0.95 && cur <= -0.95 && this.stepAcc > 0.35) { this.stepAcc = 0; this.onStep?.(Math.min(1, hspeed / PLAYER.SPRINT_SPEED) * (this.crouching ? 0.35 : 1)); }
    this.landDip *= Math.exp(-dt * 7);
    this.trauma = Math.max(0, this.trauma - dt * 1.3);
    this.fovKick += ((this.sprinting && hspeed > 4 ? 1 : 0) - this.fovKick) * Math.min(1, dt * 5);
    const bobScale = s.headBob;
    const bobY = Math.sin(this.bobPhase * 2) * 0.032 * this.bobAmp * bobScale;
    const bobX = Math.cos(this.bobPhase) * 0.022 * this.bobAmp * bobScale;
    const shake = this.trauma * this.trauma * s.cameraShake;
    const t = performance.now() / 1000;
    const sx = (Math.sin(t * 37.1) + Math.sin(t * 21.7)) * 0.5 * shake * 0.05;
    const sy = (Math.sin(t * 29.3) + Math.sin(t * 17.9)) * 0.5 * shake * 0.05;
    this.camPos.set(this.pos.x + Math.cos(this.yaw) * bobX, this.pos.y + this.eye + bobY - this.landDip, this.pos.z - Math.sin(this.yaw) * bobX);
    this.euler.set(this.pitch + sy + (this.pinned ? Math.sin(t * 13) * 0.02 : 0), this.yaw + sx, Math.cos(this.bobPhase) * 0.004 * this.bobAmp * bobScale + shake * Math.sin(t * 23) * 0.03);
    this.camQuat.setFromEuler(this.euler);
    void this.fallSpeed;
  }

  get fovOffset() { return this.fovKick * 7; }

  private setCapsule(h: number) {
    const hh = Math.max(0.05, (h - 2 * PLAYER.RADIUS) / 2);
    this.world.playerCollider.setHalfHeight(hh);
    this.syncBody(true);
  }

  private headroom(h: number): boolean {
    const hh = (h - 2 * PLAYER.RADIUS) / 2;
    const shape = new RAPIER.Capsule(hh, PLAYER.RADIUS - 0.04);
    let blocked = false;
    this.world.world.intersectionsWithShape({ x: this.pos.x, y: this.pos.y + PLAYER.RADIUS + hh + 0.05, z: this.pos.z }, { x: 0, y: 0, z: 0, w: 1 }, shape, () => { blocked = true; return false; }, undefined, groups(0xffff, COLLISION.STATIC | COLLISION.DOOR));
    return !blocked;
  }

  applyCorrection(p: [number, number, number], epoch: number) {
    this.epoch = epoch;
    this.teleport(p[0], p[1], p[2]);
  }

  impulse(v: [number, number, number]) {
    this.vel.x += v[0]; this.vel.y += v[1]; this.vel.z += v[2];
    if (v[1] > 0.5) this.grounded = false;
    this.trauma = Math.min(1, this.trauma + Math.hypot(v[0], v[2]) * 0.06);
  }
}
