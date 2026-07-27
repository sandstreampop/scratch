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
import { setAnisotropy, setResolutionScale } from './textures.js';
import { Input, isTouchDevice } from './input.js';
import { Quality, platform } from './quality.js';

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
  // Every preset above looks within about fifteen degrees of the sun, so all
  // four are the same composition — a backlit silhouette — captured from four
  // positions. It is the hardest case and worth keeping, but a rim light hides
  // albedo, normal and roughness completely, and those are most of the work.
  // These two turn around and across so lit surfaces can be judged at all.
  sunlit: {
    position: [-8.0, 0, 5.0], yaw: 2.106, pitch: -0.030, ads: 0,
    enemies: [[-19.0, 3.0, 0.6], [-23.5, -6.5, 0.9]],
    warmup: 150,
    action: 'idle',
  },
  cross: {
    position: [-4.0, 0, 2.0], yaw: 0.536, pitch: -0.035, ads: 0,
    enemies: [[3.0, -15.0, 1.2], [-6.0, -19.0, 1.0]],
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
    this.ready = false;
    this.quality = new Quality();
  }

  /**
   * Procedural generation takes seconds on a desktop and considerably longer
   * on a phone, so the boot is staged and yields to the event loop between
   * steps. Without that the browser paints nothing until the whole thing is
   * done, and iOS shows a white screen for long enough to look like a crash.
   */
  async build(onProgress = () => {}) {
    const step = async (label, fraction, fn) => {
      onProgress(label, fraction);
      // Two frames: one to paint the label, one to let the paint land before
      // the main thread is blocked again.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      fn();
    };

    await step('INITIALISING RENDERER', 0.05, () => this.setupRenderer());
    await step('BUILDING ATMOSPHERE', 0.15, () => this.setupAtmosphere());
    await step('GENERATING TERRAIN', 0.30, () => this.setupLevel());
    await step('FORGING WEAPON', 0.62, () => this.setupWeapon());
    await step('DEPLOYING HOSTILES', 0.76, () => this.setupSystems());
    await step('COMPILING SHADERS', 0.88, () => this.setupPost());
    await step('READY', 1.0, () => this.setupInput());
    return this;
  }

  /* ------------------------------------------------------------ renderer -- */

  setupRenderer() {
    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
    });
    const dpr = SHOT ? 1 : Math.min(window.devicePixelRatio || 1, this.quality.get('pixelRatio'));
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.info.autoReset = true;
    this.container.appendChild(this.renderer.domElement);

    // iOS discards the WebGL context under memory pressure. Without a handler
    // the canvas simply stops updating and looks like a hang.
    this.renderer.domElement.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
      console.error('renderer: WebGL context lost');
      showFatal('GRAPHICS CONTEXT LOST', 'The browser reclaimed the WebGL context, '
        + 'usually from memory pressure. Reload to restart.');
    });
    this.renderer.domElement.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      console.warn('renderer: WebGL context restored');
    });

    setAnisotropy(Math.min(this.quality.get('anisotropy'),
      this.renderer.capabilities.getMaxAnisotropy()));
    // Must precede any material construction; textures are cached on first use.
    setResolutionScale(SHOT ? 1 : this.quality.get('textureScale'));

    // A phone on a low tier renders shadows at a quarter of the desktop
    // resolution; below that they cost more than they contribute.
    this.renderer.shadowMap.enabled = this.quality.get('shadowMapSize') > 0;
  }

  setupAtmosphere() {
    this.scene = new THREE.Scene();
    // A narrower lens on a phone-sized viewport keeps the same amount of the
    // world legible without the extreme edge stretching a 78-degree FOV gives
    // on a 19.5:9 screen held at arm's length.
    const fov = platform.mobile ? 68 : 78;
    this.camera = new THREE.PerspectiveCamera(
      fov, window.innerWidth / window.innerHeight, 0.10, 700,
    );

    window.__MARK?.('scene:init');
    this.atmosphere = new Atmosphere(this.renderer, this.scene);
    this.atmosphere.configureShadows(this.quality.get('shadowMapSize') || 1024);
    this.atmosphere.sun.shadow.radius = this.quality.get('shadowRadius');
    if (this.scene.fog) this.scene.fog.density *= this.quality.get('fogDensityScale');
    // Ask the GPU whether the environment map actually lights anything before
    // a single surface is built on top of the assumption that it does.
    this.envReport = this.atmosphere.verifyEnvironment(this.renderer);
    window.__MARK?.('atmosphere');
  }

  setupLevel() {
    this.level = new Level().build();
    window.__MARK?.('level');
    this.scene.add(this.level.group);
  }

  setupWeapon() {
    this.player = new Player(this.level, this.camera);
    this.weapon = new Weapon(this.renderer, this.camera, this.scene.environment);
    window.__MARK?.('weapon');
  }

  setupSystems() {
    this.vfx = new VFX(this.scene, this.camera, this.level);
    this.vfx.setPixelRatio(this.renderer.getPixelRatio());
    this.director = new Director(this.scene, this.level);
    this.director.maxAlive = this.quality.get('maxEnemies');
    this.hud = new HUD();
    this.audio = new Audio();
    window.__MARK?.('vfx+ai+hud');
  }

  setupPost() {
    this.post = new PostStack(this.renderer, this.scene, this.camera, PRESET.exposure);
    this.viewmodelPass = this.post.setViewmodel(this.weapon.scene, this.weapon.camera);
    // One real frame through the chain before anything is presented, so a
    // device that cannot composite falls back instead of showing black.
    this.post.validateFrame();
    this.applyQuality(this.quality.settings);
    this.quality.onChange((s) => this.applyQuality(s));
    window.__MARK?.('post');

    this.wireCallbacks();
    this.director.populate(Math.min(6, this.quality.get('maxEnemies')));
  }

  /** Reapplies tier settings; safe to call at any time, including mid-play. */
  applyQuality(s) {
    if (this.post) {
      this.post.bloom.enabled = s.bloom;
      this.post.shafts.enabled = s.shafts;
      this.post.smaa.enabled = s.smaa;
      this.post.setAmbientOcclusion(s.gtao);
    }
    if (this.renderer && !SHOT) {
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, s.pixelRatio));
      this.renderer.shadowMap.enabled = s.shadowMapSize > 0;
      this.vfx?.setPixelRatio(this.renderer.getPixelRatio());
      this.post?.setSize(window.innerWidth, window.innerHeight);
    }
    if (this.atmosphere && s.shadowMapSize > 0) {
      this.atmosphere.sun.shadow.radius = s.shadowRadius;
    }
    if (this.director) this.director.maxAlive = s.maxEnemies;
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
    this.inputManager = new Input(this.renderer.domElement, this.player, {
      onReload: () => this.tryReload(),
    });
    // The rest of the game reads a plain action-state object and never needs
    // to know whether a thumb or a keyboard produced it.
    this.input = this.inputManager.state;

    if (isTouchDevice) document.body.classList.add('touch');

    window.addEventListener('resize', () => this.onResize());
    window.visualViewport?.addEventListener('resize', () => this.onResize());
    window.addEventListener('orientationchange', () => {
      // iOS reports stale dimensions if measured too early in the rotation.
      setTimeout(() => this.onResize(), 250);
    });
  }

  /** Called once the player has committed, from a real user gesture. */
  beginPlay() {
    if (this.running) return;
    document.getElementById('start')?.classList.add('hidden');
    document.body.classList.add('playing');
    this.hud.show();
    this.hud.playTitle();

    this.inputManager.enabled = true;
    this.inputManager.requestPointerLock();

    // WebAudio starts suspended until a gesture on iOS, so this has to happen
    // here rather than at construction.
    this.audio.init();
    this.audio.resume();
    this.audio.startAmbience();

    this.start();
  }

  onResize() {
    // visualViewport tracks the area actually visible under iOS Safari's
    // collapsing toolbars; innerWidth/innerHeight lag behind it during the
    // transition and leave a strip of unpainted page.
    const vv = window.visualViewport;
    const w = Math.round(vv?.width ?? window.innerWidth);
    const h = Math.round(vv?.height ?? window.innerHeight);
    if (w < 2 || h < 2) return;

    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.weapon.camera.aspect = w / h;
    this.weapon.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.post.setSize(w, h);

    document.body.classList.toggle('portrait', h > w);
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

    this.inputManager?.update();
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
    this._raf = requestAnimationFrame(this.loop);
    const dt = Math.min(this.clock.getDelta(), 1 / 20);
    this.step(dt);
    this.render(dt);
    this.quality.sample(dt, this.elapsed);
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

  document.getElementById('start')?.classList.add('hidden');
  document.getElementById('loading')?.classList.add('hidden');
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
      // Holding the trigger is all this should do. Resetting lastShot first —
      // which it used to — defeats the weapon's own rate limiter and fires a
      // round every single frame, roughly ten times the real cadence. Two
      // dozen smoke puffs then stack into one white cloud that swallows the
      // frame, which is not a capture of the game firing.
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

  if (params.get('diag') === '1') showDiagnostics(game);

  window.__SHOT_READY = true;
}

