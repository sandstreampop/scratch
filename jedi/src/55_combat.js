/* JK.Combat + JK.Fx — entity registry, swept-saber hit detection, particle
 * pool, and 3 training droids. Owner: combat agent (55_combat.js).
 *
 * LIFECYCLE: 90_main's SYSTEMS list contains 'Fx' (not 'Combat'), so JK.Fx owns
 * init/update/draw and drives JK.Combat.update() itself. Fx updates AFTER
 * Sabers, so player sweeps are fresh; Bots update BEFORE Fx, so bot-sourced
 * hitTest calls (iteration 4) land the same frame they swing.
 *
 * JK.Combat:
 *   register(ent) / unregister(ent)
 *     ent contract: { pos:[x,y,z] (feet), radius, height, hp,
 *                     team:'player'|'enemy'|'neutral', onHit(dmg, dir3, kind) }
 *     Extras this impl provides: onHit receives a 4th arg hitPos [x,y,z]
 *     (impact point on the blade, also mirrored at JK.Combat.hitPos), and
 *     JK.Combat.hitKnock holds the sweep's knockback (m/s) during the call.
 *     Entities with hp <= 0 are skipped (dead things don't eat swings).
 *   hitTest(sweep, attackId, attackerTeam, channel) -> number of entities hit
 *     REUSABLE BY THE BOTS ITERATION: a bot builds/borrows a sweep object
 *     {pb,pt,cb,ct,dmg,knock,name} from its own rig.blades (prev/cur frame)
 *     and calls JK.Combat.hitTest(sweep, botSwingCounter, 'enemy', botChannel)
 *     every damage-active frame. channel is a small int unique per attacker
 *     (player = 0, bots use 1..127); dedupe key = channel*2^26 + attackId, so
 *     each (attacker swing, entity) pair lands onHit exactly ONCE. Bots should
 *     also register the PLAYER as an entity (team 'player') so their sweeps
 *     can hurt him; JK.Combat.ents is exposed (read-only) for targeting scans.
 *   update(dt, t)  — runs every player sweep in JK.Sabers.sweeps through
 *     hitTest (guarded: fine while the sabers agent is mid-build).
 *   swingId — mirrors JK.Sabers.attackId (increments once per player swing).
 *   lastHit — {dmg, t, name} updated on every PLAYER-sourced hit (Ui reads).
 *
 * JK.Fx: preallocated 256-particle pool, one shared emissive cube drawn per
 * live particle with additive blending, model matrix from module scratch.
 *   sparks(pos, n, color)   — impact sparks: gravity, quick fade
 *   burst(pos, n, color)    — explosion: big box shards that bounce on sand
 *   shimmer(pos, n, color)  — rising twinkle column (droid respawn)
 * color = [r,g,b] 0..1 or null for the kind's default. Zero alloc per frame.
 */
