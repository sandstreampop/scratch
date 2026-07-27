// Procedural PBR texture authoring.
//
// Every surface in the game is generated here as a full material set:
//   albedo (sRGB) + tangent-space normal + ORM (R=ambient occlusion,
//   G=roughness, B=metalness), which is the packing MeshStandardMaterial
//   reads natively via aoMap/.r, roughnessMap/.g, metalnessMap/.b.
//
// Noise is periodic so every map tiles seamlessly at any repeat count.

import * as THREE from 'three';

/* ---------------------------------------------------------------- noise -- */

const PERM = (() => {
  const p = new Uint8Array(512);
  const a = new Uint8Array(256);
  let s = 0x9e3779b9;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 256; i++) a[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = (rnd() * (i + 1)) | 0;
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  for (let i = 0; i < 512; i++) p[i] = a[i & 255];
  return p;
})();

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smoothstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };

const hash2 = (x, y) => PERM[(PERM[x & 255] + (y & 255)) & 255];

function grad2(h, x, y) {
  switch (h & 7) {
    case 0: return x + y;
    case 1: return -x + y;
    case 2: return x - y;
    case 3: return -x - y;
    case 4: return x * 1.414;
    case 5: return -x * 1.414;
    case 6: return y * 1.414;
    default: return -y * 1.414;
  }
}

/** Periodic Perlin noise. Repeats every `px`/`py` units. Returns ~[-1,1]. */
export function perlin(x, y, px, py) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const X0 = ((xi % px) + px) % px, Y0 = ((yi % py) + py) % py;
  const X1 = (X0 + 1) % px, Y1 = (Y0 + 1) % py;
  const u = fade(xf), v = fade(yf);
  return lerp(
    lerp(grad2(hash2(X0, Y0), xf, yf), grad2(hash2(X1, Y0), xf - 1, yf), u),
    lerp(grad2(hash2(X0, Y1), xf, yf - 1), grad2(hash2(X1, Y1), xf - 1, yf - 1), u),
    v,
  );
}

/** Fractal Brownian motion over periodic Perlin. `u`,`v` in [0,1). */
export function fbm(u, v, octaves = 5, base = 8, gain = 0.5, lacunarity = 2) {
  let amp = 1, freq = base, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * perlin(u * freq, v * freq, freq, freq);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** Ridged multifractal — sharp creases, good for cracks and rock. */
export function ridged(u, v, octaves = 5, base = 8, gain = 0.5) {
  let amp = 1, freq = base, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(perlin(u * freq, v * freq, freq, freq));
    sum += amp * n * n;
    norm += amp;
    amp *= gain;
    freq *= 2;
  }
  return sum / norm;
}

/** Periodic Worley/cellular. Returns nearest and second-nearest distances. */
export function worley(u, v, cells) {
  const px = u * cells, py = v * cells;
  const xi = Math.floor(px), yi = Math.floor(py);
  let f1 = 1e9, f2 = 1e9;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const gx = xi + ox, gy = yi + oy;
      const cx = ((gx % cells) + cells) % cells, cy = ((gy % cells) + cells) % cells;
      const h = hash2(cx, cy);
      const jx = gx + PERM[h] / 255, jy = gy + PERM[(h + 71) & 511] / 255;
      const dx = px - jx, dy = py - jy;
      const d = dx * dx + dy * dy;
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
    }
  }
  return { f1: Math.sqrt(f1), f2: Math.sqrt(f2) };
}

/** Domain-warped fbm — organic, non-repetitive-looking flow. */
export function warped(u, v, octaves = 5, base = 6, strength = 0.35) {
  const qx = fbm(u, v, 3, base);
  const qy = fbm(u + 0.37, v + 0.19, 3, base);
  return fbm(u + strength * qx, v + strength * qy, octaves, base);
}

/* ------------------------------------------------------------- assembly -- */

function heightToNormal(height, size, strength) {
  const out = new Uint8Array(size * size * 4);
  const at = (x, y) => height[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const tl = at(x - 1, y - 1), t = at(x, y - 1), tr = at(x + 1, y - 1);
      const l = at(x - 1, y), r = at(x + 1, y);
      const bl = at(x - 1, y + 1), b = at(x, y + 1), br = at(x + 1, y + 1);
      // Sobel gradient in image space.
      const gx = (tr + 2 * r + br) - (tl + 2 * l + bl);
      const gy = (bl + 2 * b + br) - (tl + 2 * t + tr);
      // Tangent-space Y points opposite image Y (OpenGL normal-map convention).
      const nx = -gx * strength, ny = gy * strength, nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      const i = (y * size + x) * 4;
      out[i] = (nx * inv * 0.5 + 0.5) * 255;
      out[i + 1] = (ny * inv * 0.5 + 0.5) * 255;
      out[i + 2] = (nz * inv * 0.5 + 0.5) * 255;
      out[i + 3] = 255;
    }
  }
  return out;
}

