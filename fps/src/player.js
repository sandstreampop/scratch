// First-person character controller.
//
// Movement model is tuned against modern military shooters rather than a physics
// sim: high ground acceleration so input feels instant, almost no air
// acceleration so a jump is a commitment, per-heading speed penalties, and a hard
// separation between the collision body (an AABB, axis-resolved) and the camera
// (which floats on springs so bob, sway and recoil never push the player through
// a wall).
//
// Three things in here were measured wrong for a long time and the shapes that
// fixed them are load-bearing, so they are named:
//
//   Directional speed penalties ride on maxSpeed, never on the wish vector.
//   Scaling a contribution and then normalising the sum discards the scale
//   exactly; that is how a backpedal ran at 4.986 m/s against a 4.547 m/s walk
//   while declaring a 0.78 penalty.
//
//   The acceleration clamp is on the wish AXIS, so it cannot bound |v| on its
//   own — see capSpeed(). A sprint measured 7.295 m/s against a 7.15 m/s cap not
//   in a straight line but through a turn.
//
//   Everything integrates at whatever dt it is handed, which makes free fall over
//   0.5 s differ by 2.4% between 240 Hz and 60 Hz. That is NOT fixable here: the
//   controller cannot tell that its dt is wrong. The fix is a fixed-tick
//   accumulator in Game.step/Game.loop in main.js, and gameplay-movement.mjs
//   keeps its frame-rate-independence checks red and pointed at it.

import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);