/* ------------------------------------------------------------- entry ----- */

/** Shown instead of a black screen when the renderer cannot continue. */
function showFatal(title, detail) {
  let el = document.getElementById('fatal');
  if (!el) {
    el = document.createElement('div');
    el.id = 'fatal';
    el.style.cssText = 'position:fixed;inset:0;z-index:60;display:flex;flex-direction:column;'
      + 'align-items:center;justify-content:center;background:#07090b;color:#f0f4f8;'
      + 'font:600 13px/1.7 -apple-system,system-ui,sans-serif;letter-spacing:2px;'
      + 'text-align:center;padding:24px';
    document.body.appendChild(el);
  }
  el.innerHTML = `<div style="color:#ffb454;letter-spacing:4px">${title}</div>`
    + `<div style="margin-top:12px;max-width:34em;color:rgba(240,244,248,0.6);`
    + `letter-spacing:1px;font-weight:400">${detail}</div>`;
}

/**
 * On-screen renderer report. The console is not reachable on a phone, so when
 * something only reproduces on a device this is the only way to see what that
 * device actually provided.
 */
function showDiagnostics(game) {
  const gl = game.renderer.getContext();
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const rows = [
    ['WebGL', game.renderer.capabilities.isWebGL2 ? '2' : '1'],
    ['renderer', info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'masked'],
    ['tier', game.quality.tierName],
    ['pixel ratio', String(game.renderer.getPixelRatio())],
    ['buffers', game.post.bufferType === THREE.HalfFloatType ? 'half-float' : '8-bit'],
    ['post', game.post.postDisabled ? 'DISABLED (fallback)' : 'active'],
    ['color_buffer_float', String(game.renderer.extensions.has('EXT_color_buffer_float'))],
    ['float_linear', String(game.renderer.extensions.has('OES_texture_float_linear'))],
    ['half_float_linear', String(game.renderer.extensions.has('OES_texture_half_float_linear'))],
    ['max texture', String(gl.getParameter(gl.MAX_TEXTURE_SIZE))],
    ['env map', game.scene.environment ? 'present' : 'MISSING'],
    ['env response', game.envReport
      ? `${game.envReport.measured.toFixed(4)} / ${game.envReport.expected.toFixed(4)}`
        + (game.envReport.healed ? ' HEALED' : '')
      : 'unmeasured'],
    ['draw calls', String(game.renderer.info.render.calls)],
    ['triangles', String(game.renderer.info.render.triangles)],
    ['gl error', String(gl.getError())],
  ];
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;left:8px;top:8px;z-index:50;background:rgba(4,6,8,0.86);'
    + 'color:#cfe;font:11px/1.5 ui-monospace,Menlo,monospace;padding:10px 12px;'
    + 'border:1px solid rgba(255,255,255,0.2);border-radius:4px;pointer-events:none;'
    + 'max-width:70vw';
  el.innerHTML = rows.map(([k, v]) => `${k}: <b>${v}</b>`).join('<br>');
  document.body.appendChild(el);
}

