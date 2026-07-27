// Kilo Outpost — the playable space.
//
// Everything is authored in metres against a 1.75 m eye height. Boxy forms are
// built from RoundedBoxGeometry rather than BoxGeometry: a 1–3 cm bevel costs
// almost nothing and gives every edge a specular highlight, which is most of
// the difference between "programmer blockout" and "art-passed".
//
// The sun sits 9.5° above the horizon to the east-south-east, so every metre
// of height throws six metres of shadow. Vertical elements are therefore the
// cheapest lighting tool in the level: poles, cables, railings and parapets
// are placed east of the courtyard specifically so their shadows rake back
// across the sand toward the player.
//
// Exposes:
//   group        scene contents
//   colliders    world-space Box3 list for player/AI movement
//   raycastables meshes bullets and AI line-of-sight tests hit
//   spawns       enemy spawn transforms
//   coverPoints  positions AI treat as cover

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { material, fbm, ridged, perlin } from './textures.js';

const TAU = Math.PI * 2;
const smoothstep = THREE.MathUtils.smoothstep;
const lerp = THREE.MathUtils.lerp;
const clamp = THREE.MathUtils.clamp;

/* Terrain extents. The sand reaches far enough that the ridge line beyond it
 * is never seen to end, and the compound sits in a graded basin inside it. */
const EXT = 190;          // half-extent of the sand field
const TILE = 4.2;         // metres covered by one tile of the sand maps
const WALL_X = 31, WALL_Z = 26;

/* Horizontal unit vector pointing at the sun (azimuth 104°). Wind ripples run
 * across it so their faces alternate lit/unlit under the grazing key. */
const SUN_X = 0.9703, SUN_Z = -0.2419;

/* Deterministic RNG so the level is identical every run (and every screenshot). */
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

export class Level {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'level';
    this.colliders = [];
    this.raycastables = [];
    this.spawns = [];
    this.coverPoints = [];
    this.rand = rng(0xC0FFEE);
    this._mat = new Map();

