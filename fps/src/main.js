// Bootstrap and game loop.

import * as THREE from 'three';
import './patch.js';   // must precede any material compilation
import { Atmosphere, PRESET } from './sky.js';
import { Level } from './level.js';
import { Player, TUNING } from './player.js';
import { Weapon, SPEC } from './weapon.js';
import { VFX } from './vfx.js';
import { Director, STATE } from './ai.js';
import { HUD } from './hud.js';
import { Audio } from './audio.js';
import { PostStack } from './post.js';
import { setAnisotropy } from './textures.js';

const params = new URLSearchParams(location.search);
const SHOT = params.get('shot');

/* ------------------------------------------------------------ presets --- */
// Deterministic camera/gameplay states used by the screenshot harness.

const SHOT_PRESETS = {
  hero: {
    position: [-14.0, 0, 6.5], yaw: -1.035, pitch: -0.020, ads: 0,
    enemies: [[14, -6, 3.6], [19.5, 2.5, 4.1], [8.5, -14, 3.9]],
    warmup: 150,
    action: 'idle',
  },
  combat: {
    position: [-6.0, 0, 4.0], yaw: -1.010, pitch: 0.015, ads: 0,
    enemies: [[11.5, -3.0, 3.5], [16.0, 3.5, 4.0], [6.0, -11.0, 3.8], [20, -8, 4.2]],
    warmup: 150,
    action: 'firing',
  },
  ads: {
    position: [-8.0, 0, 5.0], yaw: -1.060, pitch: -0.005, ads: 1,
    enemies: [[13.0, -4.0, 3.6], [18.0, 1.0, 4.0]],
    warmup: 150,
    action: 'aiming',
  },
  detail: {
    position: [1.0, 0, 8.5], yaw: -1.180, pitch: -0.055, ads: 0,
    enemies: [[9.0, -3.5, 3.7]],
    warmup: 150,
    action: 'idle',
  },
};

/* ------------------------------------------------------------- runtime --- */

class Game {
  constructor() {
    this.container = document.getElementById('game');
    this.clock = new THREE.Clock();
    this.elapsed = 0;
    this.score = 0;
    this.running = false;

    this.input = {
      forward: false, back: false, left: false, right: false,
      sprint: false, crouch: false, ads: false, fire: false,
    };

    this.setupRenderer();
    this.setupScene();
    this.setupSystems();
    this.setupInput();
  }

  /* ------------------------------------------------------------ renderer -- */

