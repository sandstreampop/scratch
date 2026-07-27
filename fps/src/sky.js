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
  elevation: 8.6,          // degrees above horizon
  azimuth: 104,            // degrees, clockwise from north
  // Turbidity scales Mie directly, and Mie at this sun elevation is what
  // smears the disc into a pale wash across a third of the dome. Keeping the
  // dust load low and the Rayleigh column high is what holds a cool zenith
  // above a warm horizon inside one frame, which is the whole read of dawn.
  turbidity: 1.4,
  rayleigh: 5.5,
  mieCoefficient: 0.0026,
  mieDirectionalG: 0.90,
  // Everything below renders three stops under the buffer's clip point and is
  // multiplied back here. The composite buffers are 8-bit in the capture path,
  // so anything above 1.0 linear is gone before the tone curve can roll it
  // off; holding the scene down is the only way to keep highlight headroom for
  // the tone map to shape. Exposure and the light intensities move together.
  exposure: 2.85,
  skyGain: 0.115,
  // Preetham's disc is the true 0.53 deg sun, which is six pixels at this
  // field of view — too small to survive antialiasing, let alone read as the
  // key light. A low sun seen through dust saturates a visibly wider core than
  // its geometric size, and that is what the eye recognises.
  sunDisc: 1.7,            // degrees, apparent diameter of the saturated core
  skyTint: 0x9dc0ec,       // ozone stand-in: cools the zenith, not the horizon
  // Ambient hue is the trap here. A saturated orange sun halo and a saturated
  // blue zenith push red and blue from opposite sides and leave green behind,
  // and every shadowed surface in the frame comes out magenta. Both ends of
  // the ambient are deliberately pulled toward green.
  sunColor: 0xffd2a4,      // warm dawn key
  sunIntensity: 3.0,
  skyColor: 0x6d94c8,      // zenith
  groundColor: 0x7a6042,   // sand bounce
  // Key and fill have to differ in colour temperature, not just in level, or
  // the cast shadows come back as a darker copy of the sunlit sand and the
  // frame reads as one warm ramp at no particular hour.
  hemiIntensity: 0.20,
  hazeColor: 0x8fa3ba,     // aerial perspective, away from the sun
  hazeSunColor: 0xffcb9c,  // ... and looking into it
  // Haze is sky radiance seen end-on, so it has to sit on the same scale as
  // the sky. A hex swatch decodes to something near 0.5 linear, which against
  // a scene deliberately rendered around 0.1 is nine times too bright: every
  // surface it touches is lifted rather than tinted, and the midground turns
  // into a white wall at fog densities far too low to explain it.
  hazeLuminance: 0.17,
  // Thin enough that a ridge at a kilometre still keeps some of its own
  // modelling. Saturated haze turns every distance into the same flat cut-out
  // and the eye loses its only cue for how deep the scene is.
  fogDensity: 0.0030,
  fogHeight: 40,           // metres; e-folding height of the dust layer
  fillColor: 0xa6c2e6,     // cool sky fill on the shadow side
  fillIntensity: 0.22,
  skyLuminance: 0.13,      // scales the analytic IBL
  environmentIntensity: 1.0,
};

/**
 * Replaces three's flat exponential fog with aerial perspective.
 *
 * A single fog colour reads as grey gauze laid over the frame: it kills the
 * near field as readily as the far one and carries no directional
 * information. Real dawn haze does two things instead. It scatters the sun's
 * light forward, so distance warms towards the sun and cools away from it.
 * And it settles, so it is thick along the ground and thin overhead — which
 * is what makes a ridgeline dissolve at its base while its crest stays sharp.
 *
 * Both need the fragment's world position, which the stock chunks do not
 * carry. Reconstructing it from `mvPosition` and the (rigid) view matrix works
 * in every shader that includes these chunks, including the ones that never
 * define `transformed` or `worldPosition`.
 *
 * The sun vector and the forward-scatter tint are baked into the chunk source
 * rather than passed as uniforms: uniforms would mean patching every entry in
 * ShaderLib, and this preset's sun does not move.
 */
