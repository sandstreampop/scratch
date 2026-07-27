// Post-processing chain.
//
//   scene -> GTAO -> volumetric shafts -> bloom -> tonemap/sRGB
//         -> grade (CA, vignette, grain, sharpen, lift/gamma/gain) -> SMAA
//
// The grade pass runs after tonemapping because chromatic aberration, grain
// and vignette are lens/sensor artifacts — applying them in HDR makes bright
// areas smear in a way no real camera does.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { Pass } from 'three/addons/postprocessing/Pass.js';

/* ------------------------------------------------------ viewmodel pass -- */

/**
 * Composites the first-person weapon over the frame with a fresh depth buffer.
 *
 * This deliberately does NOT use RenderPass with `clear = false`. EffectComposer
 * ping-pongs between two targets, so a non-clearing pass in the middle of the
 * chain draws on top of the output from *two* passes ago, not the previous one.
 * Rendering in place into readBuffer with `needsSwap = false` keeps the chain
 * intact and costs one less full-screen copy.
 */
class ViewmodelPass extends Pass {
  constructor(scene, camera) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.needsSwap = false;
    this.clear = false;
  }

  render(renderer, writeBuffer, readBuffer) {
    const previousTarget = renderer.getRenderTarget();
    const previousAutoClear = renderer.autoClear;

    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    renderer.autoClear = false;
    // Colour is kept; depth is stale after the preceding full-screen passes.
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);

    renderer.autoClear = previousAutoClear;
    renderer.setRenderTarget(previousTarget);
  }
}

/* ------------------------------------------------- volumetric sun shafts -- */
// Occlusion-masked radial blur toward the sun's screen position. The sky near
// the sun is by far the brightest thing in frame, so thresholding luminance
// and smearing it radially reproduces crepuscular rays through the outpost
// geometry without a second scene render.

