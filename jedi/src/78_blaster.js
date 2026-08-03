/* JK.Blaster — laser bolts + the saber-deflection system. Owner: blaster agent.
 *
 * The module that makes stormtroopers threatening and the saber heroic.
 *
 * API (ITERATION 3+4 CONTRACT):
 *   JK.Blaster.fire(origin3, dir3, team, opts) -> bolt | null
 *     opts = {speed=58, dmg=9, color=[r,g,b] 0..1, spread, life, owner}
 *     team 'enemy' (imperial red) | 'player' (green) | 'neutral'.
 *     `spread` is a cone HALF-ANGLE in radians; a value > 0.5 is assumed to be
 *     degrees and converted (defensive: bot agents write "~4 deg spread").
 *     `owner` (optional) is the shooter's JK.Combat entity — never self-hit.
 *   JK.Blaster.repel(pos3, dir3) -> int   Force Push: every enemy bolt within
 *     9 m inside a 75 deg half-cone around dir flips to team 'player' and is
 *     blown back along dir. Returns how many were turned.
 *   JK.Blaster.count() -> live bolt count.   JK.Blaster.bolts -> the pool
 *     (read-only by convention; each record keeps the same identity forever).
 *   JK.Blaster.clear() -> kill every bolt.   JK.Blaster.stats {fired, deflected,
 *     hits, ground} for tests/HUD.
 *   init/update(dt,t)/draw per the standard lifecycle. Runs in 90_main's
 *   SYSTEMS slot 'Blaster' (after Bots, before Hero/Fx).
 *
 * Bolt record (preallocated, contract shape):
 *   { pos:Float32Array(3), vel:Float32Array(3), color:Float32Array(3),
 *     life, team, dmg, speed, active, deflected, owner,
 *     pop /* s of "just turned around" scale-up left — visual only *\/ }
 *
 * COLLISION: each bolt's frame movement is split into >= 2 substeps (a 58 m/s
 * bolt covers ~1 m per 60 Hz frame, up to 2.9 m on a 0.05 s clamped frame), and
 * every substep runs, in order:
 *   1. SABER DEFLECTION — segment(bolt) vs segment(blade) for every entry of
 *      JK.Rig.blades (single/dual/staff all covered).
 *   2. ENTITY HITS — exact segment vs VERTICAL CAPSULE, the same geometric test
 *      55_combat.js uses for saber sweeps, so bolts and sabers agree on what a
 *      hit is. Entities of the bolt's own team (and the shooter) are skipped.
 *   3. GROUND — JK.Terrain.height under the substep's end point.
 *
 * TUNNELING: entity hits cannot tunnel at ANY substep count, because step 2 is
 * an exact segment-vs-capsule distance test across the WHOLE substep rather than
 * a point sample at its end — the swept path is covered in full. Measured worst
 * case (58 m/s bolt, 0.05 s clamped frame = 2.9 m of travel, r=0.5 bot at 20 m):
 * the hit lands at 20 fps exactly as at 60 fps, and the miss boundary sits on the
 * true geometric radius, 0.5 + BOLT_R = 0.60 m of lateral offset. Substeps are
 * therefore there for the OTHER two tests: GROUND is a point sample at the
 * substep's end, so ceil(2.9 / SUB_LEN) = 4 steps hold ground sampling to 0.73 m
 * (finer than any dune feature), and DEFLECTION re-reads the velocity between
 * substeps, so a parried bolt turns around inside the frame that parried it.
 *
 * ONE-FRAME NOTE: JK.Rig.blades are refreshed during Rig.DRAW, so at update
 * time they hold the previous frame's pose (~16 ms, ~1 m of bolt travel). The
 * deflection radius is deliberately generous to swallow that lag — a lit saber
 * anywhere near the bolt's path sends it back, which is the fun answer. The one
 * thing it will NOT do is save a shot the body already ate: the parry and the
 * hero's own capsule are raced on ENTRY distance along the bolt's path, so the
 * verdict is pure geometry rather than a function of the substep grid. See the
 * race note on tryDeflect — getting that wrong made the same shot bounce or
 * land depending on the frame rate.
 *
 * SELLING THE PARRY. Mechanically the deflection was already excellent (9 of 9
 * chest shots turned, HP never moved) and visually it was almost invisible:
 * measured on a frozen still one frame after contact, the whole event changed
 * 0.11% of the screen — a white smudge on the blade — and the returned bolt was
 * the same small box as an incoming one, so nobody could tell they had just
 * parried a blaster shot with a lightsaber. Four additions, all pooled and all
 * drawn with the ONE shared cube:
 *   - a PARRY FLASH pool (<=4) pinned to the contact point ON THE BLADE: a
 *     screen-facing impact diamond, a white-hot core, a saber-coloured halo, two
 *     chunky crossed spikes and a streak that grows down the return path. 7 boxes
 *     each for 0.26 s, and only ever while a parry is on screen.
 *   - deflected bolts are BEEFIER for their whole flight (1.55x cross-section,
 *     1.22x core length, hotter core tint) plus a 0.13 s scale-up "pop" as they
 *     leave, so the eye is dragged onto them at the moment they turn.
 *   - one extra additive WAKE box behind a deflected bolt (+1 box per returned
 *     bolt) so the return reads as a streak of motion rather than a dot.
 *   - the same flash again where a RETURNED bolt lands, which is the end of the
 *     story: flash on the blade -> streak -> fat green bolt -> flash on the
 *     trooper who fired it.
 * Measured (frozen still, one frame after contact, 844x390): screen pixels
 * changed by the whole event went 0.08-0.14% -> 0.41-0.43% for a shot returned
 * straight down the camera axis (the worst case: everything is foreshortened) and
 * 0.45% -> 2.02% for one returned across the view. Independently re-measured with
 * a frozen-world A/B against the identical frame with no bolt in it: 0.40% down
 * the lens, 0.75% from behind, 0.95% across the view.
 *
 * DRAW COST: TWO CALLS, whatever is on screen. Every bolt and every flash is a
 * box, so they are CPU-transformed into two shared vertex buffers — one opaque
 * (the cores, which must write depth) and one additive (shells, wakes, flashes) —
 * and go out as two drawElements per frame. It used to be 3 calls per bolt plus 7
 * per flash plus a state-restore draw: a parried 3-round burst cost 34 and a
 * 20-bolt salvo 81, against a 200-call whole-game budget. See the batching note
 * above emitBox; the pixels are identical, not merely similar, and a frozen-frame
 * A/B against the per-box path measures 0 of 329160 pixels different.
 *
 * Zero per-frame allocations: the pool, all scratch vectors, matrices, batches
 * and draw option objects live at module scope.
 */
