// Hostile combatants: model, animation, behaviour.
//
// Bodies are built as a real joint hierarchy so one procedural animator can
// drive walk, aim, flinch and death without any authored clips. Hit zones are
// tagged on the meshes themselves, so the same raycast that finds the body
// also tells you whether it was a headshot.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const TAU = Math.PI * 2;
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _ray = new THREE.Raycaster();

export const STATE = {
  IDLE: 'idle',
  ALERT: 'alert',
  ENGAGE: 'engage',
  REPOSITION: 'reposition',
  DEAD: 'dead',
};

const CONFIG = {
  health: 100,
  viewDistance: 78,
  viewAngle: Math.cos(THREE.MathUtils.degToRad(72)),
  hearingRadius: 34,
  walkSpeed: 2.35,
  runSpeed: 4.9,
  fireInterval: [0.42, 1.15],
  burstCount: [2, 5],
  burstDelay: 0.098,
  accuracyBase: 0.052,        // cone half-angle, radians
  accuracyClose: 0.020,
  damage: 11,
  reactionTime: [0.28, 0.62],
  repositionChance: 0.55,
};

/* ------------------------------------------------------------- the model -- */

const MATS = {};
function mats() {
  if (MATS.built) return MATS;
  MATS.built = true;
  MATS.fatigue = new THREE.MeshStandardMaterial({ color: 0x6b6247, roughness: 0.93, metalness: 0.0 });
  MATS.fatigueDark = new THREE.MeshStandardMaterial({ color: 0x574f39, roughness: 0.94, metalness: 0.0 });
  MATS.carrier = new THREE.MeshStandardMaterial({ color: 0x3f4436, roughness: 0.86, metalness: 0.03 });
  MATS.pouch = new THREE.MeshStandardMaterial({ color: 0x4a4a38, roughness: 0.90, metalness: 0.0 });
  MATS.helmet = new THREE.MeshStandardMaterial({ color: 0x4c503f, roughness: 0.68, metalness: 0.05 });
  MATS.skin = new THREE.MeshStandardMaterial({ color: 0x9a7150, roughness: 0.70, metalness: 0.0 });
  MATS.boot = new THREE.MeshStandardMaterial({ color: 0x2a231c, roughness: 0.88, metalness: 0.0 });
  MATS.glove = new THREE.MeshStandardMaterial({ color: 0x33302a, roughness: 0.90, metalness: 0.0 });
  MATS.gun = new THREE.MeshStandardMaterial({ color: 0x14151a, roughness: 0.52, metalness: 0.85 });
  MATS.strap = new THREE.MeshStandardMaterial({ color: 0x2e2f26, roughness: 0.92, metalness: 0.0 });
  return MATS;
}

