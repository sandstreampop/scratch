/* JK.ForceFx — the visual language of the Force. Owner: forcefx agent.
 *
 * PURE SPECTACLE. No gameplay logic, no input reads, no damage, no audio.
 * JK.Powers (70_powers.js) drives every effect; this module only draws.
 *
 * PUBLIC API (the ITERATION 3+4 contract)
 *   JK.ForceFx.push(origin3, dir3)   expanding shockwave ring, 0.45 s, additive
 *   JK.ForceFx.pull(origin3, dir3)   converging tangential streaks, 0.45 s
 *   JK.ForceFx.lightning(from3, to3) ONE frame of a jagged arc — call EVERY
 *                                    frame while channelling (up to 4 at once)
 *   JK.ForceFx.grip(target, t)       swirling aura around a lifted target — call
 *                                    EVERY frame; target may be a vec3 (chest
 *                                    point) OR a JK.Combat entity ({pos,height})
 *   JK.ForceFx.speed(on)             ghost after-images + CSS vignette (latched)
 *   init() / update(dt, t) / draw()  lifecycle (90_main SYSTEMS slot 'ForceFx')
 *   clear()                          drop every live effect (respawn / tests)
 *   active()                         live effect count (harnesses)
 *
 * RENDERING BUDGET / RULES
 *   - THREE static meshes built once at init: a unit segment (x,z centred,
 *     y in [0,1]), a unit cube, and a chunky humanoid ghost. JK.GL.mesh is
 *     STATIC_DRAW, so nothing is ever rebuilt: every instance is placed with a
 *     model matrix written into module-scope scratch.
 *   - Zero allocation per frame. Pools are preallocated with hard caps:
 *     4 waves x 16 shards, 4 arcs x 9 links (+1 fork), 2 grips, 14 ghosts.
 *   - Everything draws additive + emissive + nofog, so the sand can occlude it
 *     but the fog can never grey it out. A final degenerate opaque draw restores
 *     depthMask(true) — additive draws leave it off and the next frame's depth
 *     clear would silently do nothing.
 *   - The arc jitter comes from a free-running xorshift32 (pure bitwise ops, no
 *     precision loss, no allocation), re-rolled every frame so it crackles.
 *
 * HOW JK.POWERS DRIVES IT (already wired in 70_powers.js)
 *   PUSH      castPush()   -> push(ORIGIN, FWD)          once per cast
 *   PULL      castPull()   -> pull(ORIGIN, FWD)          once per cast
 *   SPEED     setSpeed()   -> speed(true) / speed(false)  on latch change only
 *   LIGHTNING tickChannel  -> lightning(handPoint, chestOf(target)) per target
 *                            per frame (<=3), or one arc into the dunes when the
 *                            cone is empty
 *   GRIP      tickChannel  -> grip(GPOS, t) every frame while the choke holds
 *   Powers.update runs BEFORE ForceFx.update, so calls land, age, then draw in
 *   the same frame. Effects registered by anything else (bots casting push,
 *   say) work identically — the API is caller-agnostic.
 */