  setupRenderer() {
    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
    });
    const dpr = SHOT ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.info.autoReset = true;
    this.container.appendChild(this.renderer.domElement);

    setAnisotropy(Math.min(16, this.renderer.capabilities.getMaxAnisotropy()));
  }

  setupScene() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      78, window.innerWidth / window.innerHeight, 0.10, 700,
    );

    window.__MARK?.('scene:init');
    this.atmosphere = new Atmosphere(this.renderer, this.scene);
    window.__MARK?.('atmosphere');

    this.level = new Level().build();
    window.__MARK?.('level');
    this.scene.add(this.level.group);
  }

  setupSystems() {
    this.player = new Player(this.level, this.camera);
    this.weapon = new Weapon(this.renderer, this.camera, this.scene.environment);
    window.__MARK?.('weapon');
    this.vfx = new VFX(this.scene, this.camera, this.level);
    this.vfx.setPixelRatio(this.renderer.getPixelRatio());
    this.director = new Director(this.scene, this.level);
    this.hud = new HUD();
    this.audio = new Audio();

    window.__MARK?.('vfx+ai+hud');
    this.post = new PostStack(this.renderer, this.scene, this.camera, PRESET.exposure);
    this.viewmodelPass = this.post.setViewmodel(this.weapon.scene, this.weapon.camera);
    window.__MARK?.('post');

    this.wireCallbacks();
    this.director.populate(6);
  }

  wireCallbacks() {
    this.player.footstepCallback = (strength) => {
      this.audio.footstep(strength);
      this.vfx.footDust(
        new THREE.Vector3(this.player.position.x, this.player.position.y, this.player.position.z),
        strength,
      );
      this.director.alertAll(this.player.position, strength > 0.9 ? 20 : 9);
    };
    this.player.landCallback = (impact) => {
      this.audio.footstep(Math.min(1, impact * 1.4));
      this.vfx.footDust(this.player.position.clone(), impact * 1.6);
    };

    this.weapon.onReloadEvent = (stage) => this.audio.mechanical(stage);

    this.vfx.onCasingLand = (x, y, z, v) => {
      if (v > 1.2) this.audio.mechanical('casing');
    };

    this.director.onFire = (enemy, spread, distance) => this.enemyShoot(enemy, spread, distance);
    this.director.onDeath = (enemy, zone) => {
      this.score++;
      this.hud.hit(true);
      this.hud.killLine(`HOSTILE${zone === 'head' ? ' · HEADSHOT' : ''}`);
      this.audio.hitmarker(true);
    };
  }

  /* --------------------------------------------------------------- input -- */

  setupInput() {
    const keyMap = {
      KeyW: 'forward', KeyS: 'back', KeyA: 'left', KeyD: 'right',
      ShiftLeft: 'sprint', ShiftRight: 'sprint', KeyC: 'crouch', ControlLeft: 'crouch',
    };

    window.addEventListener('keydown', (e) => {
      if (keyMap[e.code]) { this.input[keyMap[e.code]] = true; e.preventDefault(); }
      if (e.code === 'Space') { this.player.requestJump(this.elapsed); e.preventDefault(); }
      if (e.code === 'KeyR') this.tryReload();
    });
    window.addEventListener('keyup', (e) => {
      if (keyMap[e.code]) { this.input[keyMap[e.code]] = false; e.preventDefault(); }
    });

    window.addEventListener('mousedown', (e) => {
      if (!this.pointerLocked) return;
      if (e.button === 0) this.input.fire = true;
      if (e.button === 2) this.input.ads = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.input.fire = false;
      if (e.button === 2) this.input.ads = false;
    });
    window.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('mousemove', (e) => {
      if (!this.pointerLocked) return;
      this.player.look(e.movementX, e.movementY);
    });

    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === this.renderer.domElement;
      if (!this.pointerLocked) {
        this.input.fire = false;
        this.input.forward = this.input.back = this.input.left = this.input.right = false;
        this.input.sprint = false;
      }
    });

    const start = document.getElementById('start');
    start.addEventListener('click', () => {
      this.renderer.domElement.requestPointerLock();
      start.style.display = 'none';
      this.hud.show();
      this.hud.playTitle();
      this.audio.init();
      this.audio.resume();
      this.audio.startAmbience();
    });

    window.addEventListener('resize', () => this.onResize());
  }

  onResize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.weapon.camera.aspect = w / h;
    this.weapon.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.post.setSize(w, h);
  }

  /* -------------------------------------------------------------- combat -- */

  tryReload() {
    if (this.weapon.startReload(this.elapsed)) return;
    if (this.weapon.ammo === 0 && this.weapon.reserve === 0) this.audio.mechanical('dryfire');
  }

  playerShoot() {
    if (this.weapon.reloading) return;
    if (this.weapon.ammo <= 0) {
      if (this.elapsed - (this._lastDry ?? -1) > 0.35) {
        this.audio.mechanical('dryfire');
        this._lastDry = this.elapsed;
        this.tryReload();
      }
      return;
    }
    const shot = this.weapon.fire(this.elapsed, this.player);
    if (!shot) return;

    this.audio.gunshot(0);
    this.director.alertAll(this.player.position, 55);

    const origin = this.camera.position.clone();
    const dir = this.player.aimDirection(new THREE.Vector3());

    // Random point in the spread cone.
    const cone = shot.spread;
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * cone;
    const basis = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(dir, basis).normalize();
    const up = new THREE.Vector3().crossVectors(right, dir).normalize();
    dir.addScaledVector(right, Math.sin(a) * r).addScaledVector(up, Math.cos(a) * r).normalize();

    this.resolveBullet(origin, dir, SPEC.damage, true);

    // Muzzle effects come off the actual viewmodel muzzle, projected into
    // the world so smoke and casings sit where the barrel is.
    const muzzleView = this.weapon.muzzleWorldPosition(new THREE.Vector3());
    const muzzleWorld = this.viewToWorld(muzzleView);
    this.vfx.muzzleSmoke(muzzleWorld, dir);

    const ejectView = this.weapon.ejectWorldPosition(new THREE.Vector3());
    const ejectWorld = this.viewToWorld(ejectView);
    const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    this.vfx.casings.eject(ejectWorld, camRight, 1);
  }

  /** Maps a point from viewmodel-camera space into world space. */
  viewToWorld(p) {
    const ndc = p.clone().project(this.weapon.camera);
    const world = ndc.clone().unproject(this.camera);
    // Keep it at the same distance in front of the eye rather than at the
    // far plane, so smoke spawns at the barrel and not on the horizon.
    const dir = world.sub(this.camera.position).normalize();
    const dist = -p.z;
    return this.camera.position.clone().addScaledVector(dir, Math.max(0.25, dist * 1.6));
  }

  resolveBullet(origin, dir, damage, fromPlayer) {
    const maxRange = SPEC.range;
    const enemyHit = this.director.raycast(origin, dir, maxRange);

    const ray = new THREE.Raycaster(origin, dir, 0.1, maxRange);
    const worldHits = ray.intersectObjects(this.level.raycastables, false);
    const worldHit = worldHits.length ? worldHits[0] : null;

    const enemyFirst = enemyHit && (!worldHit || enemyHit.distance < worldHit.distance);

    if (enemyFirst) {
      const { enemy, zone, point, distance } = enemyHit;
      const falloff = THREE.MathUtils.clamp(
        1 - (distance - SPEC.falloffStart) / (SPEC.falloffEnd - SPEC.falloffStart), 0, 1,
      );
      const dealt = damage * THREE.MathUtils.lerp(SPEC.falloffScale, 1, falloff);
      const killed = enemy.applyDamage(dealt, zone, dir);
      this.vfx.bloodBurst(point, dir, zone === 'head' ? 1.6 : 1);
      this.vfx.bloodDecals.place(
        new THREE.Vector3(point.x, this.level.groundHeight(point.x, point.z) + 0.02, point.z),
        new THREE.Vector3(0, 1, 0), 0.7 + Math.random() * 0.5,
      );
      if (fromPlayer) {
        this.audio.impact('flesh', distance);
        if (!killed) { this.hud.hit(false); this.audio.hitmarker(false); }
      }
      if (fromPlayer) this.spawnTracer(origin, dir, distance);
      return;
    }

    if (worldHit) {
      const surface = this.classifySurface(worldHit.object);
      const normal = worldHit.face
        ? worldHit.face.normal.clone().transformDirection(worldHit.object.matrixWorld)
        : new THREE.Vector3(0, 1, 0);
      this.vfx.impact(worldHit.point, normal, surface, 1);
      this.audio.impact(surface, worldHit.distance);
      if (fromPlayer) this.spawnTracer(origin, dir, worldHit.distance);
      else this.director.alertAll(worldHit.point, 12);
      return;
    }

    if (fromPlayer) this.spawnTracer(origin, dir, maxRange);
  }

  spawnTracer(origin, dir, distance) {
    // Start the streak at the muzzle, not the eye, or it reads as a laser
    // coming out of the player's forehead.
    const muzzle = this.viewToWorld(this.weapon.muzzleWorldPosition(new THREE.Vector3()));
    if (Math.random() < 0.34) {
      this.vfx.tracers.fire(muzzle, dir, distance, 520, 0.024);
    }
  }

  classifySurface(object) {
    if (object.name === 'ground' || object.name === 'courtyard') return 'sand';
    const m = object.material;
    if (m && m.metalness !== undefined && m.metalness > 0.45) return 'metal';
    if (m && m.metalnessMap) return 'metal';
    return 'stone';
  }

  enemyShoot(enemy, spread, distance) {
    const origin = new THREE.Vector3();
    enemy.muzzleAnchor.updateWorldMatrix(true, false);
    origin.setFromMatrixPosition(enemy.muzzleAnchor.matrixWorld);

    const target = this.camera.position.clone();
    const dir = target.sub(origin).normalize();
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * spread;
    const right = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
    const up = new THREE.Vector3().crossVectors(right, dir).normalize();
    dir.addScaledVector(right, Math.sin(a) * r).addScaledVector(up, Math.cos(a) * r).normalize();

    this.audio.gunshot(distance);
    this.vfx.tracers.fire(origin, dir, Math.min(distance + 30, 160), 460, 0.018);
    this.vfx.muzzleSmoke(origin, dir);

    // Does it hit the player? Test against the player's body box, and let the
    // world take the round first if something is in the way.
    const ray = new THREE.Raycaster(origin, dir, 0.2, 200);
    const worldHits = ray.intersectObjects(this.level.raycastables, false);
    const box = this.player.aabb(new THREE.Box3());
    const hitPoint = ray.ray.intersectBox(box, new THREE.Vector3());
    const playerDist = hitPoint ? origin.distanceTo(hitPoint) : Infinity;
    const worldDist = worldHits.length ? worldHits[0].distance : Infinity;

    if (playerDist < worldDist) {
      this.player.damage(11 + Math.random() * 5);
      this.audio.hurt();
      this._damageFlash = 1;
      this._lastHitDirection = dir.clone();
    } else {
      // Near miss — the supersonic snap sells incoming fire more than a hit does.
      const toPlayer = this.camera.position.clone().sub(origin);
      const along = toPlayer.dot(dir);
      const closest = origin.clone().addScaledVector(dir, THREE.MathUtils.clamp(along, 0, worldDist));
      const miss = closest.distanceTo(this.camera.position);
      if (miss < 4) this.audio.snap(miss);
      if (worldHits.length) {
        const h = worldHits[0];
        const normal = h.face
          ? h.face.normal.clone().transformDirection(h.object.matrixWorld)
          : new THREE.Vector3(0, 1, 0);
        this.vfx.impact(h.point, normal, this.classifySurface(h.object), 0.8);
        this.audio.impact(this.classifySurface(h.object), h.distance);
      }
    }
  }

  /* --------------------------------------------------------------- frame -- */

  step(dt) {
    this.elapsed += dt;

    this.player.update(dt, this.input, this.elapsed);

    if (this.input.fire) this.playerShoot();
    if (this.weapon.ammo === 0 && !this.weapon.reloading && this.weapon.reserve > 0) {
      this.weapon.startReload(this.elapsed);
    }

    this.weapon.update(dt, this.elapsed, this.player, this.input);
    this.weapon.syncLighting(this.atmosphere.sunDirection, this.camera);

    this.director.update(dt, this.player, this.elapsed);
    this.atmosphere.update(this.camera);
    this.vfx.update(dt, this.elapsed, this.atmosphere.sunDirection);
    this.post.updateSun(this.atmosphere.sunDirection);

    // Damage feedback decay.
    this._damageFlash = Math.max(0, (this._damageFlash ?? 0) - dt * 3.2);
    const hurtLevel = Math.max(
      this._damageFlash * 0.6,
      (1 - this.player.health / TUNING.maxHealth) * 0.35,
    );
    this.post.setDamage(hurtLevel);

    this.hud.update(dt, {
      ammo: this.weapon.ammo,
      reserve: this.weapon.reserve,
      spreadPixels: 8 + this.weapon.currentSpread(this.player) * 900,
      score: this.score,
      health: this.player.health,
      yaw: this.player.yaw,
      ads: this.player.ads > 0.6,
      sprinting: this.player.sprinting,
      reloading: this.weapon.reloading,
    });
  }

  render(dt) {
    this.post.render(dt, this.elapsed);
  }

  loop = () => {
    requestAnimationFrame(this.loop);
    const dt = Math.min(this.clock.getDelta(), 1 / 20);
    this.step(dt);
    this.render(dt);
  };

  start() {
    this.running = true;
    this.clock.start();
    this.loop();
  }
}