function setProgress(label, fraction) {
  const fill = document.getElementById('loading-fill');
  const step = document.getElementById('loading-step');
  if (fill) fill.style.width = `${Math.round(fraction * 100)}%`;
  if (step) step.textContent = label;
}

function watchOrientation() {
  const check = () => {
    const vv = window.visualViewport;
    const w = vv?.width ?? window.innerWidth;
    const h = vv?.height ?? window.innerHeight;
    document.body.classList.toggle('portrait', h > w);
  };
  check();
  window.addEventListener('resize', check);
  window.visualViewport?.addEventListener('resize', check);
  window.addEventListener('orientationchange', () => setTimeout(check, 250));
}

async function main() {
  const t0 = performance.now();
  const mark = (label) => {
    const t = performance.now();
    console.log(`[boot] ${label}: ${(t - (mark.last ?? t0)).toFixed(0)}ms`);
    mark.last = t;
  };
  window.__MARK = mark;

  if (isTouchDevice) document.body.classList.add('touch');
  watchOrientation();

  const game = new Game();
  window.__GAME = game;
  // The harness measures cadence against this rather than hard-coding it, so
  // retuning the weapon retunes the test with it.
  window.__SPEC_RPM = SPEC.rpm;
  await game.build(SHOT ? () => {} : setProgress);
  mark('build');

  document.getElementById('loading')?.classList.add('hidden');
  game.ready = true;

  if (SHOT) {
    await runShotMode(game, SHOT);
    return;
  }

  const startEl = document.getElementById('start');
  startEl?.classList.remove('hidden');

  // Both events are bound because iOS fires a synthetic click ~300 ms after
  // touchend, and the audio context will only unlock inside the gesture that
  // the user actually made.
  const begin = (e) => {
    e?.preventDefault();
    startEl?.removeEventListener('touchend', begin);
    startEl?.removeEventListener('click', begin);
    game.beginPlay();
  };
  startEl?.addEventListener('touchend', begin, { passive: false });
  startEl?.addEventListener('click', begin);

  window.__SHOT_READY = true;
}

main().catch((err) => {
  console.error(err);
  document.getElementById('loading')?.classList.add('hidden');
  const el = document.getElementById('start');
  if (el) {
    el.classList.remove('hidden');
    el.innerHTML = `<h1 style="font-size:22px">FAILED TO START</h1>`
      + `<pre style="max-width:86vw;white-space:pre-wrap;font-size:11px;color:#f88;text-align:left">`
      + `${String(err && err.stack || err)}</pre>`;
  }
});
