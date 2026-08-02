/* JK.Rig — low-poly humanoid rig + procedural animation + lightsaber(s).
 * Owner: character agent.
 *
 * Shared geometry: ONE set of white part meshes built once (buildMeshes); every
 * instance draws them with per-instance palette tints — bots reuse everything.
 *
 * Instance API (consumed by sabers / ui / future bots):
 *   var rig = JK.Rig.create(palette);
 *     palette: {skin,tunic,pants,boots,belt,hair} each [r,g,b]; null => Kyle-ish.
 *   rig.draw(pos, yaw, anim, phaseInfo)
 *     pos [x,y,z] feet, yaw radians. If phaseInfo {dt,t,speed} is given, the rig
 *     advances animation first (anim: 'idle'|'run'|'sprint'|'jump'|'fall'), then
 *     renders. Omit anim/phaseInfo to just render the current pose.
 *   rig.advance(dt, t, anim, speed2D) — step animation without rendering.
 *   rig.setType(type)   — 'single' | 'dual' | 'staff' (anything else => single).
 *     single: right-hand hilt, 1 blade. dual: extra hilt+blade in the LEFT hand
 *     (left arm holds a raised guard while sabers are on). staff: long (0.5 m)
 *     hilt in the right hand, blades BOTH ways (+Y / -Y of the hand frame),
 *     held angled across the body at idle.
 *   rig.setSaber(rgb, on) — blade color (applies to ALL blades) / ignite state.
 *   rig.blades — array of {base:Float32Array(3), tip:Float32Array(3)} in WORLD
 *     space, refreshed every draw. 1 entry single; 2 dual (right, left);
 *     2 staff (up-blade, down-blade). Entry objects + arrays are preallocated
 *     and identity-stable (safe to cache); only the array LENGTH changes with
 *     setType (blades[0] is always the same entry).
 *   rig.basePos / rig.tipPos — aliases of blades[0].base / blades[0].tip
 *     (same Float32Array identities forever).
 *   rig.playSwing(def) -> bool — keyframed swing per the ITERATION 2 contract:
 *     { dur seconds, keys:[{t 0..1, sp,sy,sr shoulder pitch/yaw/roll, el elbow,
 *       wr wrist, ty,tp torso yaw/pitch (rad), lunge m forward}...],
 *       mirror bool (also drive the LEFT arm mirrored — dual flurries) }
 *     Missing fields in a key inherit the previous key (key 0 inherits the pose
 *     at accept time). Smoothstep between adjacent keys; before keys[0].t blends
 *     from the current pose, after the last key blends back to procedural.
 *     lunge shifts the DRAWN body forward along facing (visual only — physics
 *     stays in Player). Accepted when no swing is active or the current one is
 *     >= 60% done (combo chaining); returns true if accepted.
 *   rig.swingPhase() -> 0..1 while a swing is active, else -1.
 *   rig.startSwing()  — plays a default slash def (same chaining rules).
 *   rig.swingT (-1 idle, else seconds), rig.pose (eased joint angles),
 *   rig.type ('single'|'dual'|'staff'), rig.lunge (current visual offset, m).
 *
 * JK.Rig itself is the player's bridge: init/update/draw run the player rig off
 * JK.Player state. Module-level mirrors of the player instance:
 *   JK.Rig.player, JK.Rig.blades, JK.Rig.tipPos/basePos (aliases),
 *   JK.Rig.setType / setSaber / playSwing / swingPhase / startSwing.
 * Old auto-consume of JK.Player.attackQueued runs ONLY while !JK.Sabers
 * (Sabers owns attacks in iteration 2).
 */
