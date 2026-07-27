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
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';

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

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uAberration: { value: 0.0016 },
    uVignette: { value: 0.42 },
    uVignetteSoft: { value: 0.62 },
    uGrain: { value: 0.030 },
    uSharpen: { value: 0.38 },
    uContrast: { value: 1.075 },
    uSaturation: { value: 1.055 },
    uLift: { value: new THREE.Vector3(0.008, 0.006, 0.014) },
    uGain: { value: new THREE.Vector3(1.020, 0.998, 0.962) },
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
    uniform float uTime, uAberration, uVignette, uVignetteSoft, uGrain,
                  uSharpen, uContrast, uSaturation, uHurt, uFlash;
    varying vec2 vUv;

    float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

    float hash(vec2 p) {
      p = fract(p * vec2(443.8975, 397.2973));
      p += dot(p, p + 19.19);
      return fract(p.x * p.y);
    }

    void main() {
      vec2 uv = vUv;
      vec2 centered = uv - 0.5;
      float r2 = dot(centered, centered);

      // --- lateral chromatic aberration, zero at the optical axis ---------
      float ca = uAberration * (1.0 + uHurt * 5.0);
      vec3 color;
      color.r = texture2D(tDiffuse, uv - centered * ca * 1.00).r;
      color.g = texture2D(tDiffuse, uv).g;
      color.b = texture2D(tDiffuse, uv + centered * ca * 1.00).b;

      // --- unsharp mask ---------------------------------------------------
      vec2 texel = 1.0 / uResolution;
      vec3 blur =
          texture2D(tDiffuse, uv + vec2( texel.x, 0.0)).rgb
        + texture2D(tDiffuse, uv + vec2(-texel.x, 0.0)).rgb
        + texture2D(tDiffuse, uv + vec2(0.0,  texel.y)).rgb
        + texture2D(tDiffuse, uv + vec2(0.0, -texel.y)).rgb;
      color += (color - blur * 0.25) * uSharpen;

      // --- lift / gain, contrast about mid-grey, saturation ---------------
      color = color * uGain + uLift;
      color = (color - 0.5) * uContrast + 0.5;
      color = mix(vec3(luma(color)), color, uSaturation);

      // Cold shadows against the warm dawn key — the split-tone that reads
      // as "modern military shooter" more than any other single choice.
      float shadowMask = 1.0 - smoothstep(0.0, 0.42, luma(color));
      color = mix(color, color * vec3(0.90, 0.965, 1.10), shadowMask * 0.30);

      // --- damage response ------------------------------------------------
      if (uHurt > 0.001) {
        color = mix(color, vec3(luma(color)) * vec3(1.35, 0.30, 0.24), uHurt * 0.55);
      }
      color += uFlash;

      // --- vignette ---------------------------------------------------------
      float vig = 1.0 - uVignette * smoothstep(uVignetteSoft * 0.25, 0.78, r2 * 2.0);
      color *= vig;

      // --- sensor grain, stronger in the shadows where real sensors show it -
      float g = hash(gl_FragCoord.xy + fract(uTime) * 371.13) - 0.5;
      color += g * uGrain * (1.0 - 0.65 * smoothstep(0.15, 0.85, luma(color)));

      gl_FragColor = vec4(max(color, 0.0), 1.0);
    }
  `,
};

/* ---------------------------------------------------------------- public -- */

export class PostStack {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;

    const size = renderer.getSize(new THREE.Vector2());
    const dpr = renderer.getPixelRatio();
    const w = Math.floor(size.x * dpr), h = Math.floor(size.y * dpr);

    this.composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      samples: 0,
      colorSpace: THREE.LinearSRGBColorSpace,
    }));
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(size.x, size.y);

    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    // Ground-truth ambient occlusion — contact darkening under crates,
    // sandbags and door reveals that no lightmap or IBL term can produce.
    this.gtao = new GTAOPass(scene, camera, w, h);
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

    this.output = new OutputPass();
    this.composer.addPass(this.output);

    this.grade = new ShaderPass(GradeShader);
    this.grade.uniforms.uResolution.value.set(w, h);
    this.composer.addPass(this.grade);

    this.smaa = new SMAAPass();
    this.composer.addPass(this.smaa);

    this._sunNDC = new THREE.Vector3();
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