function installAerialPerspective(settings, sunDirection) {
  // three's colour management already decodes a hex literal into the linear
  // working space, so the usual convertSRGBToLinear() on top of it decodes
  // twice and hands back something several times darker and more saturated
  // than the swatch it came from.
  const warm = new THREE.Color(settings.hazeSunColor)
    .multiplyScalar(settings.hazeLuminance);
  const f = (v) => v.toFixed(6);

  THREE.ShaderChunk.fog_pars_vertex = /* glsl */`
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vFogWorld;
#endif`;

  THREE.ShaderChunk.fog_vertex = /* glsl */`
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  vFogWorld = cameraPosition + ( mvPosition.xyz * mat3( viewMatrix ) );
#endif`;

  THREE.ShaderChunk.fog_pars_fragment = /* glsl */`
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying vec3 vFogWorld;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
#endif`;

  THREE.ShaderChunk.fog_fragment = /* glsl */`
#ifdef USE_FOG
  vec3 fogRay = vFogWorld - cameraPosition;
  float fogDist = max( length( fogRay ), 1e-4 );

  // Mean density along the ray through an atmosphere that thins with height.
  const float invH = ${f(1 / settings.fogHeight)};
  float e0 = exp( - max( cameraPosition.y, 0.0 ) * invH );
  float e1 = exp( - max( vFogWorld.y, 0.0 ) * invH );
  float dy = ( vFogWorld.y - cameraPosition.y ) * invH;
  float column = abs( dy ) < 1e-3 ? e0 : ( e0 - e1 ) / dy;

  #ifdef FOG_EXP2
    float fogAmount = fogDensity * fogDist * column;
    float fogFactor = 1.0 - exp( - fogAmount * fogAmount );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, fogDist * column );
  #endif

  float sunAmount = max( dot( fogRay / fogDist,
    vec3( ${f(sunDirection.x)}, ${f(sunDirection.y)}, ${f(sunDirection.z)} ) ), 0.0 );
  vec3 haze = mix( fogColor, vec3( ${f(warm.r)}, ${f(warm.g)}, ${f(warm.b)} ),
                   pow( sunAmount, 1.9 ) * 0.92 );

  // Never hand a surface entirely over to the haze. Full saturation is what
  // turns a distant ridge into a single flat value with no sunlit face and no
  // shadow face; leaving it a little of its own radiance keeps the internal
  // modelling that lets the eye stack one distance behind another.
  gl_FragColor.rgb = mix( gl_FragColor.rgb, haze, min( fogFactor, 0.88 ) );
#endif`;
}