(function(){
'use strict';
var M = JK.M;

/* ============================== tuning ============================== */
var MAXB        = 160;      /* pool size (contract: <= 160) */
var DEF_SPEED   = 58;       /* m/s, default bolt speed */
var DEF_DMG     = 9;        /* trooper bolt damage */
var DEF_LIFE    = 3.0;      /* s before a bolt fizzles (~174 m of flight) */
var BOLT_LEN    = 0.90;     /* m, visual length of the core */
var BOLT_R      = 0.10;     /* m, collision fatness added to entity radii */

var CORE_W      = 0.060;    /* m, opaque emissive core cross-section */
var GLOW1_W     = 0.185;    /* m, hot additive shell */
var GLOW2_W     = 0.380;    /* m, faint additive halo */
var GLOW1_A     = 0.55;
var GLOW2_A     = 0.22;
var GLOW2_LEN   = 1.18;     /* halo is slightly longer than the core */
var FAR_DRAW    = 170;      /* m, cull bolts entirely beyond this */
var FAR_HALO    = 75;       /* m, drop the outer halo beyond this */

var SUB_MIN     = 2;        /* substeps per bolt per frame (contract: >= 2) */
var SUB_MAX     = 6;
var SUB_LEN     = 0.85;     /* m of travel per substep we aim for */

var DEFL_R      = 0.46;     /* m, blade-to-bolt distance that deflects */
var DEFL_R_SW   = 0.68;     /* m, while actually swinging — very generous */
var DEFL_LOOK   = 0.75;     /* m, the head start the saber gets over the hero's
                             * own hitbox. Without it a bolt aimed at the chest
                             * can clip the 0.55 m capsule BEFORE it comes
                             * within blade radius, and the body eats a shot the
                             * saber was clearly in position to take. The saber
                             * gets the last word — that is the whole fantasy.
                             * It is a budget measured between the two ENTRY
                             * points, not a licence to parry past the body:
                             * see the race note on tryDeflect. */
var PROBE_PAD   = 0.80;     /* m of probe beyond DEFL_LOOK. entryDist() reads
                             * the solvers' closest-approach parameter, which is
                             * up to one radius (max DEFL_R_SW = 0.68) past the
                             * entry; padding the probe by more than that keeps
                             * that parameter off the segment's clamped end, so
                             * the entry distances stay exact — and therefore
                             * substep-phase independent — inside the window we
                             * actually act on. */
var DEFL_PROBE  = DEFL_LOOK + PROBE_PAD;
var DEFL_NEAR   = 4.2;      /* m, coarse reject around the player's chest */
var BLADE_NEAR  = 3.0;      /* m, sanity: ignore blades far from the player */
var DEFL_DMG    = 14;       /* deflected bolts hit harder (contract) */
var DEFL_SPEED  = 66;       /* m/s, returned bolts snap back fast */
var DEFL_SPREAD = 0.055;    /* rad, ~3 deg — the scatter cap on a return shot */
var DEFL_SCAT   = 0.30;     /* m of scatter AT THE TARGET. A fixed 3 deg angle
                             * is a 1.6 m miss at 30 m, i.e. deflected bolts
                             * would never actually hit anybody. Solving for a
                             * distance-independent metre offset keeps the shot
                             * imperfect up close and still lethal down range. */
var TARGET_R    = 40;       /* m, retarget radius for deflected bolts */

var REPEL_R     = 9.0;      /* m, Force Push bolt-repel radius */
var REPEL_COS   = 0.2588;   /* cos(75 deg) — matches JK.Powers' push cone */
var REPEL_SPEED = 52;       /* m/s floor for repelled bolts */
var REPEL_SPRD  = 0.10;     /* rad, scatter of a repelled volley */

var COL_ENEMY   = [1.00, 0.188, 0.125];   /* imperial red   #ff3020 */
var COL_PLAYER  = [0.250, 1.000, 0.376];  /* deflected green #40ff60 */
var COL_SAND    = [0.86, 0.74, 0.52];     /* ground-impact puff */
var COL_HOT     = [1.00, 1.00, 1.00];     /* parry flash core */
var CORE_MIX    = 0.55;     /* how far the core tint lerps toward white */
var DEFL_MIX    = 0.72;     /* ...and further still for a returned bolt */
var WORLD_PAD   = 60;       /* m past Terrain.SIZE before a bolt is discarded */
var DEG         = Math.PI / 180;

/* ---- the parry: how the deflection is SOLD (see the header note) ---- */
var DEFL_VIS_W  = 1.55;     /* returned bolts are this much fatter, for life */
var DEFL_VIS_L  = 1.22;     /* ...and this much longer */
var POP_T       = 0.13;     /* s of extra scale-up as a bolt turns around */
/* The pop is deliberately small. At 1.1x extra width the bolt's own halo became
 * a 1.2 m green slab across the hero's chest on the contact frame and buried the
 * flash that is supposed to be the star of the moment; the flash owns the punch,
 * the bolt only needs to swell enough to look shoved. */
var POP_W       = 0.55;     /* extra width at the start of the pop */
var POP_L       = 0.30;     /* extra length at the start of the pop */
var WAKE_LEN    = 2.8;      /* x core length: faint trail behind a returned bolt */
var WAKE_W      = 0.65;     /* x GLOW1_W (never scaled by the pop — see draw) */
var WAKE_A      = 0.16;

var FMAX        = 4;        /* concurrent parry flashes (pooled) */
var FLASH_T     = 0.26;     /* s a flash lives */
var FL_CORE     = 0.40;     /* m, white-hot core at birth */
var FL_HALO     = 0.50;     /* m, saber-coloured halo (expands) */
var FL_SPIKE_L  = 1.30;     /* m, crossed spikes at full stretch */
var FL_SPIKE_W  = 0.085;    /* m, spike cross-section at birth */
var FL_STREAK_L = 2.60;     /* m the exit streak reaches */
var FL_STREAK_W = 0.11;     /* m, streak cross-section at birth. Wider than
                             * this and the core stops reading as a beam and
                             * starts reading as a green slab. */
var FL_DIA      = 0.46;     /* m, screen-facing impact diamond at full bloom.
                             * Bigger than this and the hard-edged quad stops
                             * reading as a flash and starts reading as a kite —
                             * at 0.72 m it was 140 px across, wider than the
                             * hero's whole torso, with its left half depth-culled
                             * behind his shoulder into a lopsided wedge. */
var FL_DIA_OFF  = 0.30;     /* m along the exit dir, so the quad clears the body */

/* ============================== pool ================================ */
var pool = new Array(MAXB);
(function(){
  for (var i = 0; i < MAXB; i++){
    pool[i] = {
      pos: new Float32Array(3),
      vel: new Float32Array(3),
      color: new Float32Array(3),
      life: 0, team: 'enemy', dmg: DEF_DMG, speed: DEF_SPEED,
      active: false, deflected: false, owner: null,
      pop: 0                          /* s of "just turned around" scale-up left */
    };
  }
})();
var cursor = 0, nActive = 0;

/* ---- parry flashes: pooled, additive, all on the shared cube ---- */
var flashes = new Array(FMAX);
(function(){
  for (var i = 0; i < FMAX; i++)
    flashes[i] = { life: 0, x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: -1,
                   cr: 1, cg: 1, cb: 1, roll: 0 };
})();
var nFlash = 0;

/* ============================== scratch ============================= */
var MTX   = M.make();               /* per-draw model matrix */
var DIRV  = new Float32Array(3);    /* hit direction handed to onHit */
var SD    = new Float32Array(3);    /* spread/aim result */
var IMP   = new Float32Array(3);    /* impact point */
var NRM   = new Float32Array(3);    /* mirror normal */
var SWB   = { base: new Float32Array(3), tip: new Float32Array(3) };  /* swept blade */
var TC    = new Float32Array(3);    /* core tint */
var TG    = new Float32Array(3);    /* glow tint */
var CORE_BO = { emissive: 1, nofog: true };                   /* core batch */
var ADD_BO  = { emissive: 1, nofog: true, additive: true };   /* shell batch */

/* ---- the two batches ------------------------------------------------------
 * WHY: every bolt used to cost three back-to-back drawElements of the same unit
 * cube and every parry flash seven more. On iOS Safari each WebGL entry point is
 * marshalled across a process boundary, so the CALL COUNT — not the 12 triangles
 * behind each one — is the frame-time spike, and 200 calls a frame is the budget
 * for the whole game. Both batches use the identical trick JK.Fx's particle pool
 * uses (see the batching note in 55_combat.js):
 *  1. emissive = 1 drops the shader's lit term (vCol = base), so NORMALS are
 *     never read: they are written once at build time and a box can be 8 shared
 *     corners / 12 triangles instead of 24 split verts. CULL_FACE is off, so
 *     front and back faces still both accumulate.
 *  2. nofog = true pins the fog factor at 1, so per-box colour and alpha fold
 *     into the vertex colour exactly (aC = rgb*alpha, uTint = 1, uAlpha = 1).
 *  3. The additive batch runs with depthMask(false) and the depth TEST is per
 *     fragment, so collapsing those draws cannot change occlusion. The CORE
 *     batch does write depth, and one drawElements rasterizes its primitives in
 *     index order — the same order the separate draws used — so it too is exact.
 * The cores stay in their own batch, drawn FIRST, because they are opaque and
 * must occlude; mixing them into the additive one would lose the depth writes. */
var CORE_BOXES = MAXB;                  /* one opaque core per live bolt */
var ADD_BOXES  = MAXB * 3 + FMAX * 7;   /* glow1 + glow2 + wake, 7 per flash */
var bCore = null, bAdd = null;
var CUBE_TRI = [0,1,3, 0,3,2,   4,5,7, 4,7,6,   0,1,5, 0,5,4,
                2,3,7, 2,7,6,   0,2,6, 0,6,4,   1,3,7, 1,7,5];

var segS = 0, segT = 0;             /* params stashed by the distance tests */

/* ============================== helpers ============================= */
function clamp01(v){ return v < 0 ? 0 : (v > 1 ? 1 : v); }

function groundY(x, z){
  var T = JK.Terrain;
  return (T && T.height) ? T.height(x, z) : 0;
}

function snd(name, x, y, z, vol){
  var A = JK.Audio;
  if (!A || typeof A.play !== 'function') return;
  SND_POS[0] = x; SND_POS[1] = y; SND_POS[2] = z;
  SND_OPT.pos = SND_POS;
  SND_OPT.vol = vol === undefined ? 1 : vol;
  A.play(name, SND_OPT);
}
var SND_POS = [0, 0, 0];
var SND_OPT = { pos: SND_POS, vol: 1 };

function sparks(x, y, z, n, col){
  var F = JK.Fx;
  if (!F || typeof F.sparks !== 'function') return;
  IMP[0] = x; IMP[1] = y; IMP[2] = z;
  F.sparks(IMP, n, col || null);
}

/* Unit direction + random cone scatter. amt = half-angle in radians (small). */
function spreadDir(fx, fy, fz, amt, out){
  var l = Math.sqrt(fx * fx + fy * fy + fz * fz) || 1;
  fx /= l; fy /= l; fz /= l;
  if (amt > 0){
    var ux = 0, uy = 1, uz = 0;
    if (fy > 0.999 || fy < -0.999){ ux = 1; uy = 0; uz = 0; }
    var rx = uy * fz - uz * fy, ry = uz * fx - ux * fz, rz = ux * fy - uy * fx;
    var rl = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1;
    rx /= rl; ry /= rl; rz /= rl;
    var vx = fy * rz - fz * ry, vy = fz * rx - fx * rz, vz = fx * ry - fy * rx;
    var a = (Math.random() * 2 - 1) * amt, b = (Math.random() * 2 - 1) * amt;
    fx += rx * a + vx * b; fy += ry * a + vy * b; fz += rz * a + vz * b;
    l = Math.sqrt(fx * fx + fy * fy + fz * fz) || 1;
    fx /= l; fy /= l; fz /= l;
  }
  out[0] = fx; out[1] = fy; out[2] = fz;
  return out;
}

/* Exact closest-distance^2 between segment p + s*d (s in 0..1) and an entity's
 * VERTICAL capsule axis (x=cx, z=cz, y in y0..y1). Same specialisation of the
 * two-segment closest-point solve that 55_combat.js uses for saber sweeps, so
 * bolts and blades agree on what "inside the capsule" means. Stashes s. */
function segCapDistSq(bx, by, bz, dx, dy, dz, cx, y0, y1, cz){
  var rx = bx - cx, ry = by - y0, rz = bz - cz;
  var a = dx * dx + dy * dy + dz * dz;
  var ey = y1 - y0;
  var e = ey * ey;
  var f = ey * ry;
  var c = dx * rx + dy * ry + dz * rz;
  var s, u;
  if (a <= 1e-9){ s = 0; u = e > 1e-9 ? clamp01(f / e) : 0; }
  else if (e <= 1e-9){ u = 0; s = clamp01(-c / a); }
  else {
    var b2 = dy * ey;
    var den = a * e - b2 * b2;
    s = den > 1e-9 ? clamp01((b2 * f - c * e) / den) : 0;
    u = (b2 * s + f) / e;
    if (u < 0){ u = 0; s = clamp01(-c / a); }
    else if (u > 1){ u = 1; s = clamp01((b2 - c) / a); }
  }
  segS = s;
  var wx = bx + dx * s - cx;
  var wy = by + dy * s - (y0 + ey * u);
  var wz = bz + dz * s - cz;
  return wx * wx + wy * wy + wz * wz;
}

/* Closest-distance^2 between segment A (p1->q1) and segment B (p2->q2).
 * Ericson 5.1.9, fully clamped. Stashes the params in segS / segT. */
function segSegDistSq(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz){
  var ux = bx - ax, uy = by - ay, uz = bz - az;      /* dir of A */
  var vx = dx - cx, vy = dy - cy, vz = dz - cz;      /* dir of B */
  var wx = ax - cx, wy = ay - cy, wz = az - cz;
  var a = ux * ux + uy * uy + uz * uz;
  var b = ux * vx + uy * vy + uz * vz;
  var c = vx * vx + vy * vy + vz * vz;
  var d = ux * wx + uy * wy + uz * wz;
  var e = vx * wx + vy * wy + vz * wz;
  var s, t;
  if (a <= 1e-9 && c <= 1e-9){ s = 0; t = 0; }
  else if (a <= 1e-9){ s = 0; t = clamp01(e / c); }
  else if (c <= 1e-9){ t = 0; s = clamp01(-d / a); }
  else {
    var den = a * c - b * b;
    s = den > 1e-9 ? clamp01((b * e - c * d) / den) : 0;
    t = (b * s + e) / c;
    if (t < 0){ t = 0; s = clamp01(-d / a); }
    else if (t > 1){ t = 1; s = clamp01((b - d) / a); }
  }
  segS = s; segT = t;
  var qx = ax + ux * s - (cx + vx * t);
  var qy = ay + uy * s - (cy + vy * t);
  var qz = az + uz * s - (cz + vz * t);
  return qx * qx + qy * qy + qz * qz;
}

/* ============================== spawning ============================ */
function kill(b){
  if (b.active){ b.active = false; if (nActive > 0) nActive--; }
  b.owner = null;     /* a spent slot must not pin a dead bot's entity alive */
}

function alloc(){
  var i, k;
  for (k = 0; k < MAXB; k++){
    i = cursor + k; if (i >= MAXB) i -= MAXB;
    if (!pool[i].active){
      cursor = i + 1 >= MAXB ? 0 : i + 1;
      nActive++;
      return pool[i];
    }
  }
  /* pool saturated: recycle the bolt closest to fizzling out */
  var best = 0, bl = 1e9;
  for (k = 0; k < MAXB; k++) if (pool[k].life < bl){ bl = pool[k].life; best = k; }
  return pool[best];
}

function setCol(b, c){ b.color[0] = c[0]; b.color[1] = c[1]; b.color[2] = c[2]; }

function fire(origin, dir, team, opts){
  if (!origin || !dir) return null;
  var dl = Math.sqrt(dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]);
  if (!(dl > 1e-6)) return null;
  var o = opts || {};
  var b = alloc();

  b.team = (team === 'player') ? 'player' : (team === 'neutral' ? 'neutral' : 'enemy');
  b.speed = (o.speed > 0) ? o.speed : DEF_SPEED;
  b.dmg = (typeof o.dmg === 'number') ? o.dmg : DEF_DMG;
  b.life = (o.life > 0) ? o.life : DEF_LIFE;
  b.owner = o.owner || null;
  b.deflected = false;
  b.pop = 0;                             /* a recycled slot must not inherit one */
  b.active = true;

  var sp = o.spread || 0;
  if (sp > 0.5) sp *= DEG;               /* caller handed us degrees */
  spreadDir(dir[0], dir[1], dir[2], sp, SD);
  b.vel[0] = SD[0] * b.speed;
  b.vel[1] = SD[1] * b.speed;
  b.vel[2] = SD[2] * b.speed;

  b.pos[0] = origin[0]; b.pos[1] = origin[1]; b.pos[2] = origin[2];
  setCol(b, o.color || (b.team === 'player' ? COL_PLAYER : COL_ENEMY));

  Blaster.stats.fired++;
  sparks(origin[0], origin[1], origin[2], 2, b.color);
  snd('blaster', origin[0], origin[1], origin[2], 1);
  return b;
}

/* ============================== parry flash ========================= */
/* A parry is the most heroic thing in the game and it lasted a couple of dozen
 * pixels. spawnFlash pins a flash to the CONTACT POINT ON THE BLADE (not to the
 * bolt, which is already leaving) and remembers the exit direction, so the flash
 * and the streak both point where the shot is going. Pooled: a flash never
 * allocates and never survives more than FLASH_T seconds. */
function spawnFlash(x, y, z, dx, dy, dz, col){
  var l = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!(l > 1e-6)){ dx = 0; dy = 0; dz = -1; l = 1; }
  var f = null, i, worst = 1e9;
  for (i = 0; i < FMAX; i++){
    var c = flashes[i];
    if (c.life <= 0){ f = c; break; }
    if (c.life < worst){ worst = c.life; f = c; }     /* else steal the faintest */
  }
  if (!f) return;
  f.life = FLASH_T;
  f.roll = 0.5 + (Blaster.stats.deflected % 5) * 0.31;   /* vary the diamond */
  f.x = x; f.y = y; f.z = z;
  f.dx = dx / l; f.dy = dy / l; f.dz = dz / l;
  var c2 = col || COL_PLAYER;
  f.cr = c2[0]; f.cg = c2[1]; f.cb = c2[2];
}