    // Terrain modifiers, consumed by terrainHeight. Filled before the ground
    // is generated so the mesh, the height lookup and every prop agree.
    this.pads = [];
    this.craters = [];
  }

  mat(name, repeat, overrides) {
    const key = `${name}|${Array.isArray(repeat) ? repeat.join(',') : repeat}|${JSON.stringify(overrides ?? {})}`;
    let m = this._mat.get(key);
    if (!m) { m = material(name, repeat, overrides); this._mat.set(key, m); }
    return m;
  }

  /* ------------------------------------------------------------ helpers -- */

  add(mesh, { collide = true, shrink = 0 } = {}) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    this.raycastables.push(mesh);
    if (collide) {
      mesh.updateWorldMatrix(true, false);
      const box = new THREE.Box3().setFromObject(mesh);
      if (shrink) box.expandByScalar(-shrink);
      this.colliders.push(box);
    }
    return mesh;
  }

  box(w, h, d, x, y, z, mat, { ry = 0, bevel = 0.02, collide = true, cast = true, receive = true } = {}) {
    const seg = bevel > 0.05 ? 3 : 2;
    const geo = new RoundedBoxGeometry(w, h, d, seg, Math.min(bevel, Math.min(w, h, d) * 0.24));
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.rotation.y = ry;
    mesh.castShadow = cast;
    mesh.receiveShadow = receive;
    this.group.add(mesh);
    this.raycastables.push(mesh);
    if (collide) {
      mesh.updateWorldMatrix(true, false);
      this.colliders.push(new THREE.Box3().setFromObject(mesh));
    }
    return mesh;
  }

  /** Registers every mesh under a group for hit tests and adds one collider. */
  seal(g, { collide = true, cover = false } = {}) {
    this.group.add(g);
    g.updateWorldMatrix(true, true);
    g.traverse((o) => { if (o.isMesh) this.raycastables.push(o); });
    if (collide) this.colliders.push(new THREE.Box3().setFromObject(g));
    if (cover) this.coverPoints.push(new THREE.Vector3(g.position.x, 0, g.position.z));
    return g;
  }

  /* ------------------------------------------------------- terrain field -- */

  /**
   * Normalised distance out of the compound. A p-norm rather than a max() of
   * the two axes: max() is only C0 along the diagonals, and at this sun angle
   * a slope discontinuity there prints a fold line straight across the sand.
   */
  basin(x, z) {
    const ax = Math.abs(x) / 34.5, az = Math.abs(z) / 29.5;
    const a3 = ax * ax * ax, z3 = az * az * az;
    return Math.pow(a3 * a3 + z3 * z3, 1 / 6);
  }

  /**
   * The single source of truth for ground elevation.
   *
   * Inside the wire the field stays within about ±25 cm, which is shallow
   * enough that walls and props only need a small buried skirt, but it is
   * never flat: a long swell plus two crossed wind ripple sets give the low
   * sun something to rake across. Outside, the dunes open up, a spoil berm
   * rings the wire, and the far field falls away so the horizon is sky and
   * ridge rather than a bowl rim sixty metres out.
   */
  terrainHeight(x, z) {
    const u = x / (EXT * 2) + 0.5, v = z / (EXT * 2) + 0.5;
    const d = this.basin(x, z);
    const open = smoothstep(d, 0.97, 1.95);

    let h = 0;

    if (open > 0) {
      const dune = fbm(u * 1.15, v * 1.15, 5, 3) * 2.5 + fbm(u * 3.1, v * 3.1, 4, 5) * 0.82;
      h += dune * open;
      // Spoil thrown outward when the perimeter was cut in, broken up so it
      // never reads as an extruded ring.
      const ring = Math.max(0, 1 - Math.abs(d - 1.14) / 0.34);
      h += ring * ring * (1.15 + fbm(u * 7, v * 7, 3, 13) * 1.05);
      // Falling away past the berm keeps the skyline open.
      h -= smoothstep(d, 1.7, 4.0) * 1.35;
    }

    if (open < 1) {
      const flat = 1 - open;
      const swell = fbm(u * 4.4, v * 4.4, 3, 7) * 0.105;
      // Wind ripples run across the sun line. The phase is dragged around by
      // noise and the crest lines are skewed with a second harmonic, because
      // an unwarped sine field turns into visible corduroy the moment the
      // light grazes it.
      const drift = fbm(u * 5.2, v * 5.2, 3, 10) * 3.1;
      const p = x * SUN_X + z * SUN_Z + drift;
      const q = x * -SUN_Z + z * SUN_X;
      // Amplitudes are set so the steepest lee faces sit just inside the sun's
      // 9.5° elevation: the crests stay lit and the troughs fall to ambient,
      // which is where all the contrast in a dawn desert frame comes from.
      const amp = 0.30 + 0.70 * Math.pow(fbm(u * 7.5, v * 7.5, 3, 17) * 0.5 + 0.5, 1.6);
      const a1 = p * 1.74 + q * 0.11;
      const a2 = p * 0.58 + q * 0.05 + 1.7;
      const ripple = (Math.sin(a1) + Math.sin(a1 * 2) * 0.28) * 0.036
        + (Math.sin(a2) + Math.sin(a2 * 2) * 0.24) * 0.066;
      h += flat * (swell + ripple * amp);
    }

    // Building footprints sit dead level, with sand banked against the walls.
    for (let i = 0; i < this.pads.length; i++) {
      const p = this.pads[i];
      let px = x - p.x, pz = z - p.z;
      if (p.c !== 1) { const t = px * p.c + pz * p.s; pz = pz * p.c - px * p.s; px = t; }
      const out = Math.max(Math.abs(px) - p.hw, Math.abs(pz) - p.hd);
      if (out < p.fade) {
        h = lerp(h, p.y, 1 - smoothstep(out, -0.15, p.fade));
        // Sand banks against anything that has stood still for a season.
        if (out > 0) h += p.drift * Math.pow(1 - out / p.fade, 2.2);
      }
    }

    // Sand drifted against the perimeter wall, both faces.
    const wo = Math.max(Math.abs(x) - WALL_X, Math.abs(z) - WALL_Z);
    const wd = Math.abs(wo);
    if (wd < 3.1) {
      const t = 1 - wd / 3.1;
      h += t * t * 0.46 * (0.55 + 0.45 * (fbm(u * 11, v * 11, 3, 23) * 0.5 + 0.5));
    }

    // Shell scars: bowl plus thrown lip.
    for (let i = 0; i < this.craters.length; i++) {
      const c = this.craters[i];
      const dx = x - c.x, dz = z - c.z;
      const q = (dx * dx + dz * dz) / (c.r * c.r);
      if (q < 5) {
        const t = Math.sqrt(q);
        h -= c.d * Math.exp(-q * 1.9);
        h += c.d * 0.42 * Math.exp(-(t - 1.2) * (t - 1.2) * 3.4);
      }
    }

    return h;
  }

  /**
   * Bakes the field into a lookup grid. Particles, casings, blood decals and
   * every AI resolve their ground contact per frame; evaluating six octaves of
   * noise that often would cost more than the rest of the simulation.
   */
  bakeHeights() {
    const N = 512, HALF = 84;
    const step = (HALF * 2) / (N - 1);
    const grid = new Float32Array(N * N);
    for (let j = 0; j < N; j++) {
      const z = -HALF + j * step;
      for (let i = 0; i < N; i++) grid[j * N + i] = this.terrainHeight(-HALF + i * step, z);
    }
    this._hf = { grid, N, HALF, inv: 1 / step };
  }

  /** Samples the displaced ground height. */
  groundHeight(x, z) {
    const f = this._hf;
    if (!f) return this.terrainHeight(x, z);
    const fx = (x + f.HALF) * f.inv, fz = (z + f.HALF) * f.inv;
    if (fx < 0 || fz < 0 || fx > f.N - 1.001 || fz > f.N - 1.001) return this.terrainHeight(x, z);
    const i = fx | 0, j = fz | 0, tx = fx - i, tz = fz - j;
    const g = f.grid, N = f.N, o = j * N + i;
    const a = g[o], b = g[o + 1], c = g[o + N], e = g[o + N + 1];
    return (a + (b - a) * tx) * (1 - tz) + (c + (e - c) * tx) * tz;
  }

  /* ------------------------------------------------------- ground colour -- */

  /**
   * Per-vertex tint over the sand maps. This is the whole reason the ground
   * stops reading as one repeating swatch: the maps tile every four metres,
   * but the tonal field painted on top of them does not repeat at all, and it
   * is also where the compacted working area, the footpath wear and the
   * scorch around each shell scar live.
   */
  groundTint(x, z, out) {
    const u = x / (EXT * 2) + 0.5, v = z / (EXT * 2) + 0.5;

    const macro = fbm(u * 7.5, v * 7.5, 4, 5) * 0.5 + 0.5;
    const patch = fbm(u * 21, v * 21, 3, 9) * 0.5 + 0.5;
    let l = 0.68 + macro * 0.50 + patch * 0.22;

    // Crests scoured pale, hollows holding darker damp grit.
    const d = this.basin(x, z);
    l += smoothstep(d, 1.0, 1.35) * 0.10;

    let r = l, g = l * 0.988, b = l * 0.952;

    // The trodden compound floor: cooler, darker, and edged organically so no
    // straight line ever betrays where it stops.
    const cx = (x - 1.5) / 23, cz = (z + 1.5) / 19;
    const wob = fbm(u * 9, v * 9, 4, 12) * 0.30;
    const yard = 1 - smoothstep(Math.sqrt(cx * cx + cz * cz) + wob, 0.62, 1.04);
    r = lerp(r, r * 0.665, yard); g = lerp(g, g * 0.700, yard); b = lerp(b, b * 0.775, yard);

    // Foot polish along the routes between the gate, the huts and the sangars.
    const wear = this.pathWear(x, z);
    r = lerp(r, r * 0.60, wear); g = lerp(g, g * 0.63, wear); b = lerp(b, b * 0.70, wear);

    // Scorch rings.
    for (let i = 0; i < this.craters.length; i++) {
      const c = this.craters[i];
      const dx = x - c.x, dz = z - c.z;
      const q = Math.sqrt(dx * dx + dz * dz) / c.r;
      if (q < 2.4) {
        const s = Math.exp(-q * q * 0.7) * 0.85;
        r = lerp(r, 0.30, s); g = lerp(g, 0.29, s); b = lerp(b, 0.30, s);
      }
    }

    out[0] = r; out[1] = g; out[2] = b;
  }

  /** Worn footpaths, as distance to a handful of polylines. */
  pathWear(x, z) {
    const paths = this._paths;
    let w = 0;
    for (let i = 0; i < paths.length; i++) {
      const p = paths[i];
      for (let k = 0; k < p.length - 1; k++) {
        const ax = p[k][0], az = p[k][1], bx = p[k + 1][0], bz = p[k + 1][1];
        const dx = bx - ax, dz = bz - az;
        const t = clamp(((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz), 0, 1);
        const qx = x - (ax + dx * t), qz = z - (az + dz * t);
        const dist = Math.sqrt(qx * qx + qz * qz);
        if (dist < 1.5) w = Math.max(w, 1 - smoothstep(dist, 0.35, 1.5));
      }
    }
    return w;
  }

  /* ------------------------------------------------------------- ground -- */

  buildGround() {
    this.bakeHeights();

    // A radially graded grid: cells are 25 cm where the player's boots are and
    // five metres out at the horizon. A uniform grid fine enough for near-field
    // relief would cost thirty times the triangles for detail nobody can see.
    const N = 256;
    const axis = new Float32Array(N + 1);
    for (let i = 0; i <= N; i++) {
      const t = (i / N) * 2 - 1;
      const s = Math.abs(t);
      axis[i] = Math.sign(t) * EXT * s * (0.20 + 0.80 * Math.pow(s, 3.2));
    }

    const w = N + 1, count = w * w;
    const pos = new Float32Array(count * 3);
    const uv = new Float32Array(count * 2);
    const col = new Float32Array(count * 3);
    const tint = [0, 0, 0];

    for (let i = 0; i <= N; i++) {
      const x = axis[i];
      for (let j = 0; j <= N; j++) {
        const z = axis[j];
        const k = i * w + j;
        pos[k * 3] = x;
        pos[k * 3 + 1] = this.terrainHeight(x, z);
        pos[k * 3 + 2] = z;
        uv[k * 2] = x / TILE;
        uv[k * 2 + 1] = z / TILE;
        this.groundTint(x, z, tint);
        col[k * 3] = tint[0]; col[k * 3 + 1] = tint[1]; col[k * 3 + 2] = tint[2];
      }
    }

    const idx = new Uint32Array(N * N * 6);
    let o = 0;
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const a = i * w + j, b = a + 1, c = a + w + 1, e = a + w;
        idx[o++] = a; idx[o++] = b; idx[o++] = e;
        idx[o++] = b; idx[o++] = c; idx[o++] = e;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();

    const ground = new THREE.Mesh(geo, this.mat('sand', 1, {
      color: new THREE.Color(1.24, 1.19, 1.08),
      normalScale: new THREE.Vector2(1.85, 1.85),
      vertexColors: true,
      aoMapIntensity: 0.55,
    }));
    ground.receiveShadow = true;
    ground.castShadow = false;
    ground.name = 'ground';
    this.group.add(ground);
    this.raycastables.push(ground);
    this.ground = ground;
  }

  /**
   * Vehicle track laid over the sand: a crowned centre with two rutted wheel
   * paths. Ruts are the reason a desert compound reads as inhabited, and at
   * this sun angle a six-centimetre rut is a metre of shadow.
   */
  track(points, width = 3.3, rut = 0.055) {
    const curve = new THREE.CatmullRomCurve3(points.map(([x, z]) => new THREE.Vector3(x, 0, z)));
    const length = curve.getLength();
    const along = Math.max(24, Math.round(length / 0.9));
    const across = 18;
    const w = across + 1;
    const pos = new Float32Array((along + 1) * w * 3);
    const uv = new Float32Array((along + 1) * w * 2);
    const col = new Float32Array((along + 1) * w * 3);
    const p = new THREE.Vector3(), t = new THREE.Vector3();

    for (let i = 0; i <= along; i++) {
      const s = i / along;
      curve.getPointAt(s, p);
      curve.getTangentAt(s, t);
      const nx = -t.z, nz = t.x;
      for (let j = 0; j <= across; j++) {
        const q = (j / across) * 2 - 1;                       // -1..1 across
        const wob = perlin(s * 26, q * 2, 64, 64) * 0.16;
        const half = width * 0.5 * (1 + wob);
        const x = p.x + nx * q * half, z = p.z + nz * q * half;
        const k = i * w + j;
        // Two ruts, a crown between them, feathered edges.
        const rd = Math.exp(-Math.pow((Math.abs(q) - 0.52) * 6.5, 2)) * rut;
        const crown = Math.exp(-q * q * 9) * 0.022;
        const edge = smoothstep(Math.abs(q), 0.72, 1.0);
        const y = this.terrainHeight(x, z) + 0.014 - rd + crown - edge * 0.020
          + perlin(x * 1.7, z * 1.7, 64, 64) * 0.012;
        pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
        uv[k * 2] = q * width * 0.5 / 2.2; uv[k * 2 + 1] = s * length / 2.2;
        const shade = (1 - edge * 0.45) * (0.86 + perlin(s * 18, q * 3, 64, 64) * 0.22);
        col[k * 3] = shade; col[k * 3 + 1] = shade * 0.99; col[k * 3 + 2] = shade * 0.98;
      }
    }

    const idx = new Uint32Array(along * across * 6);
    let o = 0;
    for (let i = 0; i < along; i++) {
      for (let j = 0; j < across; j++) {
        const a = i * w + j, b = a + 1, c = a + w + 1, e = a + w;
        idx[o++] = a; idx[o++] = e; idx[o++] = b;
        idx[o++] = b; idx[o++] = e; idx[o++] = c;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();

    const mesh = new THREE.Mesh(geo, this.mat('dirt', 1, {
      color: new THREE.Color(1.45, 1.36, 1.20),
      normalScale: new THREE.Vector2(1.5, 1.5),
      vertexColors: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }));
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.name = 'ground';
    this.group.add(mesh);
    this.raycastables.push(mesh);
    return mesh;
  }

  /** Irregular gravel hardstand — a texture break in the middle distance. */
  hardstand(cx, cz, radius) {
    const seg = 56, rings = 7;
    const w = seg + 1;
    const pos = new Float32Array((rings + 1) * w * 3);
    const uv = new Float32Array((rings + 1) * w * 2);
    const col = new Float32Array((rings + 1) * w * 3);
    for (let r = 0; r <= rings; r++) {
      const rt = r / rings;
      for (let s = 0; s <= seg; s++) {
        const a = (s / seg) * TAU;
        const wob = 1 + perlin(Math.cos(a) * 2.2, Math.sin(a) * 2.2, 64, 64) * 0.34;
        const rad = radius * wob * rt;
        const x = cx + Math.cos(a) * rad, z = cz + Math.sin(a) * rad * 0.78;
        const k = r * w + s;
        pos[k * 3] = x;
        pos[k * 3 + 1] = this.terrainHeight(x, z) + 0.012 - smoothstep(rt, 0.8, 1.0) * 0.016;
        pos[k * 3 + 2] = z;
        uv[k * 2] = x / 2.6; uv[k * 2 + 1] = z / 2.6;
        const shade = 1 - smoothstep(rt, 0.62, 1.0) * 0.5;
        col[k * 3] = shade; col[k * 3 + 1] = shade; col[k * 3 + 2] = shade;
      }
    }
    const idx = new Uint32Array(rings * seg * 6);
    let o = 0;
    for (let r = 0; r < rings; r++) {
      for (let s = 0; s < seg; s++) {
        const a = r * w + s, b = a + 1, c = a + w + 1, e = a + w;
        idx[o++] = a; idx[o++] = e; idx[o++] = b;
        idx[o++] = b; idx[o++] = e; idx[o++] = c;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, this.mat('dirt', 1, {
      color: new THREE.Color(1.60, 1.50, 1.34),
      normalScale: new THREE.Vector2(1.4, 1.4),
      vertexColors: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }));
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.name = 'ground';
    this.group.add(mesh);
    this.raycastables.push(mesh);
    return mesh;
  }

  /* ------------------------------------------------- perimeter and gate -- */

  buildPerimeter() {
    const wall = this.mat('plaster', [8, 1.2]);
    const H = 3.2, T = 0.55;
    const X = WALL_X, Z = WALL_Z;

    const run = (x, z, len, ry) => {
      // Break every run into segments with independent height jitter and
      // occasional blown-out gaps — a perfectly uniform wall looks synthetic
      // and gives the player nothing to read as cover.
      const segs = Math.max(2, Math.round(len / 4.2));
      const step = len / segs;
      for (let i = 0; i < segs; i++) {
        const t = (i + 0.5) / segs - 0.5;
        const off = t * len;
        const dx = Math.cos(ry) * off, dz = -Math.sin(ry) * off;
        const damage = this.rand();
        const h = damage < 0.16 ? H * (0.28 + this.rand() * 0.26) : H * (0.93 + this.rand() * 0.07);
        // Bases run below grade so drifted sand never opens a gap beneath.
        const m = this.box(step * 1.005, h + 0.9, T, x + dx, h / 2 - 0.45, z + dz, wall,
          { ry, bevel: 0.03 });
        m.rotation.z = (this.rand() - 0.5) * 0.012;
        if (damage >= 0.16 && this.rand() < 0.6) {
          // Coping course along the top — a hard bright line at dawn.
          this.box(step * 0.99, 0.16, T + 0.16, x + dx, h + 0.08, z + dz, wall,
            { ry, bevel: 0.03, collide: false });
        }
        if (damage < 0.16) {
          this.coverPoints.push(new THREE.Vector3(x + dx, 0, z + dz));
          this.rubble(x + dx - Math.sin(ry) * 1.0, z + dz - Math.cos(ry) * 1.0, 1.9, 26);
          this.rebar(x + dx, h, z + dz, ry, 5);
        }
      }
    };

    run(0, -Z, X * 2, 0);            // south
    run(0, Z, X * 2 - 9, 0);         // north (gate gap handled below)
    run(-X, 0, Z * 2, Math.PI / 2);  // west
    run(X, 0, Z * 2, Math.PI / 2);   // east

    // Gate: two piers, a lintel, and a sagging steel leaf hanging off one hinge.
    const pier = this.mat('concrete', [1, 2]);
    this.box(1.1, 4.8, 1.1, -4.6, 2.1, Z, pier, { bevel: 0.05 });
    this.box(1.1, 4.8, 1.1, 4.6, 2.1, Z, pier, { bevel: 0.05 });
    this.box(10.3, 0.6, 0.8, 0, 4.5, Z, pier, { bevel: 0.04 });

    const leaf = this.box(4.3, 3.0, 0.12, -2.35, 1.6, Z - 0.1, this.mat('corrugated', [2, 1.4]), { bevel: 0.01 });
    leaf.rotation.set(0, -0.34, 0.06);

    // Concertina coils along the top of the east and west walls.
    this.buildWire(-X + 0.1, H, -Z + 2, Z - 2);
    this.buildWire(X - 0.1, H, -Z + 2, Z - 2);
  }

  buildWire(x, y, z0, z1) {
    const pts = [];
    const coils = Math.floor((z1 - z0) / 0.9);
    for (let i = 0; i <= coils * 24; i++) {
      const t = i / (coils * 24);
      const a = t * TAU * coils;
      pts.push(new THREE.Vector3(
        x + Math.cos(a) * 0.34,
        y + 0.34 + Math.sin(a) * 0.34,
        THREE.MathUtils.lerp(z0, z1, t),
      ));
    }
    const geo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), coils * 20, 0.018, 5, false);
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      color: 0x6d6a66, roughness: 0.52, metalness: 0.9,
    }));
    mesh.castShadow = true;
    this.group.add(mesh);
  }

  /* ---------------------------------------------------------- buildings -- */

  /**
   * Mud-brick shell with punched openings. Walls are assembled from jamb and
   * lintel segments — cheaper and cleaner than CSG, and it lets each opening
   * carry its own reveal depth.
   */
  building(cx, cz, w, d, h, ry, opts = {}) {
    const { floors = 1, openings = {}, parapet = 0.55, roofProps = true } = opts;
    const shell = this.mat('plaster', [Math.max(2, w / 3), Math.max(1.5, h / 3)]);
    const inner = this.mat('plaster', [Math.max(2, w / 3), Math.max(1.5, h / 3)], { color: 0xb9ada0 });
    const T = 0.42;
    const g = new THREE.Group();
    g.position.set(cx, 0, cz);
    g.rotation.y = ry;

    const totalH = h * floors;

    // Each side: list of [centerOffset, width, sillY, headY] holes.
    const sides = [
      { axis: 'z', sign: -1, len: w, holes: openings.south ?? [] },
      { axis: 'z', sign: 1, len: w, holes: openings.north ?? [] },
      { axis: 'x', sign: -1, len: d, holes: openings.west ?? [] },
      { axis: 'x', sign: 1, len: d, holes: openings.east ?? [] },
    ];

    const local = [];
    const put = (bw, bh, bd, bx, by, bz) => {
      const geo = new RoundedBoxGeometry(bw, bh, bd, 2, 0.025);
      const m = new THREE.Mesh(geo, shell);
      m.position.set(bx, by, bz);
      m.castShadow = true; m.receiveShadow = true;
      g.add(m);
      local.push(m);
      return m;
    };

    for (const side of sides) {
      const along = side.axis === 'z' ? w : d;
      const offset = side.axis === 'z' ? (d / 2 - T / 2) * side.sign : (w / 2 - T / 2) * side.sign;
      // Sort holes and emit the solid spans between them.
      const holes = [...side.holes].sort((a, b) => a[0] - b[0]);
      let cursor = -along / 2;
      const emit = (from, to, y0, y1) => {
        const len = to - from;
        if (len <= 0.01 || y1 - y0 <= 0.01) return;
        const c = (from + to) / 2;
        // Below-grade skirt on the ground course so ripples and drifts can
        // never open a sliver of daylight under a wall.
        const lo = y0 === 0 ? -0.55 : y0;
        if (side.axis === 'z') put(len, y1 - lo, T, c, (lo + y1) / 2, offset);
        else put(T, y1 - lo, len, offset, (lo + y1) / 2, c);
      };
      for (const [hc, hw, sill, head] of holes) {
        emit(cursor, hc - hw / 2, 0, totalH);
        if (sill > 0) emit(hc - hw / 2, hc + hw / 2, 0, sill);
        if (head < totalH) emit(hc - hw / 2, hc + hw / 2, head, totalH);
        cursor = hc + hw / 2;
      }
      emit(cursor, along / 2, 0, totalH);
    }

    // Interior floor + ceiling slabs.
    for (let f = 0; f <= floors; f++) {
      const y = f * h;
      if (f === 0) continue;
      const slab = new THREE.Mesh(new RoundedBoxGeometry(w - T * 1.6, 0.26, d - T * 1.6, 2, 0.02),
        f === floors ? this.mat('concrete', [w / 3, d / 3]) : inner);
      slab.position.set(0, y, 0);
      slab.castShadow = true; slab.receiveShadow = true;
      g.add(slab); local.push(slab);
    }

    // Roof parapet.
    if (parapet > 0) {
      const p = this.mat('plaster', [w / 2, 0.6]);
      const mk = (bw, bd, bx, bz) => {
        const m = new THREE.Mesh(new RoundedBoxGeometry(bw, parapet, bd, 2, 0.03), p);
        m.position.set(bx, totalH + parapet / 2 + 0.13, bz);
        m.castShadow = true; m.receiveShadow = true;
        g.add(m); local.push(m);
      };
      mk(w, T * 0.8, 0, -d / 2 + T * 0.4);
      mk(w, T * 0.8, 0, d / 2 - T * 0.4);
      mk(T * 0.8, d, -w / 2 + T * 0.4, 0);
      mk(T * 0.8, d, w / 2 - T * 0.4, 0);
    }

    // Projecting roof beams — a signature of this construction and a cheap
    // way to throw complex shadow patterns down the facade at dawn.
    const beamMat = this.mat('wood', [1, 1]);
    const nBeams = Math.max(3, Math.floor(w / 1.3));
    for (let i = 0; i < nBeams; i++) {
      const t = (i + 0.5) / nBeams - 0.5;
      if (this.rand() < 0.18) continue;
      const len = 0.55 + this.rand() * 0.35;
      const b = new THREE.Mesh(new RoundedBoxGeometry(0.14, 0.14, d + len * 2, 1, 0.015), beamMat);
      b.position.set(t * w, totalH - 0.2, 0);
      b.castShadow = true; b.receiveShadow = true;
      g.add(b);
    }

    if (roofProps) this.roofClutter(g, w, d, totalH + 0.13);

    this.group.add(g);
    g.updateWorldMatrix(true, true);
    for (const m of local) {
      this.raycastables.push(m);
      this.colliders.push(new THREE.Box3().setFromObject(m));
    }
    return g;
  }

  roofClutter(g, w, d, y) {
    const tank = new THREE.Mesh(
      new THREE.CylinderGeometry(0.62, 0.62, 1.15, 24, 1),
      this.mat('painted', [2, 1], { color: 0x9a9d92 }),
    );
    tank.position.set(w * 0.28, y + 0.58, -d * 0.24);
    tank.castShadow = true; tank.receiveShadow = true;
    g.add(tank);

    // Satellite dish.
    const dish = new THREE.Mesh(
      new THREE.SphereGeometry(0.46, 24, 14, 0, TAU, 0, Math.PI * 0.34),
      new THREE.MeshStandardMaterial({ color: 0xcfc9bd, roughness: 0.62, metalness: 0.1, side: THREE.DoubleSide }),
    );
    dish.position.set(-w * 0.3, y + 0.5, d * 0.22);
    dish.rotation.set(Math.PI * 0.62, 0, 0.5);
    dish.castShadow = true;
    g.add(dish);

    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 2.4, 8), this.mat('rust', 1));
    pole.position.set(-w * 0.3, y + 1.2, d * 0.22);
    pole.castShadow = true;
    g.add(pole);

    // Stair bulkhead and a whip mast — without them the parapet is one
    // unbroken horizontal, which is what makes a block read as cardboard.
    const hut = new THREE.Mesh(new RoundedBoxGeometry(2.3, 2.9, 2.0, 2, 0.03),
      this.mat('plaster', [1.5, 1.2]));
    hut.position.set(-w * 0.08, y + 1.45, -d * 0.04);
    hut.castShadow = true; hut.receiveShadow = true;
    g.add(hut);
    const cap = new THREE.Mesh(new RoundedBoxGeometry(2.7, 0.10, 2.4, 1, 0.02),
      this.mat('corrugated', [2, 2]));
    cap.position.set(-w * 0.08, y + 2.95, -d * 0.04);
    cap.rotation.z = 0.06;
    cap.castShadow = true; cap.receiveShadow = true;
    g.add(cap);

    const steel = this.mat('rust', [1, 3]);
    const whip = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.055, 4.2, 6), steel);
    whip.position.set(w * 0.42, y + 2.1, d * 0.34);
    whip.rotation.z = 0.05;
    whip.castShadow = true;
    g.add(whip);
    for (let i = 0; i < 4; i++) {
      const el = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.7, 4), steel);
      el.position.set(w * 0.42, y + 2.6 + i * 0.42, d * 0.34);
      el.rotation.set(Math.PI / 2, 0, 0);
      el.castShadow = true;
      g.add(el);
    }

    // Sandbagged firing position on the parapet.
    const bagGeo = new THREE.SphereGeometry(0.27, 10, 7);
    bagGeo.scale(1.0, 0.6, 0.72);
    const bags = new THREE.InstancedMesh(bagGeo, this.mat('burlap', [1.4, 1]), 22);
    bags.castShadow = true; bags.receiveShadow = true;
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    const p = new THREE.Vector3(), s = new THREE.Vector3();
    let n = 0;
    for (let row = 0; row < 2; row++) {
      const cnt = 8 - row;
      for (let i = 0; i < cnt && n < 22; i++) {
        p.set((i / cnt - 0.5) * w * 0.55 + w * 0.1, y + 0.17 + row * 0.3, -d / 2 + 0.55);
        e.set(0, (this.rand() - 0.5) * 0.4, (this.rand() - 0.5) * 0.14);
        q.setFromEuler(e);
        const sc = 0.95 + this.rand() * 0.12;
        s.set(sc, sc, sc);
        m4.compose(p, q, s);
        bags.setMatrixAt(n++, m4);
      }
    }
    bags.count = n;
    bags.instanceMatrix.needsUpdate = true;
    g.add(bags);
  }

  /* ------------------------------------------------------ props: bagged -- */

  /** Stacked sandbag emplacement. Bags are squashed spheres, jittered per row. */
  sandbags(x, z, length, ry, rows = 3) {
    const g = new THREE.Group();
    g.position.set(x, this.groundHeight(x, z), z);
    g.rotation.y = ry;
    const mat = this.mat('burlap', [1.4, 1]);
    const bagGeo = new THREE.SphereGeometry(0.29, 12, 8);
    bagGeo.scale(1.0, 0.62, 0.72);

    const perRow = Math.max(2, Math.round(length / 0.52));
    const inst = new THREE.InstancedMesh(bagGeo, mat, perRow * rows + rows * 2);
    inst.castShadow = true; inst.receiveShadow = true;
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    const pos = new THREE.Vector3(), scl = new THREE.Vector3();
    let n = 0;

    for (let r = 0; r < rows; r++) {
      const count = perRow - r;                       // pyramid stack
      const stagger = (r % 2) * 0.26;
      for (let i = 0; i < count; i++) {
        const t = (i + 0.5) / count - 0.5;
        pos.set(t * (length - r * 0.5) + stagger * 0.1,
          0.16 + r * 0.335,
          (this.rand() - 0.5) * 0.07);
        e.set((this.rand() - 0.5) * 0.14, (this.rand() - 0.5) * 0.3, (this.rand() - 0.5) * 0.16);
        q.setFromEuler(e);
        const s = 0.94 + this.rand() * 0.14;
        scl.set(s, s * (0.94 + this.rand() * 0.1), s);
        m4.compose(pos, q, scl);
        inst.setMatrixAt(n++, m4);
      }
    }
    inst.count = n;
    inst.instanceMatrix.needsUpdate = true;
    g.add(inst);

    this.group.add(g);
    g.updateWorldMatrix(true, true);
    this.raycastables.push(inst);

    const h = 0.14 + rows * 0.335;
    const box = new THREE.Box3().setFromCenterAndSize(
      new THREE.Vector3(x, h / 2, z),
      new THREE.Vector3(Math.abs(Math.cos(ry)) * length + Math.abs(Math.sin(ry)) * 0.7 + 0.2, h,
        Math.abs(Math.sin(ry)) * length + Math.abs(Math.cos(ry)) * 0.7 + 0.2),
    );
    this.colliders.push(box);
    this.coverPoints.push(new THREE.Vector3(x, 0, z));
    return g;
  }

  /**
   * HESCO-pattern bastion: wire cages of poured sand. Reads as a hard
   * horizontal band with a soft crumbling top, which is a different
   * silhouette from both the wall and the sandbags.
   */
  bastion(x, z, length, ry, height = 1.15) {
    const g = new THREE.Group();
    g.position.set(x, this.groundHeight(x, z), z);
    g.rotation.y = ry;
    const cells = Math.max(1, Math.round(length / 1.0));
    const cw = length / cells;

    const fill = this.mat('sand', [1.6, 1], {
      color: new THREE.Color(1.16, 1.08, 0.94), normalScale: new THREE.Vector2(2.2, 2.2),
    });
    const body = new THREE.Mesh(new RoundedBoxGeometry(length, height, 0.98, 2, 0.05), fill);
    body.position.y = height / 2 - 0.08;
    body.castShadow = true; body.receiveShadow = true;
    g.add(body);

    // Heaped, uneven fill spilling over the top of each cage.
    const capGeo = new THREE.SphereGeometry(0.5, 10, 6);
    capGeo.scale(1, 0.34, 0.95);
    const caps = new THREE.InstancedMesh(capGeo, fill, cells * 2);
    caps.castShadow = true; caps.receiveShadow = true;
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    const p = new THREE.Vector3(), s = new THREE.Vector3();
    let n = 0;
    for (let i = 0; i < cells * 2; i++) {
      p.set(((i + 0.5) / (cells * 2) - 0.5) * length, height - 0.10 + this.rand() * 0.05,
        (this.rand() - 0.5) * 0.2);
      e.set(0, this.rand() * TAU, (this.rand() - 0.5) * 0.1);
      q.setFromEuler(e);
      const sc = 0.85 + this.rand() * 0.35;
      s.set(sc, 1, sc);
      m4.compose(p, q, s);
      caps.setMatrixAt(n++, m4);
    }
    caps.instanceMatrix.needsUpdate = true;
    g.add(caps);

    // Cage: vertical stiffeners plus two hoop wires.
    const wireMat = this.mat('rust', 1);
    for (let i = 0; i <= cells; i++) {
      const bx = -length / 2 + i * cw;
      for (const sz of [-1, 1]) {
        const bar = new THREE.Mesh(new RoundedBoxGeometry(0.035, height, 0.035, 1, 0.008), wireMat);
        bar.position.set(bx, height / 2 - 0.08, sz * 0.5);
        bar.castShadow = true;
        g.add(bar);
      }
    }
    for (const hy of [0.22, height - 0.22]) {
      for (const sz of [-1, 1]) {
        const hoop = new THREE.Mesh(new RoundedBoxGeometry(length, 0.032, 0.032, 1, 0.008), wireMat);
        hoop.position.set(0, hy, sz * 0.505);
        hoop.castShadow = true;
        g.add(hoop);
      }
    }

    this.seal(g, { cover: true });
    return g;
  }

  /* --------------------------------------------------------- props: kit -- */

  container(x, z, ry, color) {
    const g = new THREE.Group();
    g.position.set(x, this.groundHeight(x, z), z);
    g.rotation.y = ry;
    const W = 6.06, H = 2.59, D = 2.44;

    const body = new THREE.Mesh(new RoundedBoxGeometry(W, H, D, 3, 0.035),
      this.mat('painted', [4, 2], { color }));
    body.position.y = H / 2 + 0.12;
    body.castShadow = true; body.receiveShadow = true;
    g.add(body);

    // Corrugation ribs down the long sides — the read that says "container".
    const ribMat = this.mat('painted', [1, 2], { color });
    const ribs = Math.floor(W / 0.28);
    for (let i = 0; i < ribs; i++) {
      const t = (i + 0.5) / ribs - 0.5;
      for (const s of [-1, 1]) {
        const rib = new THREE.Mesh(new RoundedBoxGeometry(0.11, H - 0.28, 0.055, 1, 0.012), ribMat);
        rib.position.set(t * W, H / 2 + 0.12, s * (D / 2 + 0.022));
        rib.castShadow = true; rib.receiveShadow = true;
        g.add(rib);
      }
    }
    // Corner castings.
    const cast = this.mat('rust', 1);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (const sy of [0, 1]) {
      const c = new THREE.Mesh(new RoundedBoxGeometry(0.30, 0.24, 0.24, 1, 0.02), cast);
      c.position.set(sx * (W / 2 - 0.13), 0.12 + sy * (H - 0.24) + 0.12, sz * (D / 2 - 0.1));
      c.castShadow = true; c.receiveShadow = true;
      g.add(c);
    }
    // Door furniture on one end.
    for (const off of [-0.55, -0.18, 0.18, 0.55]) {
      const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, H - 0.4, 8), cast);
      rod.position.set(W / 2 + 0.03, H / 2 + 0.12, off);
      rod.castShadow = true;
      g.add(rod);
    }
    // Skid rails.
    const rail = new THREE.Mesh(new RoundedBoxGeometry(W - 0.2, 0.14, D - 0.3, 1, 0.02), cast);
    rail.position.y = 0.07;
    rail.receiveShadow = true; rail.castShadow = true;
    g.add(rail);

    this.seal(g, { cover: true });
    return g;
  }

  barrel(x, z, tipped = false) {
    const g = new THREE.Group();
    const R = 0.29, H = 0.88;
    const y0 = this.groundHeight(x, z);
    const body = new THREE.Mesh(new THREE.CylinderGeometry(R, R, H, 28, 1), this.mat('rust', [2, 1]));
    body.castShadow = true; body.receiveShadow = true;
    g.add(body);
    for (const y of [-H * 0.28, 0, H * 0.28]) {
      const rib = new THREE.Mesh(new THREE.TorusGeometry(R + 0.008, 0.026, 6, 28), this.mat('rust', 1));
      rib.rotation.x = Math.PI / 2;
      rib.position.y = y;
      rib.castShadow = true;
      g.add(rib);
    }
    for (const s of [-1, 1]) {
      const lip = new THREE.Mesh(new THREE.TorusGeometry(R - 0.02, 0.022, 6, 28), this.mat('rust', 1));
      lip.rotation.x = Math.PI / 2;
      lip.position.y = s * H / 2;
      lip.castShadow = true;
      g.add(lip);
    }

    if (tipped) {
      g.position.set(x, y0 + R + 0.02, z);
      g.rotation.set(Math.PI / 2, this.rand() * TAU, (this.rand() - 0.5) * 0.4);
    } else {
      g.position.set(x, y0 + H / 2 + 0.02, z);
      g.rotation.y = this.rand() * TAU;
    }
    this.seal(g);
    return g;
  }

  crate(x, z, s = 1, ry = 0, ammo = false) {
    const w = 1.02 * s, h = 0.62 * s, d = 0.66 * s;
    const g = new THREE.Group();
    g.position.set(x, this.groundHeight(x, z) + h / 2 + 0.02, z);
    g.rotation.y = ry;
    const mat = ammo ? this.mat('painted', [2, 1.2]) : this.mat('wood', [1.6, 1]);
    const body = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 2, 0.022), mat);
    body.castShadow = true; body.receiveShadow = true;
    g.add(body);
    // Corner banding.
    const band = this.mat('rust', 1);
    for (const sx of [-1, 1]) {
      const b = new THREE.Mesh(new RoundedBoxGeometry(0.05 * s, h + 0.01, d + 0.015, 1, 0.008), band);
      b.position.x = sx * (w / 2 - 0.07 * s);
      b.castShadow = true;
      g.add(b);
    }
    if (ammo) {
      const latch = new THREE.Mesh(new RoundedBoxGeometry(0.14 * s, 0.09 * s, 0.05 * s, 1, 0.01), band);
      latch.position.set(0, h * 0.18, d / 2 + 0.02);
      g.add(latch);
    }
    this.seal(g);
    return g;
  }

  /**
   * Timber pallet. Stood on edge it is the one foreground prop that works
   * against a low sun: the gaps between the slats let the sky through, so it
   * reads as a striped silhouette instead of a black rectangle.
   */
  pallet(x, z, ry, lean = 0) {
    const g = new THREE.Group();
    g.position.set(x, this.groundHeight(x, z) + Math.abs(Math.sin(lean)) * 0.57, z);
    g.rotation.set(lean, ry, 0);
    const mat = this.mat('wood', [1.2, 0.8]);
    for (const bz of [-0.5, 0, 0.5]) {
      const bear = new THREE.Mesh(new RoundedBoxGeometry(1.2, 0.09, 0.10, 1, 0.012), mat);
      bear.position.set(0, 0.05, bz);
      bear.castShadow = true; bear.receiveShadow = true;
      g.add(bear);
    }
    for (let i = 0; i < 6; i++) {
      const slat = new THREE.Mesh(new RoundedBoxGeometry(0.13, 0.022, 1.14, 1, 0.006), mat);
      slat.position.set((i / 5 - 0.5) * 1.14, 0.105, 0);
      slat.castShadow = true; slat.receiveShadow = true;
      g.add(slat);
    }
    this.seal(g, { collide: false });
    return g;
  }

  /** Stack of worn truck tyres. */
  tyres(x, z, n) {
    const g = new THREE.Group();
    const y0 = this.groundHeight(x, z);
    g.position.set(x, y0, z);
    const geo = new THREE.TorusGeometry(0.38, 0.155, 7, 20);
    geo.rotateX(Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({ color: 0x1b1a19, roughness: 0.93, metalness: 0.0 });
    const inst = new THREE.InstancedMesh(geo, mat, n);
    inst.castShadow = true; inst.receiveShadow = true;
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    const p = new THREE.Vector3(), s = new THREE.Vector3(1, 1, 1);
    for (let i = 0; i < n; i++) {
      p.set((this.rand() - 0.5) * 0.10, 0.16 + i * 0.30, (this.rand() - 0.5) * 0.10);
      e.set((this.rand() - 0.5) * 0.06, this.rand() * TAU, (this.rand() - 0.5) * 0.06);
      q.setFromEuler(e);
      m4.compose(p, q, s);
      inst.setMatrixAt(i, m4);
    }
    inst.instanceMatrix.needsUpdate = true;
    g.add(inst);
    this.group.add(g);
    g.updateWorldMatrix(true, true);
    this.raycastables.push(inst);
    this.colliders.push(new THREE.Box3().setFromCenterAndSize(
      new THREE.Vector3(x, y0 + n * 0.15, z), new THREE.Vector3(1.1, n * 0.3, 1.1)));
    return g;
  }

  /** Precast traffic barrier. Short, hard-edged, and unmistakably man-made. */
  jersey(x, z, ry) {
    const g = new THREE.Group();
    g.position.set(x, this.groundHeight(x, z), z);
    g.rotation.y = ry;
    const mat = this.mat('concrete', [1.6, 1]);
    const foot = new THREE.Mesh(new RoundedBoxGeometry(2.4, 0.20, 0.62, 2, 0.02), mat);
    foot.position.y = 0.10;
    const skirt = new THREE.Mesh(new RoundedBoxGeometry(2.36, 0.22, 0.50, 2, 0.03), mat);
    skirt.position.y = 0.31;
    const waist = new THREE.Mesh(new RoundedBoxGeometry(2.32, 0.20, 0.34, 2, 0.03), mat);
    waist.position.y = 0.52;
    const cap = new THREE.Mesh(new RoundedBoxGeometry(2.30, 0.24, 0.26, 2, 0.03), mat);
    cap.position.y = 0.74;
    for (const m of [foot, skirt, waist, cap]) { m.castShadow = true; m.receiveShadow = true; g.add(m); }
    // Lifting eyes.
    for (const sx of [-0.5, 0.5]) {
      const eye = new THREE.Mesh(new THREE.TorusGeometry(0.055, 0.014, 5, 10), this.mat('rust', 1));
      eye.position.set(sx, 0.88, 0);
      eye.castShadow = true;
      g.add(eye);
    }
    this.seal(g, { cover: true });
    return g;
  }

  /** Spool of heavy cable, half unwound. */
  cableDrum(x, z, ry) {
    const g = new THREE.Group();
    g.position.set(x, this.groundHeight(x, z) + 0.62, z);
    g.rotation.set(0, ry, Math.PI / 2);
    const wood = this.mat('wood', [1.4, 1.4]);
    for (const s of [-1, 1]) {
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.06, 20), wood);
      disc.position.y = s * 0.32;
      disc.castShadow = true; disc.receiveShadow = true;
      g.add(disc);
    }
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.62, 16), wood);
    hub.castShadow = true; hub.receiveShadow = true;
    g.add(hub);
    const coil = new THREE.Mesh(new THREE.CylinderGeometry(0.44, 0.44, 0.50, 20),
      new THREE.MeshStandardMaterial({ color: 0x241f1c, roughness: 0.86, metalness: 0.12 }));
    coil.castShadow = true; coil.receiveShadow = true;
    g.add(coil);
    this.seal(g);
    return g;
  }

  /* ------------------------------------------------- props: linear steel -- */

  /**
   * Shade frame. Four legs, a rafter grid and a partial cover: the rafters
   * stripe the sand with six metres of shadow each, which is the cheapest
   * "low sun" signal in the level.
   */
  awning(x, z, w, d, ry, h = 2.85) {
    const g = new THREE.Group();
    const y0 = this.groundHeight(x, z);
    g.position.set(x, y0, z);
    g.rotation.y = ry;
    const steel = this.mat('rust', [1, 3]);

    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.062, h, 8), steel);
      leg.position.set(sx * w / 2, h / 2, sz * d / 2);
      leg.castShadow = true; leg.receiveShadow = true;
      g.add(leg);
    }
    for (const sz of [-1, 1]) {
      const beam = new THREE.Mesh(new RoundedBoxGeometry(w + 0.3, 0.10, 0.10, 1, 0.012), steel);
      beam.position.set(0, h, sz * d / 2);
      beam.castShadow = true;
      g.add(beam);
    }
    const rafters = Math.max(3, Math.round(w / 0.62));
    for (let i = 0; i <= rafters; i++) {
      const r = new THREE.Mesh(new RoundedBoxGeometry(0.07, 0.07, d + 0.5, 1, 0.01), steel);
      r.position.set((i / rafters - 0.5) * w, h + 0.08, 0);
      r.rotation.x = (this.rand() - 0.5) * 0.02;
      r.castShadow = true;
      g.add(r);
    }
    // Cover over part of the frame only, so the rafters stay legible.
    const cover = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.55, d + 0.4, 10, 6),
      this.mat('canvas', [2, 1.4], { side: THREE.DoubleSide }));
    const cp = cover.geometry.attributes.position;
    for (let i = 0; i < cp.count; i++) {
      const cu = cp.getX(i) / (w * 0.55) + 0.5, cv = cp.getY(i) / (d + 0.4) + 0.5;
      cp.setZ(i, -Math.sin(cu * Math.PI) * Math.sin(cv * Math.PI) * 0.14);
    }
    cover.geometry.computeVertexNormals();
    cover.rotation.x = -Math.PI / 2;
    cover.position.set(-w * 0.20, h + 0.13, 0);
    cover.castShadow = true; cover.receiveShadow = true;
    g.add(cover);

    this.group.add(g);
    g.updateWorldMatrix(true, true);
    g.traverse((o) => { if (o.isMesh) this.raycastables.push(o); });
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      this.colliders.push(new THREE.Box3().setFromCenterAndSize(
        new THREE.Vector3(x + (Math.cos(ry) * sx * w / 2 + Math.sin(ry) * sz * d / 2),
          y0 + h / 2, z + (-Math.sin(ry) * sx * w / 2 + Math.cos(ry) * sz * d / 2)),
        new THREE.Vector3(0.24, h, 0.24)));
    }
    return g;
  }

  /**
   * Lean-to against a wall. The roof is the point: a horizontal plate sees the
   * whole sky dome, so it stays bright against a facade that the low sun has
   * left completely unlit, and it stops a big wall reading as one black slab.
   */
  leanTo(x, z, w, depth, ry, h = 2.45) {
    const g = new THREE.Group();
    g.position.set(x, this.groundHeight(x, z), z);
    g.rotation.y = ry;
    const steel = this.mat('rust', [1, 2]);
    for (const sx of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.055, h - 0.22, 7), steel);
      post.position.set(sx * (w / 2 - 0.1), (h - 0.22) / 2, depth / 2);
      post.castShadow = true; post.receiveShadow = true;
      g.add(post);
      const brace = new THREE.Mesh(new RoundedBoxGeometry(0.06, 0.06, 0.9, 1, 0.01), steel);
      brace.position.set(sx * (w / 2 - 0.1), h - 0.55, depth * 0.18);
      brace.rotation.x = -0.72;
      brace.castShadow = true;
      g.add(brace);
    }
    const roof = new THREE.Mesh(new RoundedBoxGeometry(w, 0.07, depth + 0.35, 1, 0.015),
      this.mat('corrugated', [Math.max(2, w / 1.2), 2]));
    roof.position.set(0, h - 0.1, 0);
    roof.rotation.x = -0.10;
    roof.castShadow = true; roof.receiveShadow = true;
    g.add(roof);
    for (let i = 0; i < Math.max(2, Math.round(w / 1.1)); i++) {
      const purlin = new THREE.Mesh(new RoundedBoxGeometry(0.06, 0.06, depth + 0.25, 1, 0.01), steel);
      purlin.position.set((i / Math.max(1, Math.round(w / 1.1) - 1) - 0.5) * (w - 0.3), h - 0.18, 0);
      purlin.rotation.x = -0.10;
      purlin.castShadow = true;
      g.add(purlin);
    }
    this.seal(g, { collide: false });
    return g;
  }

  /**
   * Elevated water tank. Eleven metres of it, so it breaks the skyline on the
   * side of the frame the comms mast does not, and lays a sixty-metre bar of
   * shadow across the southern approach.
   */
  waterTower(x, z, h = 11) {
    const g = new THREE.Group();
    const y0 = this.groundHeight(x, z);
    g.position.set(x, y0, z);
    const steel = this.mat('rust', [1, 4]);
    const S = 1.6, T = 0.85;

    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const bot = new THREE.Vector3(sx * S, 0, sz * S);
      const top = new THREE.Vector3(sx * T, h, sz * T);
      const dir = new THREE.Vector3().subVectors(top, bot);
      // Chunky enough to survive the chromatic aberration: a two-pixel dark
      // leg against a blown sky comes back as a magenta hairline.
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.10, 0.13, dir.length(), 7), steel);
      leg.position.copy(bot).addScaledVector(dir, 0.5);
      leg.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
      leg.castShadow = true; leg.receiveShadow = true;
      g.add(leg);
    }
    for (let lvl = 1; lvl <= 3; lvl++) {
      const t = lvl / 4;
      const r = lerp(S, T, t) * 2;
      for (let side = 0; side < 4; side++) {
        const a = (side / 4) * TAU;
        const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, r * 1.02, 5), steel);
        bar.position.set(Math.cos(a) * r * 0.5, t * h, Math.sin(a) * r * 0.5);
        bar.rotation.set(0, -a, Math.PI / 2);
        bar.castShadow = true;
        g.add(bar);
      }
    }
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(2.0, 2.0, 2.6, 20, 1),
      this.mat('rust', [4, 2]));
    tank.position.y = h + 1.3;
    tank.castShadow = true; tank.receiveShadow = true;
    g.add(tank);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(2.15, 0.7, 20), this.mat('corrugated', [4, 1]));
    roof.position.y = h + 2.95;
    roof.castShadow = true; roof.receiveShadow = true;
    g.add(roof);
    for (const hy of [h + 0.15, h + 2.45]) {
      const hoop = new THREE.Mesh(new THREE.TorusGeometry(2.03, 0.045, 5, 20), steel);
      hoop.rotation.x = Math.PI / 2;
      hoop.position.y = hy;
      hoop.castShadow = true;
      g.add(hoop);
    }
    // Downpipe and ladder.
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, h + 0.6, 7), steel);
    pipe.position.set(1.6, (h + 0.6) / 2, 0.5);
    pipe.castShadow = true;
    g.add(pipe);
    for (const sx of [-0.2, 0.2]) {
      const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, h + 1.0, 5), steel);
      rail.position.set(-S - 0.15, (h + 1.0) / 2, sx);
      rail.castShadow = true;
      g.add(rail);
    }
    for (let i = 0; i < Math.floor(h / 0.34); i++) {
      const rung = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.42, 4), steel);
      rung.position.set(-S - 0.15, 0.25 + i * 0.34, 0);
      rung.rotation.x = Math.PI / 2;
      rung.castShadow = true;
      g.add(rung);
    }

    this.group.add(g);
    g.updateWorldMatrix(true, true);
    g.traverse((o) => { if (o.isMesh) this.raycastables.push(o); });
    this.colliders.push(new THREE.Box3().setFromCenterAndSize(
      new THREE.Vector3(x, y0 + 1.2, z), new THREE.Vector3(S * 2.4, 2.4, S * 2.4)));
    return g;
  }

  /** Guyed lattice mast. The tallest thing on site and the skyline anchor. */
  mast(x, z, h) {
    const g = new THREE.Group();
    const y0 = this.groundHeight(x, z);
    g.position.set(x, y0, z);
    const steel = this.mat('rust', [1, 4]);
    const R0 = 0.55, R1 = 0.16;

    const legPos = [];
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * TAU + 0.4;
      const bot = new THREE.Vector3(Math.cos(a) * R0, 0, Math.sin(a) * R0);
      const top = new THREE.Vector3(Math.cos(a) * R1, h, Math.sin(a) * R1);
      const dir = new THREE.Vector3().subVectors(top, bot);
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.058, dir.length(), 6), steel);
      leg.position.copy(bot).addScaledVector(dir, 0.5);
      leg.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
      leg.castShadow = true;
      g.add(leg);
      legPos.push([bot, top]);
    }
    // Zig-zag bracing between the legs.
    const levels = Math.floor(h / 0.85);
    for (let l = 0; l < levels; l++) {
      const t0 = l / levels, t1 = (l + 1) / levels;
      for (let i = 0; i < 3; i++) {
        const a = legPos[i], b = legPos[(i + 1) % 3];
        const p0 = a[0].clone().lerp(a[1], t0);
        const p1 = b[0].clone().lerp(b[1], l % 2 ? t0 : t1);
        const dir = new THREE.Vector3().subVectors(p1, p0);
        const br = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, dir.length(), 5), steel);
        br.position.copy(p0).addScaledVector(dir, 0.5);
        br.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
        br.castShadow = true;
        g.add(br);
      }
    }
    // Whip antennas and a dish, then guys down to ground anchors.
    for (const [ax, ay] of [[0.0, 1.9], [0.22, 1.35]]) {
      const whip = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.022, ay, 5), steel);
      whip.position.set(ax, h + ay / 2, 0);
      whip.castShadow = true;
      g.add(whip);
    }
    const guyMat = new THREE.MeshStandardMaterial({ color: 0x2a2724, roughness: 0.8, metalness: 0.35 });
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * TAU + 1.2;
      const anchor = new THREE.Vector3(Math.cos(a) * h * 0.40, 0, Math.sin(a) * h * 0.40);
      const top = new THREE.Vector3(0, h * 0.86, 0);
      const pts = [];
      for (let k = 0; k <= 8; k++) {
        const p = anchor.clone().lerp(top, k / 8);
        p.y -= Math.sin((k / 8) * Math.PI) * 0.25;
        pts.push(p);
      }
      const guy = new THREE.Mesh(
        new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 10, 0.022, 4, false), guyMat);
      guy.castShadow = true;
      g.add(guy);
    }

    this.group.add(g);
    g.updateWorldMatrix(true, true);
    g.traverse((o) => { if (o.isMesh) this.raycastables.push(o); });
    this.colliders.push(new THREE.Box3().setFromCenterAndSize(
      new THREE.Vector3(x, y0 + 1.2, z), new THREE.Vector3(1.4, 2.4, 1.4)));
    return g;
  }

  /**
   * Line of timber poles carrying two catenaries. Sited east of the courtyard
   * on purpose: at this sun elevation each pole lays a thirty-metre bar across
   * the sand and the sagging cables draw two long curves over the top of them.
   */
  poleLine(poles, height = 7.0) {
    const tops = [];
    const wood = this.mat('wood', [1, 3]);
    for (const [x, z] of poles) {
      const y0 = this.groundHeight(x, z);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.105, 0.145, height, 8), wood);
      pole.position.set(x, y0 + height / 2, z);
      pole.rotation.z = (this.rand() - 0.5) * 0.05;
      pole.castShadow = true; pole.receiveShadow = true;
      this.group.add(pole);
      this.raycastables.push(pole);

      const arm = new THREE.Mesh(new RoundedBoxGeometry(0.11, 0.11, 1.7, 1, 0.012), this.mat('wood', 1));
      arm.position.set(x, y0 + height - 0.5, z);
      arm.castShadow = true;
      this.group.add(arm);

      const brace = new THREE.Mesh(new RoundedBoxGeometry(0.07, 0.07, 0.9, 1, 0.01), this.mat('wood', 1));
      brace.position.set(x, y0 + height - 0.85, z);
      brace.rotation.x = 0.7;
      brace.castShadow = true;
      this.group.add(brace);

      for (const s of [-1, 1]) {
        const ins = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.13, 8),
          new THREE.MeshStandardMaterial({ color: 0x7d8c8f, roughness: 0.35, metalness: 0.05 }));
        ins.position.set(x, y0 + height - 0.37, z + s * 0.78);
        ins.castShadow = true;
        this.group.add(ins);
      }

      tops.push([
        new THREE.Vector3(x, y0 + height - 0.30, z - 0.78),
        new THREE.Vector3(x, y0 + height - 0.30, z + 0.78),
      ]);
      this.colliders.push(new THREE.Box3().setFromCenterAndSize(
        new THREE.Vector3(x, y0 + 2, z), new THREE.Vector3(0.42, 4, 0.42)));
    }

    // Cables thick enough to survive the shadow map — a hairline wire simply
    // falls through the texels and casts nothing.
    const wireMat = new THREE.MeshStandardMaterial({ color: 0x191715, roughness: 0.82, metalness: 0.35 });
    for (let i = 0; i < tops.length - 1; i++) {
      for (let w = 0; w < 2; w++) {
        const a = tops[i][w], b = tops[i + 1][w];
        const pts = [];
        const sag = a.distanceTo(b) * 0.065;
        for (let t = 0; t <= 14; t++) {
          const k = t / 14;
          const p = a.clone().lerp(b, k);
          p.y -= Math.sin(k * Math.PI) * sag;
          pts.push(p);
        }
        const geo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 18, 0.030, 4, false);
        const wire = new THREE.Mesh(geo, wireMat);
        wire.castShadow = true;
        this.group.add(wire);
      }
    }
    return tops;
  }

  /** A dropped service cable slung between two anchors. */
  cable(a, b, sag, radius = 0.026) {
    const pts = [];
    for (let t = 0; t <= 14; t++) {
      const k = t / 14;
      const p = a.clone().lerp(b, k);
      p.y -= Math.sin(k * Math.PI) * sag;
      pts.push(p);
    }
    const mesh = new THREE.Mesh(
      new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 20, radius, 4, false),
      new THREE.MeshStandardMaterial({ color: 0x201d1a, roughness: 0.85, metalness: 0.3 }),
    );
    mesh.castShadow = true;
    this.group.add(mesh);
    return mesh;
  }

  /** Chain-link run. The mesh reads as a haze at distance and a lattice close. */
  chainlink(x0, z0, x1, z1, h = 2.1) {
    const dx = x1 - x0, dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    const ry = Math.atan2(-dz, dx);
    const bays = Math.max(1, Math.round(len / 2.6));
    const bay = len / bays;
    const steel = this.mat('rust', [1, 2]);
    const meshMat = new THREE.MeshStandardMaterial({
      color: 0x6e6b64, roughness: 0.6, metalness: 0.75, side: THREE.DoubleSide,
    });

    const g = new THREE.Group();
    g.position.set(x0, 0, z0);
    g.rotation.y = ry;

    for (let i = 0; i <= bays; i++) {
      const px = i * bay;
      const y0 = this.groundHeight(x0 + Math.cos(ry) * px, z0 - Math.sin(ry) * px);
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, h + 0.3, 8), steel);
      post.position.set(px, y0 + (h + 0.3) / 2 - 0.2, 0);
      post.castShadow = true; post.receiveShadow = true;
      g.add(post);
    }
    // The fabric is built once per bay as crossed bars. Deliberately coarse:
    // a true chain-link gauge is well under a pixel at any useful distance and
    // dissolves into rainbow moiré under the sharpen and aberration passes.
    const wires = [];
    const vSpace = 0.30;
    for (let v = 0; v * vSpace < bay; v++) {
      wires.push(new THREE.BoxGeometry(0.040, h, 0.040).translate(v * vSpace, h / 2, 0));
    }
    for (let k = 0; k * vSpace < h; k++) {
      wires.push(new THREE.BoxGeometry(bay, 0.040, 0.040).translate(bay / 2, k * vSpace, 0));
    }
    const bayGeo = mergeGeometries(wires);
    const fabric = new THREE.InstancedMesh(bayGeo, meshMat, bays);
    fabric.castShadow = true; fabric.receiveShadow = true;
    const m4 = new THREE.Matrix4();
    for (let i = 0; i < bays; i++) {
      const px = i * bay;
      const y0 = this.groundHeight(x0 + Math.cos(ry) * (px + bay / 2), z0 - Math.sin(ry) * (px + bay / 2));
      m4.makeTranslation(px, y0 - 0.05, 0);
      fabric.setMatrixAt(i, m4);
    }
    fabric.instanceMatrix.needsUpdate = true;
    g.add(fabric);

    for (let i = 0; i < bays; i++) {
      const px = i * bay;
      const y0 = this.groundHeight(x0 + Math.cos(ry) * (px + bay / 2), z0 - Math.sin(ry) * (px + bay / 2));
      const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, bay, 6), steel);
      rail.rotation.z = Math.PI / 2;
      rail.position.set(px + bay / 2, y0 + h - 0.06, 0);
      rail.castShadow = true;
      g.add(rail);
    }

    this.group.add(g);
    g.updateWorldMatrix(true, true);
    g.traverse((o) => { if (o.isMesh) this.raycastables.push(o); });
    for (let i = 0; i < bays; i++) {
      const t = (i + 0.5) / bays;
      this.colliders.push(new THREE.Box3().setFromCenterAndSize(
        new THREE.Vector3(x0 + dx * t, h / 2, z0 + dz * t),
        new THREE.Vector3(Math.abs(dx / bays) + 0.2, h, Math.abs(dz / bays) + 0.2)));
    }
    return g;
  }

  /** Star pickets strung with two wires — pure shadow furniture. */
  picketLine(x0, z0, x1, z1, h = 1.05) {
    const steel = this.mat('rust', [1, 2]);
    const n = Math.max(2, Math.round(Math.hypot(x1 - x0, z1 - z0) / 1.9));
    const tops = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = lerp(x0, x1, t), z = lerp(z0, z1, t);
      const y0 = this.groundHeight(x, z);
      const post = new THREE.Mesh(new RoundedBoxGeometry(0.055, h, 0.055, 1, 0.01), steel);
      post.position.set(x, y0 + h / 2, z);
      post.rotation.set((this.rand() - 0.5) * 0.06, this.rand(), (this.rand() - 0.5) * 0.06);
      post.castShadow = true; post.receiveShadow = true;
      this.group.add(post);
      this.raycastables.push(post);
      tops.push(new THREE.Vector3(x, y0 + h, z));
    }
    const wireMat = new THREE.MeshStandardMaterial({ color: 0x4a423a, roughness: 0.75, metalness: 0.6 });
    for (let i = 0; i < n; i++) {
      for (const drop of [0.10, 0.44]) {
        const a = tops[i].clone(), b = tops[i + 1].clone();
        a.y -= drop; b.y -= drop;
        const pts = [];
        for (let k = 0; k <= 6; k++) {
          const p = a.clone().lerp(b, k / 6);
          p.y -= Math.sin((k / 6) * Math.PI) * 0.05;
          pts.push(p);
        }
        const wire = new THREE.Mesh(
          new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 6, 0.022, 4, false), wireMat);
        wire.castShadow = true;
        this.group.add(wire);
      }
    }
  }

  /** Bent reinforcement bar clawing out of a broken section. */
  rebar(x, y, z, ry, n) {
    const mat = new THREE.MeshStandardMaterial({ color: 0x50372a, roughness: 0.88, metalness: 0.55 });
    const parts = [];
    for (let i = 0; i < n; i++) {
      const len = 0.5 + this.rand() * 1.1;
      const lean = (this.rand() - 0.5) * 0.9;
      const pts = [];
      for (let k = 0; k <= 5; k++) {
        const t = k / 5;
        pts.push(new THREE.Vector3(
          (this.rand() - 0.5) * 0.03 + Math.sin(t * 2.1) * lean * 0.35,
          t * len,
          (this.rand() - 0.5) * 0.03 + t * t * lean * 0.4,
        ));
      }
      const geo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 8, 0.014, 4, false);
      geo.translate((this.rand() - 0.5) * 0.42, 0, (this.rand() - 0.5) * 0.34);
      parts.push(geo);
    }
    const mesh = new THREE.Mesh(mergeGeometries(parts), mat);
    mesh.position.set(x, y - 0.1, z);
    mesh.rotation.y = ry;
    mesh.castShadow = true;
    this.group.add(mesh);
    return mesh;
  }

  /* ----------------------------------------------------------- tower --- */

  watchtower(x, z, ry) {
    const g = new THREE.Group();
    const y0 = this.groundHeight(x, z);
    g.position.set(x, y0, z);
    g.rotation.y = ry;
    const H = 6.4, S = 2.1;
    const steel = this.mat('rust', [1, 3]);
    const plank = this.mat('wood', [2, 1]);

    // Battered legs.
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const top = new THREE.Vector3(sx * S * 0.32, H, sz * S * 0.32);
      const bot = new THREE.Vector3(sx * S * 0.62, 0, sz * S * 0.62);
      const dir = new THREE.Vector3().subVectors(top, bot);
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.09, dir.length(), 8), steel);
      leg.position.copy(bot).addScaledVector(dir, 0.5);
      leg.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
      leg.castShadow = true; leg.receiveShadow = true;
      g.add(leg);
    }
    // Cross bracing.
    for (let lvl = 1; lvl <= 3; lvl++) {
      const y = (lvl / 4) * H;
      const w = S * (0.62 - 0.3 * (y / H)) * 2;
      for (let side = 0; side < 4; side++) {
        const a = (side / 4) * TAU;
        const brace = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, w * 1.05, 6), steel);
        brace.position.set(Math.cos(a) * w * 0.5, y, Math.sin(a) * w * 0.5);
        brace.rotation.set(0, -a, Math.PI / 2);
        brace.castShadow = true;
        g.add(brace);
      }
    }
    // Deck, rail and roof.
    const deck = new THREE.Mesh(new RoundedBoxGeometry(S * 1.5, 0.14, S * 1.5, 2, 0.02), plank);
    deck.position.y = H;
    deck.castShadow = true; deck.receiveShadow = true;
    g.add(deck);
    for (let side = 0; side < 4; side++) {
      const a = (side / 4) * TAU;
      const rail = new THREE.Mesh(new RoundedBoxGeometry(S * 1.5, 0.72, 0.09, 2, 0.015), plank);
      rail.position.set(Math.cos(a) * S * 0.72, H + 0.43, Math.sin(a) * S * 0.72);
      rail.rotation.y = -a;
      rail.castShadow = true; rail.receiveShadow = true;
      g.add(rail);
    }
    const roof = new THREE.Mesh(new RoundedBoxGeometry(S * 1.85, 0.09, S * 1.85, 2, 0.02),
      this.mat('corrugated', [3, 3]));
    roof.position.y = H + 2.05;
    roof.rotation.z = 0.05;
    roof.castShadow = true; roof.receiveShadow = true;
    g.add(roof);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.0, 6), steel);
      post.position.set(sx * S * 0.68, H + 1.05, sz * S * 0.68);
      post.castShadow = true;
      g.add(post);
    }
    // Ladder.
    const lx = S * 0.66;
    for (const sx of [-0.22, 0.22]) {
      const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, H, 6), steel);
      rail.position.set(lx, H / 2, sx);
      rail.castShadow = true;
      g.add(rail);
    }
    for (let i = 0; i < Math.floor(H / 0.32); i++) {
      const rung = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.46, 5), steel);
      rung.position.set(lx, 0.2 + i * 0.32, 0);
      rung.rotation.x = Math.PI / 2;
      rung.castShadow = true;
      g.add(rung);
    }
    // Sandbagged parapet on the deck.
    const bagGeo = new THREE.SphereGeometry(0.26, 10, 7);
    bagGeo.scale(1, 0.6, 0.72);
    const bags = new THREE.InstancedMesh(bagGeo, this.mat('burlap', [1.4, 1]), 16);
    bags.castShadow = true; bags.receiveShadow = true;
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    const p = new THREE.Vector3(), s = new THREE.Vector3();
    let n = 0;
    for (const side of [0, 1]) {
      for (let i = 0; i < 8 && n < 16; i++) {
        const a = side * Math.PI * 0.5;
        const t = (i / 8 - 0.44) * S * 1.4;
        p.set(Math.cos(a) * t + Math.sin(a) * S * 0.7, H + 0.20,
          Math.sin(a) * t - Math.cos(a) * S * 0.7);
        e.set(0, this.rand() * TAU, (this.rand() - 0.5) * 0.12);
        q.setFromEuler(e);
        const sc = 0.95 + this.rand() * 0.1;
        s.set(sc, sc, sc);
        m4.compose(p, q, s);
        bags.setMatrixAt(n++, m4);
      }
    }
    bags.count = n;
    bags.instanceMatrix.needsUpdate = true;
    g.add(bags);

    this.group.add(g);
    g.updateWorldMatrix(true, true);
    g.traverse((o) => { if (o.isMesh) this.raycastables.push(o); });
    // Only the leg footprint blocks movement; the deck is above the player.
    this.colliders.push(new THREE.Box3().setFromCenterAndSize(
      new THREE.Vector3(x, y0 + 1.0, z), new THREE.Vector3(S * 1.5, 2.0, S * 1.5),
    ));
    return g;
  }

  /* --------------------------------------------------------- vegetation -- */

  scatter() {
    // Rocks — one instanced draw for the whole map.
    const rockGeo = new THREE.IcosahedronGeometry(1, 1);
    const rp = rockGeo.attributes.position;
    for (let i = 0; i < rp.count; i++) {
      const x = rp.getX(i), y = rp.getY(i), z = rp.getZ(i);
      const n = 1 + perlin(x * 2.3, z * 2.3, 64, 64) * 0.36 + perlin(y * 3.1, x * 3.1, 64, 64) * 0.2;
      rp.setXYZ(i, x * n, y * n * 0.72, z * n);
    }
    rockGeo.computeVertexNormals();

    const N = 260;
    const rocks = new THREE.InstancedMesh(rockGeo, this.mat('concrete', 1, { color: 0x8d8478 }), N);
    rocks.castShadow = true; rocks.receiveShadow = true;
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    const p = new THREE.Vector3(), s = new THREE.Vector3();
    let n = 0;
    for (let i = 0; i < N * 3 && n < N; i++) {
      const a = this.rand() * TAU, r = 8 + this.rand() * 105;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const inside = Math.abs(x) < 30 && Math.abs(z) < 25;
      if (inside && this.rand() < 0.82) continue;                    // keep the yard clear
      // A metre-wide boulder inside the wire reads as a hole punched in the
      // courtyard, so anything that survives the cull in there stays small.
      const sc = (0.09 + Math.pow(this.rand(), 2.4) * 0.9) * (inside ? 0.34 : 1);
      p.set(x, this.groundHeight(x, z) + sc * 0.28, z);
      e.set(this.rand() * 0.5, this.rand() * TAU, this.rand() * 0.5);
      q.setFromEuler(e);
      s.set(sc * (0.8 + this.rand() * 0.5), sc, sc * (0.8 + this.rand() * 0.5));
      m4.compose(p, q, s);
      rocks.setMatrixAt(n++, m4);
    }
    rocks.count = n;
    rocks.instanceMatrix.needsUpdate = true;
    this.group.add(rocks);
    this.raycastables.push(rocks);

    // Dry scrub — crossed alpha-less cards would look cheap, so these are
    // radial fans of thin tapered blades. Cheap, and they catch rim light.
    const blade = new THREE.CylinderGeometry(0.004, 0.022, 0.42, 3, 1, false);
    blade.translate(0, 0.21, 0);
    const bushGeos = [];
    for (let b = 0; b < 3; b++) {
      const parts = [];
      const count = 14 + b * 5;
      for (let i = 0; i < count; i++) {
        const gg = blade.clone();
        const a = (i / count) * TAU + this.rand();
        const tilt = 0.30 + this.rand() * 0.75;
        const len = 0.6 + this.rand() * 0.9;
        gg.scale(1, len, 1);
        gg.rotateX(Math.cos(a) * tilt);
        gg.rotateZ(-Math.sin(a) * tilt);
        gg.translate(Math.cos(a) * 0.04, 0, Math.sin(a) * 0.04);
        parts.push(gg);
      }
      bushGeos.push(mergeGeometries(parts));
    }

    const scrubMat = new THREE.MeshStandardMaterial({
      color: 0x8a7a4c, roughness: 0.92, metalness: 0,
      side: THREE.DoubleSide, flatShading: false,
    });
    for (const geo of bushGeos) {
      const M = 90;
      const bush = new THREE.InstancedMesh(geo, scrubMat, M);
      bush.castShadow = true; bush.receiveShadow = true;
      let k = 0;
      for (let i = 0; i < M * 4 && k < M; i++) {
        const a = this.rand() * TAU, r = 6 + this.rand() * 100;
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        // Nothing grows inside a compound that is driven over every day, and
        // a backlit bush in the near field is an unreadable black shard.
        if (Math.abs(x) < 30 && Math.abs(z) < 25) continue;
        const sc = 0.55 + this.rand() * 1.0;
        p.set(x, this.groundHeight(x, z) - 0.03, z);
        e.set(0, this.rand() * TAU, 0);
        q.setFromEuler(e);
        s.set(sc, sc * (0.7 + this.rand() * 0.7), sc);
        m4.compose(p, q, s);
        bush.setMatrixAt(k++, m4);
      }
      bush.count = k;
      bush.instanceMatrix.needsUpdate = true;
      this.group.add(bush);
    }
  }

  /**
   * Loose stone across the compound floor. The bottom third of every frame is
   * ground; without something casting a contact shadow at boot-scale the sand
   * has no sense of grain no matter how good the maps are.
   */
  gravel() {
    const geo = new THREE.IcosahedronGeometry(1, 0);
    const gp = geo.attributes.position;
    for (let i = 0; i < gp.count; i++) {
      gp.setXYZ(i, gp.getX(i) * (0.8 + this.rand() * 0.5),
        gp.getY(i) * 0.55, gp.getZ(i) * (0.8 + this.rand() * 0.5));
    }
    geo.computeVertexNormals();

    const N = 1600;
    const inst = new THREE.InstancedMesh(geo, this.mat('concrete', 1, { color: 0x9c9184 }), N);
    inst.castShadow = true; inst.receiveShadow = true;
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    const p = new THREE.Vector3(), s = new THREE.Vector3();
    let n = 0;
    for (let i = 0; i < N * 4 && n < N; i++) {
      // Clustered, not sprinkled: evenly spaced stones of one size read as a
      // polka dot pattern the instant they all cast the same contact shadow.
      const a = this.rand() * TAU;
      const r = Math.pow(this.rand(), 0.55) * 40;
      const cx = Math.cos(a) * r * 1.15, cz = Math.sin(a) * r;
      const clump = 0.15 + Math.pow(this.rand(), 3) * 2.4;
      const x = cx + (this.rand() - 0.5) * clump, z = cz + (this.rand() - 0.5) * clump;
      if (Math.abs(x) > 44 || Math.abs(z) > 38) continue;
      if (fbm(x / 90 + 0.5, z / 90 + 0.5, 3, 14) + 0.16 < this.rand() * 0.5) continue;
      const sc = 0.016 + Math.pow(this.rand(), 3.4) * 0.24;
      p.set(x, this.groundHeight(x, z) + sc * 0.26, z);
      e.set(this.rand() * 0.7, this.rand() * TAU, this.rand() * 0.7);
      q.setFromEuler(e);
      s.set(sc * (0.7 + this.rand() * 0.7), sc * (0.45 + this.rand() * 0.5), sc * (0.7 + this.rand() * 0.7));
      m4.compose(p, q, s);
      inst.setMatrixAt(n++, m4);
    }
    inst.count = n;
    inst.instanceMatrix.needsUpdate = true;
    this.group.add(inst);
    this.raycastables.push(inst);
  }

  /**
   * Layered ridge line in the haze. Three sloped bands rather than one: the
   * separation between them is what turns a backdrop into distance.
   */
  ridgeline() {
    // Each band rises away from the viewer, so the band in front of it always
    // buries its foot: no sky ever shows through between the layers.
    const bands = [
      { near: 155, far: 198, base: 7, amp: 13, tone: 0x776a58, seed: 9.31 },
      { near: 198, far: 254, base: 13, amp: 20, tone: 0x84775f, seed: 4.73 },
      { near: 254, far: 336, base: 20, amp: 30, tone: 0x8f8168, seed: 1.37 },
    ];
    for (const b of bands) {
      const seg = 168;
      const pos = new Float32Array((seg + 1) * 2 * 3);
      const idx = new Uint32Array(seg * 6);
      for (let i = 0; i <= seg; i++) {
        const a = (i / seg) * TAU;
        const cx = Math.cos(a), cz = Math.sin(a);
        const crest = b.base
          + b.amp * (0.35 + 0.65 * ridged(cx * 0.5 + 0.5 + b.seed, cz * 0.5 + 0.5, 4, 5))
          + perlin(cx * 3.4 + b.seed, cz * 3.4, 64, 64) * b.amp * 0.35;
        pos[i * 6] = cx * b.near; pos[i * 6 + 1] = -9; pos[i * 6 + 2] = cz * b.near;
        pos[i * 6 + 3] = cx * b.far; pos[i * 6 + 4] = crest; pos[i * 6 + 5] = cz * b.far;
      }
      for (let i = 0; i < seg; i++) {
        const a = i * 2, c = a + 1, d = a + 2, e = a + 3;
        idx[i * 6] = a; idx[i * 6 + 1] = d; idx[i * 6 + 2] = c;
        idx[i * 6 + 3] = c; idx[i * 6 + 4] = d; idx[i * 6 + 5] = e;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        color: b.tone, roughness: 1.0, metalness: 0, side: THREE.DoubleSide,
      }));
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      this.group.add(mesh);
    }
  }

  /* --------------------------------------------------------------- misc -- */

  /** Hanging tarp on a line — soft cloth silhouette against the hard geometry. */
  tarp(x, y, z, w, h, ry) {
    const geo = new THREE.PlaneGeometry(w, h, 18, 12);
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const u = p.getX(i) / w + 0.5, v = p.getY(i) / h + 0.5;
      const sag = Math.sin(u * Math.PI) * (1 - v) * 0.30;
      const ripple = Math.sin(u * 9.0 + v * 2.0) * 0.055 * (1 - v);
      p.setZ(i, sag * 0.6 + ripple);
      p.setY(i, p.getY(i) - sag * 0.5);
    }
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, this.mat('canvas', [2, 2], { side: THREE.DoubleSide }));
    mesh.position.set(x, y, z);
    mesh.rotation.y = ry;
    mesh.castShadow = true; mesh.receiveShadow = true;
    this.group.add(mesh);
    this.raycastables.push(mesh);
    return mesh;
  }

  rubble(x, z, radius, count, scale = 1) {
    const geo = new THREE.DodecahedronGeometry(1, 0);
    const inst = new THREE.InstancedMesh(geo, this.mat('plaster', 1, { color: 0xa89a88 }), count);
    inst.castShadow = true; inst.receiveShadow = true;
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    const p = new THREE.Vector3(), s = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      const a = this.rand() * TAU, r = Math.pow(this.rand(), 0.6) * radius;
      const sc = (0.05 + Math.pow(this.rand(), 2) * 0.24) * scale;
      const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
      p.set(px, this.groundHeight(px, pz) + sc * 0.45, pz);
      e.set(this.rand() * TAU, this.rand() * TAU, this.rand() * TAU);
      q.setFromEuler(e);
      s.set(sc, sc * (0.5 + this.rand() * 0.5), sc * (0.7 + this.rand() * 0.6));
      m4.compose(p, q, s);
      inst.setMatrixAt(i, m4);
    }
    inst.instanceMatrix.needsUpdate = true;
    this.group.add(inst);
    this.raycastables.push(inst);
  }

  /* -------------------------------------------------------------- build -- */

  build() {
    // Terrain modifiers first: the ground mesh, the height lookup and every
    // prop that stands on it all read from these.
    const pad = (x, z, hw, hd, ry, y, fade, drift) => this.pads.push({
      x, z, hw, hd, y, fade, drift, c: Math.cos(-ry), s: Math.sin(-ry),
    });
    pad(18, -13, 7.5, 5.0, -0.06, 0.02, 3.4, 0.30);      // two-storey block
    pad(-19, -8, 6.5, 3.75, 0.04, 0.01, 3.0, 0.26);      // barracks
    pad(17, 12, 4.5, 4.0, 0.50, 0.02, 2.8, 0.24);        // storehouse

    this.craters = [
      { x: 12.6, z: 12.0, r: 2.3, d: 0.42 },
      { x: -4.5, z: -6.5, r: 1.9, d: 0.34 },
      { x: -15.5, z: -13.0, r: 1.7, d: 0.30 },
      { x: -1.0, z: 20.5, r: 1.5, d: 0.26 },
      { x: 26.5, z: -11.0, r: 2.0, d: 0.32 },
    ];

    // Foot routes, used only to darken the sand where boots have polished it.
    this._paths = [
      [[0, 25], [-1.5, 17], [-3, 10], [-4.5, 4], [-9, 0.5], [-14, -2], [-18, -5]],
      [[-4.5, 4], [1, 1], [7, -3], [12, -8], [16, -11]],
      [[-2, 6], [-2.5, 12], [-7, 16], [-12, 18]],
      [[13, 5], [16, 9], [17, 12]],
    ];

    this.buildGround();

    // Vehicle track in from the gate, forking to the block and the huts. The
    // west leg runs almost straight at the hero camera, which is the leading
    // line the whole composition hangs off.
    this.track([[0, 32], [0.4, 24], [-1.6, 16], [-2.6, 9], [-4.8, 3.4], [-9.4, 0.4],
      [-14.6, -2.2], [-20, -4.6], [-26, -6.0]], 3.4, 0.075);
    this.track([[-3.4, 7.0], [1.5, 3.6], [7.0, -1.4], [11.5, -6.6], [15.0, -11.5]], 3.0, 0.065);
    this.hardstand(6.5, 1.5, 10.5);

    this.buildPerimeter();

    // Two-storey block on the east side — the sun rises behind it, so it is
    // the main silhouette and shaft-caster in the hero framing.
    this.building(18, -13, 15, 10, 3.3, -0.06, {
      floors: 2,
      openings: {
        west: [[-2.4, 1.5, 0.95, 2.5], [2.6, 1.5, 0.95, 2.5], [0, 1.4, 4.25, 5.85]],
        south: [[-4.0, 1.2, 4.25, 5.9], [0.5, 2.2, 0, 2.7], [5.0, 1.2, 0.95, 2.5]],
        north: [[-3.0, 1.3, 0.95, 2.5], [3.4, 1.3, 4.25, 5.9]],
        east: [[0, 1.6, 0.95, 2.6]],
      },
    });

    // Long low barracks, west side.
    this.building(-19, -8, 13, 7.5, 3.5, 0.04, {
      floors: 1,
      openings: {
        east: [[-3.2, 1.3, 0.9, 2.4], [1.0, 2.0, 0, 2.6], [4.6, 1.3, 0.9, 2.4]],
        north: [[0, 1.4, 0.9, 2.4]],
        south: [[-2, 1.2, 0.9, 2.4], [2.5, 1.2, 0.9, 2.4]],
      },
    });

    // Shot-up storehouse, north-east.
    this.building(17, 12, 9, 8, 3.9, 0.5, {
      floors: 1,
      openings: {
        west: [[0, 2.6, 0, 3.0]],
        south: [[-1.8, 1.4, 1.0, 2.7], [2.0, 1.1, 1.0, 2.5]],
      },
    });
    this.rubble(12.5, 12.5, 3.6, 110);
    this.rebar(13.4, 1.3, 12.2, 0.4, 7);

    // Lean-tos against the two walls the camera looks at. Both buildings show
    // this camera nothing but unlit faces — the sun is directly behind them —
    // so a horizontal roof plate, which sees the whole sky, is the only thing
    // that stops each facade reading as one dead black rectangle.
    this.leanTo(9.5, -13.0, 5.6, 2.0, -Math.PI / 2, 2.5);
    this.leanTo(-16.5, -3.4, 5.2, 1.9, 0.04, 2.45);

    this.watchtower(-24, 17, 0.3);
    this.watchtower(28.5, -23, -0.9);

    // The tallest thing on site, east of the courtyard so its shadow crosses
    // the whole frame; the water tower answers it on the other side so the
    // skyline is not one spike over a flat run of parapets.
    this.mast(25.5, -1.5, 13.5);
    this.waterTower(-3.5, -23.0, 11);

    // Pole line down the east side of the yard: four bars of shadow laid
    // straight across the sand toward the player, with the catenaries above.
    const tops = this.poleLine([[9, 22], [9.4, 8], [9.0, -6], [8.6, -20]], 7.2);
    // A spur dropping to a stub pole three metres off the player's shoulder.
    // The cable crosses the top of the hero frame and reads as pure depth.
    const spur = this.poleLine([[-12.6, 1.0]], 5.1);
    this.cable(spur[0][1], tops[1][1], 1.3, 0.030);

    // Sited so its rafters lay their stripes across the near foreground: a
    // three-metre frame throws eighteen metres of shadow, and anything closer
    // than that puts the pattern behind the player.
    this.awning(7.0, -9.0, 5.4, 3.4, 0.12, 2.95);
    this.awning(-9.5, -8.5, 3.8, 2.8, 1.50, 2.65);

    // Knee-high picket runs. Nothing to look at, but every post lays six
    // metres of shadow, and only a short caster can throw one into the near
    // foreground — a seven-metre pole puts its bar forty metres behind the
    // player, where it is worth nothing to the frame.
    this.picketLine(-1.0, 10.4, 12.5, 9.6, 1.05);

    // Perimeter revetments and the inner fighting positions.
    this.bastion(-4.0, -13.5, 8.0, 0.05, 1.25);
    this.bastion(-2.6, -4.4, 6.0, 0.10, 1.25);
    this.bastion(24.0, 8.0, 7.0, 1.45, 1.25);
    this.bastion(16.0, -22.0, 8.0, 0.10, 1.15);

    // Screens set back against the wire, so they add a lattice to the skyline
    // without taking a metre of floor away from anyone trying to move.
    this.chainlink(29.5, 8.0, 29.5, -6.0, 2.1);
    this.chainlink(0.5, -21.5, 9.5, -22.0, 2.0);

    // Containers: one broadside in the middle distance to carry the eye across
    // the courtyard, one stacked pair north-west, one by the south wall.
    this.container(-4.8, -10.5, 0.28, 0x5c6b58);
    this.container(-13.2, 15.4, 0.12, 0x7a4f3a);
    this.container(13.6, 7.2, 1.46, 0x4a5a66);
    this.container(5, -17.5, 0.10, 0x556067);

    // Sandbag line across the courtyard and a firing position by the gate.
    this.sandbags(-8.4, -2.6, 6.0, 0.62, 3);
    this.sandbags(-1.5, 5.6, 5.0, 0.10, 3);
    this.sandbags(7.5, 1.5, 4.2, 1.52, 3);
    this.sandbags(-8, 19, 5.0, 0.0, 2);
    this.sandbags(20, 3, 4.0, 1.60, 3);
    this.sandbags(16.5, -19.5, 4.6, 0.30, 2);

    // Foreground: a barrier chicane two metres off the muzzle. Nothing else in
    // the frame is close enough to give the shot a sense of scale, and without
    // it the courtyard could be twenty metres across or two hundred.
    this.jersey(-12.4, 4.6, 0.92);
    this.jersey(-10.4, 1.6, 0.72);
    this.jersey(-4.6, -0.6, 0.35);
    this.jersey(-2.4, -1.5, 0.50);
    this.jersey(-2.2, 10.6, 0.18);
    this.jersey(0.6, 10.2, 0.05);
    this.jersey(19.8, -8.5, 1.44);
    this.rubble(-12.7, 3.3, 1.8, 30, 0.42);

    this.tyres(-8.2, -6.6, 4);
    this.tyres(11.2, 3.4, 5);
    this.tyres(-9.5, 8.4, 3);
    this.pallet(-10.4, 6.9, 0.9);
    this.pallet(-10.0, 6.6, 1.4, 0.05);
    this.pallet(4.2, 8.4, 0.3);
    this.pallet(4.6, 8.1, -0.4, 0.9);
    this.pallet(-8.9, -0.5, 1.02, 1.24);
    this.pallet(-8.6, -1.0, 1.12, 1.30);
    this.cableDrum(-7.2, 8.6, 0.4);
    this.cableDrum(14.8, 4.2, 1.2);

    // Loose kit.
    const drums = [[-6.6, -6.2], [-5.6, -6.9], [-6.9, -7.6], [9.6, 8.4], [10.4, 9.0],
      [-16, 6], [22, -3.5], [3.5, -8], [-11, -18], [13, 20], [-3.4, 14.6], [-4.4, 15.2],
      [18.5, 2.0], [-19.5, 2.5]];
    drums.forEach(([x, z], i) => this.barrel(x, z, i % 5 === 3));

    const crates = [[-3, 12.4, 1, 0.3], [-2.1, 12.8, 0.85, -0.2], [-2.6, 12.6, 0.7, 0.9],
      [11, -4, 1, 1.1], [11.2, -4.9, 0.9, 0.4], [-14, 1.2, 1, -0.5],
      [4, 16, 0.9, 0.7], [4.9, 16.5, 0.8, 0.1], [19, 6, 1, 0.25],
      [-13.4, 1.4, 0.95, 1.15], [-10.6, -5.6, 1, 0.55], [16.8, -16.5, 0.9, 0.8]];
    crates.forEach(([x, z, s, r], i) => this.crate(x, z, s, r, i % 3 === 0));

    // Tarps: one over the gate firing position, one on the barracks wall.
    this.tarp(-8, 2.6, 18.6, 4.0, 2.2, 0);
    this.tarp(-12.3, 2.9, -8, 3.4, 2.0, Math.PI / 2);

    // Debris around the shell scars.
    for (const c of this.craters) this.rubble(c.x, c.z, c.r * 1.5, 34);

    this.gravel();
    this.scatter();
    this.ridgeline();

    // Enemy spawns, biased to cover and building interiors.
    this.spawns = [
      new THREE.Vector3(16, 0, -8), new THREE.Vector3(20, 0, 4),
      new THREE.Vector3(-17, 0, -4), new THREE.Vector3(15, 0, 13),
      new THREE.Vector3(-10, 0, 16), new THREE.Vector3(6, 0, -18),
      new THREE.Vector3(-22, 0, 9), new THREE.Vector3(23, 0, -16),
      new THREE.Vector3(0, 0, -21), new THREE.Vector3(-14, 0, 20),
    ];

    // A few extra cover anchors the AI can path to.
    for (const c of [[-8.4, -2.6], [7.5, 1.5], [-8, 19], [20, 3], [-13.2, 15.4], [5, -17.5],
      [11, -4], [-3, 12.4], [12.5, 12.5], [-6.6, -6.2], [-4.8, -10.5], [13.6, 7.2],
      [16.5, -19.5], [-1.5, 5.6]]) {
      this.coverPoints.push(new THREE.Vector3(c[0], 0, c[1]));
    }

    return this;
  }
}