function dataTexture(data, size, colorSpace, aniso) {
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = colorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}

/**
 * Runs a per-texel sampler and assembles the three maps.
 * The sampler writes into a reusable scratch record:
 *   r,g,b   linear-ish albedo in [0,1] (written out as sRGB bytes)
 *   h       height in [0,1] — drives the normal map
 *   rough   roughness in [0,1]
 *   metal   metalness in [0,1]
 *   ao      baked cavity occlusion in [0,1]
 */
function build(size, sampler, normalStrength, aniso) {
  const n = size * size;
  const albedo = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const height = new Float32Array(n);
  const c = { r: 0.5, g: 0.5, b: 0.5, h: 0.5, rough: 0.8, metal: 0, ao: 1 };
  const inv = 1 / size;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      c.r = 0.5; c.g = 0.5; c.b = 0.5; c.h = 0.5; c.rough = 0.8; c.metal = 0; c.ao = 1;
      sampler(x * inv, y * inv, c);
      const j = i * 4;
      albedo[j] = clamp(c.r, 0, 1) * 255;
      albedo[j + 1] = clamp(c.g, 0, 1) * 255;
      albedo[j + 2] = clamp(c.b, 0, 1) * 255;
      albedo[j + 3] = 255;
      orm[j] = clamp(c.ao, 0, 1) * 255;
      orm[j + 1] = clamp(c.rough, 0, 1) * 255;
      orm[j + 2] = clamp(c.metal, 0, 1) * 255;
      orm[j + 3] = 255;
      height[i] = c.h;
    }
  }

  return {
    map: dataTexture(albedo, size, THREE.SRGBColorSpace, aniso),
    normalMap: dataTexture(heightToNormal(height, size, normalStrength), size, THREE.NoColorSpace, aniso),
    ormMap: dataTexture(orm, size, THREE.NoColorSpace, aniso),
  };
}

/* ------------------------------------------------------------- samplers -- */
// Colours are authored as sRGB-ish values read off real photo references:
// dawn-lit Middle-Eastern outpost — sun-bleached plaster, oxidised steel,
// hot dust, olive-drab military kit.