/* A screen-facing quad with an in-plane roll: the 2002 impact sprite, except the
 * sprite is the same unit cube squashed flat along the view axis. Rolled 45 deg
 * it is a diamond, which is the shape that says IMPACT at any size, and it costs
 * one draw. Built straight into the matrix: right/up span the screen. */
function billboard(m, s, roll, px, py, pz){
  var eye = JK.GL.eye;
  var fx = px - eye[0], fy = py - eye[1], fz = pz - eye[2];
  var fl = Math.sqrt(fx * fx + fy * fy + fz * fz);
  if (!(fl > 1e-4)){ fx = 0; fy = 0; fz = -1; fl = 1; }
  fx /= fl; fy /= fl; fz /= fl;
  var ux = 0, uy = 1, uz = 0;
  if (fy > 0.999 || fy < -0.999){ ux = 1; uy = 0; uz = 0; }
  var rx = uy * fz - uz * fy, ry = uz * fx - ux * fz, rz = ux * fy - uy * fx;
  var rl = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1;
  rx /= rl; ry /= rl; rz /= rl;
  var vx = fy * rz - fz * ry, vy = fz * rx - fx * rz, vz = fx * ry - fy * rx;
  var c = Math.cos(roll) * s, sn = Math.sin(roll) * s;
  m[0] = rx * c + vx * sn;  m[1] = ry * c + vy * sn;  m[2] = rz * c + vz * sn;  m[3] = 0;
  m[4] = -rx * sn + vx * c; m[5] = -ry * sn + vy * c; m[6] = -rz * sn + vz * c; m[7] = 0;
  m[8] = fx * 0.02; m[9] = fy * 0.02; m[10] = fz * 0.02; m[11] = 0;
  m[12] = px; m[13] = py; m[14] = pz; m[15] = 1;
}

