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
 * cheap depth-only-ish scene pass with every material stripped to its cutout.
 */
class SunShaftsPass extends Pass {
  constructor(scene, camera, width, height) {
    super();
    this.scene = scene;
    this.camera = camera;

    // Multisampled, and that is not an optimisation — it is what stops the
    // pass drawing bright vertical streaks over thin occluders.
    //
    // The mask is half resolution, so a gate bar, a tower leg or a guy wire
    // covers well under a pixel in it. Without coverage samples those pixels
    // come back as open sky, `onSky` below hands them the full unoccluded
    // in-scatter, and the march paints a bright line straight down the middle
    // of the object that is supposed to be blocking the light. Four
    // independent reviewers picked those streaks out of one frame.
    //
    // It got worse, not better, when the beauty pass gained MSAA: the scene
    // then resolved thin geometry that the mask still could not, so the streak
    // landed on a wire the viewer could now clearly see.
    //
    // This reduced the streaks but did not remove them, and the remainder is
    // NOT understood. Three causes have been eliminated by experiment: mask
    // multisampling (helped, partial), mask resolution (full size changed
    // nothing and was reverted), and specular aliasing on the corrugated
    // sampler's sub-pixel ridges (its clean-sheet roughness floor was a
    // near-mirror 0.42 and raising it to a physically sane 0.62 left the
    // dashes untouched). Whatever draws them is somewhere else.
    this.maskTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.UnsignedByteType,
      colorSpace: THREE.LinearSRGBColorSpace,
      depthBuffer: true,
      samples: 4,
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
    // Half resolution, kept. Full resolution was tried against the vertical
    // streaks near the sun and made no difference to them at all, so it was a
    // doubled scene pass buying nothing. The multisampling above stays because
    // it visibly reduced them and is nearly free; the residual has a different
    // cause, still unidentified — see the note on the mask target.
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
   * Additively blended VFX are the one thing left out: sparks, tracers and the
   * mote field emit light rather than block it. Sprite smoke goes with them,
   * because the mask has no partial opacity and a soft puff drawn as a hard
   * black silhouette costs far more than the little occlusion it really owes.
   * Everything else stays in, cutout and all — dropping alpha-tested geometry
   * instead is what let open sky show through the awnings and the shed panels,
   * and the pass then laid full in-scatter straight on top of them.
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
    // Off. At 0.00045 this is 0.72 px of radial offset at 1600 wide, which was
    // invisible while the scene only had a stop of range in it and turned into
    // obvious red and cyan banding along every container edge, roofline and
    // strand of razor wire the moment the lighting carried three. A lens
    // artefact that reads as a filter costs more than it buys, and a bisection
    // with it zeroed is what identified it — the fringes survived fixing the
    // unsharp mask, which was the other suspect.
    uAberration: { value: 0.0 },
    uVignette: { value: 0.55 },
    // Also dithers the 8-bit composite buffers, which quantise the shadows
    // hard enough to band without it.
    uGrain: { value: 0.026 },
    uSharpen: { value: 0.26 },
    uContrast: { value: 1.12 },
    uSaturation: { value: 1.06 },
    uLift: { value: new THREE.Vector3(0.0060, 0.0060, 0.0060) },
    // Subtracted back off after the lift so the frame still has a true zero in
    // it. A lift on its own is a floor no pixel can cross, and every silhouette
    // in the frame then piles up on that one value with nothing between them.
    uBlackPoint: { value: 0.0060 },
    uGain: { value: new THREE.Vector3(1.000, 0.971, 0.940) },
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
      // Luma-only, and bounded. Applying the correction per channel and then
      // flooring each one at zero independently is a hue shift, not a sharpen:
      // on the dark side of a high-contrast edge one channel clamps to zero
      // while the others stay positive, which is what sprayed saturated red
      // and blue fringes along every roofline, container edge and wire in the
      // frame. Driving the whole pixel by a single luma ratio cannot change
      // hue. The clamp keeps the overshoot proportional to the pixel rather
      // than to its unbounded HDR magnitude, so a bright edge against sky
      // stops growing a halo the size of its own radiance.
      float lSharp = luma(color);
      float corr = (lSharp - luma(max(blur, 0.0) * 0.25)) * uSharpen;
      corr = clamp(corr, -0.30 * lSharp, 0.30 * lSharp);
      color *= lSharp > 1e-5 ? (lSharp + corr) / lSharp : 1.0;
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

      // Gain and saturation belong on scene-referred light, above the curve.
      // Below it they were multiplying a value aces() had already clamped to
      // 1.0, so a red gain above unity could only push red past the ceiling
      // and hard-clip, while a blue gain below unity capped blue at code 251
      // however bright the scene got. The result was a frame in which red was
      // the only channel that ever saturated, no neutral white existed
      // anywhere, and every highlight plateaued at a fixed warm rgb(255,227,
      // 211). Above the curve the same numbers are a white balance, and the
      // shoulder rolls all three channels together.
      color = max(color * uGain, 0.0);
      color = mix(vec3(luma(color)), color, uSaturation);

      // Bright saturated sources go white at the core, as film and sensors
      // both do. Without this a strong warm emitter keeps its hue all the way
      // up and reads as a coloured card rather than something incandescent.
      // Converge to neutral, not merely toward it. At 0.65 a warm source still
      // carried a third of its chroma into the shoulder, so red reached the
      // ceiling on its own and 3.7% of a sunlit frame sat at rgb(255,222,218) —
      // a clipped warm plateau with no modelling left in it, which two
      // reviewers described as the tone curve destroying form exactly where the
      // eye goes first. Film and sensors both go white at the core; anything
      // short of that leaves one channel to clip alone.
      float hot = smoothstep(0.42, 1.30, luma(color));
      color = mix(color, vec3(luma(color)), hot * 0.94);

      color = aces(color);

      // Cool the shadows against the warm dawn key — the split-tone that
      // reads as "modern military shooter" more than any other single choice.
      float shadowMask = 1.0 - smoothstep(0.0, 0.34, luma(color));
      color = mix(color, color * vec3(0.90, 0.965, 1.12), shadowMask * uSplit);

      // Lifted black point with a toe rather than a cliff. The lift has to be
      // neutral and the subtraction has to match it, or the frame never
      // reaches zero: the old lift was (0.0040, 0.0060, 0.0125) against a
      // scalar subtraction of 0.0028, so blue could not go below 0.0097
      // display-linear and every silhouette in the game piled up on a floor of
      // rgb(4, 11, 25) — a visibly blue black. uSplit above already cools the
      // shadows, and it does it proportionally instead of as a pedestal.
      color = uLift + color * (1.0 - uLift);
      color = max(color - uBlackPoint, 0.0) / (1.0 - uBlackPoint);

      if (uHurt > 0.001) {
        color = mix(color, vec3(luma(color)) * vec3(1.35, 0.30, 0.24), uHurt * 0.55);
      }
      color += uFlash;

      // Vignetting is aperture falloff: it happens to the light on its way to
      // the sensor, so it multiplies linear radiance. Below the encode it was
      // scaling a gamma-coded value, where a 0.30 constant costs 1.23 stops at
      // the corner rather than the 0.51 it reads as, and skews corner
      // saturation on the way. Grain stays below — that one really is added
      // after the response curve.
      color *= 1.0 - uVignette * smoothstep(0.10, 0.82, r2 * 2.0);

      color = toSRGB(clamp(color, 0.0, 1.0));

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

/** Scalar mirrors of the grade shader's transfer, for validation on the host. */
function acesToneMap(x) {
  const a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return Math.min(1, Math.max(0, (x * (a * x + b)) / (x * (c * x + d) + e)));
}

function srgbTransfer(c) {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

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
    // Rendering into RGBA16F is an extension, not a WebGL2 guarantee. Ask
    // rather than assume: being wrong here costs the entire image.
    const canRenderHalfFloat = renderer.extensions.has('EXT_color_buffer_float')
      || renderer.extensions.has('EXT_color_buffer_half_float');
    const bufferType = (!forceByte && renderer.capabilities.isWebGL2 && canRenderHalfFloat)
      ? THREE.HalfFloatType : THREE.UnsignedByteType;
    this.bufferType = bufferType;
    this.postDisabled = false;
    this._validated = false;
    // Multisampling on the target RenderPass draws into. Razor wire, guy wires
    // and ladder rungs are sub-pixel at this distance, and with no coverage
    // samples the rasteriser simply misses them on roughly one scanline in
    // five — the perimeter wire came out as a dashed line. No post-process
    // antialiasing can repair that, because SMAA and FXAA reconstruct edges
    // from neighbouring pixels and there is nothing in the neighbours to
    // reconstruct from: the geometry was never sampled at all.
    //
    // WebGL1 has no multisampled renderbuffers, so this has to be gated. three
    // ignores `samples` on a WebGL1 context rather than failing, but being
    // explicit keeps the intent legible and costs nothing.
    const msaa = renderer.capabilities.isWebGL2 ? 4 : 0;
    this.msaaSamples = msaa;
    this.composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(w, h, {
      type: bufferType,
      samples: msaa,
      colorSpace: THREE.LinearSRGBColorSpace,
    }));
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(size.x, size.y);

    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    // Ground-truth ambient occlusion. On, on the tiers that can afford it.
    //
    // The comment that used to sit here said OUTPUT.Denoise came back at 1.0
    // across the whole frame at every radius tried, and concluded the horizon
    // search was broken on this depth range. That measurement was taken while
    // validateFrame had silently disabled the entire post chain, so what it
    // actually sampled was the forward render — the same bug that had four
    // reviewers grading a look with no bloom or tone curve in it. Re-measured
    // with the chain live, Denoise reads mean 232/255 with a floor of 167 and
    // some occlusion on 56% of the frame. It was working the whole time.
    //
    // This matters more here than in a normally-lit scene. Four blind
    // reviewers, unprompted, each said nothing in the frame reads as touching
    // the ground, and one ranked contact occlusion above resolution, geometry
    // budget and post-processing combined as a share of the gap to a shipped
    // title.
    this.gtao = new GTAOPass(scene, camera, w, h);
    this.gtao.enabled = false;   // quality tier decides; see applyQuality
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
   * Renders one frame through the real chain and falls back if it comes out
   * black.
   *
   * Feature probes have repeatedly failed to predict this: a device can report
   * every extension, clear and read a target correctly, draw a single quad
   * into one, and still produce nothing from the full multi-pass composite.
   * The only question that has ever given the right answer is whether the
   * composed frame has light in it, so ask that, once, at startup.
   *
   * Two stages: drop to 8-bit buffers, then drop post-processing entirely. A
   * frame that is merely ungraded is worth far more than a black one, and
   * there is no third failure mode — a plain forward render into the default
   * framebuffer is the path the sky already proves works.
   */
  validateFrame() {
    if (this._validated) return true;
    this._validated = true;

    // ?post=force pins the chain on regardless of what this concludes. The
    // guard is a safety net for devices that genuinely cannot composite, and a
    // safety net that fires on a healthy frame is indistinguishable, from the
    // outside, from one that never fires at all. Being able to see the frame
    // it rejected is the only way to tell those apart.
    if (typeof location !== 'undefined'
      && new URLSearchParams(location.search).get('post') === 'force') {
      console.warn('post: validation overridden by ?post=force');
      return true;
    }

    const previous = this.composer.renderToScreen;
    this.composer.renderToScreen = false;
    let threw = null;
    try {
      this.composer.render(1 / 60);
    } catch (e) {
      threw = e;
    }
    this.composer.renderToScreen = previous;

    if (threw) return this.degrade(`composer threw: ${String(threw).slice(0, 120)}`);

    // Either buffer may hold the result, depending on the final pass's swap.
    const composed = Math.max(
      this.meanLuma(this.composer.readBuffer, this.bufferType),
      this.meanLuma(this.composer.writeBuffer, this.bufferType),
    );
    const reference = this.referenceLuma();

    // Nothing to diagnose if the scene itself has no light in it.
    if (reference < 0.005) return true;

    // The two are not in the same space: the reference is scene-referred
    // linear, the composite is display-referred sRGB, and a correct frame is
    // several times brighter than its linear source. Put the reference
    // through the same curve before comparing, or the test reads a working
    // frame as broken and a broken one as fine.
    const expected = srgbTransfer(acesToneMap(reference * this.grade.uniforms.uExposure.value));

    // Deliberately a long way loose. This models exposure and the tone curve
    // and nothing else, but the grade it is judging also applies a contrast
    // power about mid-grey, a lifted black point, a per-channel gain and a
    // vignette in linear — every one of which legitimately darkens the
    // composite relative to this estimate, and none of which indicates a
    // fault. At a 0.35 factor the guard began firing on perfectly good frames
    // the moment the grade was retuned, and silently disabled bloom, sun
    // shafts, the tone curve and antialiasing for an entire review cycle. A
    // whole look was judged, by four people, on a forward render.
    //
    // What this exists to catch is a device that composites black or garbage,
    // and that case is not marginal — it reads at or near zero. Anything with
    // a fifth of the expected light in it has an image in it, whatever the
    // grade did afterwards.
    const dark = composed < 0.02;
    if (!dark && composed >= expected * 0.10) return true;

    return this.degrade(
      `composed ${composed.toFixed(3)} against an expected ${expected.toFixed(3)}`,
    );
  }

  /**
   * Mean luminance of a target's centre, normalised to 0..1.
   *
   * Sampling the centre rather than the whole frame keeps this cheap and
   * avoids the vignette, which darkens exactly the region that would otherwise
   * bias the average toward "broken".
   */
  meanLuma(target, type) {
    if (!target) return -1;
    const w = Math.min(32, target.width), h = Math.min(32, target.height);
    const x = Math.max(0, (target.width - w) >> 1), y = Math.max(0, (target.height - h) >> 1);
    const half = type === THREE.HalfFloatType;
    const buffer = half ? new Uint16Array(w * h * 4) : new Uint8Array(w * h * 4);
    try {
      this.renderer.readRenderTargetPixels(target, x, y, w, h, buffer);
    } catch (e) {
      return -1;
    }
    let sum = 0;
    for (let i = 0; i < buffer.length; i += 4) {
      const r = half ? THREE.DataUtils.fromHalfFloat(buffer[i]) : buffer[i] / 255;
      const g = half ? THREE.DataUtils.fromHalfFloat(buffer[i + 1]) : buffer[i + 1] / 255;
      const b = half ? THREE.DataUtils.fromHalfFloat(buffer[i + 2]) : buffer[i + 2] / 255;
      sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
    return sum / (buffer.length / 4);
  }

  /**
   * Forward-renders the scene into an 8-bit target as a reference.
   *
   * The comparison matters: an absolute threshold cannot tell a broken
   * composite from a scene that is legitimately dark. A plain forward render
   * always works — it is the path the sky already proves — so it establishes
   * what this frame *should* look like.
   */
  referenceLuma() {
    const target = new THREE.WebGLRenderTarget(64, 64, {
      type: THREE.UnsignedByteType, colorSpace: THREE.LinearSRGBColorSpace,
    });
    const previous = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(target);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    const luma = this.meanLuma(target, THREE.UnsignedByteType);
    this.renderer.setRenderTarget(previous);
    target.dispose();
    return luma;
  }

  degrade(reason) {
    if (this.bufferType === THREE.HalfFloatType) {
      console.warn(`post: ${reason}; retrying on 8-bit buffers`);
      this.rebuildBuffers(THREE.UnsignedByteType);
      this._validated = false;
      return this.validateFrame();
    }
    console.warn(`post: ${reason}; disabling post-processing`);
    this.postDisabled = true;
    return false;
  }

  /** Swaps the composer's buffer format, preserving the pass chain. */
  rebuildBuffers(type) {
    const size = this.renderer.getSize(new THREE.Vector2());
    const dpr = this.renderer.getPixelRatio();
    const passes = [...this.composer.passes];

    this.bufferType = type;
    this.composer.renderTarget1.dispose();
    this.composer.renderTarget2.dispose();

    const target = new THREE.WebGLRenderTarget(
      Math.max(1, Math.floor(size.x * dpr)), Math.max(1, Math.floor(size.y * dpr)),
      { type, colorSpace: THREE.LinearSRGBColorSpace },
    );
    this.composer.renderTarget1 = target;
    this.composer.renderTarget2 = target.clone();
    this.composer.writeBuffer = this.composer.renderTarget1;
    this.composer.readBuffer = this.composer.renderTarget2;
    this.composer.passes = passes;
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(size.x, size.y);
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

    if (this.postDisabled) {
      // Last resort: forward render, then the viewmodel over a cleared depth
      // buffer. Ungraded, but visible.
      this.renderer.setRenderTarget(null);
      this.renderer.clear();
      this.renderer.render(this.scene, this.camera);
      if (this.viewmodel) {
        this.renderer.autoClear = false;
        this.renderer.clearDepth();
        this.renderer.render(this.viewmodel.scene, this.viewmodel.camera);
        this.renderer.autoClear = true;
      }
      return;
    }
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