const ShaftsShader = {
  uniforms: {
    tDiffuse: { value: null },
    uSunScreen: { value: new THREE.Vector2(0.5, 0.5) },
    uIntensity: { value: 0.62 },
    uDecay: { value: 0.962 },
    uDensity: { value: 0.72 },
    uWeight: { value: 0.42 },
    uThreshold: { value: 0.86 },
    uTint: { value: new THREE.Color(0xffc99a) },
    uVisible: { value: 1.0 },
    uAspect: { value: 1.0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2  uSunScreen;
    uniform float uIntensity, uDecay, uDensity, uWeight, uThreshold, uVisible, uAspect;
    uniform vec3  uTint;
    varying vec2 vUv;

    const int SAMPLES = 48;

    float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

    void main() {
      vec4 scene = texture2D(tDiffuse, vUv);
      if (uVisible < 0.001) { gl_FragColor = scene; return; }

      vec2 delta = (vUv - uSunScreen) * (uDensity / float(SAMPLES));
      vec2 uv = vUv;
      float decay = 1.0;
      vec3 accum = vec3(0.0);

      // Per-pixel dither breaks the banding that fixed-step raymarching
      // otherwise leaves across smooth sky gradients.
      float jitter = fract(sin(dot(vUv, vec2(12.9898, 78.233))) * 43758.5453);
      uv -= delta * jitter;

      for (int i = 0; i < SAMPLES; i++) {
        uv -= delta;
        vec3 s = texture2D(tDiffuse, clamp(uv, 0.0, 1.0)).rgb;
        // Only the sky above the occluders contributes to a shaft.
        float mask = smoothstep(uThreshold, uThreshold + 0.35, luma(s));
        accum += s * mask * decay * uWeight;
        decay *= uDecay;
      }
      accum /= float(SAMPLES);

      // Shafts fade out as the sun leaves frame, and never bloom behind you.
      vec2 d = (vUv - uSunScreen) * vec2(uAspect, 1.0);
      float falloff = 1.0 - smoothstep(0.15, 1.25, length(d));

      gl_FragColor = vec4(scene.rgb + accum * uTint * uIntensity * falloff * uVisible, scene.a);
    }
  `,
};

/* ------------------------------------------------------------- the grade -- */

// One pass takes the HDR frame all the way to display: lens artifacts and
// sharpening in linear light, then exposure, a fitted ACES curve, the grade,
// sRGB encode, and finally the sensor-domain effects (vignette, grain).
//
// This replaces three's OutputPass. Doing the tone map here rather than in a
// separate upstream pass means the grade operates on scene-referred values —
// contrast and saturation applied to already-display-encoded pixels crush
// highlights and skew hue, which is exactly what a filmic pipeline avoids.

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uExposure: { value: 1.0 },
    uAberration: { value: 0.0014 },
    uVignette: { value: 0.34 },
    uGrain: { value: 0.022 },
    uSharpen: { value: 0.30 },
    uContrast: { value: 1.045 },
    uSaturation: { value: 1.05 },
    uLift: { value: new THREE.Vector3(0.004, 0.005, 0.011) },
    uGain: { value: new THREE.Vector3(1.025, 1.000, 0.960) },
    uHurt: { value: 0.0 },
    uFlash: { value: 0.0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2  uResolution;
    uniform vec3  uLift, uGain;
    uniform float uTime, uExposure, uAberration, uVignette, uGrain,
                  uSharpen, uContrast, uSaturation, uHurt, uFlash;
    varying vec2 vUv;

    float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

    float hash(vec2 p) {
      p = fract(p * vec2(443.8975, 397.2973));
      p += dot(p, p + 19.19);
      return fract(p.x * p.y);
    }

    // Narkowicz's fit of the ACES RRT+ODT. Cheap, and its highlight shoulder
    // is what keeps the sun and muzzle flashes from clipping to flat white.
    vec3 aces(vec3 x) {
      const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
      return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
    }

    vec3 toSRGB(vec3 c) {
      return mix(c * 12.92,
                 1.055 * pow(max(c, vec3(1e-5)), vec3(1.0 / 2.4)) - 0.055,
                 step(vec3(0.0031308), c));
    }

    void main() {
      vec2 uv = vUv;
      vec2 centered = uv - 0.5;
      float r2 = dot(centered, centered);

      // --- lateral chromatic aberration, zero at the optical axis ---------
      float ca = uAberration * (1.0 + uHurt * 5.0);
      vec3 color;
      color.r = texture2D(tDiffuse, uv - centered * ca).r;
      color.g = texture2D(tDiffuse, uv).g;
      color.b = texture2D(tDiffuse, uv + centered * ca).b;
      color = max(color, 0.0);

      // --- unsharp mask, in linear light ----------------------------------
      vec2 texel = 1.0 / uResolution;
      vec3 blur =
          texture2D(tDiffuse, uv + vec2( texel.x, 0.0)).rgb
        + texture2D(tDiffuse, uv + vec2(-texel.x, 0.0)).rgb
        + texture2D(tDiffuse, uv + vec2(0.0,  texel.y)).rgb
        + texture2D(tDiffuse, uv + vec2(0.0, -texel.y)).rgb;
      color += (color - max(blur, 0.0) * 0.25) * uSharpen;
      color = max(color, 0.0);

      // --- exposure and tone map ------------------------------------------
      color = aces(color * uExposure);

      // --- grade, in display-linear ----------------------------------------
      color = color * uGain + uLift;
      color = (color - 0.18) * uContrast + 0.18;
      color = max(color, 0.0);
      color = mix(vec3(luma(color)), color, uSaturation);

      // Cool the shadows against the warm dawn key — the split-tone that
      // reads as "modern military shooter" more than any other single choice.
      float shadowMask = 1.0 - smoothstep(0.0, 0.34, luma(color));
      color = mix(color, color * vec3(0.90, 0.965, 1.12), shadowMask * 0.35);

      if (uHurt > 0.001) {
        color = mix(color, vec3(luma(color)) * vec3(1.35, 0.30, 0.24), uHurt * 0.55);
      }
      color += uFlash;

      color = toSRGB(clamp(color, 0.0, 1.0));

      // --- sensor domain ----------------------------------------------------
      color *= 1.0 - uVignette * smoothstep(0.10, 0.82, r2 * 2.0);

      // Grain lives mostly in the shadows, as it does on a real sensor.
      float g = hash(gl_FragCoord.xy + fract(uTime) * 371.13) - 0.5;
      color += g * uGrain * (1.0 - 0.7 * smoothstep(0.12, 0.8, luma(color)));

      gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
    }
  `,
};

/* ---------------------------------------------------------------- public -- */

export class PostStack {
  constructor(renderer, scene, camera, exposure = 1.0) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;

    const size = renderer.getSize(new THREE.Vector2());
    const dpr = renderer.getPixelRatio();
    const w = Math.floor(size.x * dpr), h = Math.floor(size.y * dpr);

    // Software GL (SwiftShader, used by the headless capture harness) renders
    // black into half-float colour targets. Fall back to 8-bit there; on real
    // hardware the HDR buffer is kept so bloom and the tone map get true
    // scene-referred values to work with.
    const bufferType = PostStack.probeHalfFloat(renderer) ? THREE.HalfFloatType : THREE.UnsignedByteType;
    this.bufferType = bufferType;
    this.composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(w, h, {
      type: bufferType,
      samples: 0,
      colorSpace: THREE.LinearSRGBColorSpace,
    }));
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(size.x, size.y);

    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    // Ground-truth ambient occlusion. Off by default: it needs a tight
    // camera near/far ratio to reconstruct position from depth, and on a
    // 130 m sightline it zeroes the ground plane outright. Enable via
    // `setAmbientOcclusion(true)` once tuned for the current frustum.
    this.gtao = new GTAOPass(scene, camera, w, h);
    this.gtao.enabled = false;
    this.gtao.output = GTAOPass.OUTPUT.Default;
    this.gtao.updateGtaoMaterial({
      radius: 0.42,
      distanceExponent: 1.0,
      thickness: 0.85,
      scale: 1.05,
      samples: 20,
      distanceFallOff: 1.0,
      screenSpaceRadius: false,
    });
    this.gtao.blendIntensity = 1.0;
    this.composer.addPass(this.gtao);

    this.shafts = new ShaderPass(ShaftsShader);
    this.composer.addPass(this.shafts);

    this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.30, 0.72, 0.86);
    this.composer.addPass(this.bloom);

    this.grade = new ShaderPass(GradeShader);
    this.grade.uniforms.uResolution.value.set(w, h);
    this.grade.uniforms.uExposure.value = exposure;
    this.composer.addPass(this.grade);

    this.smaa = new SMAAPass();
    this.composer.addPass(this.smaa);

    this._sunNDC = new THREE.Vector3();
  }

  /**
   * Renders a known colour into a half-float target and reads it back. Some
   * software rasterisers advertise the extension but return zeroes.
   */
  static probeHalfFloat(renderer) {
    if (PostStack._halfFloatOK !== undefined) return PostStack._halfFloatOK;
    const target = new THREE.WebGLRenderTarget(4, 4, {
      type: THREE.HalfFloatType, colorSpace: THREE.LinearSRGBColorSpace,
    });
    const previous = renderer.getRenderTarget();
    const previousClear = new THREE.Color();
    renderer.getClearColor(previousClear);
    const previousAlpha = renderer.getClearAlpha();

    renderer.setRenderTarget(target);
    renderer.setClearColor(0x336699, 1);
    renderer.clear(true, true, true);
    const pixels = new Uint8Array(4 * 4 * 4);
    let ok = false;
    try {
      renderer.readRenderTargetPixels(target, 0, 0, 4, 4, pixels);
      ok = pixels[0] !== 0 || pixels[1] !== 0 || pixels[2] !== 0;
    } catch (e) {
      ok = false;
    }
    renderer.setClearColor(previousClear, previousAlpha);
    renderer.setRenderTarget(previous);
    target.dispose();

    PostStack._halfFloatOK = ok;
    if (!ok) console.info('post: half-float render targets unusable, using 8-bit buffers');
    return ok;
  }

  /**
   * Inserts the first-person weapon into the chain: after world-space AO and
   * shafts (which must not touch it) but before bloom and the grade (which
   * must, or the weapon looks pasted on).
   */
  setViewmodel(scene, camera) {
    this.viewmodel = new ViewmodelPass(scene, camera);
    const index = this.composer.passes.indexOf(this.bloom);
    this.composer.insertPass(this.viewmodel, index);
    return this.viewmodel;
  }

  /** Projects the sun into screen space so the shaft pass knows where to smear. */
  updateSun(sunDirection) {
    const world = this.camera.position.clone().add(sunDirection.clone().multiplyScalar(6000));
    this._sunNDC.copy(world).project(this.camera);

    const behind = this._sunNDC.z > 1;
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    const facing = forward.dot(sunDirection);

    const u = this.shafts.uniforms;
    u.uSunScreen.value.set(this._sunNDC.x * 0.5 + 0.5, this._sunNDC.y * 0.5 + 0.5);
    // Ramp off smoothly as the sun swings behind the player.
    u.uVisible.value = behind || facing <= 0 ? 0 : Math.min(1, Math.max(0, (facing - 0.05) / 0.45));
  }

  /** Enables screen-space AO and retunes it for the current frustum. */
  setAmbientOcclusion(enabled, options = {}) {
    this.gtao.enabled = enabled;
    if (enabled) this.gtao.updateGtaoMaterial({ ...options });
  }

  get exposure() { return this.grade.uniforms.uExposure.value; }
  set exposure(v) { this.grade.uniforms.uExposure.value = v; }

  setDamage(amount) { this.grade.uniforms.uHurt.value = amount; }
  setFlash(amount) { this.grade.uniforms.uFlash.value = amount; }

  render(dt, elapsed) {
    this.grade.uniforms.uTime.value = elapsed;
    this.composer.render(dt);
  }

  setSize(width, height) {
    const dpr = this.renderer.getPixelRatio();
    const w = Math.floor(width * dpr), h = Math.floor(height * dpr);
    this.composer.setSize(width, height);
    this.gtao.setSize(w, h);
    this.bloom.setSize(w, h);
    this.grade.uniforms.uResolution.value.set(w, h);
    this.shafts.uniforms.uAspect.value = width / height;
  }
}