export class Atmosphere {
  constructor(renderer, scene, options = {}) {
    this.settings = { ...PRESET, ...options };
    this.scene = scene;
    this.renderer = renderer;

    this.sunDirection = new THREE.Vector3();
    this.sunWorld = new THREE.Vector3();
    const phi = THREE.MathUtils.degToRad(90 - this.settings.elevation);
    this.sunDirection.setFromSphericalCoords(1, phi, THREE.MathUtils.degToRad(this.settings.azimuth));

    // Has to happen before the level, weapon or soldiers compile a material.
    installAerialPerspective(this.settings, this.sunDirection);

    this.sky = new Sky();
    this.sky.material.uniforms.skyGain = { value: this.settings.skyGain };
    this.sky.material.uniforms.skyDiscCos = { value: 1 };
    this.sky.material.uniforms.skyTint = { value: new THREE.Color(this.settings.skyTint) };
    this.sky.material.fragmentShader =
      'uniform float skyGain;\nuniform float skyDiscCos;\nuniform vec3 skyTint;\n'
      + this.sky.material.fragmentShader;
    // Widen the solar core. Preetham draws the geometric disc, 0.53 deg, which
    // is six pixels here and disappears into the edge filter; a low sun through
    // dust saturates a much wider core than that, and without one the frame has
    // no visible light source at all.
    this.sky.material.fragmentShader = this.sky.material.fragmentShader.replace(
      'float sundisk = smoothstep( sunAngularDiameterCos, sunAngularDiameterCos + 0.00002, cosTheta );',
      'float sundisk = smoothstep( skyDiscCos, mix( skyDiscCos, 1.0, 0.55 ), cosTheta );',
    );
    // Two things happen here.
    //
    // Preetham's final `pow(texColor, ...)` returns NaN for any negative or
    // overflowing component, and PMREM will smear one NaN across every mip, so
    // the result is guarded before anything downstream sees it.
    //
    // And the model has no ozone term. Chappuis absorption is what deepens a
    // real twilight sky to blue overhead; without it Preetham hands back a flat
    // teal. Ozone is a vertical column, so the tint is keyed on elevation and
    // not on the angle from the sun — keyed on the latter it contributes
    // nothing to any frame that happens to face the sunrise, which is every
    // frame here. It is held back inside the forward-scatter lobe, where Mie
    // dominates and the light really is spectrally flat.
    this.sky.material.fragmentShader = this.sky.material.fragmentShader.replace(
      'gl_FragColor = vec4( retColor, 1.0 );',
      `float ozone = smoothstep( 0.03, 0.62, max( direction.y, 0.0 ) )
                   * ( 1.0 - 0.75 * pow( max( cosTheta, 0.0 ), 8.0 ) );
       vec3 safeColor = retColor * skyGain * mix( vec3( 1.0 ), skyTint, ozone );
       safeColor = mix( vec3( 0.0 ), safeColor, vec3( equal( safeColor, safeColor ) ) );
       gl_FragColor = vec4( max( safeColor, vec3( 0.0 ) ), 1.0 );`,
    );
    this.sky.material.needsUpdate = true;
    // Must sit inside the camera far plane or it is clipped away entirely,
    // taking both the visible sky and the PMREM capture with it. The box
    // corners are the binding constraint, not its faces: 640 * sqrt(3) = 1108.
    this.sky.scale.setScalar(640);
    this.sky.frustumCulled = false;
    // The shaft pass looks the dome up by name so it can leave it out of the
    // occlusion mask; without that the sky is the only thing in the mask and
    // there is nothing to occlude.
    this.sky.name = 'sky';
    scene.add(this.sky);

    this.sun = new THREE.DirectionalLight(this.settings.sunColor, this.settings.sunIntensity);
    this.sun.castShadow = true;
    this.configureShadows(4096);
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.hemi = new THREE.HemisphereLight(
      this.settings.skyColor, this.settings.groundColor, this.settings.hemiIntensity,
    );
    scene.add(this.hemi);

    // Open sky on the shadow side. A single warm key against nothing gives
    // shadowed faces one flat value; a cool counter-fill is what separates
    // them from each other and puts the blue into the shadows that reads as
    // dawn rather than as underexposure.
    this.bounce = new THREE.DirectionalLight(
      this.settings.fillColor, this.settings.fillIntensity,
    );
    this.bounce.castShadow = false;
    scene.add(this.bounce);
    scene.add(this.bounce.target);

    scene.fog = new THREE.FogExp2(this.settings.hazeColor, this.settings.fogDensity);
    scene.fog.color.multiplyScalar(this.settings.hazeLuminance);

    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmrem.compileEquirectangularShader();
    this.envSource = null;

    this.apply();
  }

