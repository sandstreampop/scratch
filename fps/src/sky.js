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
  elevation: 9.5,          // degrees above horizon
  azimuth: 104,            // degrees, clockwise from north
  turbidity: 4.6,          // dust load
  rayleigh: 2.15,
  mieCoefficient: 0.0032,
  mieDirectionalG: 0.79,
  exposure: 1.0,
  sunColor: 0xffc389,      // warm dawn key
  sunIntensity: 4.4,
  skyColor: 0x8fb6dd,      // zenith bounce
  groundColor: 0x6b5535,   // sand bounce
  hemiIntensity: 0.55,
  fogColor: 0xcfb392,
  fogDensity: 0.0026,
  skyLuminance: 1.35,        // scales the analytic IBL
  environmentIntensity: 1.0,
};

export class Atmosphere {
  constructor(renderer, scene, options = {}) {
    this.settings = { ...PRESET, ...options };
    this.scene = scene;
    this.renderer = renderer;

    this.sky = new Sky();
    // Preetham's final `pow(texColor, ...)` returns NaN for any negative or
    // overflowing component. Guard the visible sky as well as the IBL source.
    this.sky.material.fragmentShader = this.sky.material.fragmentShader.replace(
      'gl_FragColor = vec4( retColor, 1.0 );',
      `vec3 safeColor = retColor;
       safeColor = mix( vec3( 0.0 ), safeColor, vec3( equal( safeColor, safeColor ) ) );
       gl_FragColor = vec4( max( safeColor, vec3( 0.0 ) ), 1.0 );`,
    );
    this.sky.material.needsUpdate = true;
    // Must sit inside the camera far plane or it is clipped away entirely,
    // taking both the visible sky and the PMREM capture with it.
    this.sky.scale.setScalar(1000);
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
    this.envSource = null;

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

  /**
   * Builds the environment map from an analytic equirectangular sky computed
   * on the CPU, rather than by capturing the Preetham mesh.
   *
   * Capturing the mesh is the obvious approach and it is what broke the
   * renderer: Preetham's solar disc term is `vSunE * 19000`, the result goes
   * through a fractional `pow`, and any negative or overflowing component
   * comes back NaN. PMREM's convolution then smears that NaN across every mip,
   * and every PBR surface sampling the environment renders as NaN — which is
   * invisible until you read the buffer back, because NaN clamps to black.
   *
   * Generating the irradiance source directly is both immune to that and more
   * useful: ambient colour and strength become art-directable values instead
   * of emergent properties of a shader we do not control. The sun's direct
   * contribution stays out of it, since the directional light already carries
   * it and including it here would double-count.
   */
  buildEnvironmentTexture(width = 256) {
    const height = width / 2;
    const data = new Float32Array(width * height * 4);

    const zenith = new THREE.Color(this.settings.skyColor).convertSRGBToLinear();
    const horizon = new THREE.Color(this.settings.fogColor).convertSRGBToLinear();
    const ground = new THREE.Color(this.settings.groundColor).convertSRGBToLinear();
    const glow = new THREE.Color(this.settings.sunColor).convertSRGBToLinear();
    const sun = this.sunDirection;

    for (let y = 0; y < height; y++) {
      // three's equirectUv: v = asin(dir.y)/PI + 0.5, so row 0 looks straight down.
      const elevation = ((y + 0.5) / height - 0.5) * Math.PI;
      const sy = Math.sin(elevation), cy = Math.cos(elevation);
      for (let x = 0; x < width; x++) {
        const azimuth = ((x + 0.5) / width - 0.5) * Math.PI * 2;
        const dx = cy * Math.cos(azimuth), dz = cy * Math.sin(azimuth);

        let r, g, b;
        if (sy >= 0) {
          // Horizon haze grading into zenith blue. The exponent keeps the
          // warm band tight to the horizon the way real dawn haze sits.
          const t = Math.pow(sy, 0.42);
          r = horizon.r + (zenith.r - horizon.r) * t;
          g = horizon.g + (zenith.g - horizon.g) * t;
          b = horizon.b + (zenith.b - horizon.b) * t;
        } else {
          // Below the horizon: sand bounce, falling off with depth.
          const t = Math.min(1, -sy * 2.2);
          r = horizon.r * 0.55 + (ground.r - horizon.r * 0.55) * t;
          g = horizon.g * 0.55 + (ground.g - horizon.g * 0.55) * t;
          b = horizon.b * 0.55 + (ground.b - horizon.b * 0.55) * t;
        }

        // Forward-scattered glow around the sun. Bounded by construction.
        const cosSun = Math.max(0, dx * sun.x + sy * sun.y + dz * sun.z);
        const halo = Math.pow(cosSun, 6) * 2.6 + Math.pow(cosSun, 40) * 5.5;
        r += glow.r * halo;
        g += glow.g * halo;
        b += glow.b * halo;

        const i = (y * width + x) * 4;
        data[i] = r * this.settings.skyLuminance;
        data[i + 1] = g * this.settings.skyLuminance;
        data[i + 2] = b * this.settings.skyLuminance;
        data[i + 3] = 1;
      }
    }

    const tex = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.NoColorSpace;      // already linear
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
  }

  /** Re-convolves the analytic sky into scene.environment. */
  refreshEnvironment() {
    if (this.envTarget) this.envTarget.dispose();
    this.envSource?.dispose();

    this.envSource = this.buildEnvironmentTexture();
    this.envTarget = this.pmrem.fromEquirectangular(this.envSource);
    this.scene.environment = this.envTarget.texture;
    this.scene.environmentIntensity = this.settings.environmentIntensity;
  }

  /**
   * Keeps the shadow frustum tight around the viewer. A fixed world-space
   * frustum wastes almost all of its texels on geometry behind the player;
   * re-centring ahead of the camera buys roughly 4x effective resolution.
   */
  update(camera) {
    // Keep the sky centred on the viewer so it never leaves the far plane.
    this.sky.position.copy(camera.position);

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