function drawFlash(f){
  var p = 1 - f.life / FLASH_T;              /* 0 at contact -> 1 when spent */
  if (p < 0) p = 0; else if (p > 1) p = 1;
  var ip = 1 - p;

  /* 0. the impact sprite: a screen-facing diamond that blooms and fades. This is
   *    the element that makes the parry legible even when the return path runs
   *    straight away from the camera and every other cue is foreshortened. */
  var bloom = p < 0.35 ? p / 0.35 : 1;       /* snap open, then just fade */
  billboard(MTX, FL_DIA * (0.40 + 0.90 * bloom), f.roll,
            f.x + f.dx * FL_DIA_OFF, f.y + f.dy * FL_DIA_OFF, f.z + f.dz * FL_DIA_OFF);
  TG[0] = f.cr + (1 - f.cr) * 0.65; TG[1] = f.cg + (1 - f.cg) * 0.65;
  TG[2] = f.cb + (1 - f.cb) * 0.65;
  add(ip * ip * 0.85);

  /* 1. white-hot core: biggest on the contact frame, gone fast */
  var s = FL_CORE * (0.45 + 0.55 * ip);
  place(MTX, f.dx, f.dy, f.dz, s, s, s, f.x, f.y, f.z);
  TG[0] = COL_HOT[0]; TG[1] = COL_HOT[1]; TG[2] = COL_HOT[2];
  add(ip * ip * 0.95);

  /* 2. saber-coloured halo: expands as it fades, so the eye is pulled outward */
  s = FL_HALO * (0.6 + 0.9 * p);
  place(MTX, f.dx, f.dy, f.dz, s, s, s, f.x, f.y, f.z);
  TG[0] = f.cr; TG[1] = f.cg; TG[2] = f.cb;
  add(ip * 0.45);

  /* 3. two chunky spikes crossed ACROSS the exit direction — the 2002 impact
   *    star, made of the same box as everything else */
  var sl = FL_SPIKE_L * (0.35 + 0.65 * (p < 0.5 ? p * 2 : 1));
  var sw = FL_SPIKE_W * ip;
  if (sw > 0.004){
    place(MTX, f.dx, f.dy, f.dz, sl, sw, sw, f.x, f.y, f.z);
    add(ip * ip * 0.85);
    place(MTX, f.dx, f.dy, f.dz, sw, sl, sw, f.x, f.y, f.z);
    add(ip * ip * 0.85);
  }

  /* 4. the exit streak: a box that grows out of the contact point along the
   *    return path, core + fat halo. THIS is the "it went that way" cue. */
  var len = FL_STREAK_L * (0.25 + 0.75 * p);
  var w = FL_STREAK_W * (1 - 0.55 * p);
  var h = len * 0.5;
  place(MTX, f.dx, f.dy, f.dz, w, w, len,
        f.x + f.dx * h, f.y + f.dy * h, f.z + f.dz * h);
  add(ip * 0.85);
  place(MTX, f.dx, f.dy, f.dz, w * 3.2, w * 3.2, len * 0.92,
        f.x + f.dx * h, f.y + f.dy * h, f.z + f.dz * h);
  add(ip * 0.26);
}

/* ============================== deflection ========================== */
function swinging(){
  var S = JK.Sabers;
  if (S && typeof S.active === 'function' && S.active()) return true;
  var R = JK.Rig;
  if (R && typeof R.swingPhase === 'function' && R.swingPhase() >= 0) return true;
  return false;
}

function saberLit(){
  var R = JK.Rig;
  if (!R || !R.blades || !R.blades.length) return false;
  var p = R.player;
  if (p && p.saberOn === false) return false;   /* explicit ignite state wins */
  if (JK.Hero && JK.Hero.dead) return false;    /* dead men deflect nothing */
  return true;
}

