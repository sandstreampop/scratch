// First-person weapon: an M4A1-pattern carbine, built from primitives.
//
// The viewmodel lives in its own scene rendered with a cleared depth buffer
// and a narrower FOV than the world camera. That is the standard solution to
// the two problems a camera-parented weapon always has — clipping through
// geometry, and the barrel-distortion you get when a 0.4 m object is rendered
// through an 80-degree lens.
//
// Pose is composed additively: base -> stance (hip/ads/sprint) -> bob -> sway
// -> recoil spring -> reload track. Each layer is independent, so any one can
// be retimed without breaking the others.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { material } from './textures.js';

const TAU = Math.PI * 2;

export const SPEC = {
  name: 'M4A1',
  magSize: 30,
  reserve: 180,
  rpm: 780,
  damage: 34,
  headshotMultiplier: 2.4,
  range: 220,
  falloffStart: 45,
  falloffEnd: 150,
  falloffScale: 0.55,

  // Cone half-angle in radians at rest and at full bloom.
  spreadHip: 0.0165,
  spreadAds: 0.0011,
  spreadMoving: 0.019,
  spreadPerShot: 0.0022,
  spreadMax: 0.045,
  spreadRecover: 0.075,

  recoilPitch: 0.0135,
  recoilYaw: 0.0042,
  recoilKick: 0.026,
  reloadTime: 2.18,
  reloadEmptyTime: 2.74,
  adsTime: 0.19,
};

/* ------------------------------------------------------------- materials -- */

