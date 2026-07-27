// First-person character controller.
//
// Movement model is tuned against modern military shooters rather than a
// physics sim: high ground acceleration so input feels instant, real inertia
// in the air, capped strafe speed, and a hard separation between the collision
// body (an AABB, axis-resolved) and the camera (which floats on springs so
// bob, sway and recoil never push the player through a wall).

import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);

export const TUNING = {
  radius: 0.32,
  standHeight: 1.82,
  crouchHeight: 1.15,
  eyeOffset: -0.16,           // eye sits below the crown of the head
  stepHeight: 0.42,

  walkSpeed: 4.55,
  sprintSpeed: 7.15,
  crouchSpeed: 2.35,
  adsSpeed: 2.90,
  backpedalScale: 0.78,

  groundAccel: 62,
  airAccel: 14,
  friction: 9.5,
  airDrag: 0.18,

  gravity: 19.6,
  jumpVelocity: 5.05,
  coyoteTime: 0.11,
  jumpBuffer: 0.13,

  mouseSensitivity: 0.0021,
  adsSensitivityScale: 0.62,
  pitchLimit: Math.PI / 2 - 0.02,

  maxHealth: 100,
  regenDelay: 4.2,
  regenRate: 26,
};

export class Player {
  constructor(level, camera) {
    this.level = level;
    this.camera = camera;

    this.position = new THREE.Vector3(-6, 2, 17);
    this.velocity = new THREE.Vector3();
    this.yaw = Math.PI * 0.86;
    this.pitch = -0.02;

    this.height = TUNING.standHeight;
    this.targetHeight = TUNING.standHeight;
    this.onGround = false;
    this.crouching = false;
    this.sprinting = false;
    this.ads = 0;                 // 0..1 aim-down-sights blend
    this.adsTarget = 0;

    this.health = TUNING.maxHealth;
    this.lastDamageTime = -99;
    this.alive = true;

    this._coyote = 0;
    this._jumpBuffered = -99;
    this._bobPhase = 0;
    this._bobAmount = 0;
    this._landDip = 0;
    this._landDipVel = 0;
    this._stepDistance = 0;
    this._prevVerticalSpeed = 0;

    // Camera springs. `viewOffset` is bob + landing dip; `viewAngle` is
    // lean/roll and recoil-induced pitch, both additive over yaw/pitch.
    this.viewOffset = new THREE.Vector3();
    this.viewAngle = new THREE.Vector3();
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this._recoilPitchVel = 0;
    this._recoilYawVel = 0;

    // Aim punch that the weapon reads to bias its own kick.
    this.lookDelta = new THREE.Vector2();

    this._box = new THREE.Box3();
    this._tmp = new THREE.Vector3();
    this._forward = new THREE.Vector3();
    this._right = new THREE.Vector3();

    this.footstepCallback = null;
    this.landCallback = null;
  }

  /* ------------------------------------------------------------ helpers -- */

  aabb(target = this._box, height = this.height, pos = this.position) {
    const r = TUNING.radius;
    target.min.set(pos.x - r, pos.y, pos.z - r);
    target.max.set(pos.x + r, pos.y + height, pos.z + r);
    return target;
  }

  get eyeY() { return this.position.y + this.height + TUNING.eyeOffset; }