function saberCol(){
  var R = JK.Rig;
  return (R && R.player && R.player.saberCol) ? R.player.saberCol : null;
}

/* Aim a just-deflected bolt at the nearest living enemy within TARGET_R.
 * Returns true if a target was found (SD holds the unit aim direction). */
function aimAtEnemy(x, y, z){
  var C = JK.Combat;
  if (!C || !C.ents) return false;
  var ents = C.ents, best = null, bd = TARGET_R * TARGET_R;
  for (var i = 0; i < ents.length; i++){
    var e = ents[i];
    if (!e || !e.pos || e.team === 'player' || e.hp <= 0) continue;
    var cy = e.pos[1] + (e.height || 1.8) * 0.6;
    var dx = e.pos[0] - x, dy = cy - y, dz = e.pos[2] - z;
    var d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < bd){ bd = d2; best = e; }
  }
  if (!best) return false;
  var dist = Math.sqrt(bd);
  /* A target sitting exactly ON the contact point would hand spreadDir a zero
   * vector, and spreadDir's `|| 1` fallbacks answer (0,0,0) rather than NaN —
   * a bolt with no velocity at all, which boltView culls (invisible) and which
   * then idles in place for its whole 3 s life. Refuse the target instead and
   * let the caller mirror off the blade, which is always well defined. */
  if (!(dist > 1e-3)) return false;
  var amt = DEFL_SCAT / dist;
  if (amt > DEFL_SPREAD) amt = DEFL_SPREAD;
  spreadDir(best.pos[0] - x,
            best.pos[1] + (best.height || 1.8) * 0.6 - y,
            best.pos[2] - z, amt, SD);
  return true;
}

/* Contact happened: bolt point (segS along the probe, the ENTRY point) vs blade
 * point (segT). Flip team, recolor, retarget — or mirror off the blade if there
 * is nothing worth hitting; entry sits exactly one blade radius off the blade,
 * so that mirror normal is always well conditioned. `frac` is how much of the
 * probe the bolt actually covers this substep (< 1 whenever the contact is in
 * the look-ahead zone); the bolt is never teleported past where it truly is. */
function doDeflect(b, ax, ay, az, bx, by, bz, bl, frac){
  var px = ax + (bx - ax) * segS;
  var py = ay + (by - ay) * segS;
  var pz = az + (bz - az) * segS;
  var qx = bl.base[0] + (bl.tip[0] - bl.base[0]) * segT;
  var qy = bl.base[1] + (bl.tip[1] - bl.base[1]) * segT;
  var qz = bl.base[2] + (bl.tip[2] - bl.base[2]) * segT;
  var f = segS < frac ? segS : frac;

  b.pos[0] = ax + (bx - ax) * f;
  b.pos[1] = ay + (by - ay) * f;
  b.pos[2] = az + (bz - az) * f;
  b.team = 'player';
  b.deflected = true;                 /* one deflection per bolt, ever */
  /* THE BOLT HAS CHANGED HANDS. `owner` is the never-self-hit guard for the
   * shooter, and it must not survive the parry: aimAtEnemy sends the shot at the
   * NEAREST enemy, which for a bolt parried at arm's length is almost always the
   * trooper who fired it. Leaving owner set aims the bolt straight at him and
   * then makes hitEnts skip him, so the return shot sails through the one target
   * the whole system exists to punish. Same reasoning in repel(). */
  b.owner = null;
  b.dmg = DEFL_DMG;
  b.speed = DEFL_SPEED;
  b.life = DEF_LIFE;                  /* fresh clock for the return trip */
  b.pop = POP_T;                      /* brief scale-up as it turns around */
  setCol(b, COL_PLAYER);

  if (!aimAtEnemy(px, py, pz)){
    /* nothing worth hitting: mirror the bolt about the blade contact normal */
    var nx = px - qx, ny = py - qy, nz = pz - qz;
    var nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (nl < 1e-4){
      /* dead centre on the blade: use blade x velocity as the bounce normal */
      var lx = bl.tip[0] - bl.base[0], ly = bl.tip[1] - bl.base[1], lz = bl.tip[2] - bl.base[2];
      nx = ly * b.vel[2] - lz * b.vel[1];
      ny = lz * b.vel[0] - lx * b.vel[2];
      nz = lx * b.vel[1] - ly * b.vel[0];
      nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (nl < 1e-4){ nx = 0; ny = 1; nz = 0; nl = 1; }
    }
    nx /= nl; ny /= nl; nz /= nl;
    NRM[0] = nx; NRM[1] = ny; NRM[2] = nz;
    var vd = b.vel[0] * nx + b.vel[1] * ny + b.vel[2] * nz;
    var rx = b.vel[0] - 2 * vd * nx;
    var ry = b.vel[1] - 2 * vd * ny + 0.15 * b.speed;   /* a touch of loft */
    var rz = b.vel[2] - 2 * vd * nz;
    spreadDir(rx, ry, rz, DEFL_SPREAD * 2, SD);
  }
  b.vel[0] = SD[0] * b.speed;
  b.vel[1] = SD[1] * b.speed;
  b.vel[2] = SD[2] * b.speed;

  /* THE FLASH BELONGS ON THE BLADE, NOT ON THE BOLT. Its direction is the
   * bolt's NEW velocity (set just above), so the spikes cross the return path
   * and the streak points down it. Particles are batched into a single draw call
   * by JK.Fx, so the extra sparks cost pixels, not calls. */
  Blaster.stats.deflected++;
  spawnFlash(qx, qy, qz, b.vel[0], b.vel[1], b.vel[2], saberCol());
  /* 22 sparks, not 40: JK.Fx's 256-particle pool is SHARED with droid explosions
   * and a parried 3-round burst already spends 66 of it. Particles are batched
   * into one draw call, so this costs pixels rather than calls either way. */
  sparks(qx, qy, qz, 14, saberCol());
  sparks(qx, qy, qz, 8, COL_PLAYER);
  snd('deflect', qx, qy, qz, 1);
}

/* Where the bolt's path ENTERS a swollen target, in metres along the probe,
 * given the closest approach a solver just measured: a ray enters one chord
 * half-length before its closest point. The closest point is not the contact —
 * and, crucially, the DIFFERENCE of two entry distances is a property of the
 * ray alone, so a comparison built on it answers the same at every frame rate
 * and every substep phase. `d2`/`r2` are squared distance and squared radius. */
function entryDist(s, len, r2, d2){
  var k = r2 - d2;
  return s * len - (k > 0 ? Math.sqrt(k) : 0);
}

/* Where the bolt's path enters the HERO's own capsule (1e9 when it misses him).
 * Exactly the capsule hitEnts uses, so the parry and the impact agree on where
 * the body is. Leaves its result in segS — call it BEFORE the blade loop. */
function heroEntry(ax, ay, az, dx, dy, dz, len){
  var e = JK.Hero && JK.Hero.ent;               /* optional sibling */
  if (!e || !e.pos || e.hp <= 0) return 1e9;
  var rr = (e.radius || 0.55) + BOLT_R;
  rr *= rr;
  var d2 = segCapDistSq(ax, ay, az, dx, dy, dz,
                        e.pos[0], e.pos[1], e.pos[1] + (e.height || 1.8), e.pos[2]);
  if (d2 > rr) return 1e9;
  return entryDist(segS, len, rr, d2);
}