function reticleTexture() {
  const s = 256;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  g.clearRect(0, 0, s, s);
  const cx = s / 2, cy = s / 2;

  // Soft bloom halo behind the dot — this is what sells an illuminated optic.
  const glow = g.createRadialGradient(cx, cy, 0, cx, cy, s * 0.30);
  glow.addColorStop(0.00, 'rgba(255, 60, 40, 0.85)');
  glow.addColorStop(0.16, 'rgba(255, 46, 28, 0.30)');
  glow.addColorStop(0.45, 'rgba(255, 40, 24, 0.06)');
  glow.addColorStop(1.00, 'rgba(255, 40, 24, 0.00)');
  g.fillStyle = glow;
  g.fillRect(0, 0, s, s);

  const core = g.createRadialGradient(cx, cy, 0, cx, cy, s * 0.052);
  core.addColorStop(0.0, 'rgba(255, 236, 230, 1.0)');
  core.addColorStop(0.30, 'rgba(255, 96, 60, 1.0)');
  core.addColorStop(1.0, 'rgba(255, 40, 24, 0.0)');
  g.fillStyle = core;
  g.beginPath();
  g.arc(cx, cy, s * 0.055, 0, TAU);
  g.fill();

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/* ------------------------------------------------------------ the model -- */

function buildCarbine() {
  const root = new THREE.Group();
  root.name = 'carbine';

  const steel = material('gunmetal', [2, 2]);
  const steelFine = material('gunmetal', [4, 4], { roughness: 0.42, metalness: 1 });
  const poly = material('polymer', [3, 3]);
  const polyGrip = material('polymer', [6, 6], { roughness: 0.74 });
  const black = new THREE.MeshStandardMaterial({ color: 0x0a0a0b, roughness: 0.55, metalness: 0.85 });
  const anodised = new THREE.MeshStandardMaterial({ color: 0x121316, roughness: 0.38, metalness: 1.0 });

  const part = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    m.castShadow = true;
    m.receiveShadow = true;
    root.add(m);
    return m;
  };
  const rbox = (w, h, d, r = 0.003) => new RoundedBoxGeometry(w, h, d, 2, Math.min(r, Math.min(w, h, d) * 0.32));
  const cyl = (rt, rb, h, seg = 20) => new THREE.CylinderGeometry(rt, rb, h, seg);

  // ---- upper receiver ------------------------------------------------------
  part(rbox(0.052, 0.050, 0.200, 0.006), anodised, 0, 0.006, -0.030);
  // Carry-handle-less flat-top with a full-length picatinny rail.
  const railBase = part(rbox(0.040, 0.008, 0.208, 0.001), anodised, 0, 0.035, -0.030);
  for (let i = 0; i < 17; i++) {
    part(rbox(0.038, 0.0075, 0.0062, 0.0008), anodised, 0, 0.0425, -0.128 + i * 0.0122);
  }
  // Ejection port, brass deflector, forward assist.
  part(rbox(0.006, 0.026, 0.052, 0.002), black, 0.0275, 0.010, -0.010);
  part(new THREE.SphereGeometry(0.013, 12, 10), anodised, 0.026, 0.020, 0.018).scale.set(1, 0.7, 1.5);
  part(cyl(0.008, 0.008, 0.020, 12), anodised, 0.028, -0.002, 0.026, 0, 0, Math.PI / 2);

  // ---- handguard -----------------------------------------------------------
  // Slim free-float tube with M-LOK cutouts and a top rail continuation.
  const hg = part(cyl(0.0245, 0.0255, 0.230, 14), poly, 0, 0.006, -0.245);
  hg.rotation.x = Math.PI / 2;
  for (let i = 0; i < 15; i++) {
    part(rbox(0.036, 0.0075, 0.0062, 0.0008), anodised, 0, 0.0325, -0.148 - i * 0.0122);
  }
  // M-LOK slots at 3, 6 and 9 o'clock.
  for (const ang of [0, Math.PI / 2, Math.PI]) {
    for (let i = 0; i < 6; i++) {
      const z = -0.170 - i * 0.031;
      const m = part(rbox(0.010, 0.0075, 0.021, 0.002), black,
        Math.cos(ang + Math.PI / 2) * 0.0235, 0.006 + Math.sin(ang + Math.PI / 2) * 0.0235, z);
      m.rotation.z = ang + Math.PI / 2;
    }
  }
  // Handstop and a short angled foregrip.
  part(rbox(0.026, 0.030, 0.040, 0.004), polyGrip, 0, -0.026, -0.268, 0.42);

  // ---- barrel, gas block, muzzle ------------------------------------------
  const barrel = part(cyl(0.0088, 0.0100, 0.170, 16), steelFine, 0, 0.006, -0.415);
  barrel.rotation.x = Math.PI / 2;
  // Barrel nut / gas block.
  const gb = part(rbox(0.024, 0.026, 0.030, 0.003), steel, 0, 0.008, -0.372);
  const gasTube = part(cyl(0.0032, 0.0032, 0.185, 8), steelFine, 0, 0.021, -0.290);
  gasTube.rotation.x = Math.PI / 2;

  // A2-pattern birdcage.
  const muzzle = part(cyl(0.0132, 0.0132, 0.052, 18), steel, 0, 0.006, -0.500);
  muzzle.rotation.x = Math.PI / 2;
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI * 0.42 + (i / 4) * Math.PI * 0.84;
    const slot = part(rbox(0.0055, 0.010, 0.026, 0.001), black,
      Math.sin(a) * 0.0118, 0.006 + Math.cos(a) * 0.0118, -0.502);
    slot.rotation.z = -a;
  }
  part(cyl(0.0136, 0.0136, 0.008, 18), steel, 0, 0.006, -0.478, Math.PI / 2);
  // Crown / bore.
  part(cyl(0.0058, 0.0058, 0.012, 14), new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 0.9 }),
    0, 0.006, -0.522, Math.PI / 2);

  // ---- lower receiver, magwell, magazine ----------------------------------
  part(rbox(0.044, 0.046, 0.150, 0.005), anodised, 0, -0.032, -0.010);
  // Magwell flare.
  const well = part(rbox(0.036, 0.052, 0.080, 0.004), anodised, 0, -0.062, -0.045);
  // STANAG magazine — three tapered segments approximate the curve.
  const magMat = material('polymer', [2, 4], { roughness: 0.62, color: 0x2a2c26 });
  const magSegs = 4;
  const magGroup = new THREE.Group();
  for (let i = 0; i < magSegs; i++) {
    const t = i / (magSegs - 1);
    const y = -0.092 - t * 0.116;
    const z = -0.045 + Math.pow(t, 1.5) * 0.030;                    // curve toward the rear
    const seg = new THREE.Mesh(rbox(0.030, 0.042, 0.070 - t * 0.004, 0.004), magMat);
    seg.position.set(0, y, z);
    seg.rotation.x = -t * 0.22;
    seg.castShadow = true; seg.receiveShadow = true;
    magGroup.add(seg);
  }
  // Baseplate.
  const plate = new THREE.Mesh(rbox(0.034, 0.010, 0.074, 0.002), magMat);
  plate.position.set(0, -0.212, -0.008);
  plate.rotation.x = -0.22;
  plate.castShadow = true;
  magGroup.add(plate);
  root.add(magGroup);

  // Trigger group.
  part(rbox(0.020, 0.026, 0.040, 0.006), anodised, 0, -0.056, 0.030);
  const guard = new THREE.Mesh(new THREE.TorusGeometry(0.019, 0.0035, 8, 20, Math.PI * 1.25), anodised);
  guard.position.set(0, -0.062, 0.034);
  guard.rotation.set(0, Math.PI / 2, -0.4);
  guard.castShadow = true;
  root.add(guard);
  part(rbox(0.006, 0.020, 0.006, 0.002), steelFine, 0, -0.060, 0.030, 0.25);
  // Magazine release and selector.
  part(cyl(0.005, 0.005, 0.010, 10), anodised, 0.024, -0.030, -0.006, 0, 0, Math.PI / 2);
  part(cyl(0.006, 0.006, 0.016, 10), anodised, 0.023, -0.030, 0.030, 0, 0, Math.PI / 2);

  // ---- pistol grip ---------------------------------------------------------
  const grip = part(rbox(0.030, 0.098, 0.042, 0.008), polyGrip, 0, -0.088, 0.062, 0.28);
  part(rbox(0.032, 0.016, 0.038, 0.006), polyGrip, 0, -0.135, 0.076, 0.28);

  // ---- buffer tube and stock ----------------------------------------------
  const tube = part(cyl(0.0165, 0.0165, 0.170, 16), anodised, 0, 0.002, 0.140);
  tube.rotation.x = Math.PI / 2;
  for (let i = 0; i < 6; i++) {
    part(new THREE.TorusGeometry(0.0172, 0.0018, 6, 18), anodised, 0, 0.002, 0.085 + i * 0.021, Math.PI / 2);
  }
  // Collapsible stock body.
  part(rbox(0.044, 0.062, 0.062, 0.008), poly, 0, -0.006, 0.145);
  part(rbox(0.050, 0.086, 0.026, 0.008), poly, 0, -0.010, 0.196);          // butt pad face
  part(rbox(0.052, 0.090, 0.012, 0.004),
    new THREE.MeshStandardMaterial({ color: 0x08090a, roughness: 0.92 }), 0, -0.010, 0.210);
  // Cheek weld ridge and sling loop.
  part(rbox(0.036, 0.014, 0.070, 0.005), poly, 0, 0.026, 0.150);
  const loop = new THREE.Mesh(new THREE.TorusGeometry(0.010, 0.0025, 6, 14), anodised);
  loop.position.set(0.024, -0.020, 0.176);
  loop.rotation.y = Math.PI / 2;
  root.add(loop);

  // ---- charging handle -----------------------------------------------------
  part(rbox(0.052, 0.010, 0.014, 0.002), anodised, 0, 0.024, 0.070);
  part(rbox(0.014, 0.012, 0.044, 0.002), anodised, -0.022, 0.024, 0.056);

  // ---- optic: red dot on a cantilever mount -------------------------------
  const optic = new THREE.Group();
  optic.position.set(0, 0.0465, -0.052);
  root.add(optic);

  const mount = new THREE.Mesh(rbox(0.030, 0.016, 0.062, 0.003), anodised);
  mount.position.set(0, 0.008, 0.004);
  mount.castShadow = true; mount.receiveShadow = true;
  optic.add(mount);
  for (const z of [-0.020, 0.022]) {
    const screw = new THREE.Mesh(cyl(0.0035, 0.0035, 0.034, 8), steelFine);
    screw.position.set(0.016, 0.006, z);
    screw.rotation.z = Math.PI / 2;
    optic.add(screw);
  }

  // Housing: a squared tube open front and back.
  const housing = new THREE.Group();
  housing.position.set(0, 0.030, 0);
  optic.add(housing);
  const wall = (w, h, d, x, y, z) => {
    const m = new THREE.Mesh(rbox(w, h, d, 0.002), anodised);
    m.position.set(x, y, z);
    m.castShadow = true; m.receiveShadow = true;
    housing.add(m);
    return m;
  };
  wall(0.034, 0.006, 0.060, 0, 0.019, 0);          // top
  wall(0.034, 0.006, 0.060, 0, -0.019, 0);         // bottom
  wall(0.006, 0.044, 0.060, -0.014, 0, 0);         // left
  wall(0.006, 0.044, 0.060, 0.014, 0, 0);          // right
  // Adjustment turrets.
  const turret = new THREE.Mesh(cyl(0.0058, 0.0062, 0.010, 12), anodised);
  turret.position.set(0.017, 0.006, 0.014);
  turret.rotation.z = Math.PI / 2;
  housing.add(turret);
  const turret2 = new THREE.Mesh(cyl(0.0058, 0.0062, 0.010, 12), anodised);
  turret2.position.set(0, 0.024, 0.014);
  housing.add(turret2);

  // Objective lens — tinted, glossy, and slightly transmissive so the world
  // reads faintly through it even at hip.
  const lensGeo = new THREE.CircleGeometry(0.0128, 32);
  const lensMat = new THREE.MeshPhysicalMaterial({
    color: 0x0d1b24,
    roughness: 0.045,
    metalness: 0.0,
    transmission: 0.72,
    thickness: 0.004,
    ior: 1.52,
    iridescence: 0.55,
    iridescenceIOR: 1.9,
    iridescenceThicknessRange: [180, 460],
    transparent: true,
    opacity: 0.94,
    side: THREE.DoubleSide,
  });
  const lensFront = new THREE.Mesh(lensGeo, lensMat);
  lensFront.position.set(0, 0, -0.028);
  housing.add(lensFront);
  const lensRear = new THREE.Mesh(lensGeo, lensMat.clone());
  lensRear.position.set(0, 0, 0.028);
  housing.add(lensRear);

  // Reticle: additive, depth-tested off so it always floats in the tube.
  const reticle = new THREE.Mesh(
    new THREE.PlaneGeometry(0.023, 0.023),
    new THREE.MeshBasicMaterial({
      map: reticleTexture(),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
      opacity: 1,
    }),
  );
  reticle.position.set(0, 0, -0.0255);
  reticle.renderOrder = 40;
  housing.add(reticle);

  // ---- anchors -------------------------------------------------------------
  const muzzleAnchor = new THREE.Object3D();
  muzzleAnchor.position.set(0, 0.006, -0.532);
  root.add(muzzleAnchor);

  const ejectAnchor = new THREE.Object3D();
  ejectAnchor.position.set(0.032, 0.012, -0.008);
  root.add(ejectAnchor);

  // Where the sightline must land when aiming.
  const sightAnchor = new THREE.Object3D();
  sightAnchor.position.set(0, 0.0765, -0.052);
  root.add(sightAnchor);

  return { root, muzzleAnchor, ejectAnchor, sightAnchor, reticle, magGroup, lensMat };
}