const SAMPLERS = {
  /** Fine desert sand: wind ripples, scattered grit, occasional pebble. */
  sand(u, v, c) {
    const ripple = Math.sin((u * 46 + fbm(u, v, 3, 4) * 5.5) * Math.PI) * 0.5 + 0.5;
    const dunes = fbm(u, v, 4, 3) * 0.5 + 0.5;
    const grain = fbm(u, v, 3, 96) * 0.5 + 0.5;
    const peb = worley(u, v, 26);
    const pebble = smoothstep(0.20, 0.06, peb.f1);
    const patch = smoothstep(0.35, 0.65, warped(u, v, 4, 4) * 0.5 + 0.5);

    c.h = dunes * 0.42 + ripple * 0.16 + grain * 0.1 + pebble * 0.32;

    // Dry pale sand grading into damper, darker, redder sand.
    const t = clamp(dunes * 0.55 + ripple * 0.22 + patch * 0.35, 0, 1);
    c.r = lerp(0.560, 0.404, t) + grain * 0.055;
    c.g = lerp(0.472, 0.316, t) + grain * 0.048;
    c.b = lerp(0.346, 0.222, t) + grain * 0.036;

    // Pebbles read cooler and slightly glossier than the sand around them.
    c.r = lerp(c.r, 0.372, pebble); c.g = lerp(c.g, 0.352, pebble); c.b = lerp(c.b, 0.318, pebble);

    c.rough = lerp(0.97, 0.80, pebble) - ripple * 0.03;
    c.metal = 0;
    c.ao = 1 - pebble * 0.30 - (1 - ripple) * 0.10;
  },

  /** Compacted dirt / gravel track — the courtyard floor. */
  dirt(u, v, c) {
    const base = warped(u, v, 5, 5) * 0.5 + 0.5;
    const grav = worley(u, v, 34);
    const stone = smoothstep(0.24, 0.07, grav.f1);
    const crack = smoothstep(0.62, 0.98, ridged(u, v, 4, 7));
    const grain = fbm(u, v, 3, 110) * 0.5 + 0.5;
    const tyre = smoothstep(0.45, 0.55, Math.sin(v * 180 * Math.PI) * 0.5 + 0.5)
      * smoothstep(0.30, 0.10, Math.abs(u - 0.33)) * 0.5;

    c.h = base * 0.34 + stone * 0.40 + grain * 0.08 - crack * 0.30 - tyre * 0.12;

    const t = base * 0.7 + grain * 0.3;
    c.r = lerp(0.318, 0.196, t); c.g = lerp(0.258, 0.152, t); c.b = lerp(0.192, 0.112, t);
    c.r = lerp(c.r, 0.300, stone * 0.8); c.g = lerp(c.g, 0.282, stone * 0.8); c.b = lerp(c.b, 0.258, stone * 0.8);
    c.r *= 1 - crack * 0.42; c.g *= 1 - crack * 0.42; c.b *= 1 - crack * 0.42;
    c.r *= 1 - tyre * 0.25; c.g *= 1 - tyre * 0.25; c.b *= 1 - tyre * 0.25;

    c.rough = lerp(0.95, 0.74, stone);
    c.metal = 0;
    c.ao = 1 - crack * 0.55 - stone * 0.18 - tyre * 0.15;
  },

  /** Sun-bleached mud-brick plaster with blown render and exposed brick. */
  plaster(u, v, c) {
    const coarse = warped(u, v, 5, 4) * 0.5 + 0.5;
    const fine = fbm(u, v, 4, 40) * 0.5 + 0.5;
    // Rectangular brick lattice revealed where the render has failed.
    const rows = 9, cols = 4.5;
    const ry = v * rows, rx = u * cols + (Math.floor(ry) % 2) * 0.5;
    const mx = Math.abs((rx % 1) - 0.5), my = Math.abs((ry % 1) - 0.5);
    const mortar = smoothstep(0.40, 0.48, mx) + smoothstep(0.36, 0.46, my);
    const blown = smoothstep(0.52, 0.78, warped(u * 1.3, v * 1.3, 4, 3) * 0.5 + 0.5);
    const crack = smoothstep(0.70, 0.96, ridged(u, v, 5, 6));
    // Rain streaking runs downward from the top edge.
    const streak = smoothstep(0.30, 0.85, fbm(u * 6, v * 0.35, 3, 12) * 0.5 + 0.5) * smoothstep(0.0, 0.55, v) * 0.55;
    const grime = smoothstep(0.72, 1.0, v) * 0.5 + smoothstep(0.10, 0.0, v) * 0.35;

    c.h = 0.62 + coarse * 0.16 + fine * 0.08 - blown * 0.30 - clamp(mortar, 0, 1) * blown * 0.30 - crack * 0.34;

    let l = 0.760 + fine * 0.075 - coarse * 0.085;
    c.r = l * 1.005; c.g = l * 0.945; c.b = l * 0.842;              // warm limewash
    // Exposed brick beneath.
    c.r = lerp(c.r, 0.404, blown); c.g = lerp(c.g, 0.288, blown); c.b = lerp(c.b, 0.212, blown);
    // Dirt wash at plinth and cornice, plus vertical rain streaks.
    const soil = clamp(grime + streak, 0, 1);
    c.r = lerp(c.r, 0.246, soil * 0.72); c.g = lerp(c.g, 0.212, soil * 0.72); c.b = lerp(c.b, 0.176, soil * 0.72);
    c.r *= 1 - crack * 0.36; c.g *= 1 - crack * 0.36; c.b *= 1 - crack * 0.36;

    c.rough = clamp(0.90 + coarse * 0.06 - blown * 0.05, 0, 1);
    c.metal = 0;
    c.ao = 1 - crack * 0.55 - blown * 0.26 - clamp(mortar, 0, 1) * blown * 0.30 - soil * 0.14;
  },

  /** Poured concrete: form-board seams, aggregate pitting, water staining. */
  concrete(u, v, c) {
    const cloud = warped(u, v, 5, 4) * 0.5 + 0.5;
    const pit = worley(u, v, 52);
    const hole = smoothstep(0.13, 0.02, pit.f1);
    const agg = smoothstep(0.55, 0.80, worley(u, v, 30).f2 - worley(u, v, 30).f1);
    const grain = fbm(u, v, 3, 128) * 0.5 + 0.5;
    const seam = smoothstep(0.470, 0.496, Math.abs((v * 3) % 1 - 0.5)) * 0.8;
    const crack = smoothstep(0.80, 0.99, ridged(u, v, 5, 5));
    const stain = smoothstep(0.40, 0.90, fbm(u * 3, v * 0.6, 4, 9) * 0.5 + 0.5);

    c.h = 0.66 + cloud * 0.10 + grain * 0.05 + agg * 0.05 - hole * 0.42 - seam * 0.22 - crack * 0.30;

    let l = 0.518 + cloud * 0.088 + grain * 0.050 - stain * 0.115;
    c.r = l * 1.00; c.g = l * 0.985; c.b = l * 0.955;
    c.r = lerp(c.r, 0.300, hole); c.g = lerp(c.g, 0.292, hole); c.b = lerp(c.b, 0.284, hole);
    c.r *= 1 - crack * 0.32; c.g *= 1 - crack * 0.32; c.b *= 1 - crack * 0.32;
    c.r *= 1 - seam * 0.18; c.g *= 1 - seam * 0.18; c.b *= 1 - seam * 0.18;

    c.rough = clamp(0.84 + grain * 0.09 - stain * 0.10, 0, 1);
    c.metal = 0;
    c.ao = 1 - hole * 0.62 - crack * 0.45 - seam * 0.30;
  },

  /** Heavily oxidised steel — barrels, containers, corrugated roofing. */
  rust(u, v, c) {
    const patch = warped(u, v, 5, 5, 0.5) * 0.5 + 0.5;
    const flake = worley(u, v, 40);
    const scab = smoothstep(0.30, 0.05, flake.f1);
    const pit = smoothstep(0.10, 0.01, worley(u, v, 90).f1);
    const grain = fbm(u, v, 3, 150) * 0.5 + 0.5;
    const streak = smoothstep(0.35, 0.90, fbm(u * 9, v * 0.4, 4, 14) * 0.5 + 0.5);
    // Rust coverage: dominant, but bare metal survives on high spots.
    const rust = clamp(patch * 0.85 + streak * 0.45 + scab * 0.35, 0, 1);
    const bare = smoothstep(0.62, 0.30, rust);

    c.h = 0.60 + patch * 0.14 + scab * 0.22 - pit * 0.40 + grain * 0.06;

    // Bare steel, cool and dark.
    let sr = 0.196 + grain * 0.075, sg = 0.204 + grain * 0.075, sb = 0.216 + grain * 0.075;
    // Rust ramps orange -> deep red-brown with depth.
    const rr = lerp(0.478, 0.244, patch), rg = lerp(0.238, 0.112, patch), rb = lerp(0.108, 0.062, patch);
    const m = clamp(rust, 0, 1);
    c.r = lerp(sr, rr, m); c.g = lerp(sg, rg, m); c.b = lerp(sb, rb, m);
    c.r *= 1 - pit * 0.4; c.g *= 1 - pit * 0.4; c.b *= 1 - pit * 0.4;

    // Oxide is a dielectric; only the bare steel stays metallic.
    c.metal = clamp(bare * 0.92, 0, 1);
    c.rough = lerp(0.94, 0.42, bare) + scab * 0.04;
    c.ao = 1 - pit * 0.55 - scab * 0.30;
  },

  /** Chipped olive-drab paint over steel — vehicles, ammo crates, doors. */
  painted(u, v, c) {
    const wear = warped(u, v, 5, 6, 0.45) * 0.5 + 0.5;
    const chip = smoothstep(0.60, 0.80, wear) + smoothstep(0.22, 0.06, worley(u, v, 46).f1) * 0.7;
    const chipped = clamp(chip, 0, 1);
    const grain = fbm(u, v, 3, 140) * 0.5 + 0.5;
    const scuff = smoothstep(0.45, 0.85, fbm(u * 14, v * 1.4, 3, 18) * 0.5 + 0.5);
    const dust = smoothstep(0.30, 0.80, fbm(u, v, 4, 7) * 0.5 + 0.5);

    c.h = 0.66 + wear * 0.08 - chipped * 0.26 + grain * 0.05;

    // Olive drab.
    let pr = 0.184 + grain * 0.030, pg = 0.196 + grain * 0.032, pb = 0.126 + grain * 0.024;
    pr = lerp(pr, pr * 1.35, scuff * 0.4); pg = lerp(pg, pg * 1.35, scuff * 0.4); pb = lerp(pb, pb * 1.35, scuff * 0.4);
    // Rusted substrate showing through chips.
    const mr = 0.286, mg = 0.166, mb = 0.104;
    c.r = lerp(pr, mr, chipped); c.g = lerp(pg, mg, chipped); c.b = lerp(pb, mb, chipped);
    // Fine dust film knocks everything toward tan.
    c.r = lerp(c.r, 0.404, dust * 0.20); c.g = lerp(c.g, 0.354, dust * 0.20); c.b = lerp(c.b, 0.272, dust * 0.20);

    c.metal = chipped * 0.55;
    c.rough = lerp(0.58, 0.86, clamp(chipped + dust * 0.4, 0, 1)) - scuff * 0.06;
    c.ao = 1 - chipped * 0.30;
  },

  /** Woven burlap sandbag — coarse over-under weave, sun-rotted. */
  burlap(u, v, c) {
    const T = 34;
    const wu = u * T, wv = v * T;
    const fu = wu % 1, fv = wv % 1;
    const over = (Math.floor(wu) + Math.floor(wv)) % 2 === 0;
    // Rounded thread cross-section, alternating which yarn sits proud.
    const tu = Math.sin(fu * Math.PI), tv = Math.sin(fv * Math.PI);
    const thread = over ? tu * 0.85 + tv * 0.25 : tv * 0.85 + tu * 0.25;
    const fray = fbm(u, v, 4, 60) * 0.5 + 0.5;
    const dirty = warped(u, v, 4, 4) * 0.5 + 0.5;
    const sun = smoothstep(0.35, 0.85, fbm(u, v, 3, 5) * 0.5 + 0.5);

    c.h = thread * 0.62 + fray * 0.14 + 0.15;

    const l = 0.470 + thread * 0.135 + fray * 0.075;
    c.r = l * 1.02; c.g = l * 0.878; c.b = l * 0.634;
    c.r = lerp(c.r, 0.286, dirty * 0.45); c.g = lerp(c.g, 0.242, dirty * 0.45); c.b = lerp(c.b, 0.180, dirty * 0.45);
    c.r = lerp(c.r, c.r * 1.16, sun * 0.5); c.g = lerp(c.g, c.g * 1.13, sun * 0.5); c.b = lerp(c.b, c.b * 1.08, sun * 0.5);

    c.rough = 0.96 - thread * 0.05;
    c.metal = 0;
    c.ao = 0.55 + thread * 0.45 - dirty * 0.12;
  },

  /** Weathered timber plank — grain, splits, knots, nail staining. */
  wood(u, v, c) {
    const planks = 6;
    const pi = Math.floor(v * planks);
    const pv = (v * planks) % 1;
    const jitter = (PERM[(pi * 37) & 511] / 255 - 0.5) * 0.35;
    // Grain rings run along the plank, warped by the ring-jitter per board.
    const ring = Math.sin((pv * 5.5 + jitter + fbm(u * 0.7, v, 3, 5) * 2.4) * Math.PI * 2) * 0.5 + 0.5;
    const grain = fbm(u * 3.2, v * 30, 4, 26) * 0.5 + 0.5;
    const split = smoothstep(0.74, 0.97, ridged(u * 1.5, v * 6, 4, 9));
    const gap = smoothstep(0.055, 0.0, Math.min(pv, 1 - pv));
    const knotD = worley(u, v, 5).f1;
    const knot = smoothstep(0.13, 0.02, knotD);

    c.h = 0.66 + ring * 0.14 + grain * 0.11 - split * 0.34 - gap * 0.85 - knot * 0.22;

    let l = 0.372 + ring * 0.115 + grain * 0.075;
    c.r = l * 1.06; c.g = l * 0.900; c.b = l * 0.708;
    // Silvered, UV-bleached surface on the exposed face.
    const grey = smoothstep(0.30, 0.85, fbm(u, v, 3, 4) * 0.5 + 0.5);
    c.r = lerp(c.r, l * 0.93, grey * 0.6); c.g = lerp(c.g, l * 0.93, grey * 0.6); c.b = lerp(c.b, l * 0.90, grey * 0.6);
    c.r = lerp(c.r, 0.128, knot); c.g = lerp(c.g, 0.092, knot); c.b = lerp(c.b, 0.062, knot);
    c.r *= 1 - gap * 0.85; c.g *= 1 - gap * 0.85; c.b *= 1 - gap * 0.85;
    c.r *= 1 - split * 0.35; c.g *= 1 - split * 0.35; c.b *= 1 - split * 0.35;

    c.rough = clamp(0.90 + grain * 0.07 - grey * 0.04, 0, 1);
    c.metal = 0;
    c.ao = 1 - gap * 0.80 - split * 0.42 - knot * 0.35;
  },

  /** Heavy canvas tarpaulin — tight weave, folds, sun-faded dye. */
  canvas(u, v, c) {
    const T = 128;
    const fu = (u * T) % 1, fv = (v * T) % 1;
    const weave = (Math.sin(fu * Math.PI) + Math.sin(fv * Math.PI)) * 0.5;
    const fold = fbm(u * 0.9, v * 2.6, 4, 4) * 0.5 + 0.5;
    const fade_ = smoothstep(0.25, 0.85, fbm(u, v, 3, 6) * 0.5 + 0.5);
    const stain = smoothstep(0.55, 0.95, warped(u, v, 4, 5) * 0.5 + 0.5);

    c.h = 0.55 + weave * 0.14 + fold * 0.30;

    let l = 0.300 + weave * 0.045 + fold * 0.075;
    c.r = l * 1.10; c.g = l * 1.00; c.b = l * 0.760;
    c.r = lerp(c.r, c.r * 1.30, fade_ * 0.55); c.g = lerp(c.g, c.g * 1.26, fade_ * 0.55); c.b = lerp(c.b, c.b * 1.20, fade_ * 0.55);
    c.r = lerp(c.r, 0.166, stain * 0.5); c.g = lerp(c.g, 0.146, stain * 0.5); c.b = lerp(c.b, 0.118, stain * 0.5);

    c.rough = 0.90 - fade_ * 0.05;
    c.metal = 0;
    c.ao = 0.70 + weave * 0.30 - fold * 0.16;
  },

  /** Phosphate-finish gunmetal — the weapon receiver and barrel. */
  gunmetal(u, v, c) {
    const grain = fbm(u * 2, v * 0.35, 4, 90) * 0.5 + 0.5;      // machining direction
    const speck = fbm(u, v, 3, 200) * 0.5 + 0.5;
    const wear = smoothstep(0.60, 0.90, warped(u, v, 4, 8, 0.3) * 0.5 + 0.5);
    const edge = smoothstep(0.20, 0.04, worley(u, v, 60).f1);

    c.h = 0.68 + speck * 0.10 + grain * 0.05 - edge * 0.16;

    const l = 0.052 + speck * 0.030 + grain * 0.016;
    c.r = l; c.g = l * 1.02; c.b = l * 1.08;
    // Bare steel polished through at wear points.
    c.r = lerp(c.r, 0.320, wear * 0.8); c.g = lerp(c.g, 0.328, wear * 0.8); c.b = lerp(c.b, 0.340, wear * 0.8);

    c.metal = 1;
    c.rough = clamp(lerp(0.62, 0.22, wear) + speck * 0.06, 0.05, 1);
    c.ao = 1 - edge * 0.25;
  },

  /** Glass-filled polymer — handguard, stock, grips. */
  polymer(u, v, c) {
    const stipple = smoothstep(0.35, 0.15, worley(u, v, 130).f1);
    const mould = fbm(u, v, 3, 60) * 0.5 + 0.5;
    const scuff = smoothstep(0.55, 0.90, fbm(u * 10, v * 1.2, 3, 16) * 0.5 + 0.5);

    c.h = 0.60 + stipple * 0.30 + mould * 0.06;

    const l = 0.062 + mould * 0.020 + stipple * 0.018;
    c.r = l * 1.06; c.g = l * 1.00; c.b = l * 0.92;
    c.r += scuff * 0.045; c.g += scuff * 0.042; c.b += scuff * 0.038;

    c.metal = 0;
    c.rough = clamp(0.68 - stipple * 0.10 + mould * 0.05 - scuff * 0.12, 0, 1);
    c.ao = 1 - stipple * 0.30;
  },

  /** Corrugated galvanised sheet — the roofing and perimeter fencing. */
  corrugated(u, v, c) {
    const wave = Math.sin(u * Math.PI * 2 * 18);
    const zinc = fbm(u, v, 4, 22) * 0.5 + 0.5;
    const spangle = smoothstep(0.55, 0.30, worley(u, v, 18).f1);
    const rust = clamp(smoothstep(0.45, 0.90, warped(u, v, 4, 4) * 0.5 + 0.5)
      + smoothstep(0.55, 1.0, v) * 0.55, 0, 1);
    const dent = fbm(u, v, 3, 9) * 0.5 + 0.5;

    c.h = 0.5 + wave * 0.42 + dent * 0.08 + zinc * 0.03;

    let l = 0.400 + zinc * 0.100 + spangle * 0.060;
    c.r = l * 0.98; c.g = l * 1.00; c.b = l * 1.03;
    c.r = lerp(c.r, 0.352, rust * 0.9); c.g = lerp(c.g, 0.176, rust * 0.9); c.b = lerp(c.b, 0.088, rust * 0.9);

    c.metal = clamp(1 - rust * 0.85, 0, 1);
    c.rough = lerp(0.40, 0.92, rust) - spangle * 0.05;
    c.ao = 1 - rust * 0.18 - smoothstep(0.2, 0.0, Math.abs(wave)) * 0.12;
  },
};