(function(){
'use strict';

var M = JK.M;
var PI = Math.PI, TAU = PI * 2;

/* ============================== tuning ============================== */
var RING_MAX   = 4;      /* concurrent push/pull waves */
var RING_SEG   = 16;     /* shards per wave (contract: ~16 thin boxes) */
var PUSH_DUR   = 0.45;
var PULL_DUR   = 0.45;
var PUSH_R     = 4.4;    /* m: final wave radius */
var PUSH_ADV   = 2.7;    /* m: how far the wave flies down the push dir */
var PULL_R     = 3.9;    /* m: radius the streaks start at */
var PULL_ADV   = 3.6;    /* m: how far out in front they start */

var ARC_MAX    = 4;      /* concurrent lightning arcs (Powers caps at 3) */
var ARC_LINKS  = 9;      /* chain links (contract: ~10 short segments) */
var ARC_NODES  = ARC_LINKS + 1;
var FORK_LINKS = 3;
var ARC_HOLD   = 0.09;   /* s an arc survives without a refresh (fade tail) */
/* Widths are set so nothing ever falls under ~1.5 px at its working range on a
 * phone (72 deg fov): a 0.045 m core reads ~2 px at 14 m, which is the furthest
 * JK.Powers will throw an arc. Thinner than that just aliases into sparkle. */
var ARC_CORE_W = 0.045;  /* m: white-hot core cross-section */
var ARC_GLOW_K = 3.6;    /* glow width multiplier over the core */

var GRIP_MAX   = 2;
var GRIP_HOLD  = 0.16;   /* s a grip aura survives without a refresh */
var GRIP_RINGS = 3;
var GRIP_SEG   = 8;      /* shards per aura ring */
var GRIP_MOTES = 7;

var GHOSTS     = 14;     /* speed after-image ring buffer slots */
var GHOST_DT   = 0.042;  /* s between samples */
var GHOST_LIFE = 0.34;   /* s a sample stays visible */
var SPEED_TAIL = 0.30;   /* s of trailing ghosts after speed ends */

/* pale blue-white palette — the Force is cold and bright */
var C_HOT  = [1.00, 1.00, 1.00];
var C_PALE = [0.78, 0.90, 1.00];
var C_BLUE = [0.40, 0.66, 1.00];
var C_CYAN = [0.52, 0.94, 1.00];
var C_VIO  = [0.68, 0.60, 1.00];

/* ============================== state ============================== */
var mSeg = null, mCube = null, mGhost = null;   /* built ONCE at init */
var built = false;
var now = 0;
var drewAny = false;

/* ---- scratch (never reallocated) ---- */
var MTX  = M.make();
var TMX  = M.make();
var TINT = new Float32Array(3);
var OPT  = { emissive: 1, additive: true, nofog: true, alpha: 1, tint: TINT };
var RESET = {};                                  /* opaque, restores depthMask */
var PX = new Float32Array(3);                    /* perpendicular basis X */
var PZ = new Float32Array(3);                    /* perpendicular basis Z */
var HAND = new Float32Array(3);                  /* saber-hand world point */
var GP   = new Float32Array(3);                  /* resolved grip point */
var NODES = new Float32Array(ARC_NODES * 3);     /* arc polyline scratch */
var FNODES = new Float32Array((FORK_LINKS + 1) * 3);

/* ---- deterministic-but-alive jitter: xorshift32, bitwise only ---- */
var seed = 0x2f6e2b1 | 0;
function rnd(){
  seed ^= seed << 13; seed |= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5;  seed |= 0;
  return (seed >>> 0) / 4294967296;
}
function srnd(){ return rnd() * 2 - 1; }

/* ============================== pools ============================== */
function Ring(){
  return { live: false, kind: 0, t: 0, dur: PUSH_DUR, ph: 0,
           ox: 0, oy: 0, oz: 0,   /* origin */
           dx: 0, dy: 0, dz: -1,  /* unit direction (wave normal) */
           ux: 1, uy: 0, uz: 0,   /* in-plane basis */
           vx: 0, vy: 1, vz: 0 };
}
function Arc(){
  return { life: 0, hand: false,
           ax: 0, ay: 0, az: 0, bx: 0, by: 0, bz: 0 };
}
function Grip(){
  return { life: 0, x: 0, y: 0, z: 0, r: 0.9, born: 0 };
}
var rings = new Array(RING_MAX);
var arcs  = new Array(ARC_MAX);
var grips = new Array(GRIP_MAX);
(function(){
  var i;
  for (i = 0; i < RING_MAX; i++) rings[i] = Ring();
  for (i = 0; i < ARC_MAX; i++)  arcs[i]  = Arc();
  for (i = 0; i < GRIP_MAX; i++) grips[i] = Grip();
})();
var arcCursor = 0;             /* reset every update; one slot per call, in order */

/* speed after-image ring buffer: [x, y, z, yaw] + sample time */
var gPos = new Float32Array(GHOSTS * 4);
var gT   = new Float32Array(GHOSTS);
var gHead = 0, gLast = -9;
var speedOn = false, speedOffT = -9;

/* ====================== matrix / basis helpers ====================== */
/* Orthonormal basis from a unit direction: PX and PZ come out perpendicular to
 * d and to each other. This is the helper the lightning uses to jitter its
 * nodes sideways, and the one seg() uses to give a link cross-section. */
function frame(dx, dy, dz){
  var ax, ay, az;
  if (dy > -0.9 && dy < 0.9){ ax = 0; ay = 1; az = 0; }
  else { ax = 1; ay = 0; az = 0; }
  var xx = ay * dz - az * dy, xy = az * dx - ax * dz, xz = ax * dy - ay * dx;
  var l = Math.sqrt(xx * xx + xy * xy + xz * xz);
  if (l < 1e-6){ xx = 1; xy = 0; xz = 0; l = 1; }
  xx /= l; xy /= l; xz /= l;
  PX[0] = xx; PX[1] = xy; PX[2] = xz;
  PZ[0] = xy * dz - xz * dy;                    /* PZ = PX x d, already unit */
  PZ[1] = xz * dx - xx * dz;
  PZ[2] = xx * dy - xy * dx;
}

/* Place the unit-segment mesh onto the world segment o -> o + d*len with a
 * square cross-section of w. d MUST be unit length. Writes m directly (column
 * major: cols are X, Y, Z, T) — no matrix multiplies, no allocation. */
function seg(m, ox, oy, oz, dx, dy, dz, w, len){
  frame(dx, dy, dz);
  m[0] = PX[0] * w; m[1] = PX[1] * w; m[2] = PX[2] * w; m[3] = 0;
  m[4] = dx * len;  m[5] = dy * len;  m[6] = dz * len;  m[7] = 0;
  m[8] = PZ[0] * w; m[9] = PZ[1] * w; m[10] = PZ[2] * w; m[11] = 0;
  m[12] = ox; m[13] = oy; m[14] = oz; m[15] = 1;
}

/* Same, from two endpoints. Returns the length (0 => degenerate, skip it). */
function seg2(m, ax, ay, az, bx, by, bz, w){
  var dx = bx - ax, dy = by - ay, dz = bz - az;
  var l = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (l < 1e-5) return 0;
  seg(m, ax, ay, az, dx / l, dy / l, dz / l, w, l);
  return l;
}

/* Fatten an already-built segment matrix in place (glow pass reuses the core's
 * matrix, so a two-pass link costs one basis build instead of two). */
function widen(m, k){
  m[0] *= k; m[1] *= k; m[2] *= k;
  m[8] *= k; m[9] *= k; m[10] *= k;
}

function tint(c){ TINT[0] = c[0]; TINT[1] = c[1]; TINT[2] = c[2]; }
function tintLerp(a, b, s){
  TINT[0] = a[0] + (b[0] - a[0]) * s;
  TINT[1] = a[1] + (b[1] - a[1]) * s;
  TINT[2] = a[2] + (b[2] - a[2]) * s;
}

function cube(m, x, y, z, s){
  m[0] = s; m[1] = 0; m[2] = 0; m[3] = 0;
  m[4] = 0; m[5] = s; m[6] = 0; m[7] = 0;
  m[8] = 0; m[9] = 0; m[10] = s; m[11] = 0;
  m[12] = x; m[13] = y; m[14] = z; m[15] = 1;
}

function drawCube(x, y, z, s, col, a){
  if (a <= 0.004 || s <= 0) return;
  cube(MTX, x, y, z, s);
  tint(col); OPT.alpha = a;
  JK.GL.draw(mCube, MTX, OPT);
  drewAny = true;
}

/* ============================== meshes ============================== */
function buildMeshes(){
  if (built || !JK.GL || !JK.GL.gl || !JK.Geo) return;
  var G = JK.Geo, GL = JK.GL;

  /* unit segment: 1x1x1 box shifted so it spans y in [0,1] from its origin */
  M.ident(TMX); M.tr(TMX, 0, 0.5, 0);
  mSeg = GL.mesh(G.tf(G.box(1, 1, 1, 1, 1, 1), TMX));
  mCube = GL.mesh(G.box(1, 1, 1, 1, 1, 1));

  /* chunky humanoid silhouette for the Force Speed after-images */
  mGhost = GL.mesh(G.merge([
    bx(0.44, 0.86, 0.28, 0, 0.43, 0),          /* legs */
    bx(0.54, 0.70, 0.32, 0, 1.22, 0),          /* torso */
    bx(0.28, 0.28, 0.26, 0, 1.71, 0),          /* head */
    bx(0.15, 0.62, 0.17,  0.34, 1.24, 0),      /* arm R */
    bx(0.15, 0.62, 0.17, -0.34, 1.24, 0)       /* arm L */
  ]));
  built = true;
}
function bx(sx, sy, sz, x, y, z){
  M.ident(TMX); M.tr(TMX, x, y, z);
  return JK.Geo.tf(JK.Geo.box(sx, sy, sz, 1, 1, 1), TMX);
}

/* ======================= the saber hand (origin) ===================== */
/* JK.Rig.blades[0].base is the saber hand in world space, refreshed by the rig
 * EVERY draw — and ForceFx draws after JK.Rig, so in draw() it is this frame's
 * value with zero lag. Falls back to a chest-height point off the player's
 * right shoulder when the rig has not drawn yet (boot, harnesses). */
function handPoint(out){
  var R = JK.Rig, P = JK.Player;
  var b = R && R.blades && R.blades[0] && R.blades[0].base;
  if (b && P && P.pos){
    var dy = b[1] - P.pos[1];
    var dx = b[0] - P.pos[0], dz = b[2] - P.pos[2];
    if (dy > 0.2 && dy < 2.8 && dx * dx + dz * dz < 4.0){
      out[0] = b[0]; out[1] = b[1]; out[2] = b[2];
      return true;
    }
  }
  if (!P || !P.pos){ out[0] = 0; out[1] = 1.3; out[2] = 0; return false; }
  var y = P.yaw || 0;
  var fx = -Math.sin(y), fz = -Math.cos(y);
  out[0] = P.pos[0] + fx * 0.26 - fz * 0.34;   /* forward + right */
  out[1] = P.pos[1] + 1.30;
  out[2] = P.pos[2] + fz * 0.26 + fx * 0.34;
  return false;
}

/* ========================== push / pull waves ======================== */
function spawnRing(kind, o, d){
  var i, r = null, worst = 1e9;
  for (i = 0; i < RING_MAX; i++){
    var c = rings[i];
    if (!c.live){ r = c; break; }
    var rem = c.dur - c.t;                       /* else steal the oldest */
    if (rem < worst){ worst = rem; r = c; }
  }
  if (!r) return;
  r.live = true; r.kind = kind; r.t = 0;
  r.dur = kind ? PULL_DUR : PUSH_DUR;
  r.ph = rnd() * TAU;
  r.ox = o ? o[0] : 0; r.oy = o ? o[1] : 1.2; r.oz = o ? o[2] : 0;
  var dx = d ? d[0] : 0, dy = d ? d[1] : 0, dz = d ? d[2] : -1;
  var l = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (l < 1e-5){ dx = 0; dy = 0; dz = -1; l = 1; }
  r.dx = dx / l; r.dy = dy / l; r.dz = dz / l;
  frame(r.dx, r.dy, r.dz);                       /* in-plane basis for the disc */
  r.ux = PX[0]; r.uy = PX[1]; r.uz = PX[2];
  r.vx = PZ[0]; r.vy = PZ[1]; r.vz = PZ[2];
}

function drawRing(r){
  var p = r.t / r.dur; if (p > 1) p = 1; if (p < 0) p = 0;
  var pull = r.kind === 1;
  var e, rad, adv, alpha, stretch, w, ip = 1 - p;

  if (!pull){
    e = 1 - ip * ip * ip;                        /* punch out fast, ease to a stop */
    rad = 0.55 + PUSH_R * e;                     /* born as a ring, not a dot */
    adv = 0.55 + PUSH_ADV * e;                   /* clear of the player's chest */
    alpha = ip * ip;
    stretch = 0.80;
    w = 0.055 + 0.085 * ip;
  } else {
    e = p * p * (3 - 2 * p);                     /* smoothstep inward */
    rad = 0.25 + PULL_R * (1 - e);
    adv = PULL_ADV * (1 - e) + 0.25;
    alpha = p < 0.16 ? p / 0.16 : ip / 0.84;
    stretch = 0.75 + 2.4 * e;                    /* streaks smear tangentially */
    w = 0.040 + 0.055 * (1 - e);
  }
  if (alpha <= 0.004) return;

  var segArc = TAU / RING_SEG;
  for (var i = 0; i < RING_SEG; i++){
    var a = r.ph + i * segArc;
    var ca = Math.cos(a), sa = Math.sin(a);
    var rr = rad * (1 + 0.10 * Math.sin(a * 3 + r.ph * 2));   /* chunky wobble */
    /* shard centre on the disc */
    var cx = r.ox + r.dx * adv + (r.ux * ca + r.vx * sa) * rr;
    var cy = r.oy + r.dy * adv + (r.uy * ca + r.vy * sa) * rr;
    var cz = r.oz + r.dz * adv + (r.uz * ca + r.vz * sa) * rr;
    /* tangent (unit): d/da of the ring point */
    var tx = -r.ux * sa + r.vx * ca;
    var ty = -r.uy * sa + r.vy * ca;
    var tz = -r.uz * sa + r.vz * ca;
    var len = segArc * rr * stretch;
    if (len < 0.02) continue;
    var h = len * 0.5;
    seg(MTX, cx - tx * h, cy - ty * h, cz - tz * h, tx, ty, tz, w, len);

    if (pull) tintLerp(C_CYAN, C_HOT, e);
    else tintLerp(C_HOT, C_BLUE, p);
    OPT.alpha = alpha;
    JK.GL.draw(mSeg, MTX, OPT);

    widen(MTX, 2.9);                             /* fat additive halo, same matrix */
    tint(pull ? C_BLUE : C_PALE);
    OPT.alpha = alpha * 0.34;
    JK.GL.draw(mSeg, MTX, OPT);
  }
  drewAny = true;

  /* core flash at the heart of the wave — kept small and pushed out in front so
   * it punctuates the cast instead of whiting out the player's own back */
  if (!pull && p < 0.32){
    var f = 1 - p / 0.32;
    drawCube(r.ox + r.dx * (adv + 0.35), r.oy + r.dy * (adv + 0.35), r.oz + r.dz * (adv + 0.35),
             0.26 + 0.52 * f, C_HOT, f * f * 0.75);
  } else if (pull && p > 0.62){
    var g = (p - 0.62) / 0.38;
    drawCube(r.ox + r.dx * 0.3, r.oy + r.dy * 0.3, r.oz + r.dz * 0.3,
             0.20 + 0.55 * g, C_CYAN, (1 - g) * 0.8);
  }
}

/* ============================== lightning =========================== */
/* Fill `out` with n+1 jittered nodes from a->b. The jitter is perpendicular to
 * the axis (basis from frame()), enveloped so the ends stay pinned to the hand
 * and the victim, with a standing wave mixed in so it reads as a BOLT rather
 * than noise. Re-rolled every frame => it crackles. */
function jag(out, n, ax, ay, az, bx, by, bz, amp, phase){
  var dx = bx - ax, dy = by - ay, dz = bz - az;
  var len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len < 1e-4) return 0;
  frame(dx / len, dy / len, dz / len);
  var ux = PX[0], uy = PX[1], uz = PX[2];
  var vx = PZ[0], vy = PZ[1], vz = PZ[2];
  for (var j = 0; j <= n; j++){
    var s = j / n;
    var env = Math.sin(s * PI);
    env = env * (0.45 + 0.55 * env);             /* fat in the middle, pinned ends */
    var o1 = srnd() * amp * env + Math.sin(s * 9.2 + phase) * amp * env * 0.55;
    var o2 = srnd() * amp * env + Math.cos(s * 6.7 - phase) * amp * env * 0.45;
    var k = j * 3;
    out[k]     = ax + dx * s + ux * o1 + vx * o2;
    out[k + 1] = ay + dy * s + uy * o1 + vy * o2;
    out[k + 2] = az + dz * s + uz * o1 + vz * o2;
  }
  return len;
}

function drawChain(nodes, n, w, glowK, core, glow, a){
  for (var j = 0; j < n; j++){
    var k = j * 3;
    if (!seg2(MTX, nodes[k], nodes[k + 1], nodes[k + 2],
              nodes[k + 3], nodes[k + 4], nodes[k + 5], w)) continue;
    tint(core); OPT.alpha = a;
    JK.GL.draw(mSeg, MTX, OPT);
    if (glowK > 0){
      widen(MTX, glowK);
      tint(glow); OPT.alpha = a * 0.30;
      JK.GL.draw(mSeg, MTX, OPT);
    }
  }
  drewAny = true;
}

function drawArc(arc){
  var a = arc.life / (ARC_HOLD * 0.5); if (a > 1) a = 1;
  if (a <= 0.02) return;
  var ax = arc.ax, ay = arc.ay, az = arc.az;
  if (arc.hand && handPoint(HAND)){             /* re-anchor to the live hand */
    ax = HAND[0]; ay = HAND[1]; az = HAND[2];
  }
  var dx = arc.bx - ax, dy = arc.by - ay, dz = arc.bz - az;
  var len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len < 0.05) return;
  var amp = 0.11 * len; if (amp < 0.09) amp = 0.09; else if (amp > 0.58) amp = 0.58;

  jag(NODES, ARC_LINKS, ax, ay, az, arc.bx, arc.by, arc.bz, amp, now * 21);
  drawChain(NODES, ARC_LINKS, ARC_CORE_W, ARC_GLOW_K, C_HOT, C_BLUE, a);

  /* one or two short forks spitting off an interior node — free crackle */
  var forks = 1 + ((rnd() * 1.6) | 0);
  for (var f = 0; f < forks; f++){
    var j = 2 + ((rnd() * (ARC_LINKS - 3)) | 0);
    var k = j * 3;
    var fx = NODES[k], fy = NODES[k + 1], fz = NODES[k + 2];
    frame(dx / len, dy / len, dz / len);
    var s1 = srnd(), s2 = srnd();
    var gx = dx / len * 0.45 + PX[0] * s1 + PZ[0] * s2;
    var gy = dy / len * 0.45 + PX[1] * s1 + PZ[1] * s2;
    var gz = dz / len * 0.45 + PX[2] * s1 + PZ[2] * s2;
    var gl = Math.sqrt(gx * gx + gy * gy + gz * gz);
    if (gl < 1e-4) continue;
    var flen = 0.22 + len * 0.16;
    gx = fx + gx / gl * flen; gy = fy + gy / gl * flen; gz = fz + gz / gl * flen;
    if (!jag(FNODES, FORK_LINKS, fx, fy, fz, gx, gy, gz, amp * 0.45, now * 17)) continue;
    drawChain(FNODES, FORK_LINKS, ARC_CORE_W * 0.7, 0, C_PALE, C_BLUE, a * 0.75);
  }

  /* hand flare + victim scorch */
  var pu = 0.75 + 0.25 * Math.sin(now * 47);
  drawCube(ax, ay, az, 0.19 * pu, C_HOT, a * 0.9);
  drawCube(ax, ay, az, 0.42 * pu, C_BLUE, a * 0.35);
  drawCube(arc.bx, arc.by, arc.bz, 0.26 * pu, C_PALE, a * 0.75);
  drawCube(arc.bx, arc.by, arc.bz, 0.62 * pu, C_VIO, a * 0.22);
}

