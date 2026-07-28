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

/* --------------------------------------------------------- simulation --- */

/**
 * The length of one simulation step.
 *
 * physics.multiplayer_server_tick_rate: 60 Hz is the rate the authoritative
 * simulation runs at, so it is the rate this one runs at. Everything about the
 * player, the weapon, the AI and the rounds in flight advances in steps of
 * exactly this length whatever the display is doing — see Game.step.
 */
const TICK = 1 / 60;

/**
 * How many ticks one frame may consume before the debt is written off.
 *
 * Five is 83 ms of simulation: enough to absorb a shader compile or a GC pause
 * without the world jumping, and short of the point where catching up costs
 * more than the frame that fell behind, which is the accumulator death spiral.
 * Past it the simulation runs slow rather than the frame rate collapsing, which
 * is the trade a phone wants.
 */
const MAX_TICKS_PER_FRAME = 5;

/* --------------------------------------------------------- ballistics --- */

/**
 * The sourced ballistic model. Every figure names its key in tools/targets.mjs;
 * the two that have no sourced magnitude say so in place.
 *
 * This lives here rather than in SPEC because SPEC's damage block describes a
 * different model — one flat damage figure lerped from 45 m to 150 m down to
 * 0.55x — and the two cannot both be authoritative. SPEC.damage,
 * SPEC.falloffStart/End/Scale and SPEC.headshotMultiplier are no longer read by
 * anything; weapon.js is owned elsewhere, so they are left for that owner to
 * remove rather than half-removed from here.
 */
const BALLISTICS = {
  // ballistics.ar_muzzle_velocity_mcw_mw3_2023 (750 m/s post-buff), which also
  // sits mid-band in ballistics.ar_muzzle_velocity_design_band (590..850).
  muzzleVelocity: 750,

  // ballistics.instant_hit_range_formula_divisor, which is exact: a 20 Hz
  // authority resolves anything inside velocity/20 metres within a single tick,
  // so the first 37.5 m of every round registers on the tick the trigger broke
  // and only the remainder is flown. This is why a faithful model is NOT "a
  // projectile at all ranges" — inside that radius CoD is indistinguishable
  // from hitscan, and ballistics.perceptible_travel_time_threshold (40 +/- 15 m,
  // reported as 30..60) is the same boundary measured from the player's side.
  instantHitDivisor: 20,

  // ballistics.bullet_gravity_drop_present. Drop exists and is deliberately
  // small, and no title publishes a magnitude — so the round falls in the same
  // field the player does instead of in an invented one, and the drop that
  // produces (39 cm at 150 m) is measured rather than asserted.
  gravity: TUNING.gravity,

  // damage.m4a1_mw2019_max_damage / _near_range_stop / _far_range_stop /
  // _min_damage: 30 HP flat to 37.5 m, linear to 20 HP at 50 m, then 20 HP flat
  // for ever — CoD has no hard damage cutoff. Two range stops, which is the
  // whole point: against 100 HP the shots-to-kill are 4 inside the plateau
  // (ceil(100/30)) and 5 beyond the floor (100/20 exactly), and both boundaries
  // are announced distances a player can learn. The lerp this replaced moved
  // damage at every metre, so the shot-count boundary sat wherever 100/damage
  // happened to cross an integer and moved with any tweak to either end.
  maxDamage: 30,
  nearStop: 37.5,
  farStop: 50,
  minDamage: 20,

  // damage.m4a1_mw2019_headshot_multiplier is 1.4x, and the largest figure
  // anywhere in the research is 1.5x for snipers. Both values this game carried
  // were roughly double that: SPEC.headshotMultiplier (2.4, read by nothing)
  // and a 2.6 literal inside ai.js applyDamage(). At 2.6 a head hit takes
  // 78 HP, so two rounds of a spread cone could kill where four centred ones
  // were needed — which is why TTK was measurably non-monotonic in range.
  //
  // Passed to applyDamage() as an explicit argument so this table is the single
  // source. ai.js owns that method and still applies its own literal until it
  // takes the argument; the zone multiplier measured through the game is the
  // check that says which of the two is live.
  //
  // 'body' is damage.mcw_mw3_torso_multiplier_post_buff (1.0x, both torso zones
  // flattened). 'limb' has no sourced figure in any title and keeps the value
  // ai.js authored.
  zoneMultiplier: { head: 1.4, body: 1.0, limb: 0.72 },
};

