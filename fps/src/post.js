// Post-processing chain.
//
//   scene -> GTAO -> sun shafts -> viewmodel -> bloom
//         -> grade (CA, sharpen, contrast, tonemap, sRGB, vignette, grain)
//         -> FXAA or SMAA
//
// The grade owns the tone map so that contrast is applied to scene-referred
// values and the lens/sensor artifacts — aberration, vignette, grain — are
// applied after the encode, which is the only order that matches a camera.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

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

const ShaftsShader = {
  uniforms: {
    tDiffuse: { value: null },
    tMask: { value: null },
    uSunScreen: { value: new THREE.Vector2(0.5, 0.5) },
    uIntensity: { value: 0.13 },
    uDecay: { value: 0.978 },
    uDensity: { value: 1.0 },
    uWeight: { value: 1.0 },
    // How far from the sun a shaft can still be seen, in screen widths. Real
    // in-scatter reaches everywhere, but without a depth buffer this pass
    // cannot tell a distant silhouette from a near one, and letting it run to
    // the frame edge lifts the whole foreground into a flat veil.
    uReach: { value: 0.38 },
    uTint: { value: new THREE.Color(0xffd9b4) },
    uVisible: { value: 1.0 },
    uAspect: { value: 1.0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse, tMask;
    uniform vec2  uSunScreen;
    uniform float uIntensity, uDecay, uDensity, uWeight, uReach, uVisible, uAspect;
    uniform vec3  uTint;
    varying vec2 vUv;

    const int SAMPLES = 40;

    void main() {
      vec4 scene = texture2D(tDiffuse, vUv);
      if (uVisible < 0.001) { gl_FragColor = scene; return; }

      vec2 delta = (vUv - uSunScreen) * (uDensity / float(SAMPLES));
      vec2 uv = vUv;
      float decay = 1.0;
      float accum = 0.0;
      float total = 0.0;

      // Per-pixel dither breaks the banding that fixed-step raymarching
      // otherwise leaves across smooth sky gradients.
      float jitter = fract(sin(dot(vUv, vec2(12.9898, 78.233))) * 43758.5453);
      uv -= delta * jitter;

      for (int i = 0; i < SAMPLES; i++) {
        uv -= delta;
        accum += texture2D(tMask, clamp(uv, 0.0, 1.0)).r * decay * uWeight;
        total += decay * uWeight;
        decay *= uDecay;
      }
      // Normalised against a completely unoccluded march, so uIntensity is the
      // in-scatter added under open sky and does not silently change every
      // time the decay is retuned. Open sky adds that value flat — the shafts
      // are the departures from it, so it has to stay small or it is a veil.
      accum /= max(total, 1e-4);

      // Shafts fade out as the sun leaves frame, and never bloom behind you.
      vec2 d = (vUv - uSunScreen) * vec2(uAspect, 1.0);
      float falloff = 1.0 - smoothstep(0.03, uReach, length(d));

      // With no depth buffer the march cannot tell how much air lies in front
      // of a silhouette, and a thin one — a guy wire, a crossarm — barely
      // dents the accumulation, so it takes the full open-sky in-scatter and
      // comes out amber against the sky it is meant to be blocking. Damping
      // the contribution over occluders keeps the light in the air between
      // them, which is the part the eye reads as a shaft.
      float here = texture2D(tMask, vUv).r;
      float onSky = mix(0.10, 1.0, here * here);

      gl_FragColor = vec4(scene.rgb + accum * uTint * uIntensity * falloff * uVisible * onSky,
                          scene.a);
    }
  `,
};

/**
 * Crepuscular rays, driven by a real occlusion mask rather than by frame luma.
 *
 * Thresholding the composited frame is the cheap way to do this and it does
 * not work at dawn: the sky is barely brighter than the sunlit sand, so any
 * threshold low enough to catch the sky catches the ground too and the pass
 * collapses into an omnidirectional glow. Drawing the occluders into a
 * half-resolution black-on-white mask separates the two exactly, and costs one
 * cheap depth-only-ish scene pass with every material replaced by flat black.
 */
class SunShaftsPass extends Pass {
  constructor(scene, camera, width, height) {
    super();
    this.scene = scene;
    this.camera = camera;

    this.maskTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.UnsignedByteType,
      colorSpace: THREE.LinearSRGBColorSpace,
      depthBuffer: true,
    });
    this.setSize(width, height);

    this.occluder = new THREE.MeshBasicMaterial({
      color: 0x000000, fog: false, side: THREE.DoubleSide,
    });
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(ShaftsShader.uniforms),
      vertexShader: ShaftsShader.vertexShader,
      fragmentShader: ShaftsShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    this.uniforms = this.material.uniforms;
    this.fsQuad = new FullScreenQuad(this.material);

    this._hidden = [];
    this._swapped = [];
    this._cutouts = new Map();
    this._clear = new THREE.Color();
  }

  setSize(width, height) {
    this.maskTarget.setSize(Math.max(2, width >> 1), Math.max(2, height >> 1));
  }

  /**
   * The black stand-in a material occludes with: its own cutout, no colour.
   *
   * Everything solid can share one flat black. Only alpha-tested geometry —
   * awning slats, chain-link, shed panels — needs a material of its own, and
   * it needs one badly: with `transparent` geometry simply dropped from the
   * mask, open sky shows through wherever those objects stand and the pass
   * lays full in-scatter directly on top of them.
   */
  cutoutFor(source) {
    if (!source.transparent && !(source.alphaTest > 0)) return this.occluder;
    if (!source.map && !source.alphaMap) return this.occluder;
    let mat = this._cutouts.get(source);
    if (!mat) {
      mat = new THREE.MeshBasicMaterial({
        color: 0x000000,
        fog: false,
        side: THREE.DoubleSide,
        map: source.map || null,
        alphaMap: source.alphaMap || null,
        alphaTest: source.alphaTest > 0 ? source.alphaTest : 0.5,
      });
      this._cutouts.set(source, mat);
    }
    return mat;
  }

  /**
   * White where open sky reaches the camera, black wherever a solid blocks it.
   *
   * Additively blended VFX are the one thing left out. Sparks, tracers and the
   * mote field emit light rather than block it, and the override material has
   * no opacity, so drawing them would cut hard notches out of the shafts where
   * there is nothing but haze. Soft sprite smoke goes with them for the same
   * reason: as a hard black silhouette it does far more damage than the little
   * occlusion it really provides is worth.
   */
  renderMask(renderer) {
    const hidden = this._hidden;
    const swapped = this._swapped;
    hidden.length = 0;
    swapped.length = 0;
    this.scene.traverseVisible((o) => {
      if (o.isSky || o.name === 'sky' || o.isPoints || o.isSprite) { hidden.push(o); return; }
      if (!o.isMesh && !o.isLine) return;
      const m = o.material;
      if (!m) return;
      const additive = Array.isArray(m)
        ? m.some((x) => x && x.blending === THREE.AdditiveBlending)
        : m.blending === THREE.AdditiveBlending;
      if (additive) { hidden.push(o); return; }
      swapped.push(o, m);
      o.material = Array.isArray(m) ? m.map((x) => this.cutoutFor(x)) : this.cutoutFor(m);
    });
    for (const o of hidden) o.visible = false;

    const target = renderer.getRenderTarget();
    const shadowAuto = renderer.shadowMap.autoUpdate;
    renderer.getClearColor(this._clear);
    const alpha = renderer.getClearAlpha();

    // The shadow map was already built for this frame by the beauty pass.
    renderer.shadowMap.autoUpdate = false;
    renderer.setClearColor(0xffffff, 1);
    renderer.setRenderTarget(this.maskTarget);
    renderer.clear();
    renderer.render(this.scene, this.camera);

    renderer.setClearColor(this._clear, alpha);
    renderer.setRenderTarget(target);
    renderer.shadowMap.autoUpdate = shadowAuto;
    for (const o of hidden) o.visible = true;
    for (let i = 0; i < swapped.length; i += 2) swapped[i].material = swapped[i + 1];
  }

  render(renderer, writeBuffer, readBuffer) {
    if (this.uniforms.uVisible.value > 0.001) this.renderMask(renderer);

    this.uniforms.tDiffuse.value = readBuffer.texture;
    this.uniforms.tMask.value = this.maskTarget.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (this.clear) renderer.clear();
    this.fsQuad.render(renderer);
  }

  dispose() {
    this.maskTarget.dispose();
    this.occluder.dispose();
    for (const m of this._cutouts.values()) m.dispose();
    this._cutouts.clear();
    this.material.dispose();
    this.fsQuad.dispose();
  }
}

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
    uAberration: { value: 0.00045 },
    uVignette: { value: 0.30 },
    // Also dithers the 8-bit composite buffers, which quantise the shadows
    // hard enough to band without it.
    uGrain: { value: 0.026 },
    uSharpen: { value: 0.26 },
    uContrast: { value: 1.40 },
    uSaturation: { value: 1.06 },
    uLift: { value: new THREE.Vector3(0.0040, 0.0060, 0.0125) },
    // Subtracted back off after the lift so the frame still has a true zero in
    // it. A lift on its own is a floor, and a floor is why the darkest pixel
    // anywhere was sRGB 21 and the silhouettes had no separation.
    uBlackPoint: { value: 0.0028 },
    uGain: { value: new THREE.Vector3(1.030, 1.000, 0.968) },
    uSplit: { value: 0.20 },
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
                  uSharpen, uContrast, uSaturation, uSplit, uHurt, uFlash,
                  uBlackPoint;
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

      // --- exposure, contrast, tone map -------------------------------------
      color *= uExposure;
      // Contrast pivoted on scene mid-grey, applied where it belongs: before
      // the curve. The straight (x - p) * c + p form drives everything below
      // p - p/c negative, and clamping that is what flattened the shadows
      // into a dead black with no separation in them. A power about the same
      // pivot cannot go negative, and the tone curve's shoulder then absorbs
      // what the same boost does to the highlights.
      color = 0.18 * pow(max(color, 1e-5) / 0.18, vec3(uContrast));
      color = aces(color);

      // --- grade, in display-linear ----------------------------------------
      color = max(color * uGain, 0.0);
      color = mix(vec3(luma(color)), color, uSaturation);

      // Cool the shadows against the warm dawn key — the split-tone that
      // reads as "modern military shooter" more than any other single choice.
      float shadowMask = 1.0 - smoothstep(0.0, 0.34, luma(color));
      color = mix(color, color * vec3(0.90, 0.965, 1.12), shadowMask * uSplit);

      // Lifted, tinted black point. Print film has a toe rather than a cliff,
      // and the cold cast sitting under the darkest part of the frame is most
      // of what separates a dawn exterior from an underexposed one. The
      // stretch that follows is what keeps it a toe: the lift alone sets a
      // floor no pixel can cross, and a frame with a floor and no clipped
      // highlight has neither end of the range and reads as haze.
      color = uLift + color * (1.0 - uLift);
      color = max(color - uBlackPoint, 0.0) / (1.0 - uBlackPoint);

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

/* -------------------------------------------------------------- edge AA -- */

// SMAA is the better edge filter and it is what the top tiers run. Below them
// it is switched off, and raw stair-stepping on the overhead cables and the
// rifle's rail teeth is the most obviously cheap thing in the frame. FXAA
// costs a single tap-and-blend pass and covers exactly that gap.

const FXAAShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTexel: { value: new THREE.Vector2(1 / 1024, 1 / 1024) },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2 uTexel;
    varying vec2 vUv;

    float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

    void main() {
      vec3 m  = texture2D(tDiffuse, vUv).rgb;
      vec3 nw = texture2D(tDiffuse, vUv + vec2(-1.0, -1.0) * uTexel).rgb;
      vec3 ne = texture2D(tDiffuse, vUv + vec2( 1.0, -1.0) * uTexel).rgb;
      vec3 sw = texture2D(tDiffuse, vUv + vec2(-1.0,  1.0) * uTexel).rgb;
      vec3 se = texture2D(tDiffuse, vUv + vec2( 1.0,  1.0) * uTexel).rgb;

      float lM = luma(m), lNW = luma(nw), lNE = luma(ne), lSW = luma(sw), lSE = luma(se);
      float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
      float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
      if (lMax - lMin < max(0.045, lMax * 0.15)) { gl_FragColor = vec4(m, 1.0); return; }

      vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
      float reduce = max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078125);
      dir = clamp(dir / (min(abs(dir.x), abs(dir.y)) + reduce), -8.0, 8.0) * uTexel;

      vec3 a = 0.5 * (texture2D(tDiffuse, vUv + dir * -0.16667).rgb
                    + texture2D(tDiffuse, vUv + dir *  0.16667).rgb);
      vec3 b = a * 0.5 + 0.25 * (texture2D(tDiffuse, vUv - dir * 0.5).rgb
                               + texture2D(tDiffuse, vUv + dir * 0.5).rgb);

      float lB = luma(b);
      gl_FragColor = vec4((lB < lMin || lB > lMax) ? a : b, 1.0);
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

    // Half-float buffers everywhere they work, which is every real GPU
    // including every iOS device.
    //
    // They do NOT work on a software rasteriser: SwiftShader renders a real
    // multi-pass scene black into one, while still clearing, single-quad
    // drawing and reading back correctly, so no feature probe detects it — and
    // WebKit masks its renderer string, so sniffing fails too. Rather than
    // guess, the headless harnesses declare it: ?buffers=byte. Nothing a
    // player runs takes that path.
    const forceByte = new URLSearchParams(location.search).get('buffers') === 'byte';
    const bufferType = (!forceByte && renderer.capabilities.isWebGL2)
      ? THREE.HalfFloatType : THREE.UnsignedByteType;
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

    // Ground-truth ambient occlusion, off by default.
    //
    // It no longer zeroes the ground plane at the current 0.1/700 frustum —
    // OUTPUT.Normal is a correct view-space normal buffer and the beauty pass
    // survives it. It also contributes nothing: OUTPUT.Denoise comes back at
    // 1.0 across the whole frame for every world-space radius from 0.4 m to
    // 2 m and for screenSpaceRadius at 32 px. Paying a full extra depth and
    // normal prepass for an all-white occlusion buffer is worse than having
    // no AO, so this stays off until someone finds what the horizon search
    // is doing on this depth range.
    this.gtao = new GTAOPass(scene, camera, w, h);
    this.gtao.enabled = false;
    this.gtao.output = GTAOPass.OUTPUT.Default;
    this.gtao.updateGtaoMaterial({
      radius: 0.6,
      distanceExponent: 1.0,
      thickness: 1.0,
      scale: 1.1,
      samples: 16,
      distanceFallOff: 1.0,
      screenSpaceRadius: false,
    });
    this.gtao.blendIntensity = 1.0;
    this.composer.addPass(this.gtao);

    this.shafts = new SunShaftsPass(scene, camera, w, h);
    this.shafts.uniforms.uAspect.value = w / h;
    this.composer.addPass(this.shafts);

    // The threshold is in scene-referred linear, and the scene is authored
    // three stops under the buffer clip so the grade can put the exposure back
    // (see PRESET.exposure). Display white therefore sits around 0.35 here, and
    // a threshold below that catches sunlit sand, hot dust puffs and every
    // work lamp in the outpost — which is how bloom ends up reading as fog with
    // a second sun in it. Above 0.6 only the solar core and a muzzle flash
    // qualify, which is the one thing in a dawn frame that should glare.
    this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.45, 0.35, 0.85);
    this.composer.addPass(this.bloom);

    this.grade = new ShaderPass(GradeShader);
    this.grade.uniforms.uResolution.value.set(w, h);
    this.grade.uniforms.uExposure.value = exposure;
    this.composer.addPass(this.grade);

    this.fxaa = new ShaderPass(FXAAShader);
    this.fxaa.uniforms.uTexel.value.set(1 / w, 1 / h);
    this.composer.addPass(this.fxaa);

    this.smaa = new SMAAPass();
    this.composer.addPass(this.smaa);

    this._sunNDC = new THREE.Vector3();
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
    // The proxy has to sit inside the far plane. Projecting one at 6 km put
    // it past it, every frame reported the sun as behind the camera, and the
    // shaft pass switched itself off — which is why it never contributed.
    const world = this.camera.position.clone()
      .addScaledVector(sunDirection, this.camera.far * 0.5);
    this._sunNDC.copy(world).project(this.camera);

    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    const facing = forward.dot(sunDirection);

    const u = this.shafts.uniforms;
    u.uSunScreen.value.set(this._sunNDC.x * 0.5 + 0.5, this._sunNDC.y * 0.5 + 0.5);
    // Ramp off smoothly as the sun swings behind the player.
    u.uVisible.value = Math.min(1, Math.max(0, (facing - 0.05) / 0.45));
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
    // The quality tier owns `smaa.enabled`; FXAA takes over whenever it drops.
    this.fxaa.enabled = !this.smaa.enabled;
    this.composer.render(dt);
  }

  setSize(width, height) {
    const dpr = this.renderer.getPixelRatio();
    const w = Math.floor(width * dpr), h = Math.floor(height * dpr);
    this.composer.setSize(width, height);
    this.gtao.setSize(w, h);
    this.bloom.setSize(w, h);
    this.shafts.setSize(w, h);
    this.grade.uniforms.uResolution.value.set(w, h);
    this.fxaa.uniforms.uTexel.value.set(1 / w, 1 / h);
    this.shafts.uniforms.uAspect.value = width / height;
  }
}