/* Test one bolt substep against every blade of the player's saber. The segment
 * handed in is the substep extended by DEFL_PROBE; `frac` is the real portion
 * of it, so frac*len is the bolt's actual travel this substep.
 *
 * THE PARRY/BODY RACE. Both the blade and the hero's own capsule can sit on
 * this path, and "run the parry first, over a longer segment" is NOT the same
 * question as "which one does the bolt reach first". It made the outcome hinge
 * on whether each contact happened to fall inside the current substep, so the
 * substep GRID decided who won. Measured on a bolt fired from directly behind
 * the player — which must pass clean through him before any blade held in
 * front can be reached, so the body must always win — the parry fired on 68%
 * of spawn phases at 60 fps, 75% at 30 fps and 78% at 20 fps, and at a FIXED
 * 60 fps it flipped between parried and eaten as the spawn moved by 7 cm.
 *
 * Decide on ENTRY distance instead: the saber wins when it meets the bolt no
 * more than DEFL_LOOK metres after the body would have, which is exactly what
 * DEFL_LOOK was always meant to buy. Both entries are ray properties, so the
 * verdict is identical at every frame rate and every phase; and because the
 * accepted case always clears the parry's reach threshold at least as early as
 * the body clears the entity test, the parry still gets there first. A bolt
 * that has already gone through the player can no longer be saved by a blade
 * on the far side of him. */
function tryDeflect(b, ax, ay, az, bx, by, bz, frac){
  if (!saberLit()) return false;
  var P = JK.Player;
  if (!P || !P.pos) return false;
  var dx = bx - ax, dy = by - ay, dz = bz - az;
  var len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  var cx = P.pos[0], cy = P.pos[1] + 1.10, cz = P.pos[2];
  /* coarse reject: no point of the probe is within DEFL_NEAR of the chest */
  var mx = (ax + bx) * 0.5 - cx, my = (ay + by) * 0.5 - cy, mz = (az + bz) * 0.5 - cz;
  var mr = DEFL_NEAR + len * 0.5;
  if (mx * mx + my * my + mz * mz > mr * mr) return false;

  var hIn = heroEntry(ax, ay, az, dx, dy, dz, len);
  var reach = frac * len + DEFL_LOOK;     /* this substep's travel + head start */

  var blades = JK.Rig.blades;
  var rad = swinging() ? DEFL_R_SW : DEFL_R;
  var rr = rad * rad;
  var bestIn = 1e9, bestT = 0, best = null, i, d2, en;
  for (i = 0; i < blades.length; i++){
    var bl = blades[i];
    if (!bl || !bl.base || !bl.tip) continue;
    /* sanity: blades are filled in during Rig.draw — before the first draw they
       are still at the world origin. Only trust blades held near the player. */
    var hx = bl.base[0] - cx, hy = bl.base[1] - cy, hz = bl.base[2] - cz;
    if (hx * hx + hy * hy + hz * hz > BLADE_NEAR * BLADE_NEAR) continue;
    d2 = segSegDistSq(ax, ay, az, bx, by, bz,
                      bl.base[0], bl.base[1], bl.base[2],
                      bl.tip[0], bl.tip[1], bl.tip[2]);
    if (d2 > rr) continue;
    en = entryDist(segS, len, rr, d2);
    /* earliest contact wins, not the first entry of a dual/staff pair */
    if (en < bestIn){ bestIn = en; bestT = segT; best = bl; }
  }

  /* A swinging blade crosses metres between frames, and JK.Rig.blades only
   * holds where it was at the last draw. JK.Sabers publishes the swept quad
   * (prev base/tip -> cur base/tip) while a swing is damage-active, so test the
   * PREVIOUS blade position too — the parry window covers the whole arc. */
  var S = JK.Sabers;
  if (!best && rad === DEFL_R_SW && S && S.sweeps){
    for (i = 0; i < S.sweeps.length; i++){
      var sw = S.sweeps[i];
      if (!sw || !sw.pb || !sw.pt) continue;
      d2 = segSegDistSq(ax, ay, az, bx, by, bz,
                        sw.pb[0], sw.pb[1], sw.pb[2],
                        sw.pt[0], sw.pt[1], sw.pt[2]);
      if (d2 > rr) continue;
      en = entryDist(segS, len, rr, d2);
      if (en < bestIn){
        bestIn = en; bestT = segT;
        SWB.base[0] = sw.pb[0]; SWB.base[1] = sw.pb[1]; SWB.base[2] = sw.pb[2];
        SWB.tip[0] = sw.pt[0]; SWB.tip[1] = sw.pt[1]; SWB.tip[2] = sw.pt[2];
        best = SWB;
      }
    }
  }

  if (!best) return false;
  if (bestIn > reach) return false;             /* the blade is not there yet */
  if (bestIn > hIn + DEFL_LOOK) return false;   /* the body got there first */
  /* stash the contact for doDeflect: the bolt stops where it MEETS the blade */
  segS = (len > 1e-6 && bestIn > 0) ? bestIn / len : 0;
  segT = bestT;
  doDeflect(b, ax, ay, az, bx, by, bz, best, frac);
  return true;
}

/* ============================== impacts ============================= */
function hitEnts(b, ax, ay, az, bx, by, bz){
  var C = JK.Combat;
  if (!C || !C.ents) return false;
  var ents = C.ents;
  var dx = bx - ax, dy = by - ay, dz = bz - az;
  var segLen = Math.sqrt(dx * dx + dy * dy + dz * dz);
  var best = null, bestS = 2;
  for (var i = 0; i < ents.length; i++){
    var e = ents[i];
    if (!e || !e.pos || e.team === b.team || e.hp <= 0 || e === b.owner) continue;
    var er = e.radius || 0.5, eh = e.height || 1.8;
    var ecx = e.pos[0], ecz = e.pos[2], ecy = e.pos[1] + eh * 0.5;
    var rr = er + BOLT_R;
    /* coarse sphere reject around the segment start */
    var reach = segLen + rr + eh * 0.5;
    var fx = ecx - ax, fy = ecy - ay, fz = ecz - az;
    if (fx * fx + fy * fy + fz * fz > reach * reach) continue;
    if (segCapDistSq(ax, ay, az, dx, dy, dz, ecx, e.pos[1], e.pos[1] + eh, ecz) > rr * rr) continue;
    /* Two capsules can share one substep (bots keep only 1.6 m of separation
     * and a substep spans ~0.85 m plus both radii). The bolt must stop at the
     * one it reaches FIRST, not at whichever sits earlier in the registry —
     * that order shuffles every time unregister() swaps in the last entry. */
    if (segS < bestS){ bestS = segS; best = e; }
  }
  if (!best) return false;

  var px = ax + dx * bestS, py = ay + dy * bestS, pz = az + dz * bestS;
  var vl = Math.sqrt(b.vel[0] * b.vel[0] + b.vel[1] * b.vel[1] + b.vel[2] * b.vel[2]) || 1;
  DIRV[0] = b.vel[0] / vl; DIRV[1] = b.vel[1] / vl; DIRV[2] = b.vel[2] / vl;
  b.pos[0] = px; b.pos[1] = py; b.pos[2] = pz;
  Blaster.stats.hits++;
  sparks(px, py, pz, b.deflected ? 14 : 10, b.color);
  /* A RETURNED shot landing is the end of the parry's story, so it gets the same
   * flash the blade got — same pool, same 7 boxes, only for bolts the player sent
   * back. Aimed along the bolt's own heading so the streak sprays THROUGH the
   * victim: "that came off my saber and it went into him". */
  if (b.deflected) spawnFlash(px, py, pz, DIRV[0], DIRV[1], DIRV[2], COL_PLAYER);
  snd('boltHit', px, py, pz, 1);
  /* onHit last: a bot may die and unregister, which mutates ents underneath us */
  if (typeof best.onHit === 'function') best.onHit(b.dmg, DIRV, 'bolt', b.pos);
  return true;
}

function hitGround(b, bx, by, bz){
  var gy = groundY(bx, bz);
  if (by > gy) return false;
  sparks(bx, gy + 0.05, bz, 6, COL_SAND);
  sparks(bx, gy + 0.05, bz, 4, b.color);
  snd('boltHit', bx, gy, bz, 0.7);
  Blaster.stats.ground++;
  b.pos[0] = bx; b.pos[1] = gy; b.pos[2] = bz;
  return true;
}

