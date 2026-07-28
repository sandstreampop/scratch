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

/**
 * Periodic Worley/cellular. Returns nearest and second-nearest distances plus
 * `id`, a stable [0,1) hash of the winning cell — the cheapest way to give
 * every pebble, flake or aggregate grain its own colour.
 */
export function worley(u, v, cells) {
  const px = u * cells, py = v * cells;
  const xi = Math.floor(px), yi = Math.floor(py);
  let f1 = 1e9, f2 = 1e9, id = 0;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const gx = xi + ox, gy = yi + oy;
      const cx = ((gx % cells) + cells) % cells, cy = ((gy % cells) + cells) % cells;
      const h = hash2(cx, cy);
      const jx = gx + PERM[h] / 255, jy = gy + PERM[(h + 71) & 511] / 255;
      const dx = px - jx, dy = py - jy;
      const d = dx * dx + dy * dy;
      if (d < f1) { f2 = f1; f1 = d; id = PERM[(h + 149) & 511] / 255; } else if (d < f2) { f2 = d; }
    }
  }
  return { f1: Math.sqrt(f1), f2: Math.sqrt(f2), id };
}

/** Domain-warped fbm — organic, non-repetitive-looking flow. */
export function warped(u, v, octaves = 5, base = 6, strength = 0.35) {
  const qx = fbm(u, v, 3, base);
  const qy = fbm(u + 0.37, v + 0.19, 3, base);
  return fbm(u + strength * qx, v + strength * qy, octaves, base);
}

/**
 * fbm for the grain and pitting octaves, with the top octave held below the
 * map's own Nyquist limit.
 *
 * An octave finer than about four texels per cycle does not resolve — it
 * aliases into flat noise, gets averaged out by the Sobel in heightToNormal,
 * and costs a full noise lookup to achieve nothing. Capping against `size`
 * also keeps micro-detail proportionate when setResolutionScale drops a
 * 1024 map to 256.
 */