/* ================================ grip ============================== */
/* target may be a vec3 (already the chest point — that is what JK.Powers hands
 * us) or a JK.Combat entity whose pos is FEET. Powers' GPOS is a vec3 that also
 * aliases itself as .pos, so `p.pos === p` distinguishes the two cleanly. */
function gripPoint(p, out){
  if (!p) return false;
  var a = p.pos;
  if (a && a !== p && a.length >= 3){
    out[0] = a[0]; out[1] = a[1] + (p.height || 1.8) * 0.55; out[2] = a[2];
    return true;
  }
  a = a && a.length >= 3 ? a : p;
  if (!a || a.length < 3) return false;
  out[0] = a[0]; out[1] = a[1]; out[2] = a[2];
  return true;
}

function drawGrip(g){
  var a = g.life / (GRIP_HOLD * 0.6); if (a > 1) a = 1;
  if (a <= 0.02) return;
  var age = now - g.born;
  var pop = age < 0.18 ? age / 0.18 : 1;         /* rings snap open on the lock */
  var i, k;

  for (k = 0; k < GRIP_RINGS; k++){
    var rad = (0.62 + 0.20 * k) * g.r * (0.6 + 0.4 * pop);
    var tilt = 0.0 + k * 1.05;                   /* 0, 60, 120 deg about X */
    var spin = now * (1.7 - 1.05 * k) + k * 2.1; /* counter-rotating gyroscope */
    var yoff = (k - 1) * 0.16 + Math.sin(now * 2.3 + k) * 0.05;
    var ct = Math.cos(tilt), stl = Math.sin(tilt);
    var cs = Math.cos(spin), ss = Math.sin(spin);
    /* ring plane basis: horizontal ring tilted about X, then yawed by spin */
    var e1x = cs,          e1y = 0,   e1z = -ss;
    var e2x = ct * ss,     e2y = stl, e2z = ct * cs;
    var step = TAU / GRIP_SEG;
    var w = 0.046 + 0.014 * k;
    for (i = 0; i < GRIP_SEG; i++){
      var an = i * step + spin * 0.5;
      var ca = Math.cos(an), sa = Math.sin(an);
      var cx = g.x + (e1x * ca + e2x * sa) * rad;
      var cy = g.y + yoff + (e1y * ca + e2y * sa) * rad;
      var cz = g.z + (e1z * ca + e2z * sa) * rad;
      var tx = -e1x * sa + e2x * ca;
      var ty = -e1y * sa + e2y * ca;
      var tz = -e1z * sa + e2z * ca;
      var len = step * rad * 0.72;
      var h = len * 0.5;
      seg(MTX, cx - tx * h, cy - ty * h, cz - tz * h, tx, ty, tz, w, len);
      tintLerp(C_PALE, C_VIO, k / GRIP_RINGS);
      OPT.alpha = a * (0.85 - 0.15 * k);
      JK.GL.draw(mSeg, MTX, OPT);
      widen(MTX, 2.6);
      tint(C_BLUE);
      OPT.alpha = a * 0.22;
      JK.GL.draw(mSeg, MTX, OPT);
    }
  }
  drewAny = true;

  /* motes rising out of the choke — pure formula, no state, no allocation */
  for (i = 0; i < GRIP_MOTES; i++){
    var ph = (now * 0.62 + i * 0.1371) % 1;
    var ang = i * 2.3999 + now * 1.15;
    var mr = g.r * 0.85 * (1 - 0.55 * ph);
    var mx = g.x + Math.cos(ang) * mr;
    var my = g.y - 0.72 + ph * 1.85;
    var mz = g.z + Math.sin(ang) * mr;
    drawCube(mx, my, mz, 0.075 * (1 - 0.55 * ph), C_CYAN, a * Math.sin(ph * PI) * 0.9);
  }

  /* the choke itself */
  drawCube(g.x, g.y, g.z, 0.22 + 0.05 * Math.sin(now * 15), C_HOT, a * 0.55);
  drawCube(g.x, g.y, g.z, 0.62 + 0.10 * Math.sin(now * 15), C_VIO, a * 0.18);
}

