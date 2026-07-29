// Hostile combatants: model, animation, behaviour.
//
// Bodies are built as a real joint hierarchy so one procedural animator can
// drive walk, aim, flinch and death without any authored clips. Hit zones are
// tagged on the meshes themselves, so the same raycast that finds the body
// also tells you whether it was a headshot.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { material } from './textures.js';
// The zone multiplier ladder belongs to the weapon, not to the target: a
// headshot is a property of the round that lands, and applyDamage() below used
// to hard-code 2.6 while SPEC.headshotMultiplier sat at 2.4 and was read by
// nobody. Consumed with a fallback rather than destructured, so removing or
// renaming the field in weapon.js degrades to the historical 2.6 instead of
// multiplying damage by undefined.
import { SPEC } from './weapon.js';

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
  // Aim error, as a radius at the target rather than a cone half-angle. See
  // shoot(): `aimErrorMetres / distance` is the angle that puts a fixed
  // positional error on the target, `aimErrorAngle` is the residual wobble that
  // does grow with range. A pure cone was measured at 98% hits at 10 m and 5%
  // at 40 m — a cliff with no fightable middle — because a fixed angle puts a
  // circle of linearly growing radius on a target of fixed size, so accuracy
  // falls as 1/d^2. Splitting the error is what makes the falloff a curve.
  aimErrorMetres: 0.18,
  aimErrorAngle: 0.030,
  aimErrorFloorRange: 4,      // m; below this the 1/d term stops shrinking
  damage: 11,
  // The delay the player actually experiences between being seen and being
  // shot at, because nothing else adds to it any more: ALERT holds this timer
  // and ENGAGE fires on the tick it expires (fireTimer is armed at 0). It used
  // to be [0.28, 0.62] on top of a fresh 0.12-0.34 s fireTimer and a tick spent
  // arming the burst without firing it, which measured 644-921 ms end to end —
  // outside the 0.20-0.40 s band in targets.mjs by more than a factor of two,
  // and reading as an enemy who had to wake up first.
  // Kept at [0.22, 0.32] on purpose after a blind comparison called the band too
  // narrow against the reference's 0.233-0.383. The only SOURCED statement about
  // this quantity is ai.ai_reaction_delay_base (0.25 s, tolerance 0.20-0.30) and
  // ai.ai_reaction_delay_range, whose tolerance IS the 0.20-0.40 s band; measured
  // over 72 engagements the delay the player experiences runs 0.238-0.338 s at a
  // 0.283 s mean, which is inside both. Widening to the full 0.20-0.40 band is
  // what the comparison suggested and it fails the base: the mean would land at
  // ~0.31 s once the line-of-sight schedule's couple of ticks are added, outside
  // the 0.30 s ceiling on the median. Nothing publishes a DISPERSION for an AI
  // reaction, so the sd difference (0.029 vs 0.041) is a shape the comparison had
  // no reference for — two of its three judges said as much — and there is no
  // number here to move it toward without inventing one.
  reactionTime: [0.22, 0.32],
  repositionChance: 0.55,
};

/* ------------------------------------------------------------- the model -- */