/* ------------------------------------------------------------- viewmodel -- */

export class Weapon {
  constructor(renderer, worldCamera, environment) {
    this.renderer = renderer;
    this.worldCamera = worldCamera;

    this.scene = new THREE.Scene();
    this.scene.environment = environment;
    this.scene.environmentIntensity = 1.0;

    this.camera = new THREE.PerspectiveCamera(
      worldCamera.fov * 0.70, worldCamera.aspect, 0.008, 8,
    );

    const built = buildCarbine();
    this.model = built.root;
    this.muzzleAnchor = built.muzzleAnchor;
    this.ejectAnchor = built.ejectAnchor;
    this.sightAnchor = built.sightAnchor;
    this.reticle = built.reticle;
    this.magGroup = built.magGroup;

    // Hands would normally be skinned; a pair of simple gloved forms reads
    // correctly at this framing and keeps the silhouette from floating.
    this.hands = buildHands();
    this.model.add(this.hands);

    this.rig = new THREE.Group();
    this.rig.add(this.model);
    this.scene.add(this.rig);

    this.setupLighting();

    // --- pose ---------------------------------------------------------------
    this.hipPosition = new THREE.Vector3(0.088, -0.082, -0.180);
    this.hipRotation = new THREE.Euler(0.012, 0.052, 0.014);
    // Aligning the sight to the optical axis: cancel the sight's local offset
    // and push the weapon forward so the eyebox sits just off the lens.
    const s = this.sightAnchor.position;
    this.adsPosition = new THREE.Vector3(-s.x, -s.y, -0.155);
    this.adsRotation = new THREE.Euler(0, 0, 0);
    this.sprintPosition = new THREE.Vector3(0.135, -0.145, -0.115);
    this.sprintRotation = new THREE.Euler(0.30, 0.78, -0.20);

    this.position = this.hipPosition.clone();
    this.rotation = this.hipRotation.clone();

    // --- state --------------------------------------------------------------
    this.ammo = SPEC.magSize;
    this.reserve = SPEC.reserve;
    this.spread = SPEC.spreadHip;
    this.lastShot = -99;
    this.reloading = false;
    this.reloadStart = 0;
    this.reloadDuration = 0;
    this.reloadWasEmpty = false;

    this._recoil = new THREE.Vector3();          // positional kick
    this._recoilVel = new THREE.Vector3();
    this._recoilRot = new THREE.Vector3();
    this._recoilRotVel = new THREE.Vector3();
    this._sway = new THREE.Vector2();
    this._swayVel = new THREE.Vector2();
    this._bobPhase = 0;
    this._breathe = 0;
    this._shotCount = 0;

    // --- muzzle flash --------------------------------------------------------
    this.flashLight = new THREE.PointLight(0xffcc88, 0, 9, 2);
    this.flashLight.castShadow = false;
    this.muzzleAnchor.add(this.flashLight);

    this.flashSprites = new THREE.Group();
    this.muzzleAnchor.add(this.flashSprites);
    const flashMat = new THREE.MeshBasicMaterial({
      map: flashTexture(),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      opacity: 0,
      side: THREE.DoubleSide,
    });
    this.flashMaterials = [];
    for (let i = 0; i < 3; i++) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(0.20, 0.20), flashMat.clone());
      m.rotation.z = (i / 3) * Math.PI;
      m.renderOrder = 30;
      this.flashSprites.add(m);
      this.flashMaterials.push(m.material);
    }
    // Forward-facing cone so the flash has volume when seen off-axis.
    this.flashCone = new THREE.Mesh(
      new THREE.ConeGeometry(0.035, 0.13, 12, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xffd9a0, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide,
      }),
    );
    this.flashCone.rotation.x = Math.PI / 2;
    this.flashCone.position.z = -0.05;
    this.muzzleAnchor.add(this.flashCone);
    this._flash = 0;

    this.onShot = null;
    this.onReloadEvent = null;
  }

  setupLighting() {
    // Matches the world key so the weapon reads as being in the same place,
    // with a tight fill that keeps the left side of the receiver off black.
    this.key = new THREE.DirectionalLight(0xffd0a0, 3.1);
    this.key.position.set(0.6, 1.0, 0.35);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(1024, 1024);
    this.key.shadow.camera.near = 0.05;
    this.key.shadow.camera.far = 3;
    this.key.shadow.camera.left = -0.6;
    this.key.shadow.camera.right = 0.6;
    this.key.shadow.camera.top = 0.6;
    this.key.shadow.camera.bottom = -0.6;
    this.key.shadow.bias = -0.0009;
    this.key.shadow.normalBias = 0.004;
    this.scene.add(this.key);
    this.scene.add(this.key.target);

    this.fill = new THREE.DirectionalLight(0x9dbede, 0.55);
    this.fill.position.set(-0.8, 0.2, 0.6);
    this.scene.add(this.fill);

    this.rim = new THREE.DirectionalLight(0xffb066, 1.15);
    this.rim.position.set(-0.3, 0.4, -1.0);
    this.scene.add(this.rim);
  }

  /** Aligns the viewmodel key light with the world sun as the player turns. */
  syncLighting(sunDirection, worldCamera) {
    const local = sunDirection.clone().applyQuaternion(worldCamera.quaternion.clone().invert());
    this.key.position.copy(local).multiplyScalar(2).add(new THREE.Vector3(0, 0.2, 0));
    this.key.target.position.set(0, -0.05, -0.2);
    this.key.target.updateMatrixWorld();
    this.rim.position.copy(local).multiplyScalar(-2);
  }

  /* --------------------------------------------------------------- fire -- */

  get canFire() {
    return !this.reloading && this.ammo > 0
      && (performance.now() / 1000 - this.lastShot) >= 60 / SPEC.rpm;
  }

  fire(now, player) {
    if (!this.canFire) return null;
    this.lastShot = now;
    this.ammo--;
    this._shotCount++;

    // Recoil grows for the first several rounds then plateaus — the classic
    // controllable-then-punishing curve.
    const ramp = Math.min(1, 0.45 + this._shotCount * 0.075);
    const adsScale = THREE.MathUtils.lerp(1, 0.66, player.ads);

    // Camera kick.
    const yawSign = Math.sin(this._shotCount * 2.399) ;
    player.addRecoil(
      SPEC.recoilPitch * ramp * adsScale * 42,
      SPEC.recoilYaw * ramp * adsScale * yawSign * 42,
    );

    // Viewmodel kick.
    this._recoilVel.z += SPEC.recoilKick * ramp * adsScale * 46;
    this._recoilVel.y += 0.006 * ramp * adsScale * 46;
    this._recoilVel.x += yawSign * 0.0035 * ramp * adsScale * 46;
    this._recoilRotVel.x -= 0.055 * ramp * adsScale * 42;
    this._recoilRotVel.z += yawSign * 0.022 * ramp * adsScale * 42;

    this.spread = Math.min(SPEC.spreadMax, this.spread + SPEC.spreadPerShot);
    this._flash = 1;

    return {
      spread: this.currentSpread(player),
      damage: SPEC.damage,
    };
  }

  currentSpread(player) {
    const base = THREE.MathUtils.lerp(SPEC.spreadHip, SPEC.spreadAds, player.ads);
    const motion = THREE.MathUtils.clamp(player.speedHorizontal / 6, 0, 1)
      * SPEC.spreadMoving * (1 - player.ads * 0.7);
    const air = player.onGround ? 0 : 0.022;
    const crouch = player.crouching ? -base * 0.28 : 0;
    return Math.max(0.0004, base + motion + air + crouch + (this.spread - SPEC.spreadHip));
  }

  startReload(now) {
    if (this.reloading || this.ammo >= SPEC.magSize || this.reserve <= 0) return false;
    this.reloading = true;
    this.reloadWasEmpty = this.ammo === 0;
    this.reloadStart = now;
    this.reloadDuration = this.reloadWasEmpty ? SPEC.reloadEmptyTime : SPEC.reloadTime;
    this._reloadStage = 0;
    return true;
  }

  /* ------------------------------------------------------------- update -- */

  update(dt, now, player, input) {
    // --- reload track --------------------------------------------------------
    let magOffset = new THREE.Vector3();
    let magRot = 0;
    if (this.reloading) {
      const t = (now - this.reloadStart) / this.reloadDuration;
      if (t >= 1) {
        const need = SPEC.magSize - this.ammo;
        const take = Math.min(need, this.reserve);
        this.ammo += take;
        this.reserve -= take;
        this.reloading = false;
      } else {
        // 0.00-0.22 mag release, 0.22-0.42 drop, 0.42-0.72 insert,
        // 0.72-0.86 seat, 0.86-1.0 bolt release (empty reload only).
        if (t < 0.42) {
          const k = THREE.MathUtils.smoothstep(t, 0.06, 0.42);
          magOffset.y = -k * 0.34;
          magRot = k * 0.5;
          if (this._reloadStage === 0 && t > 0.08) { this._reloadStage = 1; this.onReloadEvent?.('release'); }
        } else if (t < 0.76) {
          const k = 1 - THREE.MathUtils.smoothstep(t, 0.42, 0.72);
          magOffset.y = -k * 0.30;
          magOffset.z = k * 0.05;
          magRot = k * 0.4;
          if (this._reloadStage === 1 && t > 0.50) { this._reloadStage = 2; this.onReloadEvent?.('insert'); }
        } else {
          magOffset.set(0, 0, 0);
          if (this._reloadStage === 2 && t > 0.80) { this._reloadStage = 3; this.onReloadEvent?.('seat'); }
        }
        // Whole-weapon reload motion: tilt in toward the body and dip.
        const swing = Math.sin(THREE.MathUtils.clamp(t, 0, 1) * Math.PI);
        this._reloadPose = {
          pos: new THREE.Vector3(0.030 * swing, -0.075 * swing, 0.035 * swing),
          rot: new THREE.Vector3(0.22 * swing, -0.34 * swing, 0.30 * swing),
        };
      }
    }
    if (!this.reloading) this._reloadPose = null;
    this.magGroup.position.copy(magOffset);
    this.magGroup.rotation.x = magRot;

    // --- stance blend --------------------------------------------------------
    const sprintBlend = player.sprinting ? 1 : 0;
    this._sprint = THREE.MathUtils.damp(this._sprint ?? 0, this.reloading ? 0 : sprintBlend, 11, dt);

    const targetPos = new THREE.Vector3();
    const targetRot = new THREE.Vector3();
    targetPos.copy(this.hipPosition).lerp(this.adsPosition, player.ads);
    targetRot.set(this.hipRotation.x, this.hipRotation.y, this.hipRotation.z)
      .lerp(new THREE.Vector3(this.adsRotation.x, this.adsRotation.y, this.adsRotation.z), player.ads);
    targetPos.lerp(this.sprintPosition, this._sprint);
    targetRot.lerp(new THREE.Vector3(this.sprintRotation.x, this.sprintRotation.y, this.sprintRotation.z), this._sprint);

    if (this._reloadPose) {
      targetPos.add(this._reloadPose.pos);
      targetRot.add(this._reloadPose.rot);
    }

    // --- bob ------------------------------------------------------------------
    const speed = player.speedHorizontal;
    const moving = player.onGround && speed > 0.3;
    const cadence = player.sprinting ? 8.4 : player.crouching ? 4.2 : 6.3;
    if (moving) this._bobPhase += dt * cadence;
    else this._bobPhase += dt * 1.0;

    const bobWeight = (moving ? THREE.MathUtils.clamp(speed / 4.5, 0, 1.5) : 0)
      * THREE.MathUtils.lerp(1, 0.22, player.ads);
    this._bobWeight = THREE.MathUtils.damp(this._bobWeight ?? 0, bobWeight, 7, dt);

    const bob = new THREE.Vector3(
      Math.cos(this._bobPhase) * 0.0125 * this._bobWeight,
      Math.sin(this._bobPhase * 2) * 0.0092 * this._bobWeight - this._bobWeight * 0.004,
      Math.sin(this._bobPhase * 2 + 0.6) * 0.0055 * this._bobWeight,
    );
    const bobRot = new THREE.Vector3(
      Math.sin(this._bobPhase * 2) * 0.011 * this._bobWeight,
      Math.cos(this._bobPhase) * 0.016 * this._bobWeight,
      Math.cos(this._bobPhase) * 0.020 * this._bobWeight,
    );

    // --- idle breathing -------------------------------------------------------
    this._breathe += dt;
    const breathAmp = THREE.MathUtils.lerp(1, 0.30, player.ads) * (1 - this._bobWeight * 0.6);
    bob.y += Math.sin(this._breathe * 1.35) * 0.0026 * breathAmp;
    bob.x += Math.sin(this._breathe * 0.83) * 0.0019 * breathAmp;
    bobRot.z += Math.sin(this._breathe * 0.71) * 0.007 * breathAmp;

    // --- look sway (weapon lags the camera) -----------------------------------
    const swayScale = THREE.MathUtils.lerp(0.024, 0.006, player.ads);
    const swayTargetX = THREE.MathUtils.clamp(-player.lookDelta.x * swayScale * 0.09, -0.055, 0.055);
    const swayTargetY = THREE.MathUtils.clamp(player.lookDelta.y * swayScale * 0.09, -0.055, 0.055);
    const sk = 62, sd = 12;
    this._swayVel.x += ((swayTargetX - this._sway.x) * sk - this._swayVel.x * sd) * dt;
    this._swayVel.y += ((swayTargetY - this._sway.y) * sk - this._swayVel.y * sd) * dt;
    this._sway.x += this._swayVel.x * dt;
    this._sway.y += this._swayVel.y * dt;

    // --- recoil springs --------------------------------------------------------
    const rk = 190, rd = 21;
    for (const axis of ['x', 'y', 'z']) {
      this._recoilVel[axis] += (-this._recoil[axis] * rk - this._recoilVel[axis] * rd) * dt;
      this._recoil[axis] += this._recoilVel[axis] * dt;
      this._recoilRotVel[axis] += (-this._recoilRot[axis] * rk * 0.85 - this._recoilRotVel[axis] * rd) * dt;
      this._recoilRot[axis] += this._recoilRotVel[axis] * dt;
    }

    // --- compose ---------------------------------------------------------------
    this.position.lerp(
      targetPos.clone().add(bob).add(this._recoil)
        .add(new THREE.Vector3(this._sway.x, this._sway.y, 0)),
      1 - Math.exp(-26 * dt),
    );
    const finalRot = targetRot.clone().add(bobRot).add(this._recoilRot)
      .add(new THREE.Vector3(this._sway.y * 1.6, -this._sway.x * 1.6, this._sway.x * 1.1));
    this.rotation.x = THREE.MathUtils.damp(this.rotation.x, finalRot.x, 26, dt);
    this.rotation.y = THREE.MathUtils.damp(this.rotation.y, finalRot.y, 26, dt);
    this.rotation.z = THREE.MathUtils.damp(this.rotation.z, finalRot.z, 26, dt);

    this.model.position.copy(this.position);
    this.model.rotation.copy(this.rotation);

    // --- spread recovery --------------------------------------------------------
    if (now - this.lastShot > 0.12) {
      this.spread = Math.max(SPEC.spreadHip, this.spread - SPEC.spreadRecover * dt);
      if (now - this.lastShot > 0.35) this._shotCount = Math.max(0, this._shotCount - dt * 22);
    }

    // --- muzzle flash decay -------------------------------------------------------
    this._flash = Math.max(0, this._flash - dt * 26);
    const f = this._flash;
    this.flashLight.intensity = f * f * 22;
    this.flashCone.material.opacity = f * 0.85;
    this.flashCone.scale.setScalar(0.7 + (1 - f) * 0.9);
    for (let i = 0; i < this.flashMaterials.length; i++) {
      this.flashMaterials[i].opacity = f * (0.9 - i * 0.16);
      this.flashSprites.children[i].scale.setScalar(0.55 + (1 - f) * 1.4 + i * 0.22);
      this.flashSprites.children[i].rotation.z += dt * (i % 2 ? 9 : -9);
    }
    this.flashSprites.visible = f > 0.001;
    this.flashCone.visible = f > 0.001;

    // Reticle dims when not aiming — an unmagnified dot is barely visible
    // off-eyebox in reality, and hiding it keeps the HUD crosshair readable.
    this.reticle.material.opacity = THREE.MathUtils.lerp(0.28, 1.0, player.ads);

    this.camera.fov = this.worldCamera.fov * THREE.MathUtils.lerp(0.70, 0.60, player.ads);
    this.camera.aspect = this.worldCamera.aspect;
    this.camera.updateProjectionMatrix();
  }

  /** World-space muzzle position, for tracers and impact sounds. */
  muzzleWorldPosition(target = new THREE.Vector3()) {
    this.muzzleAnchor.updateWorldMatrix(true, false);
    return target.setFromMatrixPosition(this.muzzleAnchor.matrixWorld);
  }

  ejectWorldPosition(target = new THREE.Vector3()) {
    this.ejectAnchor.updateWorldMatrix(true, false);
    return target.setFromMatrixPosition(this.ejectAnchor.matrixWorld);
  }
}