/* --------------------------------------------------------------- public -- */

const RESOLUTION = {
  sand: 1024, dirt: 1024, plaster: 1024, concrete: 1024,
  rust: 512, painted: 512, burlap: 512, wood: 512,
  canvas: 512, gunmetal: 512, polymer: 512, corrugated: 512,
};

const NORMAL_STRENGTH = {
  sand: 0.9, dirt: 1.5, plaster: 1.4, concrete: 1.2,
  rust: 1.6, painted: 1.0, burlap: 2.6, wood: 1.7,
  canvas: 1.2, gunmetal: 0.9, polymer: 1.4, corrugated: 3.2,
};

const cache = new Map();
let anisotropy = 8;
let resolutionScale = 1;

export function setAnisotropy(value) { anisotropy = value; }

/**
 * Scales every surface's authored resolution.
 *
 * Generation is CPU-bound fractal noise, so cost falls with the square of this
 * value: at 0.25 a phone builds the whole material set in roughly a
 * sixteenth of the time and holds a sixteenth of the texture memory, which is
 * the difference between booting and having iOS discard the WebGL context.
 * Must be set before the first `maps()` call.
 */
export function setResolutionScale(value) {
  resolutionScale = Math.max(0.125, Math.min(1, value));
}

/** Returns `{ map, normalMap, ormMap }` for a named surface. Cached. */
export function maps(name) {
  let entry = cache.get(name);
  if (!entry) {
    const sampler = SAMPLERS[name];
    if (!sampler) throw new Error(`unknown surface "${name}"`);
    // Round to a power of two so mipmaps stay clean.
    const base = RESOLUTION[name] ?? 512;
    const size = Math.max(64, 2 ** Math.round(Math.log2(base * resolutionScale)));
    entry = build(size, sampler, NORMAL_STRENGTH[name] ?? 1.2, anisotropy);
    cache.set(name, entry);
  }
  return entry;
}

/**
 * Builds a MeshStandardMaterial wired to a named surface.
 * `repeat` tiles all three maps together; `overrides` patches the material.
 */
export function material(name, repeat = 1, overrides = {}) {
  const { map, normalMap, ormMap } = maps(name);
  const r = Array.isArray(repeat) ? repeat : [repeat, repeat];

  // Clone so each material can tile independently off one shared image.
  const m0 = map.clone(), n0 = normalMap.clone(), o0 = ormMap.clone();
  for (const t of [m0, n0, o0]) {
    t.needsUpdate = true;
    t.repeat.set(r[0], r[1]);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
  }

  const mat = new THREE.MeshStandardMaterial({
    map: m0,
    normalMap: n0,
    aoMap: o0,
    roughnessMap: o0,
    metalnessMap: o0,
    roughness: 1,
    metalness: 1,
    aoMapIntensity: 1,
    normalScale: new THREE.Vector2(1, 1),
    envMapIntensity: 1,
    dithering: true,
  });
  Object.assign(mat, overrides);
  return mat;
}

export const SURFACES = Object.keys(SAMPLERS);
