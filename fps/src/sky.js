// Atmosphere, key lighting and image-based lighting.
//
// A Preetham analytic sky drives everything: it is rendered to a cube target
// once, convolved through PMREM into scene.environment (so every PBR surface
// gets correct sky/ground irradiance and specular), and its sun direction is
// shared with the directional key light and the god-ray pass.

import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

/** 0547 hrs: sun just clear of the ridgeline, heavy dust in the air. */
export const PRESET = {
  elevation: 3.6,          // degrees above horizon
  azimuth: 104,            // degrees, clockwise from north
  turbidity: 7.4,          // dust load
  rayleigh: 2.15,
  mieCoefficient: 0.0068,
  mieDirectionalG: 0.86,
  exposure: 0.82,
  sunColor: 0xffc389,      // warm dawn key
  sunIntensity: 5.6,
  skyColor: 0x8fb6dd,      // zenith bounce
  groundColor: 0x6b5535,   // sand bounce
  hemiIntensity: 0.55,
  fogColor: 0xcfb392,
  fogDensity: 0.0072,
};

export class Atmosphere {
  constructor(renderer, scene, options = {}) {
    this.settings = { ...PRESET, ...options };
    this.scene = scene;
    this.renderer = renderer;

    this.sky = new Sky();
    this.sky.scale.setScalar(45000);
    this.sky.frustumCulled = false;
    scene.add(this.sky);

    this.sunDirection = new THREE.Vector3();
    this.sunWorld = new THREE.Vector3();

    this.sun = new THREE.DirectionalLight(this.settings.sunColor, this.settings.sunIntensity);
    this.sun.castShadow = true;
    this.configureShadows(4096);
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.hemi = new THREE.HemisphereLight(
      this.settings.skyColor, this.settings.groundColor, this.settings.hemiIntensity,
    );
    scene.add(this.hemi);

    // Warm bounce from the sunlit sand back into shadowed faces. Sand is a
    // strong diffuse reflector at grazing dawn angles and this is the single
    // biggest thing separating a flat render from a shot film plate.
    this.bounce = new THREE.DirectionalLight(0xffb877, 0.55);
    this.bounce.castShadow = false;
    scene.add(this.bounce);
    scene.add(this.bounce.target);

    scene.fog = new THREE.FogExp2(this.settings.fogColor, this.settings.fogDensity);

    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmrem.compileEquirectangularShader();

    this.apply();
  }

  configureShadows(size) {
    const s = this.sun.shadow;
    s.mapSize.set(size, size);
    s.camera.near = 0.5;
    s.camera.far = 260;
    s.camera.left = -62;
    s.camera.right = 62;
    s.camera.top = 62;
    s.camera.bottom = -62;
    // Long dawn shadows graze the ground, so normal-bias does the heavy
    // lifting; a large constant bias would detach contact shadows entirely.
    s.bias = -0.00016;
    s.normalBias = 0.028;
    s.blurSamples = 16;
    s.radius = 2.4;
    s.camera.updateProjectionMatrix();
  }

  /** Pushes `settings` into the sky shader, lights, fog, and rebuilds the IBL. */
  apply() {
    const s = this.settings;
    const u = this.sky.material.uniforms;
    u.turbidity.value = s.turbidity;
    u.rayleigh.value = s.rayleigh;
    u.mieCoefficient.value = s.mieCoefficient;
    u.mieDirectionalG.value = s.mieDirectionalG;

    const phi = THREE.MathUtils.degToRad(90 - s.elevation);
    const theta = THREE.MathUtils.degToRad(s.azimuth);
    this.sunDirection.setFromSphericalCoords(1, phi, theta);
    u.sunPosition.value.copy(this.sunDirection);

    this.sunWorld.copy(this.sunDirection).multiplyScalar(400);
    this.sun.position.copy(this.sunWorld);
    this.sun.target.position.set(0, 0, 0);
    this.sun.color.set(s.sunColor);
    this.sun.intensity = s.sunIntensity;

    // Bounce comes from the opposite side, low and warm.
    this.bounce.position.set(-this.sunDirection.x * 200, 40, -this.sunDirection.z * 200);
    this.bounce.target.position.set(0, 0, 0);

    this.hemi.color.set(s.skyColor);
    this.hemi.groundColor.set(s.groundColor);
    this.hemi.intensity = s.hemiIntensity;

    if (this.scene.fog) {
      this.scene.fog.color.set(s.fogColor);
      this.scene.fog.density = s.fogDensity;
    }

    this.refreshEnvironment();
  }

  /** Re-convolves the sky into an environment map. */
  refreshEnvironment() {
    if (this.envTarget) this.envTarget.dispose();
    // The Sky mesh is BackSide and enormous; PMREM's scene capture handles it
    // directly, giving a physically consistent horizon gradient in the IBL.
    this.envTarget = this.pmrem.fromScene(new THREE.Scene().add(this.sky.clone()), 0.04, 0.1, 1000);
    this.scene.environment = this.envTarget.texture;
    this.scene.environmentIntensity = 1.0;
  }

  /**
   * Keeps the shadow frustum tight around the viewer. A fixed world-space
   * frustum wastes almost all of its texels on geometry behind the player;
   * re-centring ahead of the camera buys roughly 4x effective resolution.
   */
  update(camera) {
    const focus = camera.position.clone();
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() > 1e-6) forward.normalize().multiplyScalar(22);
    focus.add(forward);
    focus.y = 0;

    // Snap to shadow texel grid so shadows do not shimmer while walking.
    const cam = this.sun.shadow.camera;
    const texelWorld = (cam.right - cam.left) / this.sun.shadow.mapSize.x;
    focus.x = Math.round(focus.x / texelWorld) * texelWorld;
    focus.z = Math.round(focus.z / texelWorld) * texelWorld;

    this.sun.position.copy(focus).add(this.sunDirection.clone().multiplyScalar(180));
    this.sun.target.position.copy(focus);
    this.sun.target.updateMatrixWorld();

    this.bounce.position.copy(focus).add(
      new THREE.Vector3(-this.sunDirection.x * 120, 60, -this.sunDirection.z * 120),
    );
    this.bounce.target.position.copy(focus);
    this.bounce.target.updateMatrixWorld();
  }

  dispose() {
    this.envTarget?.dispose();
    this.pmrem.dispose();
  }
}