export const TUNING = {
  radius: 0.32,
  standHeight: 1.82,
  crouchHeight: 1.15,
  eyeOffset: -0.16,           // eye sits below the crown of the head
  stepHeight: 0.42,

  walkSpeed: 4.55,
  // 1.5 x walkSpeed exactly. Was 7.15, which is 1.571x — outside the 1.4-1.6
  // band for player_sprintSpeedScale and, more to the point, above the
  // 1.55 x walk that a slide is allowed to reach, which left no room for a
  // slide to be a boost over a sprint at all. 6.83 also lands on the measured
  // AR-class tactical sprint (BP50, 6.8 m/s) rather than the disputed general
  // figure, which is the right class for the one rifle this game ships.
  sprintSpeed: 6.825,
  crouchSpeed: 2.35,
  adsSpeed: 2.90,
  // player_backSpeedScale / player_strafeSpeedScale. Both were being discarded:
  // the wish vector was scaled and then normalised, so a pure backpedal came out
  // a unit vector and ran at full walkSpeed — measurably FASTER than forward
  // (4.986 against 4.547) because backpedal was the only contributor. The scales
  // now ride on maxSpeed, where normalisation cannot reach them.
  backpedalScale: 0.70,
  strafeScale: 0.80,

  groundAccel: 62,
  // Was 14, which is 41% of the measured ground lateral authority and gave a
  // standing jump 4.20 m/s of side velocity — 92% of a ground strafe, i.e. total
  // air control and a working strafe-jump. The sourced spec asks for well under
  // 10% of ground authority; 1.0 measures at ~5%, which is a nudge rather than a
  // second set of legs. Ruled out setting it to 0: a CoD jump can be steered
  // slightly, and 0 makes a mistimed jump unrecoverable in a way the reference
  // is not.
  airAccel: 1.0,
  friction: 9.5,
  airDrag: 0.18,

  // g_gravity 800 units/s^2 and jump_height 39 units, i.e. the dvar pair the
  // whole IW-engine jump arc is defined by. Was 19.6 / 5.05, an apex of 0.640 m
  // against the 0.991 m those dvars imply — a jump 35% short, which is why the
  // 1.15 m ledge in the mantle tests is unreachable by jumping even now.
  gravity: 20.32,
  jumpVelocity: 6.345,
  coyoteTime: 0.11,
  jumpBuffer: 0.13,

  // Slide. physics.slide_max_duration (0.65 s) and physics.slide_max_speed_scale
  // (1.55) are sourced; the patch notes do not say which speed the 1.55
  // multiplies, so this states its choice: base WALK speed, giving 7.05 m/s,
  // just above the 6.83 sprint. Read as 1.55 x sprint it would be 10.6 m/s,
  // half again as fast as tactical sprint, and nothing sourced supports that.
  slideSpeedScale: 1.55,
  slideMaxDuration: 0.65,
  // Chosen so the boost is still above crouch speed when the duration cap ends
  // the slide: exp(-1.3 * 0.65) x 7.05 = 3.03 m/s. Ordinary friction here
  // (drop = max(v,3) * 9.5 * dt) erases a 7 m/s boost in ~100 ms, so the sourced
  // 0.65 s cap would never be the thing that ends a slide and the duration would
  // be a property of the friction constant instead.
  slideFriction: 1.3,
  // Long enough that a released-and-repressed crouch cannot chain slides back to
  // back; short enough not to feel like a cooldown.
  slideCooldown: 0.45,

  // Mantle. physics.mantle_duration is an explicit negative result — no CoD
  // figure exists for any title — so these two are bounded by measured
  // quantities rather than invented: the low bracket is under the measured
  // ballistic rise a jump would cost (physics.jump_apex_time, 0.312 s), or
  // vaulting a knee-high wall would be strictly worse than jumping it, and the
  // high bracket is under the slide's 0.65 s, the longest movement lockout
  // anything sourced sanctions. Two brackets rather than a height-scaled
  // duration because targets.mjs reads the BO6 "all mantle speeds have been
  // increased" (plural) as several discrete fixed-length animations.
  mantleLowMaxHeight: 0.90,
  mantleMaxHeight: 1.60,
  mantleLowDuration: 0.26,
  mantleHighDuration: 0.40,

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
    this._prevCrouch = false;
    this._sliding = false;
    this._slideStart = -99;
    this._slideEnd = -99;
    this._mantle = null;
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
    this._tmpMantle = new THREE.Vector3();

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

  /**
   * Clamps horizontal speed after an acceleration step.
   *
   * The acceleration clamp is on the WISH AXIS — it limits the component along
   * the direction being asked for, not the magnitude — so a direction change adds
   * a full step at right angles to whatever is already there and comes out above
   * the cap. That is where a 7.295 m/s sprint against a 7.15 m/s cap came from:
   * not the straight-line top speed, which settles on the cap exactly, but what a
   * turn does to it.
   *
   * The ceiling is max(cap, whatever we already had) rather than cap, so speed
   * that is legitimately above the cap — a slide boost, or an ADS blend lowering
   * the cap underneath the body — decays through friction as before instead of
   * being teleported down. The invariant this buys is the one worth having:
   * accelerating can never RAISE speed past the cap.
   */
  capSpeed(cap, before) {
    const after = Math.hypot(this.velocity.x, this.velocity.z);
    const ceil = Math.max(cap, before);
    if (after > ceil && after > 1e-9) {
      const s = ceil / after;
      this.velocity.x *= s; this.velocity.z *= s;
    }
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

  /**
   * Finds a ledge the body could be pulled on top of, ahead along (dx, dz).
   *
   * Behavioural, not geometric bookkeeping: the ledge is read out of the same
   * collider list the movement solver uses, so anything the body can be stopped
   * by is a thing it can be lifted over, and nothing needs to be tagged.
   */
  findLedge(dx, dz) {
    // Probed at radius + 0.06, so the ledge has to be within a hair of the body:
    // a longer reach starts mantling ledges the player is walking past.
    const px = this.position.x + dx * (TUNING.radius + 0.06);
    const pz = this.position.z + dz * (TUNING.radius + 0.06);
    const lo = this.position.y + TUNING.stepHeight;   // below this, step-up owns it
    const hi = this.position.y + TUNING.mantleMaxHeight;
    let top = -Infinity;
    for (const c of this.level.colliders) {
      if (px < c.min.x || px > c.max.x || pz < c.min.z || pz > c.max.z) continue;
      if (c.max.y <= lo || c.max.y > hi) continue;
      if (c.max.y > top) top = c.max.y;
    }
    if (top === -Infinity) return null;

    // The pull-up lands a full body diameter in, so the AABB ends up entirely on
    // the ledge rather than half over the lip.
    const reach = TUNING.radius * 2 + 0.06;
    const to = this._tmpMantle.set(this.position.x + dx * reach, top + 0.002, this.position.z + dz * reach);
    // Both ends of the path have to be clear: the animation rises in place first
    // and only then moves in, so those are the only two poses it passes through.
    const up = new THREE.Vector3(this.position.x, top + 0.002, this.position.z);
    if (this.blocked(up, this.height) || this.blocked(to, this.height)) return null;
    return { to: to.clone(), height: top - this.position.y };
  }

  /**
   * Advances an in-progress mantle and returns true while it owns the frame.
   *
   * Vertical first, horizontal second, with no overlap: any easing that moves the
   * body in over the lip while it is still rising puts the AABB inside the ledge
   * for a few frames, which is a collision failure dressed up as an animation.
   */
  stepMantle(dt, now) {
    const m = this._mantle;
    const k = Math.min(1, (now - m.t0) / m.dur);
    const kh = Math.max(0, (k - 0.5) * 2);
    const smooth = kh * kh * (3 - 2 * kh);
    this.position.x = m.from.x + (m.to.x - m.from.x) * smooth;
    this.position.z = m.from.z + (m.to.z - m.from.z) * smooth;
    this.position.y = m.from.y + (m.to.y - m.from.y) * Math.min(1, k * 2);
    this.velocity.set(0, 0, 0);
    this.onGround = false;
    if (k >= 1) {
      this.position.copy(m.to);
      this._mantle = null;
      this.onGround = true;
      this._coyote = now;
    }
    this.height = THREE.MathUtils.damp(this.height, this.targetHeight, 14, dt);
    if (this.alive && now - this.lastDamageTime > TUNING.regenDelay && this.health < TUNING.maxHealth) {
      this.health = Math.min(TUNING.maxHealth, this.health + TUNING.regenRate * dt);
    }
    this.updateView(dt, false);
    return true;
  }

  update(dt, input, now) {
    this._now = now;

    // A mantle is animation-locked, as it is in the reference: the body is off
    // the movement solver entirely until it is standing on the ledge, which is
    // what makes the lockout duration a thing a player can learn.
    if (this._mantle) { this.stepMantle(dt, now); return; }

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

    // Built in the player's own frame first. The per-axis speed penalties cannot
    // live in the wish vector: scaling a contribution and then normalising the
    // sum discards the scale exactly, which is what made a backpedal (the only
    // contributor, therefore a unit vector after normalise) run at full walk
    // speed. The direction stays a unit vector and the penalty rides on
    // maxSpeed via dirScale below.
    let wf = 0, wr = 0;
    if (input.forward) wf += 1;
    if (input.back) wf -= 1;
    if (input.left) wr -= 1;
    if (input.right) wr += 1;
    const wlen = Math.hypot(wf, wr);
    const moving = wlen > 1e-6;
    let dirScale = 1;
    const wish = this._tmp.set(0, 0, 0);
    if (moving) {
      wf /= wlen; wr /= wlen;
      wish.addScaledVector(this._forward, wf).addScaledVector(this._right, wr);
      // Elliptical speed limit: semi-axis 1 ahead, backpedalScale behind,
      // strafeScale sideways. An ellipse rather than a per-axis min so that a
      // diagonal is not the fastest heading in the game, which is what a naive
      // max(scales) would make it.
      const aF = wf >= 0 ? 1 : TUNING.backpedalScale;
      dirScale = 1 / Math.hypot(wf / aF, wr / TUNING.strafeScale);
    }

    // ---- slide ------------------------------------------------------------
    // Read against the PREVIOUS tick's sprint flag on purpose: the stance block
    // above has already set `crouching`, and `wantSprint` requires !crouching, so
    // asking "am I sprinting" after it is always false and a slide could never
    // start. "Was sprinting when crouch went down" is also the condition a player
    // would describe.
    const crouchPressed = !!input.crouch && !this._prevCrouch;
    this._prevCrouch = !!input.crouch;
    const slideCap = TUNING.walkSpeed * TUNING.slideSpeedScale;
    if (this._sliding) {
      if (now - this._slideStart >= TUNING.slideMaxDuration || !input.crouch
        || !this.onGround || this.speedHorizontal <= TUNING.crouchSpeed) {
        this._sliding = false;
        this._slideEnd = now;
      }
    } else if (crouchPressed && this.sprinting && this.onGround
      && this.speedHorizontal > TUNING.walkSpeed
      && now - this._slideEnd > TUNING.slideCooldown) {
      this._sliding = true;
      this._slideStart = now;
      // Proportional to entry speed, not a fixed impulse: a fixed one makes a
      // chain of slides from a standing start a faster way to travel than
      // sprinting, since every press resets the body to the cap. Scaled this way
      // a full-sprint entry lands exactly on the sourced 1.55x and a half-speed
      // entry gains 3%.
      const sp = this.speedHorizontal;
      const to = Math.min(slideCap, sp * (slideCap / TUNING.sprintSpeed));
      if (to > sp) { const s = to / sp; this.velocity.x *= s; this.velocity.z *= s; }
    }

    // ---- sprint / ads gating ---------------------------------------------
    // Grounding is checked against the coyote window rather than this frame's
    // onGround, which the measurement suite caught: sprinting held for only 55%
    // of a nine-tenths-of-a-second run-up because the flag drops on every tick
    // a run momentarily leaves the terrain. Bumpy ground therefore flickered
    // sprint off — and with it the sprint-to-fire penalty, which is the part
    // that matters, since a penalty that lapses on a bump is one a player gets
    // for free by running over rubble. The same window already exists for
    // jumping, and reusing it means one definition of "on the ground for
    // gameplay purposes" instead of two that disagree.
    const groundedForSprint = this.onGround || (now - this._coyote) < TUNING.coyoteTime;
    const wantSprint = input.sprint && input.forward && !this.crouching && !input.ads && groundedForSprint;
    this.sprinting = wantSprint && this.speedHorizontal > 1.2;
    this.adsTarget = input.ads && !this.sprinting ? 1 : 0;
    this.ads = THREE.MathUtils.damp(this.ads, this.adsTarget, 16, dt);

    let maxSpeed = TUNING.walkSpeed;
    if (this.crouching) maxSpeed = TUNING.crouchSpeed;
    else if (wantSprint) maxSpeed = TUNING.sprintSpeed;
    maxSpeed = THREE.MathUtils.lerp(maxSpeed, Math.min(maxSpeed, TUNING.adsSpeed), this.ads);
    maxSpeed *= dirScale;
    if (this._sliding) maxSpeed = slideCap;

    // ---- mantle acquisition ----------------------------------------------
    // Only from the ground, only when pressing into it, and never out of a slide:
    // the sourced material describes mantling as a deliberate approach to a
    // ledge, and a slide that ends by climbing a wall is a different mechanic.
    if (!this._mantle && this.onGround && !this._sliding && moving && wf > 0.3) {
      const led = this.findLedge(wish.x, wish.z);
      if (led) {
        this._mantle = {
          t0: now,
          dur: led.height <= TUNING.mantleLowMaxHeight ? TUNING.mantleLowDuration : TUNING.mantleHighDuration,
          from: this.position.clone(),
          to: led.to,
        };
        this.stepMantle(dt, now);
        return;
      }
    }

    // ---- acceleration -----------------------------------------------------
    const vel = this.velocity;
    if (this.onGround) {
      // Friction first, applied to the horizontal component only.
      const speed = Math.hypot(vel.x, vel.z);
      if (speed > 0.001) {
        // A slide decays on a much gentler curve and without the max(v, 3) floor,
        // which exists to snap a walk to a stop and would erase the boost in
        // ~100 ms — leaving the sourced 0.65 s cap unable to be the thing that
        // ends a slide.
        const drop = this._sliding
          ? speed * TUNING.slideFriction * dt
          : Math.max(speed, 3.0) * TUNING.friction * dt;
        const scale = Math.max(0, speed - drop) / speed;
        vel.x *= scale; vel.z *= scale;
      }
      // No steering acceleration during a slide: it is committed, which is what
      // makes it a decision rather than a free speed buff.
      if (moving && !this._sliding) {
        const before = Math.hypot(vel.x, vel.z);
        const current = vel.x * wish.x + vel.z * wish.z;
        const add = Math.min(maxSpeed - current, TUNING.groundAccel * dt * maxSpeed / TUNING.walkSpeed);
        if (add > 0) { vel.x += wish.x * add; vel.z += wish.z * add; }
        this.capSpeed(maxSpeed, before);
      }
    } else {
      if (moving) {
        const before = Math.hypot(vel.x, vel.z);
        const current = vel.x * wish.x + vel.z * wish.z;
        const add = Math.min(Math.max(0, maxSpeed - current), TUNING.airAccel * dt);
        vel.x += wish.x * add; vel.z += wish.z * add;
        this.capSpeed(maxSpeed, before);
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
