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
 *     life, team, dmg, speed, active, deflected, owner }
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
 * anywhere near the bolt's path sends it back, which is the fun answer.
 *
 * Zero per-frame allocations: the pool, all scratch vectors, matrices and draw
 * option objects live at module scope. JK.GL.mesh is STATIC_DRAW — ONE unit
 * cube is built at init and every bolt is placed with a per-draw model matrix.
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
var DEFL_LOOK   = 0.75;     /* m, the parry test peeks this far down the bolt's
                             * path. Without it a bolt aimed at the chest clips
                             * the hero's 0.55 m capsule BEFORE it comes within
                             * blade radius, and the body eats a shot the saber
                             * was clearly in position to take. The saber gets
                             * the last word — that is the whole fantasy. */
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
var CORE_MIX    = 0.55;     /* how far the core tint lerps toward white */
var WORLD_PAD   = 60;       /* m past Terrain.SIZE before a bolt is discarded */
var DEG         = Math.PI / 180;

/* ============================== pool ================================ */
var pool = new Array(MAXB);
(function(){
  for (var i = 0; i < MAXB; i++){
    pool[i] = {
      pos: new Float32Array(3),
      vel: new Float32Array(3),
      color: new Float32Array(3),
      life: 0, team: 'enemy', dmg: DEF_DMG, speed: DEF_SPEED,
      active: false, deflected: false, owner: null
    };
  }
})();
var cursor = 0, nActive = 0;

/* ============================== scratch ============================= */
var MTX   = M.make();               /* per-draw model matrix */
var DIRV  = new Float32Array(3);    /* hit direction handed to onHit */
var SD    = new Float32Array(3);    /* spread/aim result */
var IMP   = new Float32Array(3);    /* impact point */
var NRM   = new Float32Array(3);    /* mirror normal */
var SWB   = { base: new Float32Array(3), tip: new Float32Array(3) };  /* swept blade */
var TC    = new Float32Array(3);    /* core tint */
var TG    = new Float32Array(3);    /* glow tint */
var CORE_O  = { emissive: 1, nofog: true, tint: TC };
var GLOW1_O = { emissive: 1, nofog: true, additive: true, alpha: GLOW1_A, tint: TG };
var GLOW2_O = { emissive: 1, nofog: true, additive: true, alpha: GLOW2_A, tint: TG };
var FLAT_O  = {};                   /* opaque state-restore draw */
var mesh = null;                    /* ONE shared unit cube */

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

/* Contact happened: bolt point (segS along the tested segment) vs blade point
 * (segT). Flip team, recolor, retarget — or mirror off the blade if there is
 * nothing worth hitting. `frac` is how much of the tested segment the bolt
 * actually covers this substep (< 1 when the contact is in the look-ahead
 * zone); the bolt is never teleported past where it truly is. */
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

  /* the flash belongs ON the blade, not on the bolt */
  Blaster.stats.deflected++;
  sparks(qx, qy, qz, 12, saberCol());
  sparks(qx, qy, qz, 5, COL_PLAYER);
  snd('deflect', qx, qy, qz, 1);
}

/* Test one bolt substep segment (already extended by DEFL_LOOK) against every
 * blade of the player's saber. `frac` = the real portion of that segment. */
function tryDeflect(b, ax, ay, az, bx, by, bz, frac){
  if (!saberLit()) return false;
  var P = JK.Player;
  if (!P || !P.pos) return false;
  var cx = P.pos[0], cy = P.pos[1] + 1.10, cz = P.pos[2];
  var mx = (ax + bx) * 0.5 - cx, my = (ay + by) * 0.5 - cy, mz = (az + bz) * 0.5 - cz;
  if (mx * mx + my * my + mz * mz > DEFL_NEAR * DEFL_NEAR) return false;

  var blades = JK.Rig.blades;
  var rad = swinging() ? DEFL_R_SW : DEFL_R;
  var rr = rad * rad;
  for (var i = 0; i < blades.length; i++){
    var bl = blades[i];
    if (!bl || !bl.base || !bl.tip) continue;
    /* sanity: blades are filled in during Rig.draw — before the first draw they
       are still at the world origin. Only trust blades held near the player. */
    var hx = bl.base[0] - cx, hy = bl.base[1] - cy, hz = bl.base[2] - cz;
    if (hx * hx + hy * hy + hz * hz > BLADE_NEAR * BLADE_NEAR) continue;
    if (segSegDistSq(ax, ay, az, bx, by, bz,
                     bl.base[0], bl.base[1], bl.base[2],
                     bl.tip[0], bl.tip[1], bl.tip[2]) <= rr){
      doDeflect(b, ax, ay, az, bx, by, bz, bl, frac);
      return true;
    }
  }

  /* A swinging blade crosses metres between frames, and JK.Rig.blades only
   * holds where it was at the last draw. JK.Sabers publishes the swept quad
   * (prev base/tip -> cur base/tip) while a swing is damage-active, so test the
   * PREVIOUS blade position too — the parry window covers the whole arc. */
  var S = JK.Sabers;
  if (rad === DEFL_R_SW && S && S.sweeps){
    for (i = 0; i < S.sweeps.length; i++){
      var sw = S.sweeps[i];
      if (!sw || !sw.pb || !sw.pt) continue;
      if (segSegDistSq(ax, ay, az, bx, by, bz,
                       sw.pb[0], sw.pb[1], sw.pb[2],
                       sw.pt[0], sw.pt[1], sw.pt[2]) <= rr){
        SWB.base[0] = sw.pb[0]; SWB.base[1] = sw.pb[1]; SWB.base[2] = sw.pb[2];
        SWB.tip[0] = sw.pt[0]; SWB.tip[1] = sw.pt[1]; SWB.tip[2] = sw.pt[2];
        doDeflect(b, ax, ay, az, bx, by, bz, SWB, frac);
        return true;
      }
    }
  }
  return false;
}