  get speedHorizontal() {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  /** Would the body at `pos` with `height` overlap anything? */
  blocked(pos, height) {
    const box = this.aabb(new THREE.Box3(), height, pos);
    for (const c of this.level.colliders) if (box.intersectsBox(c)) return true;
    return false;
  }

  /* ------------------------------------------------------------- input -- */

  look(dx, dy) {
    const scale = THREE.MathUtils.lerp(1, TUNING.adsSensitivityScale, this.ads);
    this.yaw -= dx * TUNING.mouseSensitivity * scale;
    this.pitch -= dy * TUNING.mouseSensitivity * scale;
    this.pitch = THREE.MathUtils.clamp(this.pitch, -TUNING.pitchLimit, TUNING.pitchLimit);
    this.lookDelta.set(dx, dy);
  }

  requestJump(now) { this._jumpBuffered = now; }

  /** Kick from firing. Recovers on a critically-damped spring. */
  addRecoil(pitch, yaw) {
    this._recoilPitchVel += pitch;
    this._recoilYawVel += yaw;
  }

  damage(amount) {
    if (!this.alive) return;
    this.health = Math.max(0, this.health - amount);
    this.lastDamageTime = this._now ?? 0;
    if (this.health <= 0) this.alive = false;
  }

  /* -------------------------------------------------------------- solve -- */

  /**
   * Moves one axis and resolves penetration on that axis only. Axis-separated
   * resolution is what keeps the body from catching on the seams between
   * adjacent colliders, which a single push-out vector always does.
   */
  moveAxis(axis, amount) {
    if (amount === 0) return false;
    this.position[axis] += amount;
    let hit = false;

    for (let iter = 0; iter < 4; iter++) {
      const box = this.aabb();
      let overlap = null;
      for (const c of this.level.colliders) {
        if (!box.intersectsBox(c)) continue;
        overlap = c;
        break;
      }
      if (!overlap) break;
      hit = true;
      if (amount > 0) this.position[axis] -= (box.max[axis] - overlap.min[axis]) + 1e-4;
      else this.position[axis] += (overlap.max[axis] - box.min[axis]) + 1e-4;
    }

    if (hit) this.velocity[axis] = 0;
    return hit;
  }

  /** Horizontal move with automatic step-up over kerbs, rubble and sandbags. */
  moveHorizontal(dx, dz) {
    const startY = this.position.y;

    const tryAxis = (axis, amount) => {
      const before = this.position[axis];
      const blockedNow = this.moveAxis(axis, amount);
      if (!blockedNow || !this.onGround) return;

      // Retry the same motion from one step higher; if it clears and there is
      // headroom, keep the raised position and let gravity settle us down.
      const savedY = this.position.y;
      this.position[axis] = before;
      this.position.y += TUNING.stepHeight;
      if (!this.blocked(this.position, this.height)) {
        this.position[axis] += amount;
        if (this.blocked(this.position, this.height)) {
          this.position[axis] = before;
          this.position.y = savedY;
        }
      } else {
        this.position.y = savedY;
      }
    };

    // Move along the larger component first — reduces corner snagging.
    if (Math.abs(dx) >= Math.abs(dz)) { tryAxis('x', dx); tryAxis('z', dz); }
    else { tryAxis('z', dz); tryAxis('x', dx); }

    if (this.position.y > startY + 1e-4) this._steppedUp = true;
  }

  /* ------------------------------------------------------------- update -- */

  update(dt, input, now) {
    this._now = now;

    // ---- stance -----------------------------------------------------------
    const wantCrouch = input.crouch;
    if (wantCrouch) {
      this.crouching = true;
    } else if (this.crouching) {
      // Only stand back up when there is room.
      const probe = this._tmp.copy(this.position);
      if (!this.blocked(probe, TUNING.standHeight)) this.crouching = false;
    }
    this.targetHeight = this.crouching ? TUNING.crouchHeight : TUNING.standHeight;
    this.height = THREE.MathUtils.damp(this.height, this.targetHeight, 14, dt);

    // ---- wish direction ---------------------------------------------------
    this._forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this._right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));

    const wish = this._tmp.set(0, 0, 0);
    if (input.forward) wish.add(this._forward);
    if (input.back) wish.addScaledVector(this._forward, -TUNING.backpedalScale);
    if (input.left) wish.addScaledVector(this._right, -1);
    if (input.right) wish.add(this._right);
    const moving = wish.lengthSq() > 1e-6;
    if (moving) wish.normalize();

    // ---- sprint / ads gating ---------------------------------------------
    const wantSprint = input.sprint && input.forward && !this.crouching && !input.ads && this.onGround;
    this.sprinting = wantSprint && this.speedHorizontal > 1.2;
    this.adsTarget = input.ads && !this.sprinting ? 1 : 0;
    this.ads = THREE.MathUtils.damp(this.ads, this.adsTarget, 16, dt);

    let maxSpeed = TUNING.walkSpeed;
    if (this.crouching) maxSpeed = TUNING.crouchSpeed;
    else if (wantSprint) maxSpeed = TUNING.sprintSpeed;
    maxSpeed = THREE.MathUtils.lerp(maxSpeed, Math.min(maxSpeed, TUNING.adsSpeed), this.ads);

    // ---- acceleration -----------------------------------------------------
    const vel = this.velocity;
    if (this.onGround) {
      // Friction first, applied to the horizontal component only.
      const speed = Math.hypot(vel.x, vel.z);
      if (speed > 0.001) {
        const drop = Math.max(speed, 3.0) * TUNING.friction * dt;
        const scale = Math.max(0, speed - drop) / speed;
        vel.x *= scale; vel.z *= scale;
      }
      if (moving) {
        const current = vel.x * wish.x + vel.z * wish.z;
        const add = Math.min(maxSpeed - current, TUNING.groundAccel * dt * maxSpeed / TUNING.walkSpeed);
        if (add > 0) { vel.x += wish.x * add; vel.z += wish.z * add; }
      }
    } else {
      if (moving) {
        const current = vel.x * wish.x + vel.z * wish.z;
        const add = Math.min(Math.max(0, maxSpeed - current), TUNING.airAccel * dt);
        vel.x += wish.x * add; vel.z += wish.z * add;
      }
      const d = 1 - TUNING.airDrag * dt;
      vel.x *= d; vel.z *= d;
    }

    // ---- jump -------------------------------------------------------------
    if (this.onGround) this._coyote = now;
    const canJump = now - this._coyote < TUNING.coyoteTime;
    if (now - this._jumpBuffered < TUNING.jumpBuffer && canJump) {
      vel.y = TUNING.jumpVelocity;
      this._jumpBuffered = -99;
      this._coyote = -99;
      this.onGround = false;
    }

    vel.y -= TUNING.gravity * dt;
    vel.y = Math.max(vel.y, -60);

