// Kilo Outpost — the playable space.
//
// Everything is authored in metres against a 1.75 m eye height. Boxy forms are
// built from RoundedBoxGeometry rather than BoxGeometry: a 1–3 cm bevel costs
// almost nothing and gives every edge a specular highlight, which is most of
// the difference between "programmer blockout" and "art-passed".
//
// Exposes:
//   group        scene contents
//   colliders    world-space Box3 list for player/AI movement
//   raycastables meshes bullets and AI line-of-sight tests hit
//   spawns       enemy spawn transforms
//   coverPoints  positions AI treat as cover

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { material, fbm, worley, perlin } from './textures.js';

const TAU = Math.PI * 2;

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

  /* ------------------------------------------------------------- ground -- */

  buildGround() {
    // Broad displaced sand bowl. 220 m across so the horizon never shows an
    // edge through the dust, with enough tessellation for soft dune relief.
    const size = 260, seg = 200;
    const geo = new THREE.PlaneGeometry(size, size, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const u = (x / size) + 0.5, v = (z / size) + 0.5;
      // Dunes at the perimeter, graded flat across the compound footprint so
      // the buildings sit properly and the player never fights the terrain.
      const compound = Math.max(
        Math.abs(x) / 34,
        Math.abs(z) / 29,
      );
      const flatten = THREE.MathUtils.smoothstep(compound, 0.86, 1.7);
      let h = fbm(u * 1.6, v * 1.6, 5, 3) * 2.6 + fbm(u * 4, v * 4, 4, 6) * 0.55;
      h += Math.max(0, compound - 1.0) * 1.9;                       // berm outside the wall
      pos.setY(i, h * flatten + fbm(u, v, 3, 40) * 0.035);
    }
    geo.computeVertexNormals();
    geo.computeBoundingBox();

    const ground = new THREE.Mesh(geo, this.mat('sand', 64));
    ground.receiveShadow = true;
    ground.castShadow = false;
    ground.name = 'ground';
    this.group.add(ground);
    this.raycastables.push(ground);
    this.ground = ground;

    // Compacted dirt courtyard laid over the sand, very slightly proud so it
    // never z-fights and reads as a distinct surface.
    const yard = new THREE.Mesh(new THREE.PlaneGeometry(58, 48, 40, 40), this.mat('dirt', 18));
    yard.geometry.rotateX(-Math.PI / 2);
    const yp = yard.geometry.attributes.position;
    for (let i = 0; i < yp.count; i++) {
      const x = yp.getX(i), z = yp.getZ(i);
      yp.setY(i, 0.012 + fbm(x / 58 + 0.5, z / 48 + 0.5, 3, 8) * 0.06);
    }
    yard.geometry.computeVertexNormals();
    yard.receiveShadow = true;
    yard.name = 'courtyard';
    this.group.add(yard);
    this.raycastables.push(yard);
  }

  /* ------------------------------------------------- perimeter and gate -- */

  buildPerimeter() {
    const wall = this.mat('plaster', [8, 1.2]);
    const H = 3.2, T = 0.55;
    const X = 31, Z = 26;

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
        const h = damage < 0.14 ? H * (0.32 + this.rand() * 0.22) : H * (0.93 + this.rand() * 0.07);
        const m = this.box(step * 1.005, h, T, x + dx, h / 2, z + dz, wall,
          { ry, bevel: 0.03 });
        m.rotation.z = (this.rand() - 0.5) * 0.012;
        if (damage >= 0.14 && this.rand() < 0.55) {
          // Coping course along the top.
          this.box(step * 0.99, 0.16, T + 0.14, x + dx, h + 0.08, z + dz, wall, { ry, bevel: 0.03, collide: false });
        }
        if (damage < 0.14) this.coverPoints.push(new THREE.Vector3(x + dx, 0, z + dz));
      }
    };

    run(0, -Z, X * 2, 0);            // south
    run(0, Z, X * 2 - 9, 0);         // north (gate gap handled below)
    run(-X, 0, Z * 2, Math.PI / 2);  // west
    run(X, 0, Z * 2, Math.PI / 2);   // east

    // Gate: two piers, a lintel, and a sagging steel leaf hanging off one hinge.
    const pier = this.mat('concrete', [1, 2]);
    this.box(1.1, 4.2, 1.1, -4.6, 2.1, Z, pier, { bevel: 0.05 });
    this.box(1.1, 4.2, 1.1, 4.6, 2.1, Z, pier, { bevel: 0.05 });
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
    const geo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), coils * 20, 0.016, 5, false);
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
        if (side.axis === 'z') put(len, y1 - y0, T, c, (y0 + y1) / 2, offset);
        else put(T, y1 - y0, len, offset, (y0 + y1) / 2, c);
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
  }

  /* ------------------------------------------------------ props: bagged -- */

  /** Stacked sandbag emplacement. Bags are squashed spheres, jittered per row. */
  sandbags(x, z, length, ry, rows = 3) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
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
          0.20 + r * 0.335,
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

  /* --------------------------------------------------------- props: kit -- */

  container(x, z, ry, color) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
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

    this.group.add(g);
    g.updateWorldMatrix(true, true);
    g.traverse((o) => { if (o.isMesh) this.raycastables.push(o); });
    this.colliders.push(new THREE.Box3().setFromObject(g));
    this.coverPoints.push(new THREE.Vector3(x, 0, z));
    return g;
  }

  barrel(x, z, tipped = false) {
    const g = new THREE.Group();
    const R = 0.29, H = 0.88;
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
      g.position.set(x, R + 0.02, z);
      g.rotation.set(Math.PI / 2, this.rand() * TAU, (this.rand() - 0.5) * 0.4);
    } else {
      g.position.set(x, H / 2 + 0.02, z);
      g.rotation.y = this.rand() * TAU;
    }
    this.group.add(g);
    g.updateWorldMatrix(true, true);
    g.traverse((o) => { if (o.isMesh) this.raycastables.push(o); });
    this.colliders.push(new THREE.Box3().setFromObject(g));
    return g;
  }

  crate(x, z, s = 1, ry = 0, ammo = false) {
    const w = 1.02 * s, h = 0.62 * s, d = 0.66 * s;
    const g = new THREE.Group();
    g.position.set(x, h / 2 + 0.02, z);
    g.rotation.y = ry;
    const mat = ammo ? this.mat('painted', [2, 1.2]) : this.mat('wood', [1.6, 1]);
    const body = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 2, 0.022), mat);
    body.castShadow = true; body.receiveShadow = true;
    g.add(body);
    // Corner banding.
    const band = ammo ? this.mat('rust', 1) : this.mat('rust', 1);
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
    this.group.add(g);
    g.updateWorldMatrix(true, true);
    g.traverse((o) => { if (o.isMesh) this.raycastables.push(o); });
    this.colliders.push(new THREE.Box3().setFromObject(g));
    return g;
  }

  /* ----------------------------------------------------------- tower --- */

  watchtower(x, z, ry) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
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

    this.group.add(g);
    g.updateWorldMatrix(true, true);
    g.traverse((o) => { if (o.isMesh) this.raycastables.push(o); });
    // Only the leg footprint blocks movement; the deck is above the player.
    this.colliders.push(new THREE.Box3().setFromCenterAndSize(
      new THREE.Vector3(x, 1.0, z), new THREE.Vector3(S * 1.5, 2.0, S * 1.5),
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

    const N = 240;
    const rocks = new THREE.InstancedMesh(rockGeo, this.mat('concrete', 1, { color: 0x8d8478 }), N);
    rocks.castShadow = true; rocks.receiveShadow = true;
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    const p = new THREE.Vector3(), s = new THREE.Vector3();
    let n = 0;
    for (let i = 0; i < N * 3 && n < N; i++) {
      const a = this.rand() * TAU, r = 8 + this.rand() * 105;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (Math.abs(x) < 30 && Math.abs(z) < 25 && this.rand() < 0.82) continue;  // keep the yard clear
      const sc = 0.09 + Math.pow(this.rand(), 2.4) * 0.9;
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
        if (Math.abs(x) < 29 && Math.abs(z) < 24 && this.rand() < 0.9) continue;
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

  /** Samples the displaced ground height. Mirrors buildGround's formula. */
  groundHeight(x, z) {
    const size = 260;
    const u = (x / size) + 0.5, v = (z / size) + 0.5;
    const compound = Math.max(Math.abs(x) / 34, Math.abs(z) / 29);
    const flatten = THREE.MathUtils.smoothstep(compound, 0.86, 1.7);
    let h = fbm(u * 1.6, v * 1.6, 5, 3) * 2.6 + fbm(u * 4, v * 4, 4, 6) * 0.55;
    h += Math.max(0, compound - 1.0) * 1.9;
    return h * flatten;
  }

  /* --------------------------------------------------------------- misc -- */

  powerline() {
    const poles = [[-26, 22], [-26, 4], [-26, -14], [-26, -30]];
    const tops = [];
    for (const [x, z] of poles) {
      const y0 = this.groundHeight(x, z);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.10, 0.14, 7.2, 8), this.mat('wood', [1, 3]));
      pole.position.set(x, y0 + 3.6, z);
      pole.castShadow = true; pole.receiveShadow = true;
      this.group.add(pole);
      const arm = new THREE.Mesh(new RoundedBoxGeometry(0.10, 0.10, 1.6, 1, 0.012), this.mat('wood', 1));
      arm.position.set(x, y0 + 6.7, z);
      arm.castShadow = true;
      this.group.add(arm);
      tops.push([new THREE.Vector3(x, y0 + 6.7, z - 0.7), new THREE.Vector3(x, y0 + 6.7, z + 0.7)]);
      this.colliders.push(new THREE.Box3().setFromCenterAndSize(
        new THREE.Vector3(x, y0 + 2, z), new THREE.Vector3(0.4, 4, 0.4)));
    }
    const wireMat = new THREE.MeshStandardMaterial({ color: 0x1c1a18, roughness: 0.85, metalness: 0.3 });
    for (let i = 0; i < tops.length - 1; i++) {
      for (let w = 0; w < 2; w++) {
        const a = tops[i][w], b = tops[i + 1][w];
        const pts = [];
        for (let t = 0; t <= 16; t++) {
          const k = t / 16;
          const p = a.clone().lerp(b, k);
          p.y -= Math.sin(k * Math.PI) * 0.85;                       // catenary sag
          pts.push(p);
        }
        const geo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 20, 0.014, 4, false);
        this.group.add(new THREE.Mesh(geo, wireMat));
      }
    }
  }

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

  rubble(x, z, radius, count) {
    const geo = new THREE.DodecahedronGeometry(1, 0);
    const inst = new THREE.InstancedMesh(geo, this.mat('plaster', 1, { color: 0xa89a88 }), count);
    inst.castShadow = true; inst.receiveShadow = true;
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    const p = new THREE.Vector3(), s = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      const a = this.rand() * TAU, r = Math.pow(this.rand(), 0.6) * radius;
      const sc = 0.05 + Math.pow(this.rand(), 2) * 0.24;
      p.set(x + Math.cos(a) * r, sc * 0.45, z + Math.sin(a) * r);
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
    this.buildGround();
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
    this.rubble(12.5, 12.5, 3.4, 90);

    this.watchtower(-24, 17, 0.3);

    // Containers stacked by the gate.
    this.container(-13, 15, 0.12, 0x5c6b58);
    this.container(-13.4, 12.2, -0.05, 0x7a4f3a);
    this.container(6, -20, 1.52, 0x4a5a66);

    // Sandbag line across the courtyard and a firing position by the gate.
    this.sandbags(-2, 4, 6.5, 0.05, 3);
    this.sandbags(7.5, 1.5, 4.2, 1.52, 3);
    this.sandbags(-8, 19, 5.0, 0.0, 2);
    this.sandbags(20, 3, 4.0, 1.60, 3);

    // Loose kit.
    const drums = [[-6, -3], [-5.2, -3.7], [-6.4, -4.3], [9, 8], [9.8, 8.6],
      [-16, 6], [22, -3.5], [3.5, -8], [-11, -18], [13, 20]];
    drums.forEach(([x, z], i) => this.barrel(x, z, i % 5 === 3));

    const crates = [[-3, 10, 1, 0.3], [-2.1, 10.4, 0.85, -0.2], [-2.6, 10.2, 0.7, 0.9],
      [11, -4, 1, 1.1], [11.2, -4.9, 0.9, 0.4], [-14, 2, 1, -0.5],
      [4, 16, 0.9, 0.7], [4.9, 16.5, 0.8, 0.1], [19, 6, 1, 0.25]];
    crates.forEach(([x, z, s, r], i) => this.crate(x, z, s, r, i % 3 === 0));

    // Tarps: one over the gate firing position, one on the barracks wall.
    this.tarp(-8, 2.6, 18.6, 4.0, 2.2, 0);
    this.tarp(-12.3, 2.9, -8, 3.4, 2.0, Math.PI / 2);

    this.powerline();
    this.scatter();

    // Enemy spawns, biased to cover and building interiors.
    this.spawns = [
      new THREE.Vector3(16, 0, -8), new THREE.Vector3(20, 0, 4),
      new THREE.Vector3(-17, 0, -4), new THREE.Vector3(15, 0, 13),
      new THREE.Vector3(-10, 0, 16), new THREE.Vector3(6, 0, -18),
      new THREE.Vector3(-22, 0, 9), new THREE.Vector3(23, 0, -16),
      new THREE.Vector3(0, 0, -21), new THREE.Vector3(-14, 0, 20),
    ];

    // A few extra cover anchors the AI can path to.
    for (const c of [[-2, 4], [7.5, 1.5], [-8, 19], [20, 3], [-13, 15], [6, -20],
      [11, -4], [-3, 10], [12.5, 12.5], [-6, -3]]) {
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