function buildSoldier() {
  const M = mats();
  const root = new THREE.Group();

  const mk = (parent, geo, mat, x, y, z, zone) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    if (zone) m.userData.zone = zone;
    parent.add(m);
    return m;
  };
  const rb = (w, h, d, r = 0.02) => new RoundedBoxGeometry(w, h, d, 2, Math.min(r, Math.min(w, h, d) * 0.3));

  // hips -> torso -> chest/head/arms ; hips -> legs
  const hips = new THREE.Group();
  hips.position.y = 0.93;
  root.add(hips);
  mk(hips, rb(0.32, 0.20, 0.22, 0.05), M.fatigue, 0, 0, 0, 'body');
  // Belt kit.
  mk(hips, rb(0.34, 0.055, 0.24, 0.02), M.strap, 0, 0.09, 0, 'body');
  mk(hips, rb(0.11, 0.13, 0.07, 0.02), M.pouch, -0.16, 0.02, 0.02, 'body');
  mk(hips, rb(0.10, 0.12, 0.07, 0.02), M.pouch, 0.16, 0.01, -0.03, 'body');

  const torso = new THREE.Group();
  torso.position.y = 0.14;
  hips.add(torso);
  mk(torso, rb(0.38, 0.44, 0.24, 0.06), M.fatigue, 0, 0.19, 0, 'body');
  // Plate carrier with front pouches — the strongest silhouette read.
  mk(torso, rb(0.36, 0.40, 0.10, 0.03), M.carrier, 0, 0.20, 0.10, 'body');
  mk(torso, rb(0.34, 0.34, 0.08, 0.03), M.carrier, 0, 0.20, -0.10, 'body');
  for (let i = 0; i < 3; i++) {
    mk(torso, rb(0.085, 0.13, 0.06, 0.015), M.pouch, -0.10 + i * 0.10, 0.11, 0.155, 'body');
  }
  mk(torso, rb(0.10, 0.09, 0.05, 0.015), M.pouch, 0.13, 0.30, 0.15, 'body');
  // Shoulder straps.
  for (const s of [-1, 1]) {
    mk(torso, rb(0.07, 0.06, 0.24, 0.015), M.strap, s * 0.115, 0.395, 0.0, 'body');
  }

  const neck = mk(torso, rb(0.11, 0.08, 0.11, 0.03), M.skin, 0, 0.44, 0, 'body');

  const head = new THREE.Group();
  head.position.y = 0.50;
  torso.add(head);
  mk(head, rb(0.152, 0.192, 0.168, 0.055), M.skin, 0, 0.045, 0.004, 'head');
  // Helmet: shell + brim + NVG mount + side rails.
  const shell = new THREE.Mesh(
    new THREE.SphereGeometry(0.116, 20, 14, 0, TAU, 0, Math.PI * 0.58), M.helmet,
  );
  shell.position.set(0, 0.082, 0.004);
  shell.scale.set(1.03, 1.08, 1.12);
  shell.castShadow = true; shell.receiveShadow = true;
  shell.userData.zone = 'head';
  head.add(shell);
  mk(head, rb(0.11, 0.028, 0.055, 0.012), M.helmet, 0, 0.072, 0.116, 'head');
  mk(head, rb(0.052, 0.045, 0.035, 0.010), M.helmet, 0, 0.128, 0.098, 'head');   // NVG shroud
  for (const s of [-1, 1]) {
    mk(head, rb(0.014, 0.030, 0.115, 0.006), M.helmet, s * 0.116, 0.070, 0.0, 'head');
  }
  // Balaclava / lower face.
  mk(head, rb(0.135, 0.075, 0.145, 0.035), M.fatigueDark, 0, -0.020, 0.012, 'head');
  // Eye-pro.
  const goggles = mk(head, rb(0.145, 0.038, 0.030, 0.012),
    new THREE.MeshStandardMaterial({ color: 0x14161c, roughness: 0.20, metalness: 0.5 }),
    0, 0.040, 0.078, 'head');

  // ---- arms ----------------------------------------------------------------
  const makeArm = (side) => {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * 0.215, 0.375, 0);
    torso.add(shoulder);
    mk(shoulder, new THREE.SphereGeometry(0.072, 12, 10), M.fatigue, 0, 0, 0, 'limb');
    const upper = new THREE.Group();
    shoulder.add(upper);
    mk(upper, rb(0.098, 0.235, 0.098, 0.042), M.fatigue, 0, -0.125, 0, 'limb');
    const elbow = new THREE.Group();
    elbow.position.y = -0.245;
    upper.add(elbow);
    mk(elbow, rb(0.088, 0.215, 0.088, 0.038), M.fatigue, 0, -0.108, 0, 'limb');
    mk(elbow, rb(0.094, 0.075, 0.094, 0.030), M.fatigueDark, 0, -0.198, 0, 'limb');  // cuff
    const hand = new THREE.Group();
    hand.position.y = -0.232;
    elbow.add(hand);
    mk(hand, rb(0.072, 0.090, 0.055, 0.024), M.glove, 0, -0.040, 0.008, 'limb');
    return { shoulder, upper, elbow, hand };
  };
  const armL = makeArm(-1);
  const armR = makeArm(1);

  // ---- legs ----------------------------------------------------------------
  const makeLeg = (side) => {
    const hip = new THREE.Group();
    hip.position.set(side * 0.105, -0.085, 0);
    hips.add(hip);
    const thigh = new THREE.Group();
    hip.add(thigh);
    mk(thigh, rb(0.132, 0.300, 0.140, 0.052), M.fatigue, 0, -0.155, 0, 'limb');
    mk(thigh, rb(0.115, 0.100, 0.060, 0.020), M.pouch, side * 0.075, -0.190, 0.02, 'limb');
    const knee = new THREE.Group();
    knee.position.y = -0.315;
    thigh.add(knee);
    mk(knee, rb(0.112, 0.300, 0.120, 0.044), M.fatigue, 0, -0.155, 0, 'limb');
    mk(knee, rb(0.120, 0.090, 0.130, 0.030), M.fatigueDark, 0, -0.030, 0.012, 'limb');  // knee pad
    const foot = new THREE.Group();
    foot.position.y = -0.310;
    knee.add(foot);
    mk(foot, rb(0.125, 0.098, 0.145, 0.030), M.boot, 0, -0.048, 0.008, 'limb');
    mk(foot, rb(0.130, 0.042, 0.245, 0.020), M.boot, 0, -0.088, 0.048, 'limb');
    return { hip, thigh, knee, foot };
  };
  const legL = makeLeg(-1);
  const legR = makeLeg(1);

  // ---- weapon --------------------------------------------------------------
  const gun = new THREE.Group();
  armR.hand.add(gun);
  gun.position.set(-0.02, -0.06, 0.02);
  const g = (w, h, d, x, y, z, m = M.gun) => {
    const mesh = new THREE.Mesh(rb(w, h, d, 0.008), m);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    gun.add(mesh);
    return mesh;
  };
  g(0.045, 0.055, 0.30, 0, 0, -0.10);                       // receiver
  g(0.035, 0.030, 0.26, 0, 0.002, -0.34);                   // handguard
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.010, 0.011, 0.16, 10), M.gun);
  bar.position.set(0, 0.004, -0.53); bar.rotation.x = Math.PI / 2; bar.castShadow = true;
  gun.add(bar);
  g(0.030, 0.115, 0.055, 0, -0.085, -0.13);                 // magazine
  g(0.038, 0.058, 0.062, 0, -0.048, 0.02);                  // grip
  g(0.042, 0.062, 0.16, 0, 0.000, 0.13);                    // stock
  g(0.030, 0.030, 0.058, 0, 0.042, -0.14);                  // optic
  const muzzleAnchor = new THREE.Object3D();
  muzzleAnchor.position.set(0, 0.004, -0.615);
  gun.add(muzzleAnchor);

  return {
    root, hips, torso, head, armL, armR, legL, legR, gun, muzzleAnchor,
  };
}