/* ============================== stepping ============================ */
function stepBolt(b, dt){
  var vl = Math.sqrt(b.vel[0] * b.vel[0] + b.vel[1] * b.vel[1] + b.vel[2] * b.vel[2]);
  var ns = Math.ceil((vl * dt) / SUB_LEN);
  if (!(ns >= SUB_MIN)) ns = SUB_MIN;
  else if (ns > SUB_MAX) ns = SUB_MAX;
  var sdt = dt / ns;

  for (var s = 0; s < ns; s++){
    var ax = b.pos[0], ay = b.pos[1], az = b.pos[2];
    /* velocity can change mid-loop (deflection) — always re-read it */
    var bx = ax + b.vel[0] * sdt, by = ay + b.vel[1] * sdt, bz = az + b.vel[2] * sdt;

    /* Parry first, probing DEFL_PROBE metres further down the path so the blade
     * can beat the hero's own hitbox to a chest shot. tryDeflect only ACTS on
     * the first DEFL_LOOK of that; the rest is headroom for its entry-distance
     * maths. `frac` keeps the bolt from being teleported into the probe zone. */
    if (b.team !== 'player' && !b.deflected){
      var sl = Math.sqrt((bx - ax) * (bx - ax) + (by - ay) * (by - ay) + (bz - az) * (bz - az));
      var ex = bx, ey = by, ez = bz, frac = 1;
      if (sl > 1e-6){
        var k = (sl + DEFL_PROBE) / sl;
        ex = ax + (bx - ax) * k; ey = ay + (by - ay) * k; ez = az + (bz - az) * k;
        frac = 1 / k;
      }
      if (tryDeflect(b, ax, ay, az, ex, ey, ez, frac))
        continue;                     /* bolt stays where it is, newly re-aimed */
    }

    if (hitEnts(b, ax, ay, az, bx, by, bz)){ kill(b); return; }
    if (hitGround(b, bx, by, bz)){ kill(b); return; }

    b.pos[0] = bx; b.pos[1] = by; b.pos[2] = bz;
  }

  var lim = ((JK.Terrain && JK.Terrain.SIZE) || 350) + WORLD_PAD;
  if (b.pos[0] < -lim || b.pos[0] > lim || b.pos[2] < -lim || b.pos[2] > lim ||
      b.pos[1] > 400) kill(b);
}

/* ============================== repel =============================== */
function repel(pos, dir){
  if (!pos || !dir) return 0;
  var dl = Math.sqrt(dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]);
  if (!(dl > 1e-6)) return 0;
  var fx = dir[0] / dl, fy = dir[1] / dl, fz = dir[2] / dl;
  var n = 0, lx = 0, ly = 0, lz = 0;
  for (var i = 0; i < MAXB; i++){
    var b = pool[i];
    if (!b.active || b.team === 'player') continue;
    var dx = b.pos[0] - pos[0], dy = b.pos[1] - pos[1], dz = b.pos[2] - pos[2];
    var d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > REPEL_R * REPEL_R) continue;
    var d = Math.sqrt(d2);
    if (d > 0.05 && (dx * fx + dy * fy + dz * fz) / d < REPEL_COS) continue;

    b.team = 'player';
    b.deflected = true;               /* spent: never deflectable again */
    b.owner = null;                   /* changed hands — the shooter is fair game */
    b.dmg = b.dmg > DEFL_DMG ? b.dmg : DEFL_DMG;
    b.speed = b.speed > REPEL_SPEED ? b.speed : REPEL_SPEED;
    b.life = DEF_LIFE;
    b.pop = POP_T;                    /* same "it just turned" pop as a parry */
    setCol(b, COL_PLAYER);
    spreadDir(fx, fy, fz, REPEL_SPRD, SD);
    b.vel[0] = SD[0] * b.speed; b.vel[1] = SD[1] * b.speed; b.vel[2] = SD[2] * b.speed;
    spawnFlash(b.pos[0], b.pos[1], b.pos[2], SD[0], SD[1], SD[2], COL_PLAYER);
    sparks(b.pos[0], b.pos[1], b.pos[2], 8, COL_PLAYER);
    lx = b.pos[0]; ly = b.pos[1]; lz = b.pos[2];
    n++;
  }
  if (n){
    Blaster.stats.deflected += n;
    snd('deflect', lx, ly, lz, 1);
  }
  return n;
}

/* ============================== drawing ============================= */
function buildBatches(){
  if (bAdd || !JK.GL || !JK.GL.dynamic) return;
  bCore = mkBatch(CORE_BOXES);
  bAdd  = mkBatch(ADD_BOXES);
}
function mkBatch(nb){
  var idx = new Uint16Array(nb * 36), i, j;
  for (i = 0; i < nb; i++){
    var vb = i * 8, ib = i * 36;
    for (j = 0; j < 36; j++) idx[ib + j] = vb + CUBE_TRI[j];
  }
  var h = JK.GL.dynamic(nb * 8, { idx: idx });
  var v = h.v;                        /* normals: unused (emissive), set once */
  for (i = 3; i < v.length; i += 9){ v[i] = 0; v[i + 1] = 1; v[i + 2] = 0; }
  return h;
}

/* Queue one box into batch `h` from a model matrix built by place()/billboard()
 * (cols X, Y, Z, T; the local box is the unit cube centred on the origin), with
 * the colour folded to rgb*alpha so nothing per-box reaches a uniform. */
function emitBox(h, m, r, g, b, a){
  if (!h || h.n + 8 > h.max || !(a > 0)) return;   /* full or invisible: drop */
  var e0x = m[0] * 0.5, e0y = m[1] * 0.5, e0z = m[2] * 0.5;
  var e1x = m[4] * 0.5, e1y = m[5] * 0.5, e1z = m[6] * 0.5;
  var e2x = m[8] * 0.5, e2y = m[9] * 0.5, e2z = m[10] * 0.5;
  var cx = m[12], cy = m[13], cz = m[14];
  r *= a; g *= a; b *= a;
  var V = h.v, o = h.n * 9;
  for (var q = 0; q < 8; q++){        /* sign bits: 1=+x, 2=+y, 4=+z */
    var sx = (q & 1) ? 1 : -1, sy = (q & 2) ? 1 : -1, sz = (q & 4) ? 1 : -1;
    V[o]     = cx + sx * e0x + sy * e1x + sz * e2x;
    V[o + 1] = cy + sx * e0y + sy * e1y + sz * e2y;
    V[o + 2] = cz + sx * e0z + sy * e1z + sz * e2z;
    V[o + 6] = r; V[o + 7] = g; V[o + 8] = b;      /* o+3..o+5: normal, fixed */
    o += 9;
  }
  h.n += 8; h.ni += 36;
}
/* queue MTX into the additive batch tinted by TG at alpha `a` */
function add(a){ emitBox(bAdd, MTX, TG[0], TG[1], TG[2], a); }

/* Build an orientation+scale+translation matrix whose local +Z runs along the
 * bolt's velocity. The exactly-vertical case would make cross(up, f) vanish, so
 * the reference up flips to +X there. Column-major: cols = right, up, fwd. */