/**
 * Surface penetration, by weapon class.
 *
 * ballistics.penetration_class_hierarchy: penetration strength is assigned by
 * CLASS and not tuned per gun, ordered LMG > AR > SMG with snipers highest. The
 * ORDERING is the sourced part of this table; neither the thickness gate in
 * metres nor the retained fraction is published for any weapon, so those are
 * design numbers authored to that ordering and measured rather than asserted.
 *
 * ballistics.penetration_damage_falloff_is_flat_not_thickness_scaled: past the
 * gate the penalty is ONE flat percentage, decoupled from thickness. So
 * `retain` is deliberately not a function of the measured path length anywhere
 * below — a round that crosses 4 cm and a round that crosses 19 cm of the same
 * class of surface arrive with the same damage, and only the gate is thickness.
 */
const PENETRATION = {
  sniper: { maxThickness: 0.55, retain: 0.80 },
  lmg: { maxThickness: 0.35, retain: 0.70 },
  ar: { maxThickness: 0.20, retain: 0.55 },
  smg: { maxThickness: 0.10, retain: 0.45 },
};

/**
 * The class the shipped weapon belongs to. SPEC has no class field and
 * weapon.js is owned elsewhere; the M4A1 is an assault rifle, so the tier is
 * named here until SPEC can carry it.
 */
const WEAPON_CLASS = 'ar';