/* ------------------------------------------------------------- the agent -- */

export class Enemy {
  constructor(level, spawn, id) {
    this.level = level;
    this.id = id;
    const built = buildSoldier();
    Object.assign(this, built);

    this.group = new THREE.Group();
    this.group.add(this.root);
    this.group.position.copy(spawn);
    this.group.position.y = level.groundHeight(spawn.x, spawn.z);

    this.velocity = new THREE.Vector3();
    this.facing = Math.random() * TAU;
    this.targetFacing = this.facing;

    this.health = CONFIG.health;
    this.state = STATE.IDLE;
    this.alive = true;
    this.aware = 0;                 // 0..1 suspicion meter
    this.reactionTimer = 0;
    this.fireTimer = 1 + Math.random() * 2;
    this.burstLeft = 0;
    this.burstTimer = 0;
    this.repositionTarget = null;
    this.stateTimer = 0;

    this._phase = Math.random() * TAU;
    this._aimBlend = 0;
    this._flinch = 0;
    this._flinchVel = 0;
    this._muzzle = 0;
    this._deathTime = 0;
    this._deathSpin = new THREE.Vector3();
    this._deathTip = 0;
    this._lean = 0;

    // Hit zones for the shooter's raycast.
    this.hitMeshes = [];
    this.root.traverse((o) => {
      if (o.isMesh && o.userData.zone) {
        o.userData.enemy = this;
        this.hitMeshes.push(o);
      }
    });

    // Cheap muzzle flash for the AI weapon.
    this.flash = new THREE.PointLight(0xffbb70, 0, 7, 2);
    this.muzzleAnchor.add(this.flash);
    this.flashSprite = new THREE.Mesh(
      new THREE.PlaneGeometry(0.28, 0.28),
      new THREE.MeshBasicMaterial({
        color: 0xffd08a, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
      }),
    );
    this.flashSprite.renderOrder = 25;
    this.muzzleAnchor.add(this.flashSprite);

    this.onFire = null;
    this.onDeath = null;
    this.onHit = null;
  }