/* ---------------------------------------------------------------- hands -- */

function buildHands() {
  const g = new THREE.Group();
  const glove = new THREE.MeshStandardMaterial({ color: 0x312c26, roughness: 0.88, metalness: 0.0 });
  const skin = new THREE.MeshStandardMaterial({ color: 0x8c6247, roughness: 0.72, metalness: 0.0 });

  const finger = (parent, x, y, z, len, rot, mat) => {
    const f = new THREE.Mesh(new RoundedBoxGeometry(0.017, 0.017, len, 2, 0.007), mat);
    f.position.set(x, y, z);
    f.rotation.set(rot, 0, 0);
    f.castShadow = true; f.receiveShadow = true;
    parent.add(f);
    return f;
  };

  // Firing hand wrapped around the pistol grip.
  const right = new THREE.Group();
  right.position.set(0.006, -0.098, 0.062);
  right.rotation.set(0.28, 0, 0);
  const rPalm = new THREE.Mesh(new RoundedBoxGeometry(0.042, 0.088, 0.052, 3, 0.016), glove);
  rPalm.position.set(0.016, 0.004, 0.006);
  rPalm.castShadow = true; rPalm.receiveShadow = true;
  right.add(rPalm);
  for (let i = 0; i < 3; i++) finger(right, -0.010, 0.022 - i * 0.024, -0.020, 0.040, -0.5, glove);
  finger(right, 0.004, 0.040, -0.014, 0.036, -0.9, glove);          // trigger finger
  g.add(right);

  // Support hand on the handguard.
  const left = new THREE.Group();
  left.position.set(-0.010, -0.026, -0.268);
  left.rotation.set(0.30, 0.16, -0.55);
  const lPalm = new THREE.Mesh(new RoundedBoxGeometry(0.046, 0.038, 0.076, 3, 0.016), glove);
  lPalm.castShadow = true; lPalm.receiveShadow = true;
  left.add(lPalm);
  for (let i = 0; i < 4; i++) {
    const f = finger(left, 0.020, 0.006, -0.026 + i * 0.021, 0.044, 0, glove);
    f.rotation.set(0, 0, -1.15 - i * 0.05);
    f.position.set(0.016 + i * 0.0008, -0.014, -0.026 + i * 0.021);
  }
  const thumb = finger(left, -0.020, 0.008, -0.012, 0.038, 0, glove);
  thumb.rotation.set(0.2, 0, 0.9);
  g.add(left);

  // Cuffs — a hard edge where the glove meets the sleeve stops the hands
  // from reading as floating blobs at the bottom of frame.
  const cuffMat = new THREE.MeshStandardMaterial({ color: 0x4a4437, roughness: 0.93 });
  const rCuff = new THREE.Mesh(new THREE.CylinderGeometry(0.030, 0.034, 0.075, 14), cuffMat);
  rCuff.position.set(0.024, -0.150, 0.098);
  rCuff.rotation.set(0.85, 0, 0.18);
  rCuff.castShadow = true;
  g.add(rCuff);
  const lCuff = new THREE.Mesh(new THREE.CylinderGeometry(0.030, 0.036, 0.085, 14), cuffMat);
  lCuff.position.set(-0.056, -0.078, -0.252);
  lCuff.rotation.set(0.42, 0.2, -1.02);
  lCuff.castShadow = true;
  g.add(lCuff);

  return g;
}