  configureShadows(size) {
    const s = this.sun.shadow;
    s.mapSize.set(size, size);
    s.camera.near = 1;
    s.camera.far = 340;
    // Tight enough that 2048 still buys ~4.5 cm texels, wide enough that the
    // buildings ringing the courtyard stay inside it and keep casting.
    s.camera.left = -48;
    s.camera.right = 48;
    s.camera.top = 48;
    s.camera.bottom = -48;
    // Long dawn shadows graze the ground, so normal-bias does the heavy
    // lifting; a large constant bias would detach contact shadows entirely.
    s.bias = -0.00008;
    s.normalBias = 0.038;
    s.blurSamples = 16;
    s.radius = 2.0;
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
    u.skyGain.value = s.skyGain;
    u.skyDiscCos.value = Math.cos(THREE.MathUtils.degToRad(s.sunDisc * 0.5));
    u.skyTint.value.set(s.skyTint);

    const phi = THREE.MathUtils.degToRad(90 - s.elevation);
    const theta = THREE.MathUtils.degToRad(s.azimuth);
    this.sunDirection.setFromSphericalCoords(1, phi, theta);
    u.sunPosition.value.copy(this.sunDirection);

    this.sunWorld.copy(this.sunDirection).multiplyScalar(400);
    this.sun.position.copy(this.sunWorld);
    this.sun.target.position.set(0, 0, 0);
    this.sun.color.set(s.sunColor);
    this.sun.intensity = s.sunIntensity;

    this.bounce.color.set(s.fillColor);
    this.bounce.intensity = s.fillIntensity;
    this.bounce.position.set(-this.sunDirection.x * 200, 90, -this.sunDirection.z * 200);
    this.bounce.target.position.set(0, 0, 0);

    this.hemi.color.set(s.skyColor);
    this.hemi.groundColor.set(s.groundColor);
    this.hemi.intensity = s.hemiIntensity;

    if (this.scene.fog) {
      this.scene.fog.color.set(s.hazeColor).multiplyScalar(s.hazeLuminance);
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

    const lin = (hex) => new THREE.Color(hex);
    const zenith = lin(this.settings.skyColor);
    const cool = lin(this.settings.hazeColor);
    const warm = lin(this.settings.hazeSunColor);
    const ground = lin(this.settings.groundColor);
    const glow = lin(this.settings.sunColor);
    const sun = this.sunDirection;

    // Sun azimuth, for the warm/cool split around the horizon. Ambient that
    // is the same colour in every direction is the thing that makes a render
    // look like a render; a real sky is orange on one side and blue on the
    // other, and shadowed geometry picks that up.
    const sunAz = Math.atan2(sun.z, sun.x);

    for (let y = 0; y < height; y++) {
      // three's equirectUv: v = asin(dir.y)/PI + 0.5, so row 0 looks straight down.
      const elevation = ((y + 0.5) / height - 0.5) * Math.PI;
      const sy = Math.sin(elevation), cy = Math.cos(elevation);
      for (let x = 0; x < width; x++) {
        const azimuth = ((x + 0.5) / width - 0.5) * Math.PI * 2;
        const dx = cy * Math.cos(azimuth), dz = cy * Math.sin(azimuth);

        const toward = 0.5 + 0.5 * Math.cos(azimuth - sunAz);
        const w = Math.pow(toward, 1.6);
        const hz = [
          cool.r + (warm.r - cool.r) * w,
          cool.g + (warm.g - cool.g) * w,
          cool.b + (warm.b - cool.b) * w,
        ];

        let r, g, b;
        if (sy >= 0) {
          // Horizon haze grading into zenith blue. The exponent keeps the
          // warm band tight to the horizon the way real dawn haze sits.
          const t = Math.pow(sy, 0.42);
          r = hz[0] + (zenith.r - hz[0]) * t;
          g = hz[1] + (zenith.g - hz[1]) * t;
          b = hz[2] + (zenith.b - hz[2]) * t;
        } else {
          // Below the horizon: sand bounce, falling off with depth. It keeps
          // the azimuthal split, so undersides on the sun side stay warm.
          const t = Math.min(1, -sy * 2.2);
          r = hz[0] * 0.62 + (ground.r - hz[0] * 0.62) * t;
          g = hz[1] * 0.62 + (ground.g - hz[1] * 0.62) * t;
          b = hz[2] * 0.62 + (ground.b - hz[2] * 0.62) * t;
        }

        // Forward-scattered glow around the sun — the aureole only. A term
        // tight and strong enough to stand in for the disc puts the direct
        // light back into an irradiance map that exists precisely to exclude
        // it, and every shadowed surface then gets lit by the light it is
        // shadowed from, which is what collapses key and fill onto one colour.
        const cosSun = Math.max(0, dx * sun.x + sy * sun.y + dz * sun.z);
        const halo = Math.pow(cosSun, 8) * 0.25;
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

    // The sun grazes the ground at this elevation, so the caster that matters
    // can be a long way up-sun of anything visible. Standing off further than
    // the frustum is deep keeps those casters in front of the near plane.
    this.sun.position.copy(focus).add(this.sunDirection.clone().multiplyScalar(170));
    this.sun.target.position.copy(focus);
    this.sun.target.updateMatrixWorld();

    this.bounce.position.copy(focus).add(
      new THREE.Vector3(-this.sunDirection.x * 120, 90, -this.sunDirection.z * 120),
    );
    this.bounce.target.position.copy(focus);
    this.bounce.target.updateMatrixWorld();
  }

  dispose() {
    this.envTarget?.dispose();
    this.pmrem.dispose();
  }
}