  get position() { return this.group.position; }

  /** Chest height — what the AI aims at and what the player usually hits. */
  chestPosition(target = new THREE.Vector3()) {
    return target.set(this.position.x, this.position.y + 1.28, this.position.z);
  }

  eyePosition(target = new THREE.Vector3()) {
    return target.set(this.position.x, this.position.y + 1.62, this.position.z);
  }

  /* ------------------------------------------------------------ senses -- */

  canSee(point, blockers) {
    const eye = this.eyePosition(_v);
    const to = _v2.copy(point).sub(eye);
    const dist = to.length();
    if (dist > CONFIG.viewDistance) return false;
    to.divideScalar(dist);
    const forward = new THREE.Vector3(Math.sin(this.facing), 0, Math.cos(this.facing));
    if (forward.dot(new THREE.Vector3(to.x, 0, to.z).normalize()) < CONFIG.viewAngle) return false;

    _ray.set(eye, to);
    _ray.far = dist - 0.35;
    const hits = _ray.intersectObjects(blockers, false);
    return hits.length === 0;
  }

  alertTo(point) {
    if (!this.alive) return;
    this.aware = Math.min(1, this.aware + 0.55);
    this.lastKnown = point.clone();
    if (this.state === STATE.IDLE) {
      this.state = STATE.ALERT;
      this.reactionTimer = THREE.MathUtils.lerp(
        CONFIG.reactionTime[0], CONFIG.reactionTime[1], Math.random(),
      );
    }
  }

  /* -------------------------------------------------------------- damage -- */

  applyDamage(amount, zone, direction) {
    if (!this.alive) return false;
    const mult = zone === 'head' ? 2.6 : zone === 'limb' ? 0.72 : 1.0;
    this.health -= amount * mult;
    this._flinchVel -= 7 * (zone === 'head' ? 1.6 : 1);
    this.aware = 1;
    this.onHit?.(this, zone);

    if (this.health <= 0) {
      this.kill(direction, zone);
      return true;
    }
    return false;
  }

  kill(direction, zone) {
    this.alive = false;
    this.state = STATE.DEAD;
    this._deathTime = 0;
    // Tip away from the shot, with a bit of spin, and pick a fall direction.
    const d = direction ? direction.clone().setY(0).normalize() : new THREE.Vector3(0, 0, 1);
    this._deathDir = d;
    this._deathSpin.set(
      1.6 + Math.random() * 1.4,
      (Math.random() - 0.5) * 2.4,
      (Math.random() - 0.5) * 1.8,
    );
    this._deathTip = zone === 'head' ? 1.35 : 1.0;
    this.flash.intensity = 0;
    this.flashSprite.material.opacity = 0;
    this.onDeath?.(this, zone);
  }

  /* -------------------------------------------------------------- update -- */