/* Minimal geometry merge — avoids pulling in BufferGeometryUtils for one call. */
function mergeGeometries(geometries) {
  const attrNames = ['position', 'normal', 'uv'];
  let vertexCount = 0, indexCount = 0;
  for (const g of geometries) {
    vertexCount += g.attributes.position.count;
    indexCount += g.index ? g.index.count : g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  const arrays = {};
  for (const name of attrNames) {
    const src = geometries[0].attributes[name];
    if (!src) continue;
    arrays[name] = new Float32Array(vertexCount * src.itemSize);
  }
  const indices = new Uint32Array(indexCount);
  let vOff = 0, iOff = 0;
  for (const g of geometries) {
    const count = g.attributes.position.count;
    for (const name of attrNames) {
      const src = g.attributes[name];
      if (!src || !arrays[name]) continue;
      arrays[name].set(src.array, vOff * src.itemSize);
    }
    if (g.index) {
      for (let i = 0; i < g.index.count; i++) indices[iOff++] = g.index.array[i] + vOff;
    } else {
      for (let i = 0; i < count; i++) indices[iOff++] = i + vOff;
    }
    vOff += count;
  }
  for (const name of attrNames) {
    if (!arrays[name]) continue;
    out.setAttribute(name, new THREE.BufferAttribute(arrays[name], geometries[0].attributes[name].itemSize));
  }
  out.setIndex(new THREE.BufferAttribute(indices, 1));
  out.computeBoundingSphere();
  return out;
}