/* =============================== speed ============================== */
var vig = null, vigOn = false, domBuilt = false;

var CSS = [
'#jkfxVig { position:absolute; left:0; top:0; right:0; bottom:0; z-index:1;',
'  pointer-events:none; opacity:0; transition:opacity .20s ease-out;',
'  background:',
'    radial-gradient(ellipse at 50% 50%, rgba(150,215,255,0) 30%,',
'      rgba(105,180,255,.16) 62%, rgba(170,225,255,.42) 100%),',
'    radial-gradient(ellipse at 50% 120%, rgba(90,170,255,.22) 0%,',
'      rgba(90,170,255,0) 55%); }',
'#jkfxVig.on { opacity:1; animation:jkfxRush .42s ease-in-out infinite alternate; }',
'@keyframes jkfxRush { from { opacity:.72; } to { opacity:1; } }'
].join('\n');

function buildDom(){
  if (domBuilt) return;
  if (typeof document === 'undefined' || !document.body) return;
  domBuilt = true;
  if (document.getElementById('jkfxVig')){ vig = document.getElementById('jkfxVig'); return; }
  var st = document.createElement('style');
  st.textContent = CSS;
  (document.head || document.getElementsByTagName('head')[0] || document.body).appendChild(st);
  vig = document.createElement('div');
  vig.id = 'jkfxVig';
  document.body.appendChild(vig);
}