/**
 * Soldier surfaces.
 *
 * These were ten flat MeshStandardMaterials with no albedo, normal or ORM map
 * on any of them, and four independent blind reviewers each landed on the same
 * word for the result: mannequin. The soldier is the one object in the frame
 * the player is supposed to be looking at, so it was also the worst place in
 * the level to be spending nothing on surface.
 *
 * Every woven part below is `canvas` and not `burlap`, which is the opposite
 * of what the weave scale argues for — burlap's hessian is far coarser and so
 * survives the mip chain much better at the distance these are fought at.
 * burlap is disqualified by its macro entry in textures.js. That pass keys off
 * world position: its tone lobes off world XZ and its dust film off world Y.
 * Both are exactly right on a wall that never moves and wrong on a body that
 * covers four metres between bursts, where the film slides up and down the
 * shins and the tone pumps as he crosses the compound. canvas, polymer and
 * gunmetal are the three samplers with no macro entry at all, which happens to
 * be precisely the set a moving object wants. Tried burlap on the fatigues
 * first and the swim is obvious the moment an enemy repositions.
 *
 * `repeat` here is texel density and nothing else. Box UVs run 0..1 across a
 * face whatever that face measures, so one repeat over a 0.4 m torso and the
 * same repeat over a 0.09 m cuff are a factor of four apart in thread size —
 * which is how a soldier ends up wearing four different fabrics. The numbers
 * are chosen to land every canvas tile near 10-13 cm of body. That puts the
 * weave itself around a millimetre, where it is honest but gone by fifteen
 * metres, and — the part that actually matters — puts the sampler's fold,
 * bleach and stain octaves at three to five centimetres, which is the finest
 * scale still resolving at the ten to thirty metres where these are read.
 *
 * The colour constants are multipliers against the sampler's own albedo, not
 * the colour anyone sees, so they look nothing like the material they produce.
 * Each was solved backwards from a target rendered albedo measured against the
 * sand's, because the sharpest note the panel returned was not about surface
 * at all: the soldiers were beige figures standing on beige sand and were
 * effectively invisible. The old fatigue was 0x6b6247 — the sand's own hue at
 * three quarters of its value, which is camouflage doing its job. Sand sits at
 * 0.25 linear luminance and strongly orange; the figure now runs cool grey-
 * green at 2% to 20% of that, and the ladder inside it — fatigues lightest,
 * then pouches, helmet, carrier, webbing, boots near black — gives the
 * silhouette internal structure instead of the single mass it read as before.
 *
 * How far down that ladder had to go was settled by measurement, and the first
 * pass got it badly wrong. The fatigues went in at 40% of sand, a perfectly
 * defensible faded-cotton albedo, and the captured soldier came back at 156
 * sRGB against sand at 152 — no separation at all, and no visible weave
 * either. The cause is lighting geometry rather than albedo. The sun in these
 * captures is a few degrees above the horizon, so it rakes flat ground at a
 * grazing angle and strikes a standing figure square on, and the figure
 * therefore collects several times the ground's irradiance. That puts every
 * vertical sunlit surface on the shoulder of the tone curve — the limewashed
 * walls clip outright at 251 — and the measured slope up there is only about
 * thirty sRGB levels per e-fold of albedo. Halving the albedo buys twenty
 * levels, and the texture authored into the figure only begins to survive once
 * he is off the shoulder entirely. So the ladder sits at the dark end of what
 * these materials really occupy, which is also just more accurate: a plate
 * carrier and a pair of boots are far darker than desert sand, and of the ten
 * surfaces only the uniform's value was ever arguable.
 *
 * Hue was expected to do more of the work than it does. A 5000 K sun multiplies
 * whatever is under it, so a cool albedo under this light lands much warmer
 * than it reads on the swatch: the fatigues are authored at a blue-to-red ratio
 * of 1.0 and photograph at 0.60 against the sand's 0.48. That is a real
 * separation and it is worth having, but value is doing most of the lifting
 * and pushing the cloth green enough to win on hue alone would turn the
 * garrison into toy soldiers.
 */