function micro(u, v, base, octaves, size) {
  const limit = Math.max(4, size >> 2);
  const b = Math.min(base, limit);
  let n = 1;
  while (n < octaves && b * 2 ** n <= limit) n++;
  return fbm(u, v, n, b);
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
      // Sobel with the diagonal taps halved. Full Sobel averages across the
      // gradient direction, which quietly erases the two-to-four-texel grain
      // and pitting octaves — exactly the detail the player is close enough
      // to see. Leaning on the central difference keeps them.
      const gx = 2 * (r - l) + 0.5 * ((tr + br) - (tl + bl));
      const gy = 2 * (b - t) + 0.5 * ((bl + br) - (tl + tr));
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
      sampler(x * inv, y * inv, c, size);
      const j = i * 4;
      albedo[j] = clamp(c.r, 0, 1) * 255;
      albedo[j + 1] = clamp(c.g, 0, 1) * 255;
      albedo[j + 2] = clamp(c.b, 0, 1) * 255;
      albedo[j + 3] = 255;
      orm[j] = clamp(c.ao, 0, 1) * 255;
      // Hard floor: a zero-roughness texel collapses the specular lobe to a
      // point and the environment lookup returns the unfiltered mip, which
      // shows up as fireflies the bloom pass then smears across the frame.
      orm[j + 1] = clamp(c.rough, 0.06, 1) * 255;
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
// Colours are authored as sRGB bytes, so the numbers below are *encoded*
// values. Measured albedo lives between 0.03 and 0.85 linear, which is 0.19
// to 0.94 encoded; anything outside that reads as a hole or as paper. Useful
// anchors: 0.30 enc = 0.073 lin (black polymer), 0.50 enc = 0.214 lin (dry
// dirt), 0.68 enc = 0.42 lin (desert sand), 0.78 enc = 0.57 lin (limewash).
//
// Metals carry F0 in the albedo channel, not a diffuse colour: iron sits near
// 0.56 linear, so bare steel must be authored around 0.75 encoded. Authoring
// a metal dark is what turns barrels and receivers into black cut-outs.
//
// Three rules keep the maps from announcing themselves.
//
// Noise multipliers on u/v must be whole numbers — perlin's period is tied to
// its own frequency, so fbm(u * 1.3, …) tears at the wrap.
//
// Nothing may key off raw u or v as a gradient: at any repeat other than one
// it bands, and a band that lines up with the tile grid is unmistakable.
//
// And no feature at tile scale may carry much contrast. One dark blotch in a
// map is one dark blotch repeated forty times across the compound, which is
// the single loudest tiling tell there is. Contrast belongs in the octaves
// smaller than a tile; the large scale is the macro pass's job, and it works
// in world space where repetition cannot reach it.

// Diffuse albedo across these samplers is a ladder, and it has to stay one.
//
// Every material here was authored between 0.30 and 0.77 peak — a two-to-one
// spread — while the real ladder from limewash to tyre rubber spans about
// twenty to one. Twelve blind reviewers across three panels each reported that
// steel, wood, cloth, concrete and rubber all answer the light identically,
// and this was the mechanism: albedo carried almost no information about what
// a surface was made of, so nothing but the normal map distinguished them, and
// the normal map mips away.
//
// Roughly where real materials sit, for anyone retuning one of these:
//   limewash plaster 0.60-0.70   dry sand 0.35-0.45   galvanised sheet 0.35-0.50
//   concrete 0.25-0.40           hessian 0.30-0.40    weathered timber 0.25-0.35
//   olive-drab canvas 0.12-0.20  polymer furniture 0.05-0.12
//   phosphated steel 0.05-0.08   tyre rubber 0.03-0.05
//
// Raising one because it "looks too dark" is almost always the wrong fix; the
// exposure and the key-to-fill ratio are the levers for that, and a surface
// brighter than its real counterpart clips before the tone curve can shape it.
const SAMPLERS = {
  /** Fine desert sand: wind ripples, scattered grit, occasional pebble. */
  sand(u, v, c, s) {
    // Metre-scale drift, deliberately gentle: it sets where sand is loose and
    // where it is packed, but the ground repeats every four metres and a
    // strong dune here would be a strong dune forty times over.
    const drift = warped(u, v, 4, 2, 0.55) * 0.5 + 0.5;
    const flow = fbm(u, v, 3, 3);
    // Ripples meander with the airflow and only form where sand is loose.
    const ripple = Math.sin((u * 30 + v * 8 + flow * 7) * Math.PI) * 0.5 + 0.5;
    const loose = smoothstep(0.34, 0.72, drift);
    const patchy = fbm(u + 0.61, v + 0.23, 3, 8) * 0.5 + 0.5;
    const grain = micro(u, v, 48, 3, s) * 0.5 + 0.5;
    const grit = micro(u, v, 160, 2, s) * 0.5 + 0.5;
    // Pebbles collect in lag deposits where the fines have blown out, never
    // in an even scatter — an even scatter is what reads as polka dots.
    const lag = smoothstep(0.44, 0.76, fbm(u + 0.31, v + 0.77, 4, 3) * 0.5 + 0.5);
    const peb = worley(u, v, 22);
    // Grading the stones by cell hash matters more than it sounds: a lag of
    // identically sized clasts is read instantly as a stamped pattern, and
    // the cells that fall below the threshold leave the gaps that sell it.
    const pebble = smoothstep(0.22 * peb.id, 0.02, peb.f1) * lag;

    // A heightmap's slope is amplitude over wavelength, so the metre-scale
    // drift below barely tilts a texel however tall it is, and the ripple
    // amplitude has to be generous to register at a 30 cm wavelength.
    c.h = 0.26 + drift * 0.30 + ripple * loose * 0.18 + grain * 0.11 + grit * 0.06 + pebble * 0.24;

    // Dry wind-polished sand grading into damper, redder sand in the hollows.
    // The half-metre band does the work here: it is too fine for the eye to
    // clock as a repeat and coarse enough to survive out to twenty metres,
    // which is the range at which flat ground stops looking like ground.
    const t = clamp(drift * 0.42 + patchy * 0.30 + ripple * loose * 0.12 + grain * 0.22, 0, 1);
    c.r = lerp(0.678, 0.516, t) + grit * 0.030;
    c.g = lerp(0.596, 0.436, t) + grit * 0.026;
    c.b = lerp(0.470, 0.334, t) + grit * 0.020;

    // Pebbles are pale chert and dark basalt in roughly equal measure; a
    // single pebble colour is as obvious a repeat as a single pebble shape.
    const pr = lerp(0.628, 0.436, peb.id), pg = lerp(0.602, 0.414, peb.id), pb = lerp(0.556, 0.386, peb.id);
    c.r = lerp(c.r, pr, pebble); c.g = lerp(c.g, pg, pebble); c.b = lerp(c.b, pb, pebble);

    // Loose sand is near-Lambertian; wind-packed crust and pebbles are not.
    c.rough = lerp(0.99, 0.84, (1 - loose) * 0.6 + (1 - patchy) * 0.4) - pebble * 0.34;
    c.metal = 0;
    c.ao = 1 - pebble * 0.20 - (1 - ripple) * loose * 0.06;
  },

  /** Compacted dirt / gravel track — the courtyard floor. */
  dirt(u, v, c, s) {
    const base = warped(u, v, 5, 3) * 0.5 + 0.5;
    // Where fines have washed in the surface is smooth and pale; elsewhere
    // the binder is gone and the gravel stands proud.
    const fines = smoothstep(0.32, 0.66, fbm(u + 0.53, v + 0.19, 4, 2) * 0.5 + 0.5);
    const grav = worley(u, v, 28);
    const stone = smoothstep(0.20, 0.06, grav.f1) * (1 - fines * 0.7);
    // Ridged noise draws a very recognisable tangle. Kept faint and confined
    // to the silted patches it reads as dried mud; any louder and the eye
    // learns the shape and sees the same tangle stamped across the courtyard.
    const crack = smoothstep(0.74, 0.97, ridged(u, v, 4, 9)) * fines;
    const grain = micro(u, v, 80, 3, s) * 0.5 + 0.5;
    const dust = micro(u, v, 200, 2, s) * 0.5 + 0.5;

    c.h = 0.30 + base * 0.26 + stone * 0.32 + grain * 0.10 + dust * 0.05 - crack * 0.28;

    const t = clamp(base * 0.66 + grain * 0.34, 0, 1);
    c.r = lerp(0.520, 0.372, t) + dust * 0.026;
    c.g = lerp(0.452, 0.316, t) + dust * 0.022;
    c.b = lerp(0.362, 0.248, t) + dust * 0.016;
    // Pale limestone gravel through to dark ironstone.
    const sr = lerp(0.578, 0.408, grav.id), sg = lerp(0.556, 0.382, grav.id), sb = lerp(0.514, 0.344, grav.id);
    c.r = lerp(c.r, sr, stone * 0.85); c.g = lerp(c.g, sg, stone * 0.85); c.b = lerp(c.b, sb, stone * 0.85);
    // Fines settle out lighter and chalkier than the substrate.
    c.r = lerp(c.r, 0.562, fines * 0.30); c.g = lerp(c.g, 0.500, fines * 0.30); c.b = lerp(c.b, 0.412, fines * 0.30);
    c.r *= 1 - crack * 0.22; c.g *= 1 - crack * 0.22; c.b *= 1 - crack * 0.22;

    // Traffic burnishes exposed stone; loose fines stay dead matt.
    c.rough = clamp(lerp(0.82, 0.98, fines) - stone * 0.30 + grain * 0.06, 0, 1);
    c.metal = 0;
    c.ao = 1 - crack * 0.34 - stone * 0.16;
  },

  /** Sun-bleached mud-brick plaster with blown render and exposed brick. */
  plaster(u, v, c, s) {
    const coarse = warped(u, v, 5, 5) * 0.5 + 0.5;
    const fine = fbm(u, v, 4, 24) * 0.5 + 0.5;
    const grit = micro(u, v, 96, 3, s) * 0.5 + 0.5;
    // Rectangular brick lattice revealed where the render has failed. Even
    // row count and whole column count so the running bond survives the wrap.
    const rows = 12, cols = 7;
    const ry = v * rows, rx = u * cols + (Math.floor(ry) % 2) * 0.5;
    const mx = Math.abs((rx % 1) - 0.5), my = Math.abs((ry % 1) - 0.5);
    const mortar = clamp(smoothstep(0.38, 0.47, mx) + smoothstep(0.32, 0.44, my), 0, 1);
    // Several small failures rather than one big one. A single blown sheet
    // per tile is truer to one wall and ruinous across forty of them.
    const blown = smoothstep(0.58, 0.84, fbm(u + 0.13, v + 0.61, 4, 6) * 0.5 + 0.5);
    const crack = smoothstep(0.76, 0.97, ridged(u, v, 5, 7));
    // Rain streaks: six to one anisotropy, from whole-number multipliers.
    // Any stronger and a facade seen from thirty metres reads as combed hair
    // rather than as a wall that water has run down a few times.
    const streak = smoothstep(0.52, 0.94, fbm(u * 6, v, 3, 3) * 0.5 + 0.5)
      * smoothstep(0.44, 0.76, fbm(u + 0.7, v + 0.2, 3, 2) * 0.5 + 0.5);
    // Airborne-dust soiling, unrelated to the render breakup above it.
    const soot = smoothstep(0.40, 0.84, fbm(u + 0.91, v + 0.44, 4, 5) * 0.5 + 0.5);

    c.h = 0.60 + coarse * 0.14 + fine * 0.07 + grit * 0.06
      - blown * 0.26 - mortar * blown * 0.28 - crack * 0.30;

    // Diffuse albedo, and it has to stay in the range real pigment occupies.
    // At 0.748 the red channel peaked near 0.83 — fresh paper — on the largest
    // sunlit surface in the level, so the wall clipped against any exposure
    // that left the ground readable, and no amount of grading could recover a
    // value the material never had. Weathered limewash over mud brick sits
    // around 0.55 to 0.65; the variation is unchanged, only the level.
    const l = 0.580 + fine * 0.055 + grit * 0.028 - coarse * 0.072;
    c.r = l * 1.000; c.g = l * 0.958; c.b = l * 0.862;              // warm limewash
    // Exposed mud brick beneath. Sun-bleached to nearly the value of the
    // render itself — the relief is what shows, not a change of colour.
    c.r = lerp(c.r, 0.598, blown * 0.85); c.g = lerp(c.g, 0.492, blown * 0.85); c.b = lerp(c.b, 0.392, blown * 0.85);
    // Dust wash and rain streaking. Dilute dirt on a bright wall is a grey
    // veil, not the near-black smear it is tempting to author.
    const soil = clamp(soot * 0.62 + streak * 0.44, 0, 1);
    c.r = lerp(c.r, 0.446, soil * 0.52); c.g = lerp(c.g, 0.402, soil * 0.52); c.b = lerp(c.b, 0.344, soil * 0.52);
    c.r *= 1 - crack * 0.20; c.g *= 1 - crack * 0.20; c.b *= 1 - crack * 0.20;

    // Chalky limewash is the roughest thing on the outpost; the soiled runs
    // are bound by dust and grease and take a faint sheen.
    c.rough = clamp(0.88 + coarse * 0.10 - streak * 0.14 - soot * 0.10, 0, 1);
    c.metal = 0;
    c.ao = 1 - crack * 0.36 - blown * 0.22 - mortar * blown * 0.28 - soil * 0.10;
  },

  /** Poured concrete: form-board seams, aggregate pitting, water staining. */
  concrete(u, v, c, s) {
    const cloud = warped(u, v, 5, 3) * 0.5 + 0.5;
    const bub = worley(u, v, 44);
    const hole = smoothstep(0.11, 0.02, bub.f1) * smoothstep(0.30, 0.55, bub.id);
    const cell = worley(u, v, 26);
    const agg = smoothstep(0.50, 0.78, cell.f2 - cell.f1);
    const grain = micro(u, v, 88, 3, s) * 0.5 + 0.5;
    const seam = smoothstep(0.470, 0.496, Math.abs((v * 3) % 1 - 0.5)) * 0.8;
    const crack = smoothstep(0.84, 0.99, ridged(u, v, 5, 6));
    const stain = smoothstep(0.42, 0.88, fbm(u * 4, v, 4, 3) * 0.5 + 0.5);
    // Laitance: the cement-rich skin, patchy and much paler than the body.
    const skin = smoothstep(0.38, 0.74, fbm(u + 0.27, v + 0.83, 4, 2) * 0.5 + 0.5);

    c.h = 0.62 + cloud * 0.10 + grain * 0.07 + agg * 0.05 - hole * 0.38 - seam * 0.20 - crack * 0.28;

    // Peaked at 0.705 in red, which is a sheet of paper. Precast concrete is a
    // dark material — 0.25 to 0.40 weathered, and it does not get much above
    // 0.5 even fresh off the mould. At the old value a barrier facing a low sun
    // clipped outright, and clipped in red alone because the key is warm, which
    // is the plateau two reviewers described as the tone curve destroying form.
    // The same mistake as the plaster wall, one material along.
    const l = 0.380 + cloud * 0.070 + grain * 0.045 + skin * 0.062 - stain * 0.085;
    c.r = l * 1.000; c.g = l * 0.990; c.b = l * 0.962;
    // Exposed aggregate is warmer and darker than the paste around it.
    c.r = lerp(c.r, 0.472, agg * 0.35); c.g = lerp(c.g, 0.444, agg * 0.35); c.b = lerp(c.b, 0.402, agg * 0.35);
    c.r = lerp(c.r, 0.352, hole); c.g = lerp(c.g, 0.344, hole); c.b = lerp(c.b, 0.336, hole);
    c.r *= 1 - crack * 0.26; c.g *= 1 - crack * 0.26; c.b *= 1 - crack * 0.26;
    c.r *= 1 - seam * 0.14; c.g *= 1 - seam * 0.14; c.b *= 1 - seam * 0.14;

    // Water runs polish the laitance; blown paste and pits stay porous.
    c.rough = clamp(0.86 + grain * 0.08 - stain * 0.22 - skin * 0.08 + hole * 0.06, 0, 1);
    c.metal = 0;
    c.ao = 1 - hole * 0.58 - crack * 0.42 - seam * 0.26 - agg * 0.10;
  },

  /** Heavily oxidised steel — barrels, containers, corrugated roofing. */
  rust(u, v, c, s) {
    const patch = warped(u, v, 5, 7, 0.5) * 0.5 + 0.5;
    const flake = worley(u, v, 26);
    // Scale lifts in irregular plates: the cell interior is the plate and the
    // cell wall is the lifted lip. Reading the cell centre instead gives a
    // field of identical round dots, which looks like measles.
    const scab = smoothstep(0.16, 0.02, flake.f2 - flake.f1) * smoothstep(0.35, 0.60, patch);
    const pit = smoothstep(0.09, 0.01, worley(u, v, 72).f1);
    const grain = micro(u, v, 72, 3, s) * 0.5 + 0.5;
    const streak = smoothstep(0.40, 0.90, fbm(u * 8, v, 4, 6) * 0.5 + 0.5);
    // Rust dominates, but bare metal survives on the high spots and wherever
    // the drum has been dragged. Without it the barrels are brown cardboard.
    const rust = clamp(patch * 0.95 + streak * 0.45 + scab * 0.34 - 0.14, 0, 1);
    const bare = smoothstep(0.72, 0.40, rust);
    const polish = smoothstep(0.55, 0.90, fbm(u * 6, v, 3, 3) * 0.5 + 0.5) * bare;

    c.h = 0.58 + patch * 0.12 + scab * 0.16 + grain * 0.08 - pit * 0.30;

    // Bare steel carries iron's F0, not a diffuse grey.
    const sr = 0.688 + grain * 0.085, sg = 0.696 + grain * 0.085, sb = 0.708 + grain * 0.082;
    // Oxide ramps from fresh orange to deep red-brown as the scale thickens.
    const rr = lerp(0.452, 0.272, patch), rg = lerp(0.282, 0.186, patch), rb = lerp(0.182, 0.142, patch);
    c.r = lerp(sr, rr, rust); c.g = lerp(sg, rg, rust); c.b = lerp(sb, rb, rust);
    c.r *= 1 - pit * 0.22; c.g *= 1 - pit * 0.22; c.b *= 1 - pit * 0.22;

    // Oxide is a dielectric; only the bare steel stays metallic.
    c.metal = clamp(bare * 0.96, 0, 1);
    c.rough = clamp(lerp(0.96, 0.38, bare) - polish * 0.16 + scab * 0.04 - grain * 0.05, 0, 1);
    c.ao = 1 - pit * 0.34 - scab * 0.24;
  },

  /** Chipped olive-drab paint over steel — vehicles, ammo crates, doors. */
  painted(u, v, c, s) {
    const wear = warped(u, v, 5, 5, 0.45) * 0.5 + 0.5;
    // Chips cluster where the panel gets knocked, so a broad mask decides
    // where damage happens at all and the cell field decides its shape.
    const zone = smoothstep(0.36, 0.72, fbm(u + 0.19, v + 0.53, 3, 2) * 0.5 + 0.5);
    const flake = worley(u, v, 30);
    const edge = smoothstep(0.22, 0.06, flake.f1) * smoothstep(0.30, 0.55, flake.id);
    const chipped = clamp((smoothstep(0.52, 0.76, wear) + edge * 0.9) * zone, 0, 1);
    // Only the deepest chips reach steel; the rest stop at red-oxide primer.
    const toMetal = smoothstep(0.55, 0.92, chipped);
    const grain = micro(u, v, 84, 3, s) * 0.5 + 0.5;
    const scuff = smoothstep(0.52, 0.88, fbm(u * 9, v * 2, 4, 3) * 0.5 + 0.5);
    const dust = smoothstep(0.26, 0.74, fbm(u + 0.41, v + 0.87, 4, 5) * 0.5 + 0.5);

    c.h = 0.64 + wear * 0.08 + grain * 0.06 - chipped * 0.22 - edge * 0.10;

    // Olive drab, matt vehicle enamel.
    let pr = 0.288 + grain * 0.038, pg = 0.308 + grain * 0.040, pb = 0.230 + grain * 0.030;
    pr += scuff * 0.055; pg += scuff * 0.058; pb += scuff * 0.044;
    c.r = lerp(pr, 0.372, chipped); c.g = lerp(pg, 0.252, chipped); c.b = lerp(pb, 0.192, chipped);
    c.r = lerp(c.r, 0.672, toMetal * 0.7); c.g = lerp(c.g, 0.678, toMetal * 0.7); c.b = lerp(c.b, 0.686, toMetal * 0.7);
    // Nothing at this outpost stays the colour it was painted. The dust film
    // is heavy enough to be the main thing lifting a container out of its own
    // shadow, which is otherwise where olive drab goes to die.
    c.r = lerp(c.r, 0.548, dust * 0.42); c.g = lerp(c.g, 0.494, dust * 0.42); c.b = lerp(c.b, 0.402, dust * 0.42);

    c.metal = toMetal * 0.85;
    c.rough = clamp(lerp(0.54, 0.90, chipped) + dust * 0.12 - scuff * 0.16 - toMetal * 0.28, 0, 1);
    c.ao = 1 - chipped * 0.26 - edge * 0.14;
  },

  /** Woven burlap sandbag — coarse over-under weave, sun-rotted. */
  burlap(u, v, c, s) {
    // Coarse enough to survive the mip chain at the four-to-five metres a
    // sandbag wall is normally read from. A physically correct thread count
    // averages to flat beige before the player is close enough to care.
    const T = 18;
    const wu = u * T, wv = v * T;
    const fu = wu % 1, fv = wv % 1;
    const over = (Math.floor(wu) + Math.floor(wv)) % 2 === 0;
    // Rounded thread cross-section, alternating which yarn sits proud.
    const tu = Math.sin(fu * Math.PI), tv = Math.sin(fv * Math.PI);
    const thread = over ? tu * 0.85 + tv * 0.25 : tv * 0.85 + tu * 0.25;
    const fray = micro(u, v, 48, 3, s) * 0.5 + 0.5;
    const dirty = warped(u, v, 4, 3) * 0.5 + 0.5;
    const sun = smoothstep(0.35, 0.82, fbm(u + 0.6, v + 0.3, 3, 2) * 0.5 + 0.5);
    // A few bags have taken water and dried out dark and stiff.
    const damp = smoothstep(0.62, 0.90, fbm(u + 0.2, v + 0.9, 4, 2) * 0.5 + 0.5);
    // Slack in the hessian. The weave itself mips away by four or five metres
    // and the bag goes smooth; this is the relief that still reads at range.
    const slack = fbm(u * 2, v, 3, 2) * 0.5 + 0.5;

    c.h = 0.08 + thread * 0.50 + fray * 0.15 + slack * 0.27;

    const l = 0.336 + thread * 0.068 + fray * 0.036;
    c.r = l * 1.020; c.g = l * 0.908; c.b = l * 0.702;
    c.r = lerp(c.r, c.r * 1.13, sun * 0.6); c.g = lerp(c.g, c.g * 1.11, sun * 0.6); c.b = lerp(c.b, c.b * 1.08, sun * 0.6);
    c.r = lerp(c.r, 0.372, dirty * 0.40); c.g = lerp(c.g, 0.322, dirty * 0.40); c.b = lerp(c.b, 0.252, dirty * 0.40);
    c.r = lerp(c.r, 0.298, damp * 0.55); c.g = lerp(c.g, 0.258, damp * 0.55); c.b = lerp(c.b, 0.208, damp * 0.55);

    c.rough = clamp(0.99 - thread * 0.07 - damp * 0.14 - slack * 0.06, 0, 1);
    c.metal = 0;
    c.ao = 0.58 + thread * 0.42 - dirty * 0.10 - (1 - slack) * 0.12;
  },

  /**
   * Worn tyre rubber — tread blocks, sidewall relief, sun-perished shoulders.
   *
   * The stacks were a flat 0x1b1a19 with no maps at all, which four
   * independent blind reviewers each picked out by name; one called them
   * "literal toruses". Rubber is the easiest material in the level to give
   * away, because it is the only one with a strong regular geometric pattern
   * moulded into it, and a black ellipsoid with no pattern reads as licorice.
   *
   * The v axis runs around the carcass, so the tread band sits in a fixed
   * range of v and the sidewalls either side of it. That lets one sampler
   * carry both surfaces, which a torus needs since it has no seam to split at.
   */
  rubber(u, v, c, s) {
    // Where on the carcass we are: 0 at the outer crown, 1 at the bead.
    const across = Math.abs(v - 0.5) * 2;
    const crown = 1 - smoothstep(0.30, 0.62, across);

    // Directional tread blocks, chevroned and offset row to row.
    const ROWS = 26;
    const ru = u * ROWS;
    const row = Math.floor(ru);
    const skew = (row % 2) * 0.5;
    const bu = Math.abs(((ru + skew) % 1) - 0.5);
    const groove = smoothstep(0.30, 0.42, bu);
    // A circumferential groove either side of centre, as most road tyres have.
    const rib = smoothstep(0.035, 0.075, Math.abs(across - 0.34));
    const tread = clamp(groove * rib, 0, 1);

    // Sidewall lettering and the moulded ring it sits on: too small to read,
    // but it catches a grazing sun and that is what says "tyre" at ten metres.
    const ring = smoothstep(0.02, 0.05, Math.abs(across - 0.74));
    const letters = smoothstep(0.55, 0.85, fbm(u * 9, (across - 0.74) * 30, 2, 6) * 0.5 + 0.5)
      * (1 - ring) * (across > 0.6 ? 1 : 0);

    const grain = micro(u, v, 110, 3, s) * 0.5 + 0.5;
    const scuff = warped(u * 3, v, 4, 5) * 0.5 + 0.5;
    // Perished, chalky patches where the sun has got at the sidewall.
    const perish = smoothstep(0.52, 0.88, fbm(u * 2 + 0.4, v + 0.7, 4, 4) * 0.5 + 0.5)
      * (0.35 + across * 0.65);

    c.h = 0.34 + tread * 0.44 * crown + letters * 0.16 + grain * 0.06 - perish * 0.08;

    // Carbon black is dark but not the 0.011 linear the flat colour was using;
    // real tyre rubber sits nearer 0.035 and lifts further where it is dusty.
    const l = 0.052 + grain * 0.012 + tread * 0.008 * crown;
    c.r = l * 1.000; c.g = l * 0.972; c.b = l * 0.944;
    // Dust does most of the visual work on a tyre lying in sand.
    const dust = clamp(scuff * 0.55 + perish * 0.5, 0, 1);
    c.r = lerp(c.r, 0.212, dust * 0.42); c.g = lerp(c.g, 0.184, dust * 0.42); c.b = lerp(c.b, 0.146, dust * 0.42);

    // Crown polished by the road, sidewall matte, perished patches chalkiest.
    c.rough = clamp(0.94 - crown * 0.16 - tread * 0.05 + perish * 0.05, 0, 1);
    c.metal = 0;
    c.ao = 1 - (1 - tread) * 0.30 * crown - perish * 0.10;
  },

  /** Weathered timber plank — grain, splits, knots, nail staining. */
  wood(u, v, c, s) {
    const planks = 5;
    const pi = Math.floor(v * planks);
    const pv = (v * planks) % 1;
    const jitter = (PERM[(pi * 37) & 511] / 255 - 0.5) * 0.35;
    const shade = PERM[(pi * 91 + 13) & 511] / 255;
    // Grain rings run along the plank, warped by the ring-jitter per board.
    const ring = Math.sin((pv * 5.5 + jitter + fbm(u, v, 3, 4) * 2.4) * Math.PI * 2) * 0.5 + 0.5;
    const grain = micro(u * 2, v * 12, 3, 3, s) * 0.5 + 0.5;
    const split = smoothstep(0.74, 0.97, ridged(u * 2, v * 6, 4, 6));
    const gap = smoothstep(0.055, 0.0, Math.min(pv, 1 - pv));
    // A board carries one or two knots, not a regular scatter of them, so the
    // cell field is thinned by a mask rather than used directly.
    const kn = worley(u, v, 4);
    const knot = smoothstep(0.15, 0.03, kn.f1) * smoothstep(0.42, 0.62, kn.id);

    c.h = 0.62 + ring * 0.13 + grain * 0.13 - split * 0.32 - gap * 0.85 - knot * 0.20;

    // Boards come from different batches; a uniform tone reads as extrusion.
    const l = 0.282 + ring * 0.050 + grain * 0.040 + (shade - 0.5) * 0.052;
    c.r = l * 1.055; c.g = l * 0.942; c.b = l * 0.792;
    // Silvered, UV-bleached surface on the exposed face.
    const grey = smoothstep(0.28, 0.84, fbm(u, v, 4, 2) * 0.5 + 0.5);
    c.r = lerp(c.r, l * 0.985, grey * 0.7); c.g = lerp(c.g, l * 0.975, grey * 0.7); c.b = lerp(c.b, l * 0.945, grey * 0.7);
    c.r = lerp(c.r, 0.252, knot); c.g = lerp(c.g, 0.186, knot); c.b = lerp(c.b, 0.132, knot);
    // The seam between boards is a shadow, not a black pigment; the AO map
    // carries it so the albedo can stay inside the range real timber occupies.
    c.r *= 1 - gap * 0.42; c.g *= 1 - gap * 0.42; c.b *= 1 - gap * 0.42;
    c.r *= 1 - split * 0.22; c.g *= 1 - split * 0.22; c.b *= 1 - split * 0.22;

    // Weathered softwood is fibrous and dead matt; knots are resinous.
    c.rough = clamp(0.88 + grain * 0.09 + grey * 0.06 - knot * 0.34, 0, 1);
    c.metal = 0;
    c.ao = 1 - gap * 0.80 - split * 0.40 - knot * 0.30;
  },

  /** Heavy canvas tarpaulin — tight weave, folds, sun-faded dye. */
  canvas(u, v, c, s) {
    const T = 96;
    const fu = (u * T) % 1, fv = (v * T) % 1;
    const weave = (Math.sin(fu * Math.PI) + Math.sin(fv * Math.PI)) * 0.5;
    const slub = micro(u * 2, v * 2, 40, 2, s) * 0.5 + 0.5;
    const fold = fbm(u, v * 3, 4, 3) * 0.5 + 0.5;
    const bleach = smoothstep(0.25, 0.82, fbm(u, v, 4, 2) * 0.5 + 0.5);
    const stain = smoothstep(0.56, 0.94, warped(u + 0.45, v + 0.11, 4, 3) * 0.5 + 0.5);

    c.h = 0.48 + weave * 0.16 + slub * 0.10 + fold * 0.26;

    const l = 0.196 + weave * 0.020 + slub * 0.014 + fold * 0.024;
    c.r = l * 1.065; c.g = l * 1.000; c.b = l * 0.800;
    c.r = lerp(c.r, c.r * 1.18, bleach * 0.6); c.g = lerp(c.g, c.g * 1.16, bleach * 0.6); c.b = lerp(c.b, c.b * 1.13, bleach * 0.6);
    c.r = lerp(c.r, 0.318, stain * 0.6); c.g = lerp(c.g, 0.286, stain * 0.6); c.b = lerp(c.b, 0.238, stain * 0.6);

    // Proofed cotton keeps a waxy sheen in the folds and loses it on the
    // sun-facing panels, where the dressing has burned off.
    c.rough = clamp(0.92 - fold * 0.16 + bleach * 0.06 - stain * 0.08, 0, 1);
    c.metal = 0;
    c.ao = 0.72 + weave * 0.28 - fold * 0.14;
  },

  /** Phosphate-finish gunmetal — the weapon receiver and barrel. */
  gunmetal(u, v, c, s) {
    const grain = fbm(u * 2, v, 4, 16) * 0.5 + 0.5;             // machining direction
    const speck = micro(u, v, 64, 3, s) * 0.5 + 0.5;
    // Finish wears off in rub lines that follow the long axis of the part and
    // along the machined arrises, never as soft clouds — clouds read as camo.
    const rub = smoothstep(0.55, 0.92, fbm(u * 12, v * 2, 4, 2) * 0.5 + 0.5);
    const edge = smoothstep(0.18, 0.04, worley(u, v, 44).f1);
    const wear = clamp(rub * smoothstep(0.34, 0.74, fbm(u, v, 3, 3) * 0.5 + 0.5) + edge * 0.55, 0, 1);
    const carbon = smoothstep(0.50, 0.86, fbm(u + 0.7, v + 0.3, 4, 3) * 0.5 + 0.5);

    c.h = 0.66 + speck * 0.14 + grain * 0.06 - edge * 0.16;

    // Manganese phosphate is a dark conversion coat over steel, so it is
    // still a metal: authored near black it reflects nothing and the rifle
    // becomes a silhouette. F0 around 0.11 linear keeps it dark but alive.
    const l = 0.086 + speck * 0.016 + grain * 0.009;
    c.r = l * 0.990; c.g = l * 1.000; c.b = l * 1.038;
    // Steel polished through at the handling points.
    c.r = lerp(c.r, 0.702, wear * 0.85); c.g = lerp(c.g, 0.710, wear * 0.85); c.b = lerp(c.b, 0.722, wear * 0.85);
    // Powder fouling around the port and gas block.
    c.r *= 1 - carbon * 0.30; c.g *= 1 - carbon * 0.30; c.b *= 1 - carbon * 0.29;

    c.metal = 1;
    c.rough = clamp(lerp(0.66, 0.19, wear) + speck * 0.07 + carbon * 0.14, 0.08, 1);
    c.ao = 1 - edge * 0.22 - carbon * 0.10;
  },

  /** Glass-filled polymer — handguard, stock, grips. */
  polymer(u, v, c, s) {
    const stipple = smoothstep(0.34, 0.14, worley(u, v, 72).f1);
    const mould = micro(u, v, 40, 3, s) * 0.5 + 0.5;
    const scuff = smoothstep(0.55, 0.90, fbm(u * 8, v, 3, 3) * 0.5 + 0.5);
    // Injection flow lines and a faint sheen where the tool was polished.
    const flow = smoothstep(0.40, 0.80, fbm(u, v * 6, 3, 3) * 0.5 + 0.5);

    c.h = 0.56 + stipple * 0.32 + mould * 0.10;

    const l = 0.104 + mould * 0.014 + stipple * 0.011;
    c.r = l * 1.055; c.g = l * 1.000; c.b = l * 0.946;
    c.r += scuff * 0.055; c.g += scuff * 0.050; c.b += scuff * 0.044;

    // A black handguard is never a black hole: what keeps it readable in
    // shadow is the sheen off the mould skin, so the roughness stays low
    // enough for the sky to register on it.
    c.metal = 0;
    c.rough = clamp(0.68 - stipple * 0.16 - flow * 0.10 + mould * 0.06 - scuff * 0.16, 0, 1);
    c.ao = 1 - stipple * 0.28;
  },

  /** Corrugated galvanised sheet — the roofing and perimeter fencing. */
  corrugated(u, v, c, s) {
    const wave = Math.sin(u * Math.PI * 2 * 18);
    const zinc = fbm(u, v, 4, 16) * 0.5 + 0.5;
    const spangle = smoothstep(0.55, 0.30, worley(u, v, 14).f1);
    const grit = micro(u, v, 96, 2, s) * 0.5 + 0.5;
    // Corrosion starts in the valleys, where grit and water sit, and creeps
    // up the sheet in runs. Keying it to raw v banded at every repeat.
    const valley = smoothstep(0.35, -0.85, wave);
    const rust = clamp(smoothstep(0.44, 0.86, warped(u, v, 4, 6) * 0.5 + 0.5)
      + smoothstep(0.55, 0.92, fbm(u * 6, v, 3, 5) * 0.5 + 0.5) * 0.5
      + valley * 0.30 - 0.10, 0, 1);
    const dent = fbm(u, v, 3, 7) * 0.5 + 0.5;

    c.h = 0.5 + wave * 0.40 + dent * 0.08 + zinc * 0.03 + grit * 0.04;

    // Zinc chalks as it ages: the sheet loses its shine long before it loses
    // its coating, and a mirror-bright roof aimed at a dawn sun clips to a
    // white slab in an eight-bit post buffer.
    const chalk = smoothstep(0.35, 0.78, fbm(u + 0.6, v + 0.2, 4, 6) * 0.5 + 0.5);
    const l = 0.412 + zinc * 0.052 + spangle * 0.034 + grit * 0.016 + chalk * 0.029;
    c.r = l * 0.982; c.g = l * 1.000; c.b = l * 1.028;
    c.r = lerp(c.r, 0.428, rust * 0.82); c.g = lerp(c.g, 0.296, rust * 0.82); c.b = lerp(c.b, 0.216, rust * 0.82);

    c.metal = clamp(1 - rust * 0.92 - chalk * 0.20, 0, 1);
    // The clean-sheet floor was 0.42, which is a near-mirror, and this sampler
    // carries the strongest normal map in the set (2.6) over corrugation whose
    // ridges go sub-pixel at any distance. A grazing dawn sun on that
    // combination aliases: the specular lobe lands on one ridge and misses the
    // next, and a solid gate comes out wearing a row of bright vertical dashes
    // that four reviewers each read as a rendering bug. It is not a shafts
    // artefact — multisampling the occlusion mask and then rendering it at full
    // resolution both failed to touch it.
    //
    // Weathered galvanised sheet is not polished metal in any case. Zinc
    // oxidises to a dull grey skin within a season, and 0.62 is where it sits.
    c.rough = clamp(lerp(0.62, 0.94, rust) + chalk * 0.26 - spangle * 0.06 + grit * 0.05, 0, 1);
    c.ao = 1 - rust * 0.16 - smoothstep(0.2, 0.0, Math.abs(wave)) * 0.10;
  },
};

/* --------------------------------------------------------------- public -- */

const RESOLUTION = {
  sand: 1024, dirt: 1024, plaster: 1024, concrete: 1024,
  rust: 512, painted: 512, burlap: 512, wood: 512,
  canvas: 512, gunmetal: 512, polymer: 512, corrugated: 512,
  rubber: 512,
};

// Chosen so the steepest texel of each surface lands near the slope the real
// material has. A wall skimmed with lime is almost flat, and a normal map
// that tilts it more than a couple of degrees per texel reads as orange peel
// rather than as plaster; weave and corrugation earn the opposite treatment.
const NORMAL_STRENGTH = {
  sand: 0.85, dirt: 1.1, plaster: 0.75, concrete: 0.8,
  rust: 1.15, painted: 0.7, burlap: 2.2, wood: 1.15,
  canvas: 1.0, gunmetal: 0.6, polymer: 1.0, corrugated: 2.6,
  // Moulded tread is deep relief; this is the whole point of the material.
  rubber: 2.4,
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
 * How hard each surface is pushed by the world-space macro pass below.
 *
 * The viewmodel surfaces are deliberately absent: the pass keys off world
 * position, and the viewmodel's world position tracks the camera, so its
 * blotches would swim across the rifle as the player walks.
 */
const MACRO = {
  sand: 0.17, dirt: 0.17, plaster: 0.15, concrete: 0.13,
  rust: 0.12, painted: 0.12, burlap: 0.12, wood: 0.11, corrugated: 0.11,
  rubber: 0.10,
};

// Value noise on world position. Nothing here is authored per-texel, so it is
// completely indifferent to how many times the maps repeat.
const MACRO_GLSL = /* glsl */`
varying vec3 vMacroPos;
uniform float uMacro;

float macroHash( vec3 p ) {
  p = fract( p * 0.3183099 + 0.1 ) * 17.0;
  return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) );
}

float macroNoise( vec3 x ) {
  vec3 i = floor( x ), f = fract( x );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix(
    mix( mix( macroHash( i ), macroHash( i + vec3( 1.0, 0.0, 0.0 ) ), f.x ),
         mix( macroHash( i + vec3( 0.0, 1.0, 0.0 ) ), macroHash( i + vec3( 1.0, 1.0, 0.0 ) ), f.x ), f.y ),
    mix( mix( macroHash( i + vec3( 0.0, 0.0, 1.0 ) ), macroHash( i + vec3( 1.0, 0.0, 1.0 ) ), f.x ),
         mix( macroHash( i + vec3( 0.0, 1.0, 1.0 ) ), macroHash( i + vec3( 1.0, 1.0, 1.0 ) ), f.x ), f.y ),
    f.z );
}
`;

/**
 * Large-scale variation that a tiling map cannot express.
 *
 * However good a texture is, once it repeats every few metres the eye finds
 * the grid — and the ground here repeats forty times across the compound.
 * The fix has to live in world space, at a wavelength longer than the tile:
 * a seventeen-metre and a six-metre lobe of value noise pushing albedo,
 * colour temperature and roughness. Roughness carries most of the weight,
 * because a change in how a surface catches the sun reads as a change in the
 * surface itself, where a change in brightness alone reads as a stain.
 *
 * The same world position gives the plinth film for free: airborne dust
 * settles on the bottom half-metre of anything vertical, and that band is
 * what stops walls looking like they were dropped onto the sand.
 */
function applyMacro(mat, amount) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uMacro = { value: amount };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vMacroPos;')
      .replace('#include <project_vertex>', /* glsl */`#include <project_vertex>
  #ifdef USE_INSTANCING
    vMacroPos = ( modelMatrix * instanceMatrix * vec4( transformed, 1.0 ) ).xyz;
  #else
    vMacroPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
  #endif`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${MACRO_GLSL}`)
      .replace('#include <normal_fragment_maps>', /* glsl */`#include <normal_fragment_maps>
  {
    float mA = macroNoise( vMacroPos * 0.059 );
    float mB = macroNoise( vMacroPos * 0.168 + 11.3 );
    float tone = ( mA * 0.66 + mB * 0.34 ) * 2.0 - 1.0;
    float gloss = ( mB * 0.72 + mA * 0.28 ) * 2.0 - 1.0;
    // Darker ground is damper, better packed and less scattering, so it is
    // also warmer and a little smoother than the bleached patches beside it.
    diffuseColor.rgb *= vec3( 1.0 + tone * uMacro * 0.84, 1.0 + tone * uMacro, 1.0 + tone * uMacro * 1.20 );
    roughnessFactor = clamp( roughnessFactor + gloss * uMacro * 0.85, 0.06, 1.0 );

    // Mid frequency: the band between texel detail and silhouette.
    //
    // The two octaves above have wavelengths of seventeen and six metres, and
    // the tiling maps below carry centimetres. Nothing occupied the half-metre
    // to three-metre range in between — the scale of a damp patch, a scuffed
    // panel, a run of staining — and that is the band that survives when the
    // maps have mipped to flat. Twelve blind reviewers across three panels
    // each named "every surface returns one albedo with one roughness" as the
    // single biggest tell, and this is the frequency they were missing.
    float mC = macroNoise( vMacroPos * 0.42 + 3.7 );
    float mD = macroNoise( vMacroPos * 1.15 + 27.1 );
    float mid = ( mC - 0.5 ) * 1.24 + ( mD - 0.5 ) * 0.76;
    diffuseColor.rgb *= 1.0 + mid * uMacro * 1.35;
    roughnessFactor = clamp( roughnessFactor + mid * uMacro * 1.55, 0.06, 1.0 );

    vec3 macroN = normalize( ( vec4( nonPerturbedNormal, 0.0 ) * viewMatrix ).xyz );
    float film = ( 1.0 - abs( macroN.y ) )
      * ( 1.0 - smoothstep( 0.04, 0.62 + mB * 0.55, vMacroPos.y ) ) * 0.34;
    diffuseColor.rgb *= mix( vec3( 1.0 ), vec3( 1.20, 1.10, 0.92 ), film );
    roughnessFactor = clamp( roughnessFactor + film * 0.22, 0.06, 1.0 );

    // Contact grime, which is not the same thing as the dust film above it.
    // Dust settles and lightens; the crevice where a surface meets the ground
    // collects dirt and loses sky, so it darkens. Every reviewer in every
    // panel said nothing reads as touching the ground. Screen-space occlusion
    // now covers that on the top two tiers, but this is world-space, so it
    // survives mipping, needs no depth prepass, and is the only grounding cue
    // a phone gets.
    float contact = ( 1.0 - smoothstep( 0.0, 0.42 + mD * 0.30, vMacroPos.y ) )
      * ( 0.62 + 0.38 * mC );
    diffuseColor.rgb *= mix( vec3( 1.0 ), vec3( 0.58, 0.55, 0.51 ), contact * 0.42 );
    roughnessFactor = clamp( roughnessFactor + contact * 0.16, 0.06, 1.0 );
  }`);
  };
  // Every macro material compiles to the same program; the strength travels
  // as a uniform so three does not build one shader per tiling variant.
  mat.customProgramCacheKey = () => 'macro';
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
  applyOverrides(mat, overrides);
  if (MACRO[name]) applyMacro(mat, MACRO[name]);
  return mat;
}

/**
 * Applies material overrides without destroying live three objects.
 *
 * `Object.assign(material, { color: 0x8899aa })` replaces the THREE.Color
 * instance with a plain number. Nothing throws — the shader then reads .r/.g/.b
 * as undefined, the diffuse uniform becomes zero, and the surface renders
 * pure black regardless of how much light reaches it. Colors, vectors and
 * euler angles all have to be written through their own setters.
 */
function applyOverrides(material, overrides) {
  for (const [key, value] of Object.entries(overrides)) {
    const current = material[key];
    if (current && current.isColor) current.set(value);
    else if (current && current.isVector2) {
      if (Array.isArray(value)) current.set(value[0], value[1]);
      else if (typeof value === 'number') current.set(value, value);
      else current.copy(value);
    } else if (current && current.isVector3 && Array.isArray(value)) {
      current.set(value[0], value[1], value[2]);
    } else {
      material[key] = value;
    }
  }
}

export const SURFACES = Object.keys(SAMPLERS);