(function(){
'use strict';
var M = JK.M;

/* ---------------- skeleton constants ---------------- */
var HIP_Y = 0.92;          /* pelvis height above feet */
var PELV2TORSO = 0.10, NECK_Y = 0.52;
var SH_X = 0.26, SH_Y = 0.44;      /* shoulder offset in torso frame */
var UARM = 0.30, LARM = 0.28;      /* arm segment lengths */
var HIP_X = 0.105, HIP_DY = -0.06; /* leg sockets in pelvis frame */
var ULEG = 0.42, LLEG = 0.38;
var HILT_TOP = 0.17, BLADE_LEN = 1.25;
var STAFF_TOP = 0.25;              /* staff hilt is 0.5 m; blades leave both ends */
var SWING_DUR = 0.38, CHAIN_FRAC = 0.6;
var MAX_KEYS = 8;
var TWO_PI = Math.PI * 2;

var DEF_PAL = {
  skin:  [0.85, 0.64, 0.47],
  tunic: [0.76, 0.60, 0.38],
  pants: [0.38, 0.26, 0.17],
  boots: [0.16, 0.13, 0.11],
  belt:  [0.28, 0.19, 0.11],
  hair:  [0.33, 0.21, 0.11]
};

/* ---------------- shared meshes (built once, white; tinted per draw) -------- */
var MESH = null;
var TB = M.make();
function bakedBox(sx, sy, sz, r, g, b, x, y, z){
  M.ident(TB); M.tr(TB, x, y, z);
  return JK.Geo.tf(JK.Geo.box(sx, sy, sz, r, g, b), TB);
}
/* one blade = core + two additive glow shells, baked along +/-Y of hand frame */
function bladeSet(base, sgn){
  var GL = JK.GL, mid = base + BLADE_LEN / 2;
  return {
    core: GL.mesh(bakedBox(0.04, BLADE_LEN, 0.04, 1,1,1, 0, sgn * mid, 0)),
    g1:   GL.mesh(bakedBox(0.11, BLADE_LEN + 0.08, 0.11, 1,1,1, 0, sgn * (mid + 0.02), 0)),
    g2:   GL.mesh(bakedBox(0.21, BLADE_LEN + 0.18, 0.21, 1,1,1, 0, sgn * (mid + 0.04), 0))
  };
}
function buildMeshes(){
  if (MESH) return;
  var G = JK.Geo, GL = JK.GL;
  MESH = {
    head: GL.mesh(G.merge([
      bakedBox(0.10, 0.10, 0.10, 1,1,1, 0, 0.03, 0),          /* neck */
      bakedBox(0.22, 0.26, 0.24, 1,1,1, 0, 0.17, 0.01)])),    /* skull */
    hair: GL.mesh(G.merge([
      bakedBox(0.24, 0.09, 0.26, 1,1,1, 0, 0.315, -0.005),    /* cap */
      bakedBox(0.24, 0.15, 0.05, 1,1,1, 0, 0.235, -0.145)])), /* back */
    torso: GL.mesh(bakedBox(0.40, 0.50, 0.24, 1,1,1, 0, 0.28, 0)),
    hips:  GL.mesh(bakedBox(0.32, 0.18, 0.21, 1,1,1, 0, -0.035, 0)),
    belt:  GL.mesh(bakedBox(0.36, 0.09, 0.25, 1,1,1, 0, 0.075, 0)),
    uarm:  GL.mesh(bakedBox(0.12, 0.34, 0.13, 1,1,1, 0, -0.13, 0)),
    larm:  GL.mesh(bakedBox(0.10, 0.30, 0.11, 1,1,1, 0, -0.12, 0)),
    hand:  GL.mesh(bakedBox(0.095, 0.11, 0.10, 1,1,1, 0, -0.01, 0)),
    uleg:  GL.mesh(bakedBox(0.15, 0.46, 0.16, 1,1,1, 0, -0.19, 0)),
    lleg:  GL.mesh(bakedBox(0.125, 0.42, 0.135, 1,1,1, 0, -0.17, 0)),
    boot: GL.mesh(G.merge([
      bakedBox(0.13, 0.16, 0.15, 1,1,1, 0, 0.03, 0),          /* shaft */
      bakedBox(0.135, 0.07, 0.26, 1,1,1, 0, -0.045, -0.055)])),/* toe fwd -Z */
    hilt: GL.mesh(G.merge([                                    /* baked colors */
      bakedBox(0.045, 0.24, 0.045, 0.60, 0.61, 0.65, 0, 0.02, 0),
      bakedBox(0.06, 0.05, 0.06, 0.18, 0.18, 0.21, 0, -0.115, 0),
      bakedBox(0.062, 0.07, 0.062, 0.42, 0.43, 0.48, 0, 0.14, 0)])),
    hiltS: GL.mesh(G.merge([                                   /* 0.5 m staff */
      bakedBox(0.045, 0.50, 0.045, 0.60, 0.61, 0.65, 0, 0, 0),
      bakedBox(0.06, 0.10, 0.06, 0.18, 0.18, 0.21, 0, 0, 0),   /* center grip */
      bakedBox(0.062, 0.06, 0.062, 0.42, 0.43, 0.48, 0, 0.22, 0),
      bakedBox(0.062, 0.06, 0.062, 0.42, 0.43, 0.48, 0, -0.22, 0)])),
    blade:  bladeSet(HILT_TOP, 1),   /* single / dual (from a hand hilt)  */
    bladeU: bladeSet(STAFF_TOP, 1),  /* staff up-blade                    */
    bladeD: bladeSet(STAFF_TOP, -1), /* staff down-blade                  */
    /* shadow: emissive dark-sand patch (core shader only blends in additive
       mode, so a thin "pre-shaded" opaque box reads as a shadow with zero
       core edits). */
    shadow: GL.mesh(bakedBox(0.95, 0.02, 1.05, 0.33, 0.25, 0.155, 0, 0, 0))
  };
}
var CORE_OPTS = { emissive: 1, nofog: true };
var SHADOW_OPTS = { emissive: 1 };

/* ---------------- def-swing machinery ----------------
 * Keys normalized at accept into preallocated Float32Array(9) records:
 *   [0]=t, [1]=sp, [2]=sy, [3]=sr, [4]=el, [5]=wr, [6]=ty, [7]=tp, [8]=lunge
 * Snapshots / procedural refs are Float32Array(8) in the same field order
 * (minus t). Left-arm records live in "authored" space: applied syL = -rec[1]
 * so one evaluator serves both sides. Zero alloc after create().            */
var SWR = new Float32Array(8), SWL = new Float32Array(8);
var PROCR = new Float32Array(8), PROCL = new Float32Array(8);
var EMPTY_KEY = {};

/* default slash (the classic iteration-1 swing, authored as a def) */
var DEFAULT_DEF = { dur: SWING_DUR, keys: [
  { t: 0.30, sp: 2.25, sy: 0.0, sr: -0.55, el: 1.00, wr: -0.35, ty: -0.45, tp: 0.08, lunge: 0.00 },
  { t: 0.62, sp: -0.55, sr: 0.95, el: 0.15, wr: 0.55, ty: 0.45, lunge: 0.20 },
  { t: 0.88, sp: 0.45, sr: 0.15, el: 0.60, wr: -0.60, ty: 0.00, tp: 0.04, lunge: 0.00 }
]};

function num(v, d){ return (typeof v === 'number' && v === v) ? v : d; }
function smooth(s){
  if (s < 0) s = 0; else if (s > 1) s = 1;
  return s * s * (3 - 2 * s);
}

/* sample the active swing for one side into out[8].
 * snap = pose at accept, proc = this frame's procedural targets. */
function swingSample(out, sw, snap, proc){
  var u = sw.t / sw.dur, keys = sw.keys, n = sw.n;
  var t0 = keys[0][0], tl = keys[n - 1][0];
  var a, b, ao, bo, s, j;
  if (u <= t0){                       /* blend in from the captured pose */
    a = snap; ao = 0; b = keys[0]; bo = 1;
    s = t0 > 1e-5 ? u / t0 : 1;
  } else if (u >= tl){                /* blend back out to procedural */
    a = keys[n - 1]; ao = 1; b = proc; bo = 0;
    s = (1 - tl) > 1e-5 ? (u - tl) / (1 - tl) : 1;
  } else {                            /* between two keys */
    var i = 0;
    while (i < n - 2 && u > keys[i + 1][0]) i++;
    a = keys[i]; ao = 1; b = keys[i + 1]; bo = 1;
    var span = b[0] - a[0];
    s = span > 1e-6 ? (u - a[0]) / span : 1;
  }
  s = smooth(s);
  for (j = 0; j < 8; j++) out[j] = a[ao + j] + (b[bo + j] - a[ao + j]) * s;
  return out;
}

function playSwing(def){
  var sw = this.swing, p = this.pose;
  if (sw.active && sw.t < sw.dur * CHAIN_FRAC) return false;   /* not chainable yet */
  if (!def || !def.keys || !def.keys.length) def = DEFAULT_DEF; /* defensive */

  /* snapshot current pose (authored space; left sy sign-flipped) */
  var sR = sw.snapR, sL = sw.snapL;
  sR[0] = p.aSwR; sR[1] = p.syR;  sR[2] = p.sprR; sR[3] = p.elbR;
  sR[4] = p.wrist; sR[5] = p.twist; sR[6] = p.lean; sR[7] = this.lunge;
  sL[0] = p.aSwL; sL[1] = -p.syL; sL[2] = p.sprL; sL[3] = p.elbL;
  sL[4] = p.wrL;  sL[5] = p.twist; sL[6] = p.lean; sL[7] = this.lunge;

  /* normalize keys into the preallocated records (missing fields inherit) */
  var n = def.keys.length; if (n > MAX_KEYS) n = MAX_KEYS;
  var prevT = 0;
  for (var i = 0; i < n; i++){
    var src = def.keys[i] || EMPTY_KEY;
    var k = sw.keys[i], pk = i > 0 ? sw.keys[i - 1] : null;
    var kt = num(src.t, i > 0 ? prevT + 0.15 : 0.25);
    if (kt > 1) kt = 1;
    if (i > 0 && kt <= prevT) kt = prevT + 1e-3;   /* keep strictly increasing */
    k[0] = kt; prevT = kt;
    k[1] = num(src.sp,    pk ? pk[1] : sR[0]);
    k[2] = num(src.sy,    pk ? pk[2] : sR[1]);
    k[3] = num(src.sr,    pk ? pk[3] : sR[2]);
    k[4] = num(src.el,    pk ? pk[4] : sR[3]);
    k[5] = num(src.wr,    pk ? pk[5] : sR[4]);
    k[6] = num(src.ty,    pk ? pk[6] : sR[5]);
    k[7] = num(src.tp,    pk ? pk[7] : sR[6]);
    k[8] = num(src.lunge, pk ? pk[8] : sR[7]);
  }
  sw.n = n;
  sw.dur = num(def.dur, SWING_DUR); if (sw.dur < 0.05) sw.dur = 0.05;
  sw.mirror = !!def.mirror;
  sw.t = 0; sw.active = true;
  this.swingT = 0;
  return true;
}

function swingPhase(){
  var sw = this.swing;
  return sw.active ? sw.t / sw.dur : -1;
}

function startSwing(){ return this.playSwing(DEFAULT_DEF); }

function setType(type){
  if (type !== 'dual' && type !== 'staff') type = 'single';
  if (type === this.type) return;
  this.type = type;
  var bl = this.blades;
  bl.length = 1;                       /* blades[0] entry never changes identity */
  if (type !== 'single') bl.push(this._blade2);
}

function setSaber(rgb, on){
  if (rgb){ this.saberCol[0] = rgb[0]; this.saberCol[1] = rgb[1]; this.saberCol[2] = rgb[2]; }
  if (on !== undefined) this.saberOn = !!on;
}

function max0(x){ return x > 0 ? x : 0; }
function ez(c, t, k){ return c + (t - c) * k; }

/* ---------------- per-instance animation step ---------------- */
function advance(dt, t, anim, speed){
  var p = this.pose;
  var sp = speed || 0;

  var stride = 2.2 + sp * 0.16;
  if (stride < 2.4) stride = 2.4; else if (stride > 3.6) stride = 3.6;
  this.phase += sp * dt * TWO_PI / stride;
  if (this.phase > TWO_PI) this.phase -= TWO_PI;
  var ph = this.phase;

  var lSwL, lSwR, kneeL, kneeR, aSwL, aSwR, sprL, sprR, elbL, elbR, wrist;
  var lean, twist, bob, head;
  var syR = 0, syL = 0, wrL = 0, wrr = 0;      /* new joints default neutral */

  if (anim === 'run' || anim === 'sprint'){
    var fast = anim === 'sprint';
    var A = fast ? 0.96 : 0.70;               /* +-55 deg / +-40 deg hips */
    var s1 = Math.sin(ph);
    var kAmp = fast ? 1.35 : 1.05;
    lSwL = A * s1;             lSwR = -A * s1;
    kneeL = -(0.22 + kAmp * max0(Math.cos(ph + 0.5)));
    kneeR = -(0.22 + kAmp * max0(-Math.cos(ph + 0.5)));
    aSwL = 0.06 - (fast ? 0.85 : 0.55) * s1;  /* counter-swing */
    aSwR = 0.35 + (fast ? 0.50 : 0.30) * s1;  /* saber arm swings less */
    sprL = 0.14; sprR = 0.16;
    elbL = 0.60; elbR = 0.55;
    wrist = -0.55;
    lean = fast ? 0.26 : 0.14;                /* ~15 / ~8 deg forward */
    bob = (fast ? 0.045 : 0.030) * (0.5 - 0.5 * Math.cos(2 * ph));
    twist = (fast ? 0.12 : 0.08) * s1;
    head = -lean * 0.6;
  } else if (anim === 'jump'){                /* tucked / trailing legs */
    lSwL = 0.55; lSwR = 0.10;
    kneeL = -1.50; kneeR = -0.75;
    aSwL = -0.55; aSwR = -0.35;               /* arms up-back */
    sprL = 0.85; sprR = 0.70;
    elbL = 0.45; elbR = 0.50;
    wrist = -0.35;
    lean = -0.06; bob = 0; twist = 0; head = 0.10;
  } else if (anim === 'fall'){                /* limbs spread */
    lSwL = 0.35; lSwR = -0.18;
    kneeL = -0.45; kneeR = -0.25;
    aSwL = -0.15; aSwR = -0.05;
    sprL = 1.05; sprR = 0.90;
    elbL = 0.35; elbR = 0.40;
    wrist = -0.50;
    lean = 0.07; bob = 0; twist = 0; head = 0.18;
  } else {                                    /* idle: breathe, saber relaxed */
    lSwL = 0.05; lSwR = -0.05;
    kneeL = -0.09; kneeR = -0.09;
    aSwL = 0.10; aSwR = 0.38;
    sprL = 0.10; sprR = 0.14;
    elbL = 0.28; elbR = 0.55;
    wrist = -0.60 + 0.05 * Math.sin(t * 1.1);
    lean = 0.04; twist = 0;
    bob = 0.013 * Math.sin(t * 1.7);
    head = 0.03 * Math.sin(t * 0.7);
  }

  /* ---- saber-type grip overrides (procedural layer) ---- */
  if (this.type === 'dual' && this.saberOn){
    /* left hand carries a live blade: raised guard, no floppy counter-swing */
    if (anim === 'run' || anim === 'sprint'){
      aSwL = 0.30 - 0.22 * Math.sin(ph);
      sprL = 0.30; elbL = 0.85; syL = 0.12; wrL = -0.50;
    } else if (anim === 'idle'){
      aSwL = 0.42; sprL = 0.32; elbL = 0.88; syL = 0.15;
      wrL = -0.55 + 0.05 * Math.sin(t * 1.3);
    }
  } else if (this.type === 'staff'){
    if (anim === 'idle'){                     /* Maul special: angled across body */
      aSwR = 0.80; syR = 0.45; sprR = 0.02; elbR = 0.70;
      wrist = -0.85; wrr = 0.85;
      twist += 0.12;
      aSwL = 0.28; sprL = 0.24; elbL = 0.55;  /* off hand up and ready */
    } else if (anim === 'run' || anim === 'sprint'){
      aSwR = 0.30 + 0.18 * Math.sin(ph);      /* calm carry, blade tilted */
      sprR = 0.10; elbR = 0.60; wrist = -0.70; wrr = 0.45;
    }
  }

  /* ---- def-swing lifecycle ---- */
  var sw = this.swing;
  if (sw.active){
    sw.t += dt;
    if (sw.t >= sw.dur) sw.active = false;
  }
  if (sw.active){
    wrr = 0;                                  /* both hands square on the hilt */
    if (!sw.mirror && !(this.type === 'dual' && this.saberOn))
      sprL += 0.25;                           /* off arm counterbalances */
  }

  /* exponential ease toward targets (~0.12 s blend) */
  var kA = 1 - Math.exp(-26 * dt);            /* limbs */
  var kB = 1 - Math.exp(-14 * dt);            /* body mass */
  var kR = sw.active ? 1 - Math.exp(-45 * dt) : kA;  /* saber arm snaps */
  p.lSwL = ez(p.lSwL, lSwL, kA);   p.lSwR = ez(p.lSwR, lSwR, kA);
  p.kneeL = ez(p.kneeL, kneeL, kA); p.kneeR = ez(p.kneeR, kneeR, kA);
  p.aSwL = ez(p.aSwL, aSwL, kA);   p.sprL = ez(p.sprL, sprL, kA);
  p.elbL = ez(p.elbL, elbL, kA);   p.syL = ez(p.syL, syL, kA);
  p.wrL = ez(p.wrL, wrL, kA);
  p.aSwR = ez(p.aSwR, aSwR, kR);   p.sprR = ez(p.sprR, sprR, kR);
  p.elbR = ez(p.elbR, elbR, kR);   p.wrist = ez(p.wrist, wrist, kR);
  p.syR = ez(p.syR, syR, kR);      p.wrr = ez(p.wrr, wrr, kR);
  p.bob = ez(p.bob, bob, kB);      p.lean = ez(p.lean, lean, kB);
  p.twist = ez(p.twist, twist, kR); p.head = ez(p.head, head, kB);

  /* ---- def-swing override: exact keyframed pose beats the eased targets ---- */
  if (sw.active){
    PROCR[0] = aSwR; PROCR[1] = syR;  PROCR[2] = sprR; PROCR[3] = elbR;
    PROCR[4] = wrist; PROCR[5] = twist; PROCR[6] = lean; PROCR[7] = 0;
    swingSample(SWR, sw, sw.snapR, PROCR);
    p.aSwR = SWR[0]; p.syR = SWR[1]; p.sprR = SWR[2]; p.elbR = SWR[3];
    p.wrist = SWR[4]; p.twist = SWR[5]; p.lean = SWR[6];
    this.lunge = SWR[7];
    if (sw.mirror){                           /* dual flurry: left arm mirrored */
      PROCL[0] = aSwL; PROCL[1] = -syL; PROCL[2] = sprL; PROCL[3] = elbL;
      PROCL[4] = wrL; PROCL[5] = twist; PROCL[6] = lean; PROCL[7] = 0;
      swingSample(SWL, sw, sw.snapL, PROCL);
      p.aSwL = SWL[0]; p.syL = -SWL[1]; p.sprL = SWL[2]; p.elbL = SWL[3];
      p.wrL = SWL[4];
    }
    this.swingT = sw.t;
  } else {
    this.swingT = -1;
    this.lunge = ez(this.lunge, 0, kB);       /* settle any leftover lunge */
  }
}

/* ---------------- render (module-scope matrix pool: zero alloc) ------------- */
var mRoot = M.make(), mPelv = M.make(), mTorso = M.make(), mA = M.make(), mS = M.make();
var mHR = M.make(), mHL = M.make();           /* hand frames kept for blade pass */

function renderRig(r, pos, yaw){
  var GL = JK.GL, p = r.pose;
  var dual = r.type === 'dual', staff = r.type === 'staff';

  /* lunge: shift the DRAWN body along facing (visual only; fwd = (-sin,-cos)) */
  var lun = r.lunge;
  var px = pos[0] - Math.sin(yaw) * lun;
  var pz = pos[2] - Math.cos(yaw) * lun;

  /* --- ground shadow first (also guarantees frame starts non-additive) --- */
  var gx = px, gz = pz, gy = 0, dhx = 0, dhz = 0, e = 0.6;
  if (JK.Terrain && JK.Terrain.height){
    gy = JK.Terrain.height(gx, gz);
    dhx = (JK.Terrain.height(gx + e, gz) - JK.Terrain.height(gx - e, gz)) / (2 * e);
    dhz = (JK.Terrain.height(gx, gz + e) - JK.Terrain.height(gx, gz - e)) / (2 * e);
  }
  var alt = pos[1] - gy; if (alt < 0) alt = 0;
  var shs = 1 - alt * 0.22; if (shs < 0.35) shs = 0.35;   /* shrinks mid-air */
  M.ident(mS); M.tr(mS, gx, gy + 0.03, gz);
  M.rx(mS, -Math.atan(dhz)); M.rz(mS, Math.atan(dhx));    /* hug the slope */
  M.sc(mS, shs, 1, shs);
  GL.draw(MESH.shadow, mS, SHADOW_OPTS);

  /* --- hierarchy --- */
  M.ident(mRoot); M.tr(mRoot, px, pos[1], pz); M.ry(mRoot, yaw);

  M.copy(mPelv, mRoot); M.tr(mPelv, 0, HIP_Y + p.bob, 0);
  GL.draw(MESH.hips, mPelv, r.oPants);
  GL.draw(MESH.belt, mPelv, r.oBelt);

  M.copy(mTorso, mPelv); M.tr(mTorso, 0, PELV2TORSO, 0);
  M.ry(mTorso, p.twist); M.rx(mTorso, p.lean);
  GL.draw(MESH.torso, mTorso, r.oTunic);

  /* head */
  M.copy(mA, mTorso); M.tr(mA, 0, NECK_Y, 0); M.rx(mA, p.head);
  GL.draw(MESH.head, mA, r.oSkin);
  GL.draw(MESH.hair, mA, r.oHair);

  /* left arm — hand frame kept in mHL for the dual blade pass */
  M.copy(mA, mTorso); M.tr(mA, -SH_X, SH_Y, 0);
  M.rz(mA, -p.sprL); M.ry(mA, p.syL); M.rx(mA, p.aSwL);
  GL.draw(MESH.uarm, mA, r.oTunic);
  M.tr(mA, 0, -UARM, 0); M.rx(mA, p.elbL);
  GL.draw(MESH.larm, mA, r.oTunic);
  M.tr(mA, 0, -LARM, 0); M.rx(mA, p.wrL);
  GL.draw(MESH.hand, mA, r.oSkin);
  if (dual){
    GL.draw(MESH.hilt, mA, null);
    M.copy(mHL, mA);
  }

  /* left leg */
  M.copy(mA, mPelv); M.tr(mA, -HIP_X, HIP_DY, 0); M.rx(mA, p.lSwL);
  GL.draw(MESH.uleg, mA, r.oPants);
  M.tr(mA, 0, -ULEG, 0); M.rx(mA, p.kneeL);
  GL.draw(MESH.lleg, mA, r.oPants);
  M.tr(mA, 0, -LLEG, 0); M.rx(mA, -(p.lSwL + p.kneeL) * 0.6);  /* fake ankle */
  GL.draw(MESH.boot, mA, r.oBoots);

  /* right leg */
  M.copy(mA, mPelv); M.tr(mA, HIP_X, HIP_DY, 0); M.rx(mA, p.lSwR);
  GL.draw(MESH.uleg, mA, r.oPants);
  M.tr(mA, 0, -ULEG, 0); M.rx(mA, p.kneeR);
  GL.draw(MESH.lleg, mA, r.oPants);
  M.tr(mA, 0, -LLEG, 0); M.rx(mA, -(p.lSwR + p.kneeR) * 0.6);
  GL.draw(MESH.boot, mA, r.oBoots);

  /* right (saber) arm — hand frame kept in mHR */
  M.copy(mA, mTorso); M.tr(mA, SH_X, SH_Y, 0);
  M.rz(mA, p.sprR); M.ry(mA, p.syR); M.rx(mA, p.aSwR);
  GL.draw(MESH.uarm, mA, r.oTunic);
  M.tr(mA, 0, -UARM, 0); M.rx(mA, p.elbR);
  GL.draw(MESH.larm, mA, r.oTunic);
  M.tr(mA, 0, -LARM, 0); M.rx(mA, p.wrist); M.rz(mA, p.wrr);
  GL.draw(MESH.hand, mA, r.oSkin);
  GL.draw(staff ? MESH.hiltS : MESH.hilt, mA, null);
  M.copy(mHR, mA);

  /* --- world blade ends for combat (valid every frame, on or off) --- */
  var b0 = r.blades[0], b1 = r.blades.length > 1 ? r.blades[1] : null;
  if (staff){
    M.xp(b0.base, mHR, 0, STAFF_TOP, 0);
    M.xp(b0.tip,  mHR, 0, STAFF_TOP + BLADE_LEN, 0);
    if (b1){
      M.xp(b1.base, mHR, 0, -STAFF_TOP, 0);
      M.xp(b1.tip,  mHR, 0, -STAFF_TOP - BLADE_LEN, 0);
    }
  } else {
    M.xp(b0.base, mHR, 0, HILT_TOP, 0);
    M.xp(b0.tip,  mHR, 0, HILT_TOP + BLADE_LEN, 0);
    if (dual && b1){
      M.xp(b1.base, mHL, 0, HILT_TOP, 0);
      M.xp(b1.tip,  mHL, 0, HILT_TOP + BLADE_LEN, 0);
    }
  }

  /* --- blade glow: always the LAST draws of the rig. Additive shells first,
     opaque cores LAST (final core draw restores blend/depthMask state). --- */
  if (r.saberOn){
    if (staff){
      GL.draw(MESH.bladeU.g2, mHR, r.oGlow2);
      GL.draw(MESH.bladeD.g2, mHR, r.oGlow2);
      GL.draw(MESH.bladeU.g1, mHR, r.oGlow1);
      GL.draw(MESH.bladeD.g1, mHR, r.oGlow1);
      GL.draw(MESH.bladeU.core, mHR, CORE_OPTS);
      GL.draw(MESH.bladeD.core, mHR, CORE_OPTS);
    } else {
      GL.draw(MESH.blade.g2, mHR, r.oGlow2);          /* faint outer shell */
      if (dual) GL.draw(MESH.blade.g2, mHL, r.oGlow2);
      GL.draw(MESH.blade.g1, mHR, r.oGlow1);          /* hot inner shell */
      if (dual) GL.draw(MESH.blade.g1, mHL, r.oGlow1);
      GL.draw(MESH.blade.core, mHR, CORE_OPTS);
      if (dual) GL.draw(MESH.blade.core, mHL, CORE_OPTS);
    }
  }
}

function instanceDraw(pos, yaw, anim, phaseInfo){
  if (phaseInfo){
    this.advance(phaseInfo.dt || 0, phaseInfo.t || 0, anim || 'idle',
      phaseInfo.speed !== undefined ? phaseInfo.speed : (phaseInfo.speed2D || 0));
  }
  renderRig(this, pos, yaw);
}

/* ---------------- factory ---------------- */
function col3(a, d){
  var o = new Float32Array(3);
  a = a || d;
  o[0] = a[0]; o[1] = a[1]; o[2] = a[2];
  return o;
}

function create(palette){
  buildMeshes();
  var pal = palette || {};
  var i, kf = [];
  for (i = 0; i < MAX_KEYS; i++) kf.push(new Float32Array(9));
  var rig = {
    pose: { bob: 0, lean: 0.04, twist: 0, head: 0,
      lSwL: 0.05, lSwR: -0.05, kneeL: -0.09, kneeR: -0.09,
      aSwL: 0.10, aSwR: 0.38, sprL: 0.10, sprR: 0.14,
      elbL: 0.28, elbR: 0.55, wrist: -0.60,
      syL: 0, syR: 0, wrL: 0, wrr: 0 },
    phase: 0,
    swingT: -1,
    lunge: 0,
    type: 'single',
    swing: { active: false, t: 0, dur: SWING_DUR, mirror: false, n: 0,
      keys: kf, snapR: new Float32Array(8), snapL: new Float32Array(8) },
    saberOn: true,
    saberCol: col3(null, [0.2, 0.9, 0.3]),
    basePos: new Float32Array(3),
    tipPos: new Float32Array(3),
    advance: advance,
    draw: instanceDraw,
    startSwing: startSwing,
    playSwing: playSwing,
    swingPhase: swingPhase,
    setType: setType,
    setSaber: setSaber
  };
  /* blades: entries preallocated once; blades[0] aliases basePos/tipPos and the
     array is mutated in place by setType (identity-stable for consumers). */
  rig.blades = [{ base: rig.basePos, tip: rig.tipPos }];
  rig._blade2 = { base: new Float32Array(3), tip: new Float32Array(3) };
  /* per-instance draw opts, allocated once (tint arrays live for rig lifetime) */
  rig.oSkin  = { tint: col3(pal.skin,  DEF_PAL.skin)  };
  rig.oTunic = { tint: col3(pal.tunic, DEF_PAL.tunic) };
  rig.oPants = { tint: col3(pal.pants, DEF_PAL.pants) };
  rig.oBoots = { tint: col3(pal.boots, DEF_PAL.boots) };
  rig.oBelt  = { tint: col3(pal.belt,  DEF_PAL.belt)  };
  rig.oHair  = { tint: col3(pal.hair,  DEF_PAL.hair)  };
  rig.oGlow1 = { emissive: 1, nofog: true, additive: true, alpha: 0.55, tint: rig.saberCol };
  rig.oGlow2 = { emissive: 1, nofog: true, additive: true, alpha: 0.25, tint: rig.saberCol };
  return rig;
}

/* ---------------- module = player instance bridge ---------------- */
var player = null;

JK.Rig = {
  create: create,
  SWING_DUR: SWING_DUR,
  player: null,
  pose: null,
  tipPos: null,
  basePos: null,
  blades: null,

  init: function(){
    buildMeshes();
    player = create(null);
    this.player = player;
    this.pose = player.pose;
    this.tipPos = player.tipPos;
    this.basePos = player.basePos;
    this.blades = player.blades;      /* identity-stable: setType mutates in place */
  },

  update: function(dt, t){
    if (!player) return;
    var P = JK.Player;
    var anim = 'idle', sp = 0;
    if (P){
      anim = P.anim || 'idle';
      sp = P.speed2D || 0;
      /* legacy attack path — ONLY while JK.Sabers isn't built/loaded
         (iteration 2: Sabers owns attack consumption + swing selection). */
      if (!JK.Sabers){
        if (P.attackQueued){
          /* keep buffered until the current swing is chainable */
          if (player.playSwing(DEFAULT_DEF)) P.attackQueued = false;
        } else if (P.attackQueued === undefined &&
                   JK.Input && JK.Input.state && JK.Input.state.attack){
          player.startSwing();   /* fallback until player module queues attacks */
        }
      }
    }
    player.advance(dt, t, anim, sp);
  },

  draw: function(){
    if (!player || !JK.Player || !JK.Player.pos) return;
    renderRig(player, JK.Player.pos, JK.Player.yaw || 0);
  },

  setSaber: function(rgb, on){ if (player) player.setSaber(rgb, on); },
  setType: function(type){ if (player) player.setType(type); },
  startSwing: function(){ return player ? player.startSwing() : false; },
  playSwing: function(def){ return player ? player.playSwing(def) : false; },
  swingPhase: function(){ return player ? player.swingPhase() : -1; }
};
})();