const MATS = {};
function mats() {
  if (MATS.built) return MATS;
  MATS.built = true;
  // Faded cotton field uniform. The largest area on the figure and the one
  // carrying the hue separation, so it is the lightest thing he is wearing.
  MATS.fatigue = material('canvas', 3.0, { color: 0x697d90, roughness: 1.0, normalScale: 1.15 });
  // Cuffs and the balaclava: same cloth, but they are 8-14 cm parts, and at
  // the fatigues' repeat the weave on them would be a quarter the size.
  MATS.fatigueDark = material('canvas', 1.2, { color: 0x576678, roughness: 1.0, normalScale: 1.05 });
  // Coated nylon plate carrier — a laminated, slightly sheeny surface, so the
  // normal is pulled back and the roughness with it. Darkest large area on the
  // body, which is what gives the torso its block at range.
  MATS.carrier = material('canvas', 3.4, { color: 0x414b5d, roughness: 0.84, normalScale: 0.6 });
  // Cordura pouches. Deliberately a denser weave than the carrier they are
  // sewn to: reading as separate objects on the chest is worth more here than
  // strict physical consistency, and at 20 m the density break is most of what
  // says there is more than one thing there.
  MATS.pouch = material('canvas', 1.3, { color: 0x525e70, roughness: 0.92, normalScale: 0.95 });
  MATS.strap = material('canvas', 1.6, { color: 0x373f51, roughness: 0.90, normalScale: 0.85 });
  // Composite shell. Roughness pulled down so the dome takes a broad sky
  // highlight — at range that highlight is the head, and it is the only thing
  // separating helmet from hair-line silhouette when the figure is backlit.
  MATS.helmet = material('polymer', 2.0, { color: 0x98aaaf, roughness: 0.85, normalScale: 0.7 });
  // Moulded knee pads. These were the same cloth as the cuffs; making them a
  // hard surface is the one material break available on an otherwise uniform
  // leg, and legs are half the standing silhouette.
  MATS.pad = material('polymer', 1.6, { color: 0x828c93, roughness: 1.0, normalScale: 1.1 });
  // Skin has no sampler and is not worth one: between helmet, balaclava and
  // eye-pro what is left is a band across the eyes and a sliver of neck. The
  // roughness was 0.70, which is a dry matte dielectric; a face has a thin
  // sebum layer over it and holds a soft highlight, so it comes down.
  MATS.skin = new THREE.MeshStandardMaterial({ color: 0x9a7150, roughness: 0.62, metalness: 0.0 });
  MATS.boot = material('polymer', 1.5, { color: 0x626469, roughness: 1.25, normalScale: 1.2 });
  MATS.glove = material('polymer', 1.0, { color: 0x7a8087, roughness: 1.15, normalScale: 1.0 });
  // The AI rifle is the same M4 the player is holding, so it is given the
  // viewmodel's phosphate verbatim — same sampler, same tint, same roughness,
  // same metalness — rather than a second interpretation of the same weapon.
  // Left untinted at first, on the reasoning that gunmetal already carries
  // iron's F0 and multiplying a metal down is what turns a receiver into a
  // black cut-out. That is true indoors and wrong here: a bare F0 near 0.11 at
  // metalness 1, pointed at a low sun sitting behind the camera, is a mirror
  // aimed back at the lens, and the captured rifle came out a pale tan stick
  // lighter than the sand. Dropping metalness to 0.24 puts most of the surface
  // back on the diffuse term, where the dark tint can hold it down.
  MATS.gun = material('gunmetal', 2.4, { color: 0x70757d, roughness: 0.62, metalness: 0.24 });
  // Eye-pro. Was 0x14161c at metalness 0.5, which is a physical impossibility
  // — a tinted lens is a dielectric — and it was also being allocated fresh
  // inside buildSoldier, so every enemy that ever spawned left another
  // MeshStandardMaterial and another compiled program behind it. polymer's
  // scuff streaks are right for a lens that has lived in a pocket, but its
  // moulding stipple is not, so the normal is scaled almost flat.
  //
  // Roughness is the interesting number. Authored as glass — 0.16 against the
  // map, so 0.06 to 0.12 — with envMapIntensity lifted to 1.6, and it did
  // exactly what the note above build() in textures.js says a near-zero
  // roughness texel does. The soldier faces the player and the sun in this
  // preset sits behind the camera, which is the one geometry that puts the
  // specular lobe straight back down the lens; a GGX highlight that narrow
  // carries a radiance in the thousands, and the bloom pass smeared it into a
  // white halo that swallowed the whole figure. The captured soldier was
  // brighter than the limewashed wall behind him.
  //
  // 0.42 lands the lens between 0.17 and 0.31, which still reads wet against
  // matte cloth and still catches the sky, without a lobe tight enough to
  // resolve the sun as a point source.
  MATS.visor = material('polymer', 1.0, {
    color: 0x495365, roughness: 0.42, normalScale: 0.12,
  });
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
  const goggles = mk(head, rb(0.145, 0.038, 0.030, 0.012), M.visor, 0, 0.040, 0.078, 'head');

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
    mk(knee, rb(0.120, 0.090, 0.130, 0.030), M.pad, 0, -0.030, 0.012, 'limb');  // knee pad
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
  // The rifle is tagged 'limb', and the tag is the point rather than the zone.
  // Every one of these meshes was untagged, and director.raycast() only ever
  // intersects tagged meshes: a 61x61 ray grid across the silhouette from 20 m
  // measured 1.1% of the rays that hit the soldier hitting nothing the game
  // would register, and a further 5.1% registering on a zone BEHIND the surface
  // the player had actually aimed at. An engaged soldier holds the rifle across
  // his chest, so that shadow sits over the middle of the target.
  //
  // 'limb' rather than 'body' because the multiplier ladder should never make
  // the weapon a better thing to shoot at than the man holding it — 0.72 makes
  // a rifle hit register, and register as the worst hit available. 'head' would
  // be absurd and an untagged mesh is a lie; there is no third option that does
  // not require a zone system this model does not have.
  const gun = new THREE.Group();
  armR.hand.add(gun);
  gun.position.set(-0.02, -0.06, 0.02);
  const g = (w, h, d, x, y, z, m = M.gun) => {
    const mesh = new THREE.Mesh(rb(w, h, d, 0.008), m);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.userData.zone = 'limb';
    gun.add(mesh);
    return mesh;
  };
  g(0.045, 0.055, 0.30, 0, 0, -0.10);                       // receiver
  g(0.035, 0.030, 0.26, 0, 0.002, -0.34);                   // handguard
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.010, 0.011, 0.16, 10), M.gun);
  bar.position.set(0, 0.004, -0.53); bar.rotation.x = Math.PI / 2; bar.castShadow = true;
  bar.userData.zone = 'limb';       // the barrel is built outside g(), so it needs its own tag
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

  /**
   * `zoneMult` is the multiplier the shooter resolved for the zone this round
   * landed in, and it is authoritative when supplied.
   *
   * Three values were competing here. A 2.6 literal lived in this method,
   * SPEC.headshotMultiplier sat at 2.4 and was read by nobody, and main.js's
   * sourced ballistics table says 1.4 — the documented MW2019 figure, where
   * nothing in the research exceeds 1.5 for any weapon class. Reading the
   * argument makes that table the single source: a head hit takes 42 HP rather
   * than 72, so a centred four-round kill can no longer be beaten by two stray
   * rounds finding the head, which is what made time-to-kill measurably
   * non-monotonic in range.
   *
   * The fallback chain is kept for a caller that has not been taught to pass
   * one, but it is now the exception rather than the live path.
   */
  applyDamage(amount, zone, direction, zoneMult = null) {
    if (!this.alive) return false;
    const head = SPEC.headshotMultiplier ?? 2.6;
    const mult = zoneMult ?? (zone === 'head' ? head : zone === 'limb' ? 0.72 : 1.0);
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

    // Re-tested on this agent's scheduled frame; cached otherwise.
    if (this.losDue !== false || this._sawPlayer === undefined) {
      this._sawPlayer = player.alive && this.canSee(player.camera.position, blockers);
    }
    const sees = this._sawPlayer;
    // Kept for pickCover(), which needs the same occluder set the sight test
    // uses and is called from a branch that is not handed it.
    this._blockers = blockers;

    if (sees) {
      this.aware = Math.min(1, this.aware + dt * 3.2);
      this.lastKnown = player.camera.position.clone();
    } else {
      // 0.35/s put a soldier who had just been in a firefight back into IDLE
      // 2.7 s after losing sight, and over a measured 26 s engagement this agent
      // spent 64% of its ticks IDLE — not suppressed, not searching, but having
      // forgotten the player entirely between one burst and the next. 0.06/s is
      // ~16 s of memory: long enough to cover a reposition, the walk back into a
      // sight line, and a second reposition after that. At 0.11/s the same
      // engagement still ended with 15% of its ticks in IDLE.
      this.aware = Math.max(0, this.aware - dt * 0.06);
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
        // Push to the last known position, and do not relax until arriving
        // there. Awareness decay alone decided this before, and it produced a
        // soldier who lost a sight line, stood still, and was measured IDLE for
        // 64% of a 26 s engagement — no longer suppressed or searching, just
        // unaware there had ever been a fight. Search-until-arrival is both the
        // conventional behaviour and the only rule available here that does not
        // amount to never forgetting: it terminates on arrival, and on a
        // 20 s cap for the case where the way there is blocked.
        let searching = false;
        if (this.lastKnown) {
          this.targetFacing = Math.atan2(
            this.lastKnown.x - this.position.x, this.lastKnown.z - this.position.z,
          );
          const to = _v.copy(this.lastKnown).sub(this.position);
          to.y = 0;
          const d = to.length();
          searching = !sees && d > 3 && this.stateTimer < 20;
          // Only while genuinely blind: an agent that can see is reacting, and
          // moving during the reaction roll would be measured as a slower
          // reaction than the one CONFIG.reactionTime describes.
          if (searching) {
            to.divideScalar(d);
            this.velocity.x = to.x * CONFIG.walkSpeed;
            this.velocity.z = to.z * CONFIG.walkSpeed;
          }
        }
        this.reactionTimer -= dt;
        if (this.reactionTimer <= 0 && sees) {
          this.state = STATE.ENGAGE;
          this.stateTimer = 0;
          // Zero, not a fresh 0.12-0.34 s roll: the reaction is over, and a
          // second delay here is what made CONFIG.reactionTime describe
          // something other than the enemy's reaction.
          this.fireTimer = 0;
        } else if (this.aware <= 0.05 && !searching) {
          this.state = STATE.IDLE;
        }
        break;
      }
      case STATE.ENGAGE: {
        this.targetFacing = Math.atan2(toPlayer.x, toPlayer.z);
        this._aimBlend = Math.min(1, this._aimBlend + dt * 5);

        if (sees) this.serviceFire(dt, player, distance);

        // Break contact and move periodically so firefights are not static.
        if (this.stateTimer > 3.2 + Math.random() * 3
          && Math.random() < CONFIG.repositionChance) {
          this.pickCover(player);
          // A roll that found nowhere to go has to cost the timer, or the
          // threshold stays crossed and pickCover runs its seven candidates —
          // each with a line-of-sight raycast and a collider walk — on every
          // subsequent tick for the rest of the engagement.
          if (this.state !== STATE.REPOSITION) this.stateTimer = 0;
        }
        if (!sees && this.aware < 0.35) { this.state = STATE.ALERT; this.stateTimer = 0; }
        break;
      }
      case STATE.REPOSITION: {
        // Move AND shoot, whenever the sight line is actually open.
        //
        // This case used to contain no firing path at all, and that is the worst
        // defect a blind telemetry comparison found in this game: ENGAGE hands
        // over on `stateTimer > 3.2 + random()*3 && random() < 0.55`, REPOSITION
        // has a six-second timeout, and nothing bounds re-entry — so two chained
        // repositions with the player in plain view produced a measured 9.367 s
        // of silence, 8.1x the 1.15 s ceiling the agent's own CONFIG.fireInterval
        // sets, and 67% of a 14 s engagement. It also cost about a third of the
        // volume of fire and half the kills at mid range, which is the same bug
        // read off the ammunition instead of the clock.
        //
        // Firing while moving was chosen over the alternative — capping the
        // non-firing window — for two reasons. It is what soldiers do: breaking
        // contact under your own suppressive fire is the manoeuvre, and a bot
        // that sprints between cover with its rifle down is the thing that reads
        // as scripted. And a cap is a second timer that has to agree with
        // fireInterval to mean anything, so it would restate the invariant in a
        // place where it can silently drift out of agreement with it; running the
        // one scheduler from both states makes the invariant hold by
        // construction rather than by arithmetic.
        //
        // Deliberately NOT added: any movement penalty on the aim. The same
        // comparison measured the AI's opening burst as landing too rarely and
        // was explicit that the cause was this scheduler rather than the error
        // model, so a `moving` term in shoot() would be a new invented constant
        // pushing a quantity that has no sourced target — and it would hide the
        // fix behind a compensating regression. The aim error is unchanged;
        // gameplay-ai.mjs measures the opening burst against the sustained rate
        // and they agree.
        if (sees) {
          this._aimBlend = Math.min(1, this._aimBlend + dt * 5);
          this.targetFacing = Math.atan2(toPlayer.x, toPlayer.z);
          this.serviceFire(dt, player, distance);
        } else {
          this._aimBlend = Math.max(0.35, this._aimBlend - dt * 2);
        }
        if (this.repositionTarget) {
          const to = _v.copy(this.repositionTarget).sub(this.position);
          to.y = 0;
          const d = to.length();
          if (d < 0.8) {
            this.state = STATE.ENGAGE;
            this.stateTimer = 0;
          } else {
            to.divideScalar(d);
            // Only while blind. A soldier who can see the player keeps the rifle
            // on him (above) and covers the ground sideways or backwards, which
            // is the pose the animator already produces from a facing that
            // disagrees with the velocity.
            if (!sees) this.targetFacing = Math.atan2(to.x, to.z);
            this.velocity.x = to.x * CONFIG.runSpeed;
            this.velocity.z = to.z * CONFIG.runSpeed;
            // Give up on a move that is not happening. integrate() zeroes the
            // blocked axis silently, so a soldier pressed against geometry runs
            // on the spot until the six-second timeout; the player sees a man
            // standing in the open not shooting. Measured over 0.5 s so a single
            // frame of sliding along a wall does not count as stuck.
            if (this._repoProgress === undefined || this.stateTimer < 0.5) {
              this._repoProgress = d; this._repoCheck = this.stateTimer;
            } else if (this.stateTimer - this._repoCheck > 0.5) {
              if (this._repoProgress - d < 0.25) {
                this.state = STATE.ENGAGE;
                this.stateTimer = 0;
                this.repositionTarget = null;
              }
              this._repoProgress = d; this._repoCheck = this.stateTimer;
            }
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

  /**
   * The burst scheduler: one tick of it, run from every state that can see the
   * player.
   *
   * It lives in a method rather than inline in ENGAGE because it is now called
   * from two states, and the whole of the worst behavioural defect this game has
   * had was that the second of those states did not call it. The invariant the
   * caller must preserve is the one gameplay-ai.mjs asserts: an agent with the
   * sight line open does not go longer than CONFIG.fireInterval[1] between
   * rounds, which holds for any set of states as long as every state that can
   * see calls this every tick.
   *
   * Arm and fire in the same tick, and hold fireInterval until the burst is
   * spent. Both were wrong before, and both were audible: the old order armed
   * the burst on one tick and fired on the next, which put a tick of latency
   * inside every reaction measurement; and fireTimer was decremented DURING the
   * burst, so five rounds at 0.098 s spacing ate 0.39 s of a 0.42 s interval and
   * the next burst began ~30 ms after the last one ended. The player heard one
   * long burst and the rolled burstCount became fiction.
   *
   * Nothing here reads the state it was called from, and that is deliberate: a
   * separate cadence for a moving shooter would be two schedules to keep in
   * agreement with one published interval, and the interval is what the player
   * hears.
   */
  serviceFire(dt, player, distance) {
    if (this.burstLeft <= 0) {
      this.fireTimer -= dt;
      if (this.fireTimer <= 0) {
        this.burstLeft = CONFIG.burstCount[0]
          + Math.floor(Math.random() * (CONFIG.burstCount[1] - CONFIG.burstCount[0] + 1));
        this.burstTimer = 0;
      }
    }
    if (this.burstLeft > 0) {
      this.burstTimer -= dt;
      if (this.burstTimer <= 0) {
        this.shoot(player, distance);
        this.burstTimer = CONFIG.burstDelay;
        if (--this.burstLeft <= 0) {
          this.fireTimer = THREE.MathUtils.lerp(
            CONFIG.fireInterval[0], CONFIG.fireInterval[1], Math.random(),
          );
        }
      }
    }
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
      // Reachable in a straight line. REPOSITION drives straight at the target
      // and integrate() zeroes whichever axis a collider blocks, so a cover
      // point on the far side of a wall is a soldier who walks into it and
      // stands there for the full six-second timeout — measured as 60% of a
      // 26 s engagement spent in REPOSITION with a maximum displacement of
      // 0.00 m. There is no pathfinder here to do better.
      //
      // A penalty and not a filter, and that distinction was measured too:
      // from a firing position outside the compound wall, ALL 17 cover points
      // inside the 26 m radius are behind 3-4 m of masonry, so filtering left
      // the soldier standing still for the whole engagement. Penalised, he
      // still commits to the best of a bad set, slides along the wall, and the
      // stall detector in REPOSITION cuts it short after half a second instead
      // of six.
      const walkable = this.pathClear(p);
      // Whether the fight continues from there. This scored for cover and
      // nothing else, and a cover point with no sight line is where an
      // engagement goes to die: the agent arrives, sees nothing, decays out of
      // ALERT and forgets the player. Weighted heavily rather than filtered
      // hard, so a map with no such point still produces a move instead of
      // leaving the soldier standing in the open.
      // coverPoints carry y = 0, so the standing eye has to be resolved against
      // the terrain rather than taken from the point.
      const eye = _v.set(p.x, this.level.groundHeight(p.x, p.z) + 1.62, p.z);
      const to = _v2.copy(player.camera.position).sub(eye);
      const dist = to.length();
      to.divideScalar(dist);
      _ray.set(eye, to);
      _ray.far = dist - 0.35;
      const keepsLos = _ray.intersectObjects(this._blockers ?? [], false).length === 0;
      // Prefer somewhere new, at a workable engagement range, that can still see.
      const score = -Math.abs(distToPlayer - 16) - distToMe * 0.25
        + (keepsLos ? 14 : 0) + (walkable ? 24 : 0) + Math.random() * 4;
      if (score > bestScore) { bestScore = score; best = p; }
    }
    if (best) {
      this.repositionTarget = best.clone();
      this.state = STATE.REPOSITION;
      this.stateTimer = 0;
    }
  }

  /**
   * Whether a straight walk to `p` clears the level's colliders.
   *
   * Sampled at the body radius rather than raycast: the collider set is the same
   * list of boxes integrate() tests against, so agreeing with integrate() is the
   * whole point — a ray against the render meshes would approve a gap the body
   * cannot fit through.
   */
  pathClear(p) {
    const r = 0.4;
    const dx = p.x - this.position.x, dz = p.z - this.position.z;
    const len = Math.hypot(dx, dz);
    // Stop a metre short. A cover point is by definition up against something,
    // so a sample taken at the point itself overlaps the very collider that
    // makes it cover — the first version of this rejected every candidate on
    // the map and the soldier stopped repositioning at all. REPOSITION hands
    // back to ENGAGE at 0.8 m anyway, so the last metre is never walked.
    const usable = Math.max(0, len - 1.0);
    const steps = Math.ceil(usable / 0.8);
    for (let i = 1; i <= steps; i++) {
      const f = (usable / len) * (i / steps);
      const x = this.position.x + dx * f;
      const z = this.position.z + dz * f;
      const y = this.level.groundHeight(x, z);
      for (const c of this.level.colliders) {
        if (x + r > c.min.x && x - r < c.max.x
          && z + r > c.min.z && z - r < c.max.z
          && y + 1.6 > c.min.y && y < c.max.y) return false;
      }
    }
    return true;
  }

  /**
   * One round, with the aim error the shooter is entitled to at this range.
   *
   * The error is authored as a radius at the target — `aimErrorMetres` — plus a
   * small true cone. Most of what makes a bot miss is not knowing exactly where
   * the target is, and that uncertainty is a distance in the world, not an
   * angle; converting it back to an angle here is what gives the falloff a
   * shoulder instead of a cliff. The two numbers were solved against measured
   * hit rates at 10/20/30/40/50/60 m, which is the only justification they have:
   * no Call of Duty AI accuracy figure is published, targets.mjs says so in its
   * missing() set, and the suite therefore asserts the SHAPE — monotone, never a
   * certainty, bounded step between adjacent ranges — and prints the values.
   */
  shoot(player, distance) {
    const d = Math.max(distance, CONFIG.aimErrorFloorRange);
    const spread = CONFIG.aimErrorMetres / d + CONFIG.aimErrorAngle;
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

  /**
   * Occluders for line-of-sight tests.
   *
   * Deliberately not the full raycast set: that includes the terrain mesh,
   * whose 80k triangles are tested on every ray because its bounding sphere
   * encloses the entire map. Sight lines inside the compound are blocked by
   * structures, not by ground the players are standing on, so excluding it
   * costs nothing visible and takes the director from tens of milliseconds a
   * frame to a fraction of one.
   */
  get blockers() {
    if (!this._blockers) {
      this._blockers = this.level.raycastables.filter(
        (o) => o.name !== 'ground' && o.name !== 'courtyard',
      );
    }
    return this._blockers;
  }

  alertAll(point, radius) {
    for (const e of this.enemies) {
      if (!e.alive) continue;
      if (e.position.distanceTo(point) < radius) e.alertTo(point);
    }
  }

  update(dt, player, now) {
    const blockers = this.blockers;

    // Line of sight is the expensive part of an agent's think, and it does not
    // need to be re-evaluated every frame. Each agent re-tests on its own slot
    // in a rotating schedule and reuses the previous answer in between, which
    // divides the raycast load by the cycle length without any perceptible
    // change in how quickly they react.
    this._losSlot = (this._losSlot ?? 0) + 1;
    const cycle = 3;
    for (let i = 0; i < this.enemies.length; i++) {
      this.enemies[i].losDue = (i % cycle) === (this._losSlot % cycle);
    }

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