/* --------------------------------------------------------- flash texture -- */

function flashTexture() {
  const s = 256;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  const cx = s / 2, cy = s / 2;

  const core = g.createRadialGradient(cx, cy, 0, cx, cy, s * 0.5);
  core.addColorStop(0.00, 'rgba(255,255,244,1.00)');
  core.addColorStop(0.10, 'rgba(255,238,190,0.92)');
  core.addColorStop(0.26, 'rgba(255,180,86,0.55)');
  core.addColorStop(0.52, 'rgba(226,110,32,0.16)');
  core.addColorStop(1.00, 'rgba(180,70,16,0.00)');
  g.fillStyle = core;
  g.fillRect(0, 0, s, s);

  // Irregular star petals — a plain radial blob reads as a bug light.
  g.globalCompositeOperation = 'lighter';
  const petals = 9;
  for (let i = 0; i < petals; i++) {
    const a = (i / petals) * TAU + 0.31;
    const len = s * (0.24 + ((i * 37) % 11) / 11 * 0.24);
    const wid = s * 0.030;
    g.save();
    g.translate(cx, cy);
    g.rotate(a);
    const grad = g.createLinearGradient(0, 0, len, 0);
    grad.addColorStop(0, 'rgba(255,244,214,0.85)');
    grad.addColorStop(0.4, 'rgba(255,178,84,0.30)');
    grad.addColorStop(1, 'rgba(255,140,50,0.0)');
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(0, -wid);
    g.lineTo(len, 0);
    g.lineTo(0, wid);
    g.closePath();
    g.fill();
    g.restore();
  }

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}