function setVignette(on){
  if (on === vigOn) return;
  vigOn = on;
  if (!vig) buildDom();
  if (vig) vig.className = on ? 'on' : '';
}

function sampleGhost(){
  var P = JK.Player;
  if (!P || !P.pos) return;
  var k = gHead * 4;
  gPos[k] = P.pos[0]; gPos[k + 1] = P.pos[1]; gPos[k + 2] = P.pos[2];
  gPos[k + 3] = P.yaw || 0;
  gT[gHead] = now;
  gHead = (gHead + 1) % GHOSTS;
  gLast = now;
}

function drawGhosts(){
  var fade = 1;
  if (!speedOn){
    var off = now - speedOffT;
    if (off > SPEED_TAIL) return;
    fade = 1 - off / SPEED_TAIL;
  }
  for (var i = 0; i < GHOSTS; i++){
    var age = now - gT[i];
    if (age <= 0.03 || age > GHOST_LIFE) continue;    /* skip the newest sample */
    var k = i * 4;
    var s = 1 - age / GHOST_LIFE;
    var a = s * s * 0.30 * fade;
    if (a <= 0.005) continue;
    var y = gPos[k + 3];
    var c = Math.cos(y), sn = Math.sin(y);
    var sc = 0.94 + 0.10 * (1 - s);
    /* rotY(y) with a uniform scale, written straight into the matrix */
    MTX[0] = c * sc;  MTX[1] = 0;  MTX[2] = -sn * sc; MTX[3] = 0;
    MTX[4] = 0;       MTX[5] = sc; MTX[6] = 0;        MTX[7] = 0;
    MTX[8] = sn * sc; MTX[9] = 0;  MTX[10] = c * sc;  MTX[11] = 0;
    MTX[12] = gPos[k]; MTX[13] = gPos[k + 1]; MTX[14] = gPos[k + 2]; MTX[15] = 1;
    tintLerp(C_CYAN, C_BLUE, 1 - s);
    OPT.alpha = a;
    JK.GL.draw(mGhost, MTX, OPT);
    drewAny = true;
  }
}