  update(dt, player, blockers, now) {
    if (!this.alive) { this.updateDeath(dt); return; }

    this.stateTimer += dt;
    const chest = this.chestPosition(_v);
    const toPlayer = _v2.copy(player.camera.position).sub(chest);
    const distance = toPlayer.length();
    toPlayer.divideScalar(distance);

    const sees = player.alive && this.canSee(player.camera.position, blockers);
    if (sees) {
      this.aware = Math.min(1, this.aware + dt * 3.2);
      this.lastKnown = player.camera.position.clone();
    } else {
      this.aware = Math.max(0, this.aware - dt * 0.35);
    }

    switch (this.state) {
      case STATE.IDLE: {
        // Slow scan of the arc.
        this.targetFacing += Math.sin(now * 0.24 + this._phase) * dt * 0.55;
        if (sees) {
          this.state = STATE.ALERT;
          this.reactionTimer = THREE.MathUtils.lerp(
            CONFIG.reactionTime[0], CONFIG.reactionTime[1], Math.random(),
          );
        }
        break;
      }
      case STATE.ALERT: {
        if (this.lastKnown) {
          this.targetFacing = Math.atan2(
            this.lastKnown.x - this.position.x, this.lastKnown.z - this.position.z,
          );
        }
        this.reactionTimer -= dt;
        if (this.reactionTimer <= 0 && sees) {
          this.state = STATE.ENGAGE;
          this.stateTimer = 0;
          this.fireTimer = 0.12 + Math.random() * 0.22;
        } else if (this.aware <= 0.05) {
          this.state = STATE.IDLE;
        }
        break;
      }
      case STATE.ENGAGE: {
        this.targetFacing = Math.atan2(toPlayer.x, toPlayer.z);
        this._aimBlend = Math.min(1, this._aimBlend + dt * 5);

        if (sees) {
          this.fireTimer -= dt;
          if (this.burstLeft > 0) {
            this.burstTimer -= dt;
            if (this.burstTimer <= 0) {
              this.shoot(player, distance);
              this.burstLeft--;
              this.burstTimer = CONFIG.burstDelay;
            }
          } else if (this.fireTimer <= 0) {
            this.burstLeft = CONFIG.burstCount[0]
              + Math.floor(Math.random() * (CONFIG.burstCount[1] - CONFIG.burstCount[0] + 1));
            this.burstTimer = 0;
            this.fireTimer = THREE.MathUtils.lerp(
              CONFIG.fireInterval[0], CONFIG.fireInterval[1], Math.random(),
            );
          }
        }

        // Break contact and move periodically so firefights are not static.
        if (this.stateTimer > 3.2 + Math.random() * 3
          && Math.random() < CONFIG.repositionChance) {
          this.pickCover(player);
        }
        if (!sees && this.aware < 0.35) { this.state = STATE.ALERT; this.stateTimer = 0; }
        break;
      }
      case STATE.REPOSITION: {
        this._aimBlend = Math.max(0.35, this._aimBlend - dt * 2);
        if (this.repositionTarget) {
          const to = _v.copy(this.repositionTarget).sub(this.position);
          to.y = 0;
          const d = to.length();
          if (d < 0.8) {
            this.state = STATE.ENGAGE;
            this.stateTimer = 0;
          } else {
            to.divideScalar(d);
            this.targetFacing = Math.atan2(to.x, to.z);
            this.velocity.x = to.x * CONFIG.runSpeed;
            this.velocity.z = to.z * CONFIG.runSpeed;
          }
        } else {
          this.state = STATE.ENGAGE;
        }
        if (this.stateTimer > 6) { this.state = STATE.ENGAGE; this.stateTimer = 0; }
        break;
      }
    }

    if (this.state !== STATE.REPOSITION) {
      this.velocity.x *= Math.max(0, 1 - 9 * dt);
      this.velocity.z *= Math.max(0, 1 - 9 * dt);
    }

    this.integrate(dt);
    this.animate(dt, now);
  }