function place(m, fx, fy, fz, sx, sy, sz, px, py, pz){
  var ux = 0, uy = 1, uz = 0;
  if (fy > 0.999 || fy < -0.999){ ux = 1; uy = 0; uz = 0; }
  var rx = uy * fz - uz * fy, ry = uz * fx - ux * fz, rz = ux * fy - uy * fx;
  var rl = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1;
  rx /= rl; ry /= rl; rz /= rl;
  var vx = fy * rz - fz * ry, vy = fz * rx - fx * rz, vz = fx * ry - fy * rx;
  m[0] = rx * sx; m[1] = ry * sx; m[2] = rz * sx; m[3] = 0;
  m[4] = vx * sy; m[5] = vy * sy; m[6] = vz * sy; m[7] = 0;
  m[8] = fx * sz; m[9] = fy * sz; m[10] = fz * sz; m[11] = 0;
  m[12] = px; m[13] = py; m[14] = pz; m[15] = 1;
}

/* Fills SD with the unit heading and returns the squared eye distance, or -1
 * when the bolt should not be drawn at all. */
function boltView(b){
  var vl = Math.sqrt(b.vel[0] * b.vel[0] + b.vel[1] * b.vel[1] + b.vel[2] * b.vel[2]);
  if (!(vl > 1e-6)) return -1;
  SD[0] = b.vel[0] / vl; SD[1] = b.vel[1] / vl; SD[2] = b.vel[2] / vl;
  var eye = JK.GL.eye;
  var ex = b.pos[0] - eye[0], ey = b.pos[1] - eye[1], ez = b.pos[2] - eye[2];
  var d2 = ex * ex + ey * ey + ez * ez;
  return d2 > FAR_DRAW * FAR_DRAW ? -1 : d2;
}

/* A returned bolt is the pay-off of the whole system, so it is drawn as a
 * heavier object than the shot that came in: wider, longer, hotter-cored, plus a
 * short scale-up "pop" over the frames it turns around. Both multipliers land in
 * VW / VL, which the two passes below share, so a bolt's core and its shells can
 * never disagree about how big it is. */
var VW = 1, VL = 1;
function boltScale(b){
  VW = b.deflected ? DEFL_VIS_W : 1;
  VL = b.deflected ? DEFL_VIS_L : 1;
  if (b.pop > 0){
    var k = b.pop / POP_T;
    VW *= 1 + POP_W * k;
    VL *= 1 + POP_L * k;
  }
}

function draw(){
  if (!bAdd) return;
  var GL = JK.GL, i, b, d2, half, len;
  GL.reset(bCore); GL.reset(bAdd);   /* counts decide what draws: never stale */
  if (nActive === 0 && nFlash === 0) return;

  /* opaque cores first so they occlude correctly... */
  for (i = 0; i < MAXB; i++){
    b = pool[i];
    if (!b.active) continue;
    d2 = boltView(b);
    if (d2 < 0) continue;
    boltScale(b);
    len = BOLT_LEN * VL; half = len * 0.5;
    var mix = b.deflected ? DEFL_MIX : CORE_MIX;
    TC[0] = b.color[0] + (1 - b.color[0]) * mix;
    TC[1] = b.color[1] + (1 - b.color[1]) * mix;
    TC[2] = b.color[2] + (1 - b.color[2]) * mix;
    place(MTX, SD[0], SD[1], SD[2], CORE_W * VW, CORE_W * VW, len,
          b.pos[0] - SD[0] * half, b.pos[1] - SD[1] * half, b.pos[2] - SD[2] * half);
    emitBox(bCore, MTX, TC[0], TC[1], TC[2], 1);
  }

  /* ...then every additive shell in one blend-state block */
  for (i = 0; i < MAXB; i++){
    b = pool[i];
    if (!b.active) continue;
    d2 = boltView(b);
    if (d2 < 0) continue;
    boltScale(b);
    len = BOLT_LEN * VL; half = len * 0.5;
    TG[0] = b.color[0]; TG[1] = b.color[1]; TG[2] = b.color[2];
    place(MTX, SD[0], SD[1], SD[2], GLOW1_W * VW, GLOW1_W * VW, len,
          b.pos[0] - SD[0] * half, b.pos[1] - SD[1] * half, b.pos[2] - SD[2] * half);
    add(GLOW1_A);
    if (d2 < FAR_HALO * FAR_HALO){
      place(MTX, SD[0], SD[1], SD[2], GLOW2_W * VW, GLOW2_W * VW, len * GLOW2_LEN,
            b.pos[0] - SD[0] * half, b.pos[1] - SD[1] * half, b.pos[2] - SD[2] * half);
      add(GLOW2_A);
      if (b.deflected && b.pop <= 0){
        /* WAKE: one faint box stretched back down the flight path, so the return
         * shot reads as MOTION rather than as a dot. +1 box, deflected only.
         * Held back until the pop is over: on the contact frames the wake points
         * back at the CAMERA (the bolt has only just turned), and a 0.5 m wide
         * box aimed down the lens is a slab over a quarter of the screen, not a
         * trail. By the time it draws, the bolt is genuinely travelling. */
        var wbase = BOLT_LEN * DEFL_VIS_L, wl = wbase * WAKE_LEN;
        var ww = GLOW1_W * WAKE_W * DEFL_VIS_W;
        var wh = wl * 0.5 - wbase * 0.5;
        TG[0] = b.color[0]; TG[1] = b.color[1]; TG[2] = b.color[2];
        place(MTX, SD[0], SD[1], SD[2], ww, ww, wl,
              b.pos[0] - SD[0] * wh, b.pos[1] - SD[1] * wh, b.pos[2] - SD[2] * wh);
        add(WAKE_A);
      }
    }
  }

  /* the parry flashes ride along in the same additive batch */
  for (i = 0; i < FMAX; i++) if (flashes[i].life > 0) drawFlash(flashes[i]);

  /* TWO calls for the whole system: cores (opaque, they write depth) then every
   * shell, wake and flash. No trailing state-restore draw — JK.GL.beginFrame
   * puts depthMask(true) back before it clears, so leaving GL additive here is
   * harmless (JK.Fx and JK.ForceFx rely on exactly the same thing). */
  if (bCore.ni) GL.draw(bCore, null, CORE_BO);
  if (bAdd.ni) GL.draw(bAdd, null, ADD_BO);
}

/* ============================== module ============================== */
var Blaster = JK.Blaster = {
  bolts: pool,                        /* read-only by convention */
  MAX: MAXB,
  stats: { fired: 0, deflected: 0, hits: 0, ground: 0 },

  fire: fire,
  repel: repel,
  count: function(){ return nActive; },

  clear: function(){
    var i;
    for (i = 0; i < MAXB; i++){
      pool[i].active = false; pool[i].owner = null; pool[i].pop = 0;
    }
    for (i = 0; i < FMAX; i++) flashes[i].life = 0;
    nActive = 0; nFlash = 0;
  },

  init: function(){
    buildBatches();
    Blaster.clear();
    cursor = 0;
    Blaster.stats.fired = Blaster.stats.deflected = 0;
    Blaster.stats.hits = Blaster.stats.ground = 0;
  },

  update: function(dt, t){
    var n = 0, i;
    for (i = 0; i < MAXB; i++){
      var b = pool[i];
      if (!b.active) continue;
      b.life -= dt;
      if (b.life <= 0){ kill(b); continue; }   /* kill() also drops b.owner */
      if (b.pop > 0){ b.pop -= dt; if (b.pop < 0) b.pop = 0; }
      stepBolt(b, dt);                /* may set pop again (a fresh deflection) */
      if (b.active) n++;
    }
    nActive = n;                      /* authoritative resync each frame */
    n = 0;
    for (i = 0; i < FMAX; i++){       /* age the parry flashes */
      var f = flashes[i];
      if (f.life <= 0) continue;
      f.life -= dt;
      /* `<= 0`, not `< 0`: a flash landing exactly on zero is dead — drawFlash
       * skips it — so counting it kept draw() awake for a frame with nothing
       * in it. Same predicate here and at the draw site. */
      if (f.life <= 0) f.life = 0;
      else n++;
    }
    nFlash = n;
  },

  draw: draw
};
})();