    // ---- integrate --------------------------------------------------------
    this._prevVerticalSpeed = vel.y;
    this.moveHorizontal(vel.x * dt, vel.z * dt);

    const wasGround = this.onGround;
    this.onGround = false;
    const hitVertical = this.moveAxis('y', vel.y * dt);
    if (hitVertical && this._prevVerticalSpeed <= 0) this.onGround = true;

    // Analytic terrain floor. The displaced ground plane is not in the
    // collider list, so it is resolved directly against its height field.
    const terrainY = this.level.groundHeight(this.position.x, this.position.z);
    if (this.position.y < terrainY) {
      this.position.y = terrainY;
      if (vel.y < 0) vel.y = 0;
      this.onGround = true;
    }

    if (this.onGround && !wasGround) {
      const impact = Math.min(1, Math.abs(this._prevVerticalSpeed) / 12);
      if (impact > 0.08) {
        this._landDipVel -= impact * 3.4;
        this.landCallback?.(impact);
      }
    }

    // ---- health regen -----------------------------------------------------
    if (this.alive && now - this.lastDamageTime > TUNING.regenDelay && this.health < TUNING.maxHealth) {
      this.health = Math.min(TUNING.maxHealth, this.health + TUNING.regenRate * dt);
    }

    this.updateView(dt, moving);
  }

  /* --------------------------------------------------------------- view -- */

  updateView(dt, moving) {
    const speed = this.speedHorizontal;
    const speedRatio = THREE.MathUtils.clamp(speed / TUNING.walkSpeed, 0, 1.7);

    // --- footstep cadence and bob -----------------------------------------
    if (this.onGround && speed > 0.4) {
      const cadence = this.sprinting ? 8.4 : this.crouching ? 4.2 : 6.3;
      const prev = this._bobPhase;
      this._bobPhase += dt * cadence * Math.min(1.35, speedRatio);
      // One footfall per half cycle.
      if (Math.floor(prev / Math.PI) !== Math.floor(this._bobPhase / Math.PI)) {
        this.footstepCallback?.(this.sprinting ? 1 : this.crouching ? 0.35 : 0.7);
      }
    } else {
      this._bobPhase += dt * 1.1;
    }

    const bobTarget = this.onGround && moving ? speedRatio : 0;
    this._bobAmount = THREE.MathUtils.damp(this._bobAmount, bobTarget, 8, dt);
    const bobScale = this._bobAmount * THREE.MathUtils.lerp(1, 0.28, this.ads);

    // Figure-eight path: vertical at 2x the lateral rate.
    const bobY = Math.sin(this._bobPhase * 2) * 0.028 * bobScale;
    const bobX = Math.cos(this._bobPhase) * 0.034 * bobScale;
    const bobRoll = Math.cos(this._bobPhase) * 0.0125 * bobScale;

    // --- landing dip (spring) ---------------------------------------------
    this._landDipVel += (-this._landDip * 92 - this._landDipVel * 13) * dt;
    this._landDip += this._landDipVel * dt;
    this._landDip = THREE.MathUtils.clamp(this._landDip, -0.34, 0.1);

    // --- strafe roll -------------------------------------------------------
    const lateral = this.velocity.x * this._right.x + this.velocity.z * this._right.z;
    const rollTarget = -THREE.MathUtils.clamp(lateral / TUNING.walkSpeed, -1, 1) * 0.020
      * THREE.MathUtils.lerp(1, 0.35, this.ads);
    this.viewAngle.z = THREE.MathUtils.damp(this.viewAngle.z, rollTarget + bobRoll, 9, dt);

    // --- recoil spring -----------------------------------------------------
    const stiff = 140, damp = 19;
    this._recoilPitchVel += (-this.recoilPitch * stiff - this._recoilPitchVel * damp) * dt;
    this.recoilPitch += this._recoilPitchVel * dt;
    this._recoilYawVel += (-this.recoilYaw * stiff - this._recoilYawVel * damp) * dt;
    this.recoilYaw += this._recoilYawVel * dt;

    this.viewOffset.set(bobX, bobY + this._landDip, 0);

    // --- compose camera ----------------------------------------------------
    const cam = this.camera;
    cam.position.set(this.position.x, this.eyeY, this.position.z);
    cam.rotation.set(0, 0, 0);
    cam.rotation.order = 'YXZ';
    cam.rotation.y = this.yaw + this.recoilYaw;
    cam.rotation.x = this.pitch + this.recoilPitch;
    cam.rotation.z = this.viewAngle.z;
    cam.updateMatrixWorld();

    // Bob is applied in view space so it never pushes the eye through a wall
    // more than a few centimetres.
    cam.position.add(
      this._tmp.set(this.viewOffset.x, this.viewOffset.y, 0).applyQuaternion(cam.quaternion),
    );
    cam.updateMatrixWorld();

    this.lookDelta.multiplyScalar(0.72);
  }

  /** Camera-space forward used for hitscan. */
  aimDirection(target = new THREE.Vector3()) {
    return this.camera.getWorldDirection(target);
  }
}