  pickCover(player) {
    const points = this.level.coverPoints;
    if (!points.length) return;
    let best = null, bestScore = -1e9;
    for (let i = 0; i < 7; i++) {
      const p = points[(Math.random() * points.length) | 0];
      const distToMe = p.distanceTo(this.position);
      const distToPlayer = p.distanceTo(player.camera.position);
      if (distToMe < 2.5 || distToMe > 26) continue;
      // Prefer somewhere new, at a workable engagement range.
      const score = -Math.abs(distToPlayer - 16) - distToMe * 0.25 + Math.random() * 4;
      if (score > bestScore) { bestScore = score; best = p; }
    }
    if (best) {
      this.repositionTarget = best.clone();
      this.state = STATE.REPOSITION;
      this.stateTimer = 0;
    }
  }

  shoot(player, distance) {
    const spread = THREE.MathUtils.lerp(
      CONFIG.accuracyClose, CONFIG.accuracyBase,
      THREE.MathUtils.clamp((distance - 6) / 40, 0, 1),
    );
    this._muzzle = 1;
    this.onFire?.(this, spread, distance);
  }

  integrate(dt) {
    // Slide along colliders rather than stopping dead.
    const step = _v.copy(this.velocity).multiplyScalar(dt);
    const r = 0.36;
    const test = (x, z) => {
      for (const c of this.level.colliders) {
        if (x + r > c.min.x && x - r < c.max.x
          && z + r > c.min.z && z - r < c.max.z
          && this.position.y + 1.6 > c.min.y && this.position.y < c.max.y) return true;
      }
      return false;
    };
    if (!test(this.position.x + step.x, this.position.z)) this.position.x += step.x;
    else this.velocity.x = 0;
    if (!test(this.position.x, this.position.z + step.z)) this.position.z += step.z;
    else this.velocity.z = 0;

    this.position.y = this.level.groundHeight(this.position.x, this.position.z);

    let delta = this.targetFacing - this.facing;
    while (delta > Math.PI) delta -= TAU;
    while (delta < -Math.PI) delta += TAU;
    this.facing += delta * Math.min(1, dt * 7.5);
    this.group.rotation.y = this.facing;
  }

  /* ----------------------------------------------------------- animation -- */