(function(){
'use strict';
var M = JK.M;

/* ============================ tuning ============================ */
var BLADE_R   = 0.12;      /* effective blade thickness for hits (m) */
var NT        = 5;         /* time slices per sweep — see tunneling note */
var CHAN_MUL  = 67108864;  /* 2^26: dedupe key = channel*2^26 + attackId */
var PMAX      = 256;       /* particle pool size (contract) */
var DROID_HP  = 60;
var RESPAWN_T = 3.0;       /* s */
var HOVER     = 1.4;       /* droid centre above ground (m) */

function groundY(x, z){
  var T = JK.Terrain;
  return (T && T.height) ? T.height(x, z) : 0;
}

/* ============================ JK.Fx: particle pool ========================= */
/* Parallel-free: preallocated records, live-prefix compaction by swap. */
var parts = new Array(PMAX);
(function(){
  for (var i = 0; i < PMAX; i++)
    parts[i] = { x:0, y:0, z:0, vx:0, vy:0, vz:0, life:0, max:1,
                 r:1, g:1, b:1, size:0.05, grav:9, spin:0, bounce:0, tw:0, ph:0 };
})();
var liveN = 0;
var meshBox = null;                       /* ONE shared 1 m cube, scaled per particle */

var FT  = new Float32Array([1, 1, 1]);    /* per-particle tint scratch */
var FXO = { emissive: 1, additive: true, nofog: true, alpha: 1, tint: FT };
var MTX = M.make();                       /* module-scope model matrix scratch */

/* kind 0 = sparks, 1 = burst shards, 2 = shimmer */
var DEF_COL = [[1, 0.86, 0.45], [0.95, 0.58, 0.28], [0.55, 0.85, 1.0]];

function emit(pos, n, col, kind){
  if (!pos) return;
  var c = col || DEF_COL[kind];
  for (var i = 0; i < n; i++){
    if (liveN >= PMAX) return;            /* pool full: drop the rest */
    var p = parts[liveN++];
    /* random direction on the unit sphere */
    var up = Math.random() * 2 - 1;
    var az = Math.random() * 6.2831853;
    var h  = Math.sqrt(1 - up * up);
    var dx = h * Math.cos(az), dy = up, dz = h * Math.sin(az);
    var r1 = Math.random(), r2 = Math.random();
    p.x = pos[0]; p.y = pos[1]; p.z = pos[2];
    p.r = c[0]; p.g = c[1]; p.b = c[2];
    p.ph = r2 * 6.28;
    if (kind === 1){                      /* explosion shards: big, bouncy */
      var sb = 2.0 + 4.5 * r1;
      p.vx = dx * sb; p.vy = dy * sb + 3.0; p.vz = dz * sb;
      p.life = p.max = 0.55 + 0.75 * r2;
      p.size = 0.07 + 0.16 * Math.random();
      p.grav = 9; p.spin = 9 * (r1 - 0.5); p.bounce = 1; p.tw = 0;
    } else if (kind === 2){               /* shimmer: gentle rise + twinkle */
      p.vx = dx * 0.5; p.vy = 0.7 + 1.1 * r1; p.vz = dz * 0.5;
      p.life = p.max = 0.5 + 0.7 * r2;
      p.size = 0.024 + 0.035 * Math.random();
      p.grav = -0.6; p.spin = 4 * (r1 - 0.5); p.bounce = 0; p.tw = 1;
    } else {                              /* sparks: fast, hot, short */
      var ss = 2.0 + 3.5 * r1;
      p.vx = dx * ss; p.vy = dy * ss + 2.0; p.vz = dz * ss;
      p.life = p.max = 0.22 + 0.35 * r2;
      p.size = 0.028 + 0.04 * Math.random();
      p.grav = 10; p.spin = 14 * (r1 - 0.5); p.bounce = 0; p.tw = 0;
    }
  }
}

function updateParticles(dt){
  var i = 0;
  while (i < liveN){
    var p = parts[i];
    p.life -= dt;
    if (p.life <= 0){                     /* kill: swap-with-last, retest slot */
      liveN--;
      parts[i] = parts[liveN];
      parts[liveN] = p;
      continue;
    }
    p.vy -= p.grav * dt;
    p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
    if (p.bounce && p.vy < 0){            /* shards bounce off the dunes */
      var gy = groundY(p.x, p.z) + p.size * 0.5;
      if (p.y < gy){
        p.y = gy;
        p.vy *= -0.42; p.vx *= 0.72; p.vz *= 0.72;
      }
    }
    i++;
  }
}

function drawParticles(){
  if (!meshBox) return;
  var GL = JK.GL;
  for (var i = 0; i < liveN; i++){
    var p = parts[i];
    var k = p.life / p.max;               /* 1 -> 0 over lifetime */
    var age = p.max - p.life;
    M.ident(MTX);
    M.tr(MTX, p.x, p.y, p.z);
    if (p.spin !== 0){ M.ry(MTX, age * p.spin); M.rx(MTX, age * p.spin * 0.7); }
    var s = p.size * (0.35 + 0.65 * k);   /* shrink as it dies */
    M.sc(MTX, s, s, s);
    FT[0] = p.r; FT[1] = p.g; FT[2] = p.b;
    var a = k;
    if (p.tw) a *= 0.55 + 0.45 * Math.sin(age * 26 + p.ph);
    FXO.alpha = a;
    GL.draw(meshBox, MTX, FXO);
  }
}

/* ============================ JK.Combat ==================================== */
var ents = [];
var nowT = 0;
var DIR  = new Float32Array(3);           /* scratch: hit direction */
var HITP = new Float32Array(3);           /* scratch: impact point on blade */
var lastS = 0;                            /* stash: blade param of closest point */

function clamp01(v){ return v < 0 ? 0 : (v > 1 ? 1 : v); }

/* Exact closest-distance^2 between the blade segment b + s*d (s in 0..1) and
 * the entity's VERTICAL capsule axis (x=cx, z=cz, y in y0..y1). Standard
 * two-segment closest-point (Ericson 5.1.9) specialised for d2 = (0,y1-y0,0).
 * Stashes the blade parameter in lastS so the caller can place sparks. */
function segCapDistSq(bx, by, bz, dx, dy, dz, cx, y0, y1, cz){
  var rx = bx - cx, ry = by - y0, rz = bz - cz;
  var a = dx * dx + dy * dy + dz * dz;    /* blade len^2 */
  var ey = y1 - y0;
  var e = ey * ey;                        /* axis len^2 */
  var f = ey * ry;
  var c = dx * rx + dy * ry + dz * rz;
  var s, u;
  if (a <= 1e-9){ s = 0; u = e > 1e-9 ? clamp01(f / e) : 0; }
  else if (e <= 1e-9){ u = 0; s = clamp01(-c / a); }
  else {
    var b2 = dy * ey;                     /* dot(blade, axis) */
    var den = a * e - b2 * b2;
    s = den > 1e-9 ? clamp01((b2 * f - c * e) / den) : 0;
    u = (b2 * s + f) / e;
    if (u < 0){ u = 0; s = clamp01(-c / a); }
    else if (u > 1){ u = 1; s = clamp01((b2 - c) / a); }
  }
  lastS = s;
  var wx = bx + dx * s - cx;
  var wy = by + dy * s - (y0 + ey * u);
  var wz = bz + dz * s - cz;
  return wx * wx + wy * wy + wz * wz;
}

/* TUNNELING NOTE (why NT=5 slices, and why exact segments beat K points):
 * Worst case: a STRONG swing tip covers ~3 m in one clamped frame (tip radius
 * ~1.9 m from the torso pivot, peak ~12 rad/s arc, dt clamp 0.05 s -> ~3 m of
 * tip travel between prev and cur). We lerp the whole blade segment across
 * NT=5 time slices (u = 0, .25, .5, .75, 1 between prev and cur = prev + cur
 * + 3 interpolated steps, as the contract asks) and run an EXACT segment-vs-
 * vertical-capsule distance test per slice. The exact segment test is the
 * K->infinity limit of "sample K points along the blade" at roughly the cost
 * of K=2, so there are NO along-blade gaps at all; the only gap left is
 * BETWEEN time slices: at most 3/4 = 0.75 m of tip travel, i.e. any point of
 * the true swept surface is within 0.375 m of a tested slice. The hit
 * threshold for a training droid is 0.4 (droid) + 0.12 (blade) = 0.52 m >
 * 0.375 m, so a 0.4 m-radius droid CANNOT tunnel through a STRONG swing at
 * 30 fps — only grazes shallower than ~0.15 m can slip, which is invisible. */
function hitTest(sweep, attackId, attackerTeam, channel){
  if (!sweep || !sweep.cb || !sweep.ct) return 0;
  var cb = sweep.cb, ct = sweep.ct;
  var pb = sweep.pb || cb, pt = sweep.pt || ct;
  var key = (channel | 0) * CHAN_MUL + (attackId | 0);
  var dmg = sweep.dmg !== undefined ? sweep.dmg : 10;
  var hits = 0, i, j;
  /* blade travel this frame (midpoint motion) -> hit direction */
  var mvx = (cb[0] + ct[0] - pb[0] - pt[0]) * 0.5;
  var mvy = (cb[1] + ct[1] - pb[1] - pt[1]) * 0.5;
  var mvz = (cb[2] + ct[2] - pb[2] - pt[2]) * 0.5;

  for (i = 0; i < ents.length; i++){
    var en = ents[i];
    if (!en || !en.pos || en.team === attackerTeam || en.hp <= 0) continue;
    var ring = en._hk;                    /* per-entity ring of recent hit keys */
    if (!ring){ ring = en._hk = [-1, -1, -1, -1, -1, -1, -1, -1]; en._hki = 0; }
    var dup = false;
    for (j = 0; j < 8; j++) if (ring[j] === key){ dup = true; break; }
    if (dup) continue;                    /* already hit by this swing */

    /* coarse sphere reject: hull of {pb,pt,cb,ct} stays within ~4.4 m of cb
     * (blade 1.37 + 3 m travel), +0.52 hit slack -> 6 covers it with margin */
    var ecx = en.pos[0], ecy = en.pos[1] + en.height * 0.5, ecz = en.pos[2];
    var reach = 6.0 + en.radius + en.height * 0.5;
    var ddx = ecx - cb[0], ddy = ecy - cb[1], ddz = ecz - cb[2];
    if (ddx * ddx + ddy * ddy + ddz * ddz > reach * reach) continue;

    var rr = en.radius + BLADE_R;
    rr *= rr;
    var y0 = en.pos[1], y1 = y0 + en.height;
    for (j = 0; j < NT; j++){
      var u = j / (NT - 1);
      var bx = pb[0] + (cb[0] - pb[0]) * u,
          by = pb[1] + (cb[1] - pb[1]) * u,
          bz = pb[2] + (cb[2] - pb[2]) * u;
      var tx = pt[0] + (ct[0] - pt[0]) * u,
          ty = pt[1] + (ct[1] - pt[1]) * u,
          tz = pt[2] + (ct[2] - pt[2]) * u;
      if (segCapDistSq(bx, by, bz, tx - bx, ty - by, tz - bz,
                       ecx, y0, y1, ecz) <= rr){
        HITP[0] = bx + (tx - bx) * lastS; /* impact = closest blade point */
        HITP[1] = by + (ty - by) * lastS;
        HITP[2] = bz + (tz - bz) * lastS;
        var ml = Math.sqrt(mvx * mvx + mvy * mvy + mvz * mvz);
        if (ml > 0.03){ DIR[0] = mvx / ml; DIR[1] = mvy / ml; DIR[2] = mvz / ml; }
        else {                            /* 1st active frame: prev==cur */
          var fx = ecx - bx, fz = ecz - bz;
          var fl = Math.sqrt(fx * fx + fz * fz) || 1;
          DIR[0] = fx / fl; DIR[1] = 0; DIR[2] = fz / fl;
        }
        ring[en._hki & 7] = key;
        en._hki = (en._hki + 1) & 7;
        Combat.hitKnock = sweep.knock || 0;
        if (typeof en.onHit === 'function') en.onHit(dmg, DIR, 'saber', HITP);
        if (attackerTeam === 'player'){
          Combat.lastHit.dmg = dmg;
          Combat.lastHit.t = nowT;
          Combat.lastHit.name = sweep.name || '';
        }
        hits++;
        break;                            /* one hit per entity per call */
      }
    }
  }
  return hits;
}

var Combat = JK.Combat = {
  ents: ents,                             /* read-only by convention */
  swingId: 0,
  hitKnock: 0,
  hitPos: HITP,
  lastHit: { dmg: 0, t: -1e9, name: '' },
  hitTest: hitTest,

  register: function(ent){
    if (!ent || ents.indexOf(ent) >= 0) return ent;
    if (!ent._hk){ ent._hk = [-1, -1, -1, -1, -1, -1, -1, -1]; ent._hki = 0; }
    ents.push(ent);
    return ent;
  },

  unregister: function(ent){
    var i = ents.indexOf(ent);
    if (i >= 0){ ents[i] = ents[ents.length - 1]; ents.pop(); }
  },

  /* Called by JK.Fx.update (Combat is not in main's SYSTEMS list). Safe to
   * call while the sabers agent is mid-build: sweeps may be missing/empty. */
  update: function(dt, t){
    nowT = t;
    var S = JK.Sabers;
    if (!S) return;
    if (typeof S.attackId === 'number') Combat.swingId = S.attackId;
    var sw = S.sweeps;
    if (!sw || !sw.length) return;
    if (S.active && !S.active()) return;  /* trust Sabers' damage window */
    for (var i = 0; i < sw.length; i++)
      hitTest(sw[i], Combat.swingId, 'player', 0);
  }
};

/* ============================ training droids ============================== */
/* Star-Wars remote-trainer vibe: small grey box body with a glowing red eye
 * and an antenna, bobbing above a thin post. They never move or block. */
var droids = [];
var meshDroid = null, meshEye = null, meshPost = null;
var SPAWN_X = 0, SPAWN_Z = 6;             /* player spawn (30_player.js) */
/* distinct bearings around spawn (angle from +Z, dist m): ahead, ahead-right,
 * ahead-left of the spawn-facing (-Z) player, 11-13 m out */
var DROID_AT = [
  { a: Math.PI,         d: 11.0 },
  { a: Math.PI * 0.78,  d: 13.0 },
  { a: -Math.PI * 0.75, d: 12.0 }
];

var FT2    = new Float32Array([1, 1, 1]);
var FLASHO = { tint: FT2 };
var EYEO   = { emissive: 1 };
var BODYO  = {};                          /* shared, avoids GL.draw's opts||{} */
var SP3    = new Float32Array(3);         /* scratch position for fx spawns */

var TB = M.make();
function bb(sx, sy, sz, r, g, b, x, y, z){ /* baked-offset box */
  M.ident(TB); M.tr(TB, x, y, z);
  return JK.Geo.tf(JK.Geo.box(sx, sy, sz, r, g, b), TB);
}

function buildMeshes(){
  if (meshBox) return;
  var G = JK.Geo, GL = JK.GL;
  meshBox = GL.mesh(G.box(1, 1, 1, 1, 1, 1));         /* shared particle cube */
  meshDroid = GL.mesh(G.merge([
    bb(0.34, 0.28, 0.34, 0.55, 0.57, 0.60, 0,  0.00,  0),     /* body */
    bb(0.22, 0.07, 0.22, 0.36, 0.38, 0.42, 0,  0.17,  0),     /* top cap */
    bb(0.22, 0.07, 0.22, 0.36, 0.38, 0.42, 0, -0.17,  0),     /* bottom cap */
    bb(0.022, 0.24, 0.022, 0.25, 0.26, 0.28, 0, 0.30, 0),     /* antenna */
    bb(0.055, 0.055, 0.055, 0.95, 0.35, 0.20, 0, 0.43, 0),    /* antenna tip */
    bb(0.05, 0.16, 0.20, 0.32, 0.34, 0.38,  0.195, 0, 0),     /* vent R */
    bb(0.05, 0.16, 0.20, 0.32, 0.34, 0.38, -0.195, 0, 0),     /* vent L */
    bb(0.11, 0.11, 0.035, 0.15, 0.15, 0.17, 0, 0.02, -0.175)  /* eye rim */
  ]));
  meshEye = GL.mesh(bb(0.055, 0.055, 0.03, 1, 0.18, 0.12, 0, 0.02, -0.195));
  meshPost = GL.mesh(G.merge([
    bb(0.07, 0.90, 0.07, 0.30, 0.27, 0.24, 0, 0.45, 0),       /* pole */
    bb(0.34, 0.07, 0.34, 0.26, 0.23, 0.20, 0, 0.035, 0),      /* foot */
    bb(0.16, 0.04, 0.16, 0.38, 0.36, 0.33, 0, 0.92, 0)        /* top plate */
  ]));
}

function droidHit(dmg, dir, kind, hitPos){
  var d = this;
  if (d.dead) return;
  d.hp -= dmg;
  d.flash = 1;
  /* wobble impulse: rotate the hit direction into droid-local, kick springs */
  var c = Math.cos(d.yaw), s = Math.sin(d.yaw);
  var lx = c * dir[0] - s * dir[2];
  var lz = s * dir[0] + c * dir[2];
  d.wvx += lz * 6;                        /* pitch away */
  d.wvz -= lx * 6;                        /* roll away */
  if (hitPos){ SP3[0] = hitPos[0]; SP3[1] = hitPos[1]; SP3[2] = hitPos[2]; }
  else { SP3[0] = d.pos[0]; SP3[1] = d.cy; SP3[2] = d.pos[2]; }
  Fx.sparks(SP3, 14, null);
  if (d.hp <= 0){                         /* boom: shards + fire, hide 3 s */
    d.hp = 0; d.dead = true; d.deadT = RESPAWN_T;
    SP3[0] = d.pos[0]; SP3[1] = d.cy; SP3[2] = d.pos[2];
    Fx.burst(SP3, 26, null);
    Fx.sparks(SP3, 18, null);
    if (JK.game) JK.game.kills++;
    if (JK.msg) JK.msg('TRAINING DROID DESTROYED', 1.4);
  }
}

function buildDroids(){
  if (droids.length) return;
  for (var i = 0; i < DROID_AT.length; i++){
    var x = SPAWN_X + Math.sin(DROID_AT[i].a) * DROID_AT[i].d;
    var z = SPAWN_Z + Math.cos(DROID_AT[i].a) * DROID_AT[i].d;
    var d = {
      /* --- JK.Combat entity contract --- */
      pos: [x, 0, z], radius: 0.4, height: 0.8,
      hp: DROID_HP, team: 'enemy', onHit: droidHit,
      /* --- droid internals --- */
      gy: 0, cy: 0, yaw: Math.atan2(-(SPAWN_X - x), -(SPAWN_Z - z)),
      ph: i * 2.1, sway: 0,
      wpx: 0, wvx: 0, wpz: 0, wvz: 0,     /* tilt springs (pitch/roll) */
      flash: 0, dead: false, deadT: 0
    };
    droids.push(d);
    Combat.register(d);
  }
}

function updateDroids(dt, t){
  for (var i = 0; i < droids.length; i++){
    var d = droids[i];
    d.gy = groundY(d.pos[0], d.pos[2]);
    if (d.dead){
      d.deadT -= dt;
      if (d.deadT <= 0){                  /* respawn with a shimmer */
        d.dead = false; d.hp = DROID_HP; d.flash = 0;
        d.wpx = d.wvx = d.wpz = d.wvz = 0;
        SP3[0] = d.pos[0]; SP3[1] = d.gy + HOVER; SP3[2] = d.pos[2];
        Fx.shimmer(SP3, 18, null);
      }
    }
    d.cy = d.gy + HOVER + Math.sin(t * 1.5 + d.ph) * 0.12;   /* hover bob */
    d.pos[1] = d.cy - d.height * 0.5;     /* capsule feet track the bob */
    d.sway = Math.sin(t * 0.8 + d.ph) * 0.18;
    /* damped tilt springs (kicked by droidHit) */
    d.wvx += (-26 * d.wpx - 4.5 * d.wvx) * dt; d.wpx += d.wvx * dt;
    d.wvz += (-26 * d.wpz - 4.5 * d.wvz) * dt; d.wpz += d.wvz * dt;
    if (d.flash > 0){ d.flash -= dt * 6; if (d.flash < 0) d.flash = 0; }
  }
}

function drawDroids(){
  var GL = JK.GL;
  for (var i = 0; i < droids.length; i++){
    var d = droids[i];
    M.ident(MTX); M.tr(MTX, d.pos[0], d.gy, d.pos[2]);
    GL.draw(meshPost, MTX, BODYO);
    if (d.dead) continue;                 /* hidden while blown up */
    M.ident(MTX);
    M.tr(MTX, d.pos[0], d.cy, d.pos[2]);
    M.ry(MTX, d.yaw + d.sway);
    M.rx(MTX, d.wpx); M.rz(MTX, d.wpz);
    var o = BODYO;
    if (d.flash > 0){                     /* brief red tint on hit */
      FT2[0] = 1; FT2[1] = 1 - 0.78 * d.flash; FT2[2] = 1 - 0.78 * d.flash;
      o = FLASHO;
    }
    GL.draw(meshDroid, MTX, o);
    GL.draw(meshEye, MTX, EYEO);          /* glowing eye dot */
  }
}

/* ============================ JK.Fx module ================================= */
var Fx = JK.Fx = {
  sparks:  function(pos, n, color){ emit(pos, n || 12, color, 0); },
  burst:   function(pos, n, color){ emit(pos, n || 24, color, 1); },
  shimmer: function(pos, n, color){ emit(pos, n || 16, color, 2); },

  init: function(){
    buildMeshes();
    buildDroids();                        /* registers 3 'enemy' entities */
    liveN = 0;
  },

  update: function(dt, t){
    updateDroids(dt, t);                  /* capsules current before tests */
    Combat.update(dt, t);                 /* saber sweeps vs entities */
    updateParticles(dt);
  },

  draw: function(){
    if (!meshBox) return;
    drawDroids();                         /* opaque first */
    drawParticles();                      /* additive on top */
    if (liveN > 0){
      /* particles leave GL in additive/depthMask(false) mode and Fx may be
       * the frame's last drawer — issue one degenerate opaque draw (zero
       * scale, rasterizes nothing) so beginFrame's depth clear works. */
      M.ident(MTX); M.sc(MTX, 0, 0, 0);
      JK.GL.draw(meshBox, MTX, BODYO);
    }
  }
};
})();