/* ============================== impacts ============================= */
function hitEnts(b, ax, ay, az, bx, by, bz){
  var C = JK.Combat;
  if (!C || !C.ents) return false;
  var ents = C.ents;
  var dx = bx - ax, dy = by - ay, dz = bz - az;
  var segLen = Math.sqrt(dx * dx + dy * dy + dz * dz);
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

    var px = ax + dx * segS, py = ay + dy * segS, pz = az + dz * segS;
    var vl = Math.sqrt(b.vel[0] * b.vel[0] + b.vel[1] * b.vel[1] + b.vel[2] * b.vel[2]) || 1;
    DIRV[0] = b.vel[0] / vl; DIRV[1] = b.vel[1] / vl; DIRV[2] = b.vel[2] / vl;
    b.pos[0] = px; b.pos[1] = py; b.pos[2] = pz;
    Blaster.stats.hits++;
    sparks(px, py, pz, b.deflected ? 14 : 10, b.color);
    snd('boltHit', px, py, pz, 1);
    if (typeof e.onHit === 'function') e.onHit(b.dmg, DIRV, 'bolt', b.pos);
    return true;
  }
  return false;
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

    /* Parry first, and peek DEFL_LOOK metres further down the path so the blade
     * beats the hero's own hitbox to a chest shot. `frac` keeps the bolt from
     * being teleported into the look-ahead zone. */
    if (b.team !== 'player' && !b.deflected){
      var sl = Math.sqrt((bx - ax) * (bx - ax) + (by - ay) * (by - ay) + (bz - az) * (bz - az));
      var ex = bx, ey = by, ez = bz, frac = 1;
      if (sl > 1e-6){
        var k = (sl + DEFL_LOOK) / sl;
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
    setCol(b, COL_PLAYER);
    spreadDir(fx, fy, fz, REPEL_SPRD, SD);
    b.vel[0] = SD[0] * b.speed; b.vel[1] = SD[1] * b.speed; b.vel[2] = SD[2] * b.speed;
    sparks(b.pos[0], b.pos[1], b.pos[2], 6, COL_PLAYER);
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

function draw(){
  if (!mesh || nActive === 0) return;
  var GL = JK.GL, i, b, d2, half;

  /* opaque cores first so they occlude correctly... */
  for (i = 0; i < MAXB; i++){
    b = pool[i];
    if (!b.active) continue;
    d2 = boltView(b);
    if (d2 < 0) continue;
    half = BOLT_LEN * 0.5;
    TC[0] = b.color[0] + (1 - b.color[0]) * CORE_MIX;
    TC[1] = b.color[1] + (1 - b.color[1]) * CORE_MIX;
    TC[2] = b.color[2] + (1 - b.color[2]) * CORE_MIX;
    place(MTX, SD[0], SD[1], SD[2], CORE_W, CORE_W, BOLT_LEN,
          b.pos[0] - SD[0] * half, b.pos[1] - SD[1] * half, b.pos[2] - SD[2] * half);
    GL.draw(mesh, MTX, CORE_O);
  }

  /* ...then every additive shell in one blend-state block */
  for (i = 0; i < MAXB; i++){
    b = pool[i];
    if (!b.active) continue;
    d2 = boltView(b);
    if (d2 < 0) continue;
    half = BOLT_LEN * 0.5;
    TG[0] = b.color[0]; TG[1] = b.color[1]; TG[2] = b.color[2];
    place(MTX, SD[0], SD[1], SD[2], GLOW1_W, GLOW1_W, BOLT_LEN,
          b.pos[0] - SD[0] * half, b.pos[1] - SD[1] * half, b.pos[2] - SD[2] * half);
    GL.draw(mesh, MTX, GLOW1_O);
    if (d2 < FAR_HALO * FAR_HALO){
      place(MTX, SD[0], SD[1], SD[2], GLOW2_W, GLOW2_W, BOLT_LEN * GLOW2_LEN,
            b.pos[0] - SD[0] * half, b.pos[1] - SD[1] * half, b.pos[2] - SD[2] * half);
      GL.draw(mesh, MTX, GLOW2_O);
    }
  }

  /* additive draws left depthMask(false); restore with one zero-scale opaque
   * draw (rasterizes nothing) so later systems and the next depth clear work. */
  M.ident(MTX); M.sc(MTX, 0, 0, 0);
  GL.draw(mesh, MTX, FLAT_O);
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
    for (var i = 0; i < MAXB; i++){ pool[i].active = false; pool[i].owner = null; }
    nActive = 0;
  },

  init: function(){
    if (!mesh && JK.GL && JK.GL.mesh) mesh = JK.GL.mesh(JK.Geo.box(1, 1, 1, 1, 1, 1));
    Blaster.clear();
    cursor = 0;
    Blaster.stats.fired = Blaster.stats.deflected = 0;
    Blaster.stats.hits = Blaster.stats.ground = 0;
  },

  update: function(dt, t){
    var n = 0;
    for (var i = 0; i < MAXB; i++){
      var b = pool[i];
      if (!b.active) continue;
      b.life -= dt;
      if (b.life <= 0){ kill(b); continue; }   /* kill() also drops b.owner */
      stepBolt(b, dt);
      if (b.active) n++;
    }
    nActive = n;                      /* authoritative resync each frame */
  },

  draw: draw
};
})();