  animate(dt, now) {
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    const moving = speed > 0.25;
    const cadence = speed > 3.4 ? 8.6 : 5.4;
    if (moving) this._phase += dt * cadence;
    else this._phase += dt * 1.2;

    const w = THREE.MathUtils.clamp(speed / CONFIG.runSpeed, 0, 1);
    this._walk = THREE.MathUtils.damp(this._walk ?? 0, w, 8, dt);
    const p = this._phase;
    const gait = this._walk;

    // Legs: opposed swing with knee flexion on the return.
    const swing = Math.sin(p) * 0.72 * gait;
    this.legL.thigh.rotation.x = swing;
    this.legR.thigh.rotation.x = -swing;
    this.legL.knee.rotation.x = Math.max(0, -Math.sin(p - 0.7)) * 1.05 * gait;
    this.legR.knee.rotation.x = Math.max(0, -Math.sin(p + Math.PI - 0.7)) * 1.05 * gait;
    this.legL.foot.rotation.x = -Math.sin(p + 0.4) * 0.30 * gait;
    this.legR.foot.rotation.x = Math.sin(p + 0.4) * 0.30 * gait;

    // Pelvis bob and counter-rotation.
    this.hips.position.y = 0.93 - Math.abs(Math.sin(p)) * 0.052 * gait;
    this.hips.rotation.y = -Math.sin(p) * 0.16 * gait;
    this.hips.rotation.z = Math.sin(p) * 0.045 * gait;
    this.torso.rotation.y = Math.sin(p) * 0.19 * gait;

    // Breathing when still.
    const breathe = Math.sin(now * 1.6 + this._phase) * 0.012 * (1 - gait);
    this.torso.rotation.x = breathe + gait * 0.14;

    // Flinch spring.
    this._flinchVel += (-this._flinch * 130 - this._flinchVel * 14) * dt;
    this._flinch += this._flinchVel * dt;
    this.torso.rotation.x += this._flinch * 0.05;
    this.head.rotation.x = -this._flinch * 0.06;

    // Arms: aim pose blended over the walking swing.
    const aim = this._aimBlend;
    const armSwing = Math.sin(p + Math.PI) * 0.55 * gait * (1 - aim * 0.85);

    // Right (firing) arm.
    this.armR.upper.rotation.set(
      THREE.MathUtils.lerp(armSwing, -1.32, aim), 0,
      THREE.MathUtils.lerp(0, -0.30, aim),
    );
    this.armR.elbow.rotation.set(THREE.MathUtils.lerp(-0.25 * gait, -1.05, aim), 0, 0);
    // Left (support) arm reaches across to the handguard.
    this.armL.upper.rotation.set(
      THREE.MathUtils.lerp(-armSwing, -1.15, aim), 0,
      THREE.MathUtils.lerp(0, 0.62, aim),
    );
    this.armL.elbow.rotation.set(THREE.MathUtils.lerp(-0.25 * gait, -1.30, aim), 0, 0);

    // Head tracks the aim direction slightly ahead of the body.
    this.head.rotation.y = THREE.MathUtils.damp(
      this.head.rotation.y, aim > 0.5 ? 0 : Math.sin(now * 0.4 + this._phase) * 0.35, 4, dt,
    );

    // Muzzle flash decay.
    this._muzzle = Math.max(0, this._muzzle - dt * 22);
    this.flash.intensity = this._muzzle * this._muzzle * 12;
    this.flashSprite.material.opacity = this._muzzle * 0.9;
    this.flashSprite.scale.setScalar(0.7 + (1 - this._muzzle) * 0.8);
    this.flashSprite.visible = this._muzzle > 0.01;
    this.flashSprite.lookAt(0, 1000, 0);
  }

  updateDeath(dt) {
    this._deathTime += dt;
    const t = this._deathTime;

    // Tip over about the ground contact, decelerating as the body settles.
    const fall = Math.min(1, t / 0.85);
    const ease = 1 - Math.pow(1 - fall, 2.4);
    const tip = ease * (Math.PI / 2) * this._deathTip;

    const d = this._deathDir ?? new THREE.Vector3(0, 0, 1);
    this.root.rotation.x = tip * d.z * Math.cos(this.facing) + tip * d.x * Math.sin(this.facing);
    this.root.rotation.z = -tip * d.x * Math.cos(this.facing) + tip * d.z * Math.sin(this.facing);
    this.root.position.y = -Math.sin(ease * Math.PI * 0.5) * 0.30;

    // Limbs go limp — damped toward a slack pose.
    const k = Math.min(1, t * 2.2);
    const slack = (joint, x, z = 0) => {
      joint.rotation.x = THREE.MathUtils.lerp(joint.rotation.x, x, k * 0.10);
      joint.rotation.z = THREE.MathUtils.lerp(joint.rotation.z, z, k * 0.10);
    };
    slack(this.armL.upper, 0.35, 0.55);
    slack(this.armR.upper, 0.28, -0.62);
    slack(this.armL.elbow, -0.30);
    slack(this.armR.elbow, -0.22);
    slack(this.legL.thigh, 0.18, 0.16);
    slack(this.legR.thigh, -0.12, -0.20);
    slack(this.legL.knee, -0.34);
    slack(this.legR.knee, -0.26);
    this.head.rotation.x = THREE.MathUtils.lerp(this.head.rotation.x, 0.42, k * 0.08);
    this.torso.rotation.x = THREE.MathUtils.lerp(this.torso.rotation.x, -0.18, k * 0.08);
    this.hips.position.y = THREE.MathUtils.lerp(this.hips.position.y, 0.86, k * 0.1);

    // Drop the rifle after a beat.
    if (t > 0.35 && this.gun.parent !== this.group) {
      this.group.attach(this.gun);
      this._gunVel = new THREE.Vector3(
        (Math.random() - 0.5) * 1.2, 0.8, (Math.random() - 0.5) * 1.2,
      );
      this._gunSpin = new THREE.Vector3(
        (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8,
      );
    }
    if (this._gunVel) {
      this._gunVel.y -= 19.6 * dt;
      this.gun.position.addScaledVector(this._gunVel, dt);
      this.gun.rotation.x += this._gunSpin.x * dt;
      this.gun.rotation.y += this._gunSpin.y * dt;
      this.gun.rotation.z += this._gunSpin.z * dt;
      if (this.gun.position.y < 0.06) {
        this.gun.position.y = 0.06;
        this._gunVel.multiplyScalar(0);
        this._gunSpin.multiplyScalar(0);
        this.gun.rotation.x = Math.PI / 2 * 0.1;
        this.gun.rotation.z = 0.06;
      }
    }
  }
}

/* ------------------------------------------------------------- director -- */

export class Director {
  constructor(scene, level) {
    this.scene = scene;
    this.level = level;
    this.enemies = [];
    this.kills = 0;
    this.nextId = 0;
    this.spawnTimer = 0;
    this.maxAlive = 7;

    this.onFire = null;
    this.onDeath = null;
    this.onHit = null;
  }