/* ============================== module ============================== */
var ForceFx = JK.ForceFx = {
  speedOn: false,

  init: function(){
    buildMeshes();
    buildDom();
    ForceFx.clear();
  },

  clear: function(){
    var i;
    for (i = 0; i < RING_MAX; i++){ rings[i].live = false; rings[i].t = 0; }
    for (i = 0; i < ARC_MAX; i++) arcs[i].life = 0;
    for (i = 0; i < GRIP_MAX; i++) grips[i].life = 0;
    for (i = 0; i < GHOSTS; i++) gT[i] = -9;
    arcCursor = 0;
    speedOn = false; ForceFx.speedOn = false; speedOffT = -9; gLast = -9;
    setVignette(false);
  },

  active: function(){
    var n = 0, i;
    for (i = 0; i < RING_MAX; i++) if (rings[i].live) n++;
    for (i = 0; i < ARC_MAX; i++) if (arcs[i].life > 0) n++;
    for (i = 0; i < GRIP_MAX; i++) if (grips[i].life > 0) n++;
    return n;
  },

  /* ---- push: expanding shockwave disc facing the push direction ---- */
  push: function(origin, dir){
    spawnRing(0, origin, dir);
    if (JK.Fx && JK.Fx.shimmer && origin) JK.Fx.shimmer(origin, 10, C_PALE);
  },

  /* ---- pull: the same ring machinery, run inward with tangential smear ---- */
  pull: function(origin, dir){
    spawnRing(1, origin, dir);
    if (JK.Fx && JK.Fx.shimmer && origin) JK.Fx.shimmer(origin, 8, C_CYAN);
  },

  /* ---- lightning: ONE frame of one arc. Call every frame while channelling.
   * Slots are handed out in call order and the cursor resets in update(), so a
   * caster that issues its arcs in a stable order (Powers scans nearest-first)
   * keeps each target on the same slot with no matching cost. ---- */
  lightning: function(from, to){
    if (!from || !to) return;
    var i = arcCursor;
    if (i >= ARC_MAX){                            /* overflow: recycle the faintest */
      i = 0;
      for (var j = 1; j < ARC_MAX; j++) if (arcs[j].life < arcs[i].life) i = j;
    } else arcCursor++;
    var a = arcs[i];
    a.ax = from[0]; a.ay = from[1]; a.az = from[2];
    a.bx = to[0];   a.by = to[1];   a.bz = to[2];
    a.life = ARC_HOLD;
    /* does this arc leave the player's saber hand? then re-anchor it per draw */
    a.hand = false;
    if (handPoint(HAND)){
      var dx = from[0] - HAND[0], dy = from[1] - HAND[1], dz = from[2] - HAND[2];
      a.hand = dx * dx + dy * dy + dz * dz < 1.0;
    }
  },

  /* ---- grip: swirling aura rings + rising motes on the lifted target ---- */
  grip: function(target, t){
    if (!gripPoint(target, GP)) return;
    if (typeof t === 'number' && t > now) now = t;
    var i, g = null, best = 1e9;
    for (i = 0; i < GRIP_MAX; i++){
      var c = grips[i];
      if (c.life > 0){
        var dx = c.x - GP[0], dy = c.y - GP[1], dz = c.z - GP[2];
        if (dx * dx + dy * dy + dz * dz < 12.25){ g = c; break; }   /* same victim */
      }
      if (c.life < best){ best = c.life; g = c; }   /* else: recycle the faintest */
    }
    if (!g) g = grips[0];
    if (g.life <= 0) g.born = now;
    g.x = GP[0]; g.y = GP[1]; g.z = GP[2];
    g.r = (target && target.radius ? target.radius : 0.55) * 1.6;
    g.life = GRIP_HOLD;
  },

  /* ---- speed: after-image ghosts + the CSS rush vignette ---- */
  speed: function(on){
    on = !!on;
    if (on === speedOn) return;
    speedOn = on;
    ForceFx.speedOn = on;
    if (on){ gLast = -9; sampleGhost(); }
    else speedOffT = now;
    setVignette(on);
    if (on && JK.Fx && JK.Fx.shimmer && JK.Player && JK.Player.pos)
      JK.Fx.shimmer(JK.Player.pos, 12, C_CYAN);
  },

  update: function(dt, t){
    var i;
    now = t || 0;
    arcCursor = 0;                                /* new registration batch */
    for (i = 0; i < RING_MAX; i++){
      var r = rings[i];
      if (!r.live) continue;
      r.t += dt;
      if (r.t >= r.dur){ r.live = false; r.t = 0; }
    }
    for (i = 0; i < ARC_MAX; i++){
      var a = arcs[i];
      if (a.life > 0){ a.life -= dt; if (a.life < 0) a.life = 0; }
    }
    for (i = 0; i < GRIP_MAX; i++){
      var g = grips[i];
      if (g.life > 0){ g.life -= dt; if (g.life < 0) g.life = 0; }
    }
    if (speedOn && now - gLast >= GHOST_DT) sampleGhost();
  },

  draw: function(){
    if (!built || !JK.GL || !JK.GL.gl) return;
    var i;
    drewAny = false;
    drawGhosts();
    for (i = 0; i < RING_MAX; i++) if (rings[i].live) drawRing(rings[i]);
    for (i = 0; i < GRIP_MAX; i++) if (grips[i].life > 0) drawGrip(grips[i]);
    for (i = 0; i < ARC_MAX; i++) if (arcs[i].life > 0) drawArc(arcs[i]);
    if (drewAny){
      /* additive draws leave depthMask(false); one degenerate opaque draw puts
       * it back so the NEXT frame's depth clear is not silently discarded. */
      cube(MTX, 0, 0, 0, 0);
      JK.GL.draw(mCube, MTX, RESET);
    }
  }
};
})();
