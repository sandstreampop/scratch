/* JK.Terrain — open desert: analytic dune heightfield, rocks, mesas, wreck, sun.
   Owner: terrain agent. */
(function(){
'use strict';
var M = JK.M, Geo = JK.Geo;

/* ---------- deterministic PRNG (mulberry32) ---------- */
var SEED = 0x0DE5E27; /* fixed seed: same dunes every load */
function mulberry32(a){
  a = a >>> 0;
  return function(){
    a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- smooth value noise on a hashed lattice ---------- */
var PERM = new Uint8Array(512);
var VALS = new Float32Array(256);
(function(){
  var r = mulberry32(SEED), i, j, t;
  for (i = 0; i < 256; i++){ PERM[i] = i; VALS[i] = r(); }
  for (i = 255; i > 0; i--){
    j = (r() * (i + 1)) | 0;
    t = PERM[i]; PERM[i] = PERM[j]; PERM[j] = t;
  }
  for (i = 0; i < 256; i++) PERM[i + 256] = PERM[i];
})();

/* value noise, returns 0..1, C1-continuous (smoothstep-interpolated) */
function vn(x, z){
  var ix = Math.floor(x), iz = Math.floor(z);
  var fx = x - ix, fz = z - iz;
  ix &= 255; iz &= 255;
  var ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
  var p0 = PERM[ix], p1 = PERM[ix + 1];
  var a = VALS[PERM[p0 + iz]], b = VALS[PERM[p1 + iz]];
  var c = VALS[PERM[p0 + iz + 1]], d = VALS[PERM[p1 + iz + 1]];
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}

/* ---------- THE contract: analytic ground height ----------
   Long rolling dune ridges (two rotated sine trains, wavelengths ~90-150m,
   phase-warped so crests wander) + broad value noise + fine ripple.
   Relief ~= +/-5m, slopes gentle enough to sprint over. */
function height(x, z){
  var u = x * 0.831 + z * 0.556;        /* rotated dune-ridge axes */
  var v = z * 0.831 - x * 0.556;
  var h = 2.6 * Math.sin(u * 0.0430 + 1.6 * Math.sin(v * 0.0110 + 0.7));
  h += 1.35 * Math.sin(v * 0.0700 + 2.1 + 0.8 * Math.sin(u * 0.0170 + 3.0));
  h += 3.9  * (vn(x * 0.0082 + 91.3, z * 0.0082 + 47.8) - 0.5);
  h += 1.7  * (vn(x * 0.0270 + 13.1, z * 0.0270 + 71.7) - 0.5);
  h += 0.45 * (vn(x * 0.0900 + 55.5, z * 0.0900 + 23.9) - 0.5);
  return h;
}

/* ---------- module state ---------- */
var terrainMesh = null, sceneryMesh = null, sunMesh = null, haloMesh = null;
var OBST = [];
var SUN_DIR = [0.71, 0.573, 0.409];   /* normalized; points UP toward the sun */
var SUN_OPTS  = { emissive: 1, nofog: true };
var HALO_OPTS = { emissive: 1, nofog: true, additive: true, alpha: 0.45 };

/* sand palette: #b8905a -> #d2aa6d, banded */
var SAND_LO = [0.722, 0.565, 0.353];
var SAND_HI = [0.824, 0.667, 0.427];

/* ---------- terrain grid: 128x128 quads over 760x760m ----------
   Mesh samples height() exactly => visuals == collision. */
function buildTerrainGeo(){
  var N = 128, V = N + 1, EXT = 760, half = EXT / 2, step = EXT / N;
  var pos = new Float32Array(V * V * 3);
  var nrm = new Float32Array(V * V * 3);
  var col = new Float32Array(V * V * 3);
  var idx = new Uint16Array(N * N * 6);
  var jr = mulberry32(SEED ^ 0x51AB);
  var e = 2.0;
  var gx, gz, x, z, y, i3, nx, ny, nz, il, t, slopeK, j, a, b, c, d, io;

  for (gz = 0; gz < V; gz++){
    z = -half + gz * step;
    for (gx = 0; gx < V; gx++){
      x = -half + gx * step;
      y = height(x, z);
      i3 = (gz * V + gx) * 3;
      pos[i3] = x; pos[i3 + 1] = y; pos[i3 + 2] = z;

      /* central-difference normal from the same height() */
      nx = height(x - e, z) - height(x + e, z);
      nz = height(x, z - e) - height(x, z + e);
      ny = 2 * e;
      il = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx *= il; ny *= il; nz *= il;
      nrm[i3] = nx; nrm[i3 + 1] = ny; nrm[i3 + 2] = nz;

      /* two-tone banding by height, pushed darker on slopes, quantized retro */
      t = (y + 5.5) / 11;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      slopeK = (1 - ny) * 26;
      if (slopeK < 0) slopeK = 0; else if (slopeK > 1) slopeK = 1;
      t -= slopeK * 0.45;
      if (t < 0) t = 0;
      t = Math.round(t * 4) / 4;          /* 5 hard bands */
      j = (jr() - 0.5) * 0.05;            /* deterministic grain */
      col[i3]     = SAND_LO[0] + (SAND_HI[0] - SAND_LO[0]) * t + j;
      col[i3 + 1] = SAND_LO[1] + (SAND_HI[1] - SAND_LO[1]) * t + j;
      col[i3 + 2] = SAND_LO[2] + (SAND_HI[2] - SAND_LO[2]) * t + j * 0.8;
    }
  }

  io = 0;
  for (gz = 0; gz < N; gz++){
    for (gx = 0; gx < N; gx++){
      a = gz * V + gx; b = a + 1; c = a + V; d = c + 1;
      if ((gx + gz) & 1){  /* alternate the diagonal — chunkier dune shading */
        idx[io++] = a; idx[io++] = c; idx[io++] = b;
        idx[io++] = b; idx[io++] = c; idx[io++] = d;
      } else {
        idx[io++] = a; idx[io++] = c; idx[io++] = d;
        idx[io++] = a; idx[io++] = d; idx[io++] = b;
      }
    }
  }
  return { pos: pos, nrm: nrm, col: col, idx: idx };
}

/* helper: boxed part placed by T*Ry*Rx*Rz, appended to list */
var TM = M.make();
function part(list, sx, sy, sz, r, g, b, x, y, z, ry, rx, rz){
  M.ident(TM);
  M.tr(TM, x, y, z);
  if (ry) M.ry(TM, ry);
  if (rx) M.rx(TM, rx);
  if (rz) M.rz(TM, rz);
  list.push(Geo.tf(Geo.box(sx, sy, sz, r, g, b), TM));
}

/* ---------- scenery: rocks + mesas + crashed cruisers, one merged mesh ---------- */
function buildSceneryGeo(){
  var parts = [];
  var rand = mulberry32(SEED ^ 0x9E3779B9);
  var i, k, n, cx, cz, guard, placed;

  /* --- rock outcrops: 34 clusters of 2-5 tilted boxes, off the spawn zone --- */
  placed = 0; guard = 0;
  while (placed < 34 && guard++ < 800){
    cx = (rand() * 2 - 1) * 330;
    cz = (rand() * 2 - 1) * 330;
    if (cx * cx + cz * cz < 42 * 42) continue;   /* keep ~30m spawn zone clear */
    n = 2 + ((rand() * 4) | 0);                  /* 2..5 rocks */
    var shade = 0.42 + rand() * 0.14;            /* grey-brown per cluster */
    var maxExt = 0;
    for (k = 0; k < n; k++){
      var s  = 1 + rand() * 5;                   /* 1..6 m */
      var sy = s * (0.6 + rand() * 0.7);
      var sz2 = s * (0.7 + rand() * 0.6);
      var dx = (rand() - 0.5) * 6, dz = (rand() - 0.5) * 6;
      var px = cx + dx, pz = cz + dz;
      var jc = (rand() - 0.5) * 0.06;
      part(parts, s, sy, sz2,
        shade + 0.06 + jc, shade + 0.01 + jc, shade - 0.05 + jc,
        px, height(px, pz) + sy * 0.30, pz,
        rand() * 6.283, (rand() - 0.5) * 0.5, (rand() - 0.5) * 0.5);
      var ext = Math.sqrt(dx * dx + dz * dz) + s * 0.75;
      if (ext > maxExt) maxExt = ext;
    }
    var rr = maxExt;
    if (rr < 1.6) rr = 1.6; if (rr > 8.5) rr = 8.5;
    OBST.push({ x: cx, z: cz, r: rr });
    placed++;
  }

  /* --- 5 giant mesas outside the playable area (radius 430-650) --- */
  var ang0 = rand() * 6.283;
  for (i = 0; i < 5; i++){
    var ang = ang0 + i * 1.2566 + (rand() - 0.5) * 0.5;
    var dist = 465 + rand() * 195;               /* 465..660 from origin */
    var mx = Math.cos(ang) * dist, mz = Math.sin(ang) * dist;
    var totH = 40 + rand() * 50;                 /* 40..90 m */
    var w = 60 + rand() * 80;
    var yb = height(mx, mz) - 4;
    var fr = [0.55, 0.32, 0.22], wf = [1.0, 0.78, 0.58];
    var rot = rand() * 6.283, yy = yb;
    OBST.push({ x: mx, z: mz, r: w * 0.75 });    /* keep corner-reach out of mesa */
    for (k = 0; k < 3; k++){
      var lh = totH * fr[k];
      var lw = w * wf[k] * (0.9 + rand() * 0.2);
      var cR = (k === 2) ? 0.76 : (k === 1 ? 0.60 : 0.70);
      var cG = (k === 2) ? 0.58 : (k === 1 ? 0.43 : 0.50);
      var cB = (k === 2) ? 0.40 : (k === 1 ? 0.32 : 0.36);
      part(parts, lw, lh, lw * (0.8 + rand() * 0.4), cR, cG, cB,
        mx + (rand() - 0.5) * 8, yy + lh / 2, mz + (rand() - 0.5) * 8,
        rot + (rand() - 0.5) * 0.3, 0, 0);
      yy += lh * 0.92;
    }
  }

  /* --- crashed star-cruiser hulls, half-buried --- */
  var P3 = [0, 0, 0], PM = M.make();
  for (i = 0; i < 2; i++){
    var ca = rand() * 6.283;
    var cd = (i === 0 ? 150 : 240) + rand() * 50;
    var wx = Math.cos(ca) * cd, wz = Math.sin(ca) * cd;
    if (wx > 300) wx = 300; if (wx < -300) wx = -300;
    if (wz > 300) wz = 300; if (wz < -300) wz = -300;
    var yaw = rand() * 6.283;
    var wy = height(wx, wz) + 0.8;
    M.ident(PM); M.tr(PM, wx, wy, wz); M.ry(PM, yaw);
    M.rx(PM, 0.16 + rand() * 0.08); M.rz(PM, (rand() - 0.5) * 0.5);

    var hull = [];
    var scale = (i === 0) ? 1 : 0.7;
    hull.push(Geo.tf(Geo.box(8 * scale, 6.5 * scale, 34 * scale, 0.45, 0.47, 0.50), M.make()));
    M.ident(TM); M.tr(TM, 0, 3.2 * scale, -2 * scale);
    hull.push(Geo.tf(Geo.box(5 * scale, 2.4 * scale, 19 * scale, 0.38, 0.40, 0.43), TM));
    M.ident(TM); M.tr(TM, 0, 7 * scale, 12 * scale); M.rx(TM, -0.15);
    hull.push(Geo.tf(Geo.box(0.9 * scale, 10 * scale, 7 * scale, 0.40, 0.42, 0.46), TM)); /* fin */
    M.ident(TM); M.tr(TM, 0, 0, 17.5 * scale);
    hull.push(Geo.tf(Geo.box(6.6 * scale, 4.2 * scale, 4.5 * scale, 0.24, 0.25, 0.28), TM)); /* engines */
    if (i === 0){ /* torn-off nose chunk a bit ahead */
      M.ident(TM); M.tr(TM, 3, -1.2, -24); M.ry(TM, 0.7); M.rz(TM, 0.4);
      hull.push(Geo.tf(Geo.box(6, 4.5, 8, 0.42, 0.44, 0.47), TM));
    }
    for (k = 0; k < hull.length; k++) parts.push(Geo.tf(hull[k], PM));

    /* collision circles: 4 along the hull axis (spaced/sized to reach the
       4x17m half-extent corners), plus engine block, plus torn-off nose */
    for (k = 0; k < 4; k++){
      M.xp(P3, PM, 0, 0, (k * 9.5 - 14.25) * scale);
      OBST.push({ x: P3[0], z: P3[2], r: 6.25 * scale });
    }
    M.xp(P3, PM, 0, 0, 17.5 * scale);
    OBST.push({ x: P3[0], z: P3[2], r: 4.6 * scale });
    if (i === 0){
      M.xp(P3, PM, 3, -1.2, -24);
      OBST.push({ x: P3[0], z: P3[2], r: 5.4 });
    }
  }

  return Geo.merge(parts);
}

/* ---------- JK.Terrain ---------- */
JK.Terrain = {
  SIZE: 350,                 /* playable half-extent; player/bots clamp to this */
  height: height,            /* analytic, continuous, cheap */
  obstacles: OBST,           /* [{x,z,r}, ...] filled during init */

  init: function(){
    terrainMesh = JK.GL.mesh(buildTerrainGeo());
    sceneryMesh = JK.GL.mesh(buildSceneryGeo());

    /* sun billboard blob 1400m out along SUN_DIR (already unit length) */
    var sp = [SUN_DIR[0] * 1400, SUN_DIR[1] * 1400, SUN_DIR[2] * 1400];
    M.ident(TM); M.tr(TM, sp[0], sp[1], sp[2]); M.ry(TM, 0.5); M.rz(TM, 0.4);
    sunMesh = JK.GL.mesh(Geo.tf(Geo.box(58, 58, 58, 1.0, 0.97, 0.86), TM));
    M.ident(TM); M.tr(TM, sp[0], sp[1], sp[2]); M.ry(TM, 1.1); M.rx(TM, 0.6);
    haloMesh = JK.GL.mesh(Geo.tf(Geo.box(125, 125, 125, 1.0, 0.80, 0.52), TM));

    /* warm desert atmosphere: visibility ~400-600m, mesas hazy on the horizon */
    JK.GL.fog([0.86, 0.72, 0.52], 0.0016);
    JK.GL.sun(SUN_DIR, [1.0, 0.92, 0.74], [0.42, 0.36, 0.30]);
  },

  draw: function(){
    JK.GL.draw(terrainMesh, null);
    JK.GL.draw(sceneryMesh, null);
    JK.GL.draw(sunMesh, null, SUN_OPTS);
    JK.GL.draw(haloMesh, null, HALO_OPTS);
  }
};
})();