  spawn(position) {
    const e = new Enemy(this.level, position, this.nextId++);
    e.onFire = (...a) => this.onFire?.(...a);
    e.onDeath = (...a) => { this.kills++; this.onDeath?.(...a); };
    e.onHit = (...a) => this.onHit?.(...a);
    this.scene.add(e.group);
    this.enemies.push(e);
    return e;
  }

  populate(count = 6) {
    const spots = [...this.level.spawns];
    for (let i = 0; i < count && spots.length; i++) {
      const idx = (Math.random() * spots.length) | 0;
      this.spawn(spots.splice(idx, 1)[0]);
    }
  }

  /** Everything a bullet or a line-of-sight test can be stopped by. */
  get blockers() { return this.level.raycastables; }

  alertAll(point, radius) {
    for (const e of this.enemies) {
      if (!e.alive) continue;
      if (e.position.distanceTo(point) < radius) e.alertTo(point);
    }
  }

  update(dt, player, now) {
    const blockers = this.blockers;
    for (const e of this.enemies) e.update(dt, player, blockers, now);

    // Clean up long-dead bodies and top the roster back up.
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      if (!e.alive && e._deathTime > 26) {
        this.scene.remove(e.group);
        this.enemies.splice(i, 1);
      }
    }

    const living = this.enemies.filter((e) => e.alive).length;
    this.spawnTimer -= dt;
    if (living < this.maxAlive && this.spawnTimer <= 0) {
      // Spawn out of the player's view where possible.
      const candidates = this.level.spawns.filter((s) => {
        const d = s.distanceTo(player.camera.position);
        return d > 22 && d < 70;
      });
      if (candidates.length) {
        const spot = candidates[(Math.random() * candidates.length) | 0];
        const e = this.spawn(spot.clone());
        e.state = STATE.ALERT;
        e.lastKnown = player.camera.position.clone();
      }
      this.spawnTimer = 3.5 + Math.random() * 3;
    }
  }

  /** Nearest enemy mesh hit along a ray, with its zone. */
  raycast(origin, direction, maxDistance) {
    const meshes = [];
    for (const e of this.enemies) if (e.alive) meshes.push(...e.hitMeshes);
    if (!meshes.length) return null;
    _ray.set(origin, direction);
    _ray.far = maxDistance;
    const hits = _ray.intersectObjects(meshes, false);
    if (!hits.length) return null;
    const h = hits[0];
    return { enemy: h.object.userData.enemy, zone: h.object.userData.zone, point: h.point, distance: h.distance };
  }
}