// Scratch vectors for the per-tick round walk. Allocating inside it would put a
// pair of Vector3s per projectile per tick through the nursery.
const _rv = new THREE.Vector3();
const _rd = new THREE.Vector3();
const _rp = new THREE.Vector3();
const _rm = new THREE.Matrix4();
// materialPath's own, and not a reuse of _rd: it is called from inside
// advanceRound's loop with advanceRound's direction vector as its argument, and
// writing the local-space direction into that same vector left every round that
// crossed a surface travelling in a direction transformed into the geometry's
// object space.
const _rpd = new THREE.Vector3();

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
    // Time owed to the simulation but not yet stepped. See step().
    this._accumulator = 0;
    this.tickLength = TICK;
    // Rounds still in the air. A round only lands here once it has passed the
    // instant-hit radius without hitting anything, so a close-quarters fight
    // never allocates one.
    this.projectiles = [];
    // The two model tables, reachable from outside so the acceptance suite can
    // perturb the model it is measuring and read the ordering of the penetration
    // tiers. Nothing in the game reads them through the instance: these are the
    // same objects the module-scope constants name, exposed for the same reason
    // window.__THREE is.
    this.ballistics = BALLISTICS;
    this.penetration = PENETRATION;
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
    this.weapon = new Weapon(this.renderer, this.camera,
      this.scene.environment, this.scene.environmentIntensity);
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

    this.fireRound(origin, dir, true);

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

  /* ----------------------------------------------------------- rounds --- */

  /** Damage a round still carries at `distance` from the muzzle. */
  static damageAtRange(distance) {
    const B = BALLISTICS;
    if (distance <= B.nearStop) return B.maxDamage;
    if (distance >= B.farStop) return B.minDamage;
    // One linear segment between the two stops, and nothing outside them.
    return B.maxDamage
      + (B.minDamage - B.maxDamage) * ((distance - B.nearStop) / (B.farStop - B.nearStop));
  }

  /**
   * Sends one round down `dir` from `origin`.
   *
   * One authority tick of flight — 1/20 s, so velocity/20 = 37.5 m — is
   * simulated here, on this tick, because that is what a 20 Hz server does with
   * it: inside that radius travel time does not merely round down to nothing, it
   * does not exist, and no amount of leading a target changes anything. Whatever
   * survives that stretch goes onto the projectile list and is flown at TICK
   * resolution from there.
   *
   * The instant stretch is flown in sub-steps rather than traced as a straight
   * ray. Resolving it in one tick is a statement about WHEN the hit registers,
   * not about the round not falling: a straight first 37.5 m makes the drop at
   * 50 m one tick's worth instead of the whole flight's, so drop stops being
   * quadratic in range and the two independent velocity estimates stop agreeing.
   * Both of those were measured before this was sub-stepped.
   */
  fireRound(origin, dir, fromPlayer) {
    const round = {
      pos: origin.clone(),
      vel: dir.clone().multiplyScalar(BALLISTICS.muzzleVelocity),
      // What penetration has taken off, kept separate from range falloff so the
      // two are composed at the moment of the hit rather than baked together.
      retain: 1,
      flown: 0,
      fromPlayer,
    };
    const instantTime = 1 / BALLISTICS.instantHitDivisor;
    let flownTime = 0;
    let spent = false;
    while (!spent && flownTime + 1e-9 < instantTime) {
      const step = Math.min(TICK, instantTime - flownTime);
      spent = this.stepRound(round, step);
      flownTime += step;
    }
    // The streak is spawned once, at the muzzle, on the tick the trigger broke:
    // a tracer that waited for the round to arrive would appear after the hit.
    if (fromPlayer) this.spawnTracer(origin, dir, spent ? round.flown : SPEC.range);
    if (!spent) this.projectiles.push(round);
  }

  /**
   * Flies one round for `dt`. Returns true once it is spent.
   *
   * Gravity is integrated before the step (semi-implicit), which is the scheme
   * the player uses, so a round and a body fall on the same curve.
   */
  stepRound(round, dt) {
    round.vel.y -= BALLISTICS.gravity * dt;
    _rv.copy(round.vel).multiplyScalar(dt);
    const length = _rv.length();
    if (length < 1e-6) return true;
    _rd.copy(_rv).divideScalar(length);
    const reach = this.advanceRound(round, _rd, length);
    return reach.spent || round.flown >= SPEC.range;
  }

  /**
   * Walks a round along one straight segment of its path.
   *
   * Returns `{spent, at}`: whether the round stopped inside the segment, and how
   * far along it the first thing it touched was (for the tracer). Mutates
   * `round.pos`, `round.flown` and `round.retain`.
   *
   * The loop is what penetration needs: a round that gets through a surface
   * carries on from the far face inside the same segment, so a 4 cm sheet does
   * not cost it a tick.
   */
  advanceRound(round, dir, length) {
    let left = length;
    let first = null;
    // Three surfaces is a wall, a window and a crate: past that the round has
    // nothing left worth spending another pair of raycasts on.
    for (let crossings = 0; crossings < 3 && left > 1e-4; crossings++) {
      const enemyHit = this.director.raycast(round.pos, dir, left);
      const ray = new THREE.Raycaster(round.pos, dir, 0.02, left);
      const worldHits = ray.intersectObjects(this.level.raycastables, false);
      const worldHit = worldHits.length ? worldHits[0] : null;

      if (enemyHit && (!worldHit || enemyHit.distance < worldHit.distance)) {
        round.flown += enemyHit.distance;
        round.pos.copy(enemyHit.point);
        this.hitBody(round, enemyHit, dir);
        return { spent: true, at: first ?? enemyHit.distance };
      }
      if (!worldHit) break;

      if (first === null) first = worldHit.distance;
      round.flown += worldHit.distance;
      const path = this.materialPath(worldHit, dir);
      const gate = PENETRATION[WEAPON_CLASS].maxThickness;
      const through = path !== null && path <= gate;
      this.hitSurface(round, worldHit, dir, through);
      if (!through) return { spent: true, at: first };

      // Flat, and deliberately not a function of `path`: past the gate the
      // penalty is one percentage, which is what makes cover a yes/no decision
      // rather than a thickness sum a player cannot see.
      round.retain *= PENETRATION[WEAPON_CLASS].retain;
      const step = worldHit.distance + path + 0.01;
      round.pos.copy(worldHit.point).addScaledVector(dir, path + 0.01);
      round.flown += path + 0.01;
      left -= step;
    }

    const free = Math.max(0, left);
    round.pos.addScaledVector(dir, free);
    round.flown += free;
    return { spent: round.flown >= SPEC.range, at: first };
  }

  /**
   * Metres of material a round would have to cross to leave `hit.object`.
   *
   * Measured in the object's own space against its geometry bounding box, not
   * against a world AABB: every plate in this game faces the shooter, and the
   * world AABB of a 4 cm sheet rotated 45 degrees is a 4 m box, which would gate
   * a sheet as if it were a bunker. Returns null when the object has no
   * geometry to measure, which reads as "does not penetrate".
   *
   * For a merged mesh the box is the whole merge, so a wall that is one draw call
   * with a building is treated as that thick. Conservative in the direction that
   * keeps cover working.
   */
  materialPath(hit, dir) {
    const geo = hit.object.geometry;
    if (!geo) return null;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const box = geo.boundingBox;
    _rm.copy(hit.object.matrixWorld).invert();
    // Local-space ray, nudged inside the surface so the entry face is behind it.
    _rp.copy(hit.point).addScaledVector(dir, 1e-4).applyMatrix4(_rm);
    _rpd.copy(dir).transformDirection(_rm);
    let exit = Infinity;
    for (const axis of ['x', 'y', 'z']) {
      const d = _rpd[axis];
      if (Math.abs(d) < 1e-9) continue;
      const t = ((d > 0 ? box.max[axis] : box.min[axis]) - _rp[axis]) / d;
      if (t < exit) exit = t;
    }
    if (!Number.isFinite(exit) || exit <= 0) return null;
    // Back to world scale by measuring the exit point rather than the parameter,
    // so a scaled mesh reports the thickness it actually has.
    _rp.addScaledVector(_rpd, exit).applyMatrix4(hit.object.matrixWorld);
    return _rp.distanceTo(hit.point);
  }

  /** A round arriving on a soldier. */
  hitBody(round, hit, dir) {
    const { enemy, zone, point, distance } = hit;
    // Range falloff is applied to the base damage and penetration to that, both
    // before the zone multiplier, so `amount` is what the round had left when it
    // arrived and the multiplier is the only thing the zone contributes.
    const amount = Game.damageAtRange(round.flown) * round.retain;
    const zoneMult = BALLISTICS.zoneMultiplier[zone] ?? 1;
    const killed = enemy.applyDamage(amount, zone, dir, zoneMult);
    this.vfx.bloodBurst(point, dir, zone === 'head' ? 1.6 : 1);
    this.vfx.bloodDecals.place(
      new THREE.Vector3(point.x, this.level.groundHeight(point.x, point.z) + 0.02, point.z),
      new THREE.Vector3(0, 1, 0), 0.7 + Math.random() * 0.5,
    );
    if (round.fromPlayer) {
      this.audio.impact('flesh', distance);
      if (!killed) { this.hud.hit(false); this.audio.hitmarker(false); }
    }
  }

  /** A round arriving on world geometry, whether or not it gets through. */
  hitSurface(round, hit, dir, through) {
    const surface = this.classifySurface(hit.object);
    const normal = hit.face
      ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld)
      : new THREE.Vector3(0, 1, 0);
    // A round that punched through still spalls the face it went in at, at
    // reduced strength: the effect is the evidence a player has that the surface
    // is penetrable at all.
    this.vfx.impact(hit.point, normal, surface, through ? 0.55 : 1);
    this.audio.impact(surface, hit.distance);
    if (!round.fromPlayer) this.director.alertAll(hit.point, 12);
  }

  /** Flies every round already in the air for one tick. */
  updateProjectiles(dt) {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      if (this.stepRound(this.projectiles[i], dt)) this.projectiles.splice(i, 1);
    }
  }

  /**
   * Drops everything in flight and the tick debt.
   *
   * A known world state has to include the rounds already in the air: a test
   * that repositions a target while a round from the previous burst is still
   * downrange gets that round's hit attributed to the new engagement.
   */
  resetSimulation() {
    this.projectiles.length = 0;
    this._accumulator = 0;
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

  /**
   * Advances one frame's worth of time, in fixed steps.
   *
   * The simulation used to integrate at whatever dt it was handed, which made
   * every quantity a player learns a function of their frame rate: the jump
   * apex measured 0.8875 m at 30 Hz against 0.9686 m at 144 Hz, a 9.6% spread on
   * a 1 m jump, and two seconds of sprint covered 13.3636 m against 13.2858 m.
   * Semi-implicit Euler overshoots by a term proportional to dt, and an
   * exponential acceleration ramp sampled coarsely is a different ramp, so
   * neither gap could be closed by retuning: the fix has to be that dt stops
   * varying.
   *
   * So the frame's time is banked and drawn down in TICK-long steps. A 30 fps
   * frame runs two ticks, a 144 fps frame runs one on two frames out of five,
   * and the sequence of simulated states is identical either way — 120 ticks in
   * two seconds at every frame rate.
   *
   * Presentation is not sub-stepped: the HUD, the sky, the sun and the damage
   * post-effect are functions of the state the ticks left behind, and running
   * them per tick would cost a phone three HUD updates on a slow frame to
   * produce one frame's worth of pixels.
   *
   * Look is applied once per frame, before the ticks, and deliberately outside
   * them: a mouse delta is not a rate, so it is frame-rate independent already,
   * and quantising the view to 60 Hz is the one part of this a player would feel.
   */
  step(dt) {
    this.inputManager?.update();

    this._accumulator += dt;
    let ticks = 0;
    // Ticks are run until the simulation covers the frame being presented, not
    // until it merely nearly covers it: any time owed at all buys the tick that
    // spans it, and the accumulator goes negative to pay for it. Draining to
    // "acc < TICK" instead leaves the frame showing a state up to a whole frame
    // old, and since that lag is a frame long it is worst exactly where the
    // frame is longest — 33 ms of stale sprint at 30 Hz against none at 240 Hz,
    // which is a frame-rate-dependent observation of a frame-rate-independent
    // trajectory. This way the lead is bounded by one tick at every rate and
    // this frame's input is always in this frame's picture. The 1e-9 is float
    // dust from subtracting TICK a few hundred times, not a tolerance.
    while (this._accumulator > 1e-9 && ticks < MAX_TICKS_PER_FRAME) {
      this._accumulator -= TICK;
      this.tick(TICK);
      ticks++;
    }
    // A frame that could not be caught up on: write the debt off rather than
    // carry it into the next frame, where it would buy another five ticks.
    if (this._accumulator > 0) this._accumulator = 0;

    this.present(dt);
  }

  /** One fixed simulation step. Everything a measurement can see happens here. */
  tick(dt) {
    this.elapsed += dt;

    this.player.update(dt, this.input, this.elapsed);

    // Before the trigger, not after. A round fired on this tick has already flown
    // its instant-hit stretch inside fireRound(), so flying it again here would
    // add another tick of travel to it and put the boundary at velocity/20 plus
    // one tick — 50 m rather than the sourced 37.5 m. Measured: with this call
    // after playerShoot, a target at 50 m was hit with zero travel time.
    this.updateProjectiles(dt);

    if (this.input.fire) this.playerShoot();
    if (this.weapon.ammo === 0 && !this.weapon.reloading && this.weapon.reserve > 0) {
      this.weapon.startReload(this.elapsed);
    }

    this.weapon.update(dt, this.elapsed, this.player, this.input);

    this.director.update(dt, this.player, this.elapsed);
    this.vfx.update(dt, this.elapsed, this.atmosphere.sunDirection);

    // Damage feedback decay.
    this._damageFlash = Math.max(0, (this._damageFlash ?? 0) - dt * 3.2);
  }

  /** Everything that reads the simulation to build a frame. */
  present(dt) {
    this.weapon.syncLighting(this.atmosphere.sunDirection, this.camera);
    this.atmosphere.update(this.camera);
    this.post.updateSun(this.atmosphere.sunDirection);

    const hurtLevel = Math.max(
      (this._damageFlash ?? 0) * 0.6,
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
  // The gameplay harness needs to ask real geometric questions — is this firing
  // lane clear, where does this ray land — and the answers have to come from
  // the same Raycaster and the same raycastables list that resolveBullet uses.
  // Reimplementing that on the harness side would produce a second, subtly
  // different world to measure against, which is how a suite ends up green
  // about a game nobody is playing.
  window.__THREE = THREE;
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