/* ---------------------------------------------------------- shot driver -- */

async function runShotMode(game, preset) {
  const cfg = SHOT_PRESETS[preset] ?? SHOT_PRESETS.hero;

  document.getElementById('start').style.display = 'none';
  game.hud.show();
  game.audio.enabled = false;
  // Enemies are placed already engaging; without this they kill the player
  // over the warmup and every capture comes back as a red death screen.
  game.player.damage = () => {};

  // Clear the procedurally-populated roster and place enemies deliberately.
  for (const e of game.director.enemies) game.scene.remove(e.group);
  game.director.enemies.length = 0;
  game.director.maxAlive = 0;

  game.player.position.set(cfg.position[0], 0, cfg.position[2]);
  game.player.position.y = game.level.groundHeight(cfg.position[0], cfg.position[2]);
  game.player.yaw = cfg.yaw;
  game.player.pitch = cfg.pitch;
  game.player.ads = cfg.ads;
  game.player.adsTarget = cfg.ads;
  if (cfg.ads) game.input.ads = true;

  for (const [x, z, facing] of cfg.enemies) {
    const e = game.director.spawn(new THREE.Vector3(x, 0, z));
    e.facing = facing;
    e.targetFacing = facing;
    e.state = STATE.ENGAGE;
    e._aimBlend = 1;
    e.lastKnown = game.camera.position.clone();
  }

  // Warm up the simulation without rendering. Springs, bob phases, particle
  // fields and AI poses all settle on CPU; there is no reason to pay for a
  // full post-processed frame 150 times to get there.
  const dt = 1 / 60;
  for (let i = 0; i < cfg.warmup; i++) {
    if (cfg.action === 'aiming') {
      game.input.ads = true;
      game.player.ads = 1;
      game.player.adsTarget = 1;
    }
    if (cfg.action === 'firing' && i > cfg.warmup - 26) {
      // Hold the trigger over the last stretch so the captured frame has a
      // live muzzle flash, smoke, tracers and casings in it.
      game.weapon.lastShot = -99;
      game.playerShoot();
    }
    game.step(dt);
    if (i % 25 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  window.__MARK?.('warmup-sim');

  // Now render for real. The first frame pays for every shader compile, so
  // draw a few and let the last one be the capture.
  for (let i = 0; i < 3; i++) {
    game.render(dt);
    window.__MARK?.(`render-${i}`);
    await new Promise((r) => setTimeout(r, 0));
  }

  window.__SHOT_READY = true;
}

/* ------------------------------------------------------------- entry ----- */

async function main() {
  const t0 = performance.now();
  const mark = (label) => {
    const t = performance.now();
    console.log(`[boot] ${label}: ${(t - (mark.last ?? t0)).toFixed(0)}ms`);
    mark.last = t;
  };
  window.__MARK = mark;

  const game = new Game();
  mark('construct');
  window.__GAME = game;

  if (SHOT) {
    await runShotMode(game, SHOT);
  } else {
    game.start();
    window.__SHOT_READY = true;
  }
}

main().catch((err) => {
  console.error(err);
  const el = document.getElementById('start');
  if (el) el.innerHTML = `<h1 style="font-size:22px">FAILED TO START</h1><pre style="max-width:80vw;white-space:pre-wrap;font-size:12px;color:#f88">${String(err.stack || err)}</pre>`;
});
