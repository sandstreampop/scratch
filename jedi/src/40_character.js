/* JK.Rig — low-poly humanoid rig + procedural animation + lightsaber(s).
 * Owner: character agent.
 *
 * Shared geometry: ONE set of white part meshes built once (buildMeshes); every
 * instance draws them with per-instance palette tints — bots reuse everything.
 *
 * ===================== THE ARC ENGINE (swing rework) =====================
 * Attacks are authored as the BLADE'S ARC, never as joint angles. An arc is a
 * rotation of the blade about a pivot in the character's chest space; the arm is
 * solved to match with two-bone IK, and the torso follows the arc automatically.
 *
 *   rig.playArc(arcDef) -> bool     (accepted when idle or phase >= 0.6)
 *   arcDef = {
 *     dur      seconds
 *     pivot    [x,y,z]  arc centre, BODY-LOCAL (+X right, +Y up, -Z forward,
 *                       origin at the FEET). Chest-ish, e.g. [0.04,1.34,-0.05]
 *     radius   m        pivot -> blade MIDDLE (arm + half blade), ~0.9-1.15
 *     axis     [x,y,z]  normal of the swing plane (need not be unit)
 *     a0, a1   rad      start/end angle in that plane
 *     tilt     rad      roll of the blade about its own length (edge)
 *     windup   0..1     fraction of dur spent in anticipation
 *     recover  0..1     fraction spent settling back toward guard
 *     lunge    m        forward body shift during the strike (visual only)
 *     name     string
 *   }
 *   ANGLE CONVENTION: angle 0 points UP from the pivot — or FORWARD when `axis`
 *   is (near) vertical, since "up" degenerates there. Positive angles follow the
 *   right-hand rule about `axis`. So:
 *     horizontal right->left sweep : axis [0,1,0], a0 -0.95 .. a1 0.85
 *     overhead chop down the front : axis [-1,0,0], a0  0.0  .. a1 1.95
 *     diagonal high-right -> low-left: axis = cross(startDir, endDir)
 *   Easing: anticipation (eases slightly PAST a0 with the blade coiled IN) ->
 *   strike (angular speed peaks a third of the way through, then decelerates) ->
 *   follow-through settle + pull back toward guard. A further short blend into
 *   the procedural pose runs AFTER dur, so swingPhase() stays exactly 0..1.
 *
 * AUTHORING NOTE (measured against jedi/test/swing_probe.js, all 12 attacks):
 *   - The idle guard points the blade up-forward at ~38 deg (GUARD_DIR below).
 *     The tip has to travel from there into the cocked pose, and the probe's
 *     `pathOverSpan <= 1.9` counts that travel. Arcs whose a0 sits within ~1 rad
 *     of the guard pass with room to spare; a cock-back on the far side of the
 *     body costs ~1.5 m of tip path.
 *   - Total swept angle |a1-a0| <= ~2.0 rad. Wider arcs cost more path per unit
 *     of span (arc/chord grows), which is what pushes pathOverSpan over.
 *   - The blade tip is smoothly pulled under CEIL_Y: you cannot hold a saber
 *     overhead at arm's length, so the elbow tucks as the blade passes vertical.
 *     Overheads therefore stay off the "antenna above the head" failure.
 *
 * Instance API (consumed by sabers / ui / bots):
 *   var rig = JK.Rig.create(palette);
 *     palette: {skin,tunic,pants,boots,belt,hair} each [r,g,b]; null => Kyle-ish.
 *   rig.draw(pos, yaw, anim, phaseInfo)
 *     pos [x,y,z] feet, yaw radians. If phaseInfo {dt,t,speed} is given, the rig
 *     advances animation first (anim: 'idle'|'run'|'sprint'|'jump'|'fall'), then
 *     renders. Omit anim/phaseInfo to just render the current pose.
 *   rig.advance(dt, t, anim, speed2D) — step animation without rendering.
 *   rig.setType(type)   — 'single' | 'dual' | 'staff' (anything else => single).
 *     single: right-hand hilt, 1 blade. dual: extra hilt+blade in the LEFT hand
 *     (left arm mirrors the arc, phase-offset 0.12, for a flurry). staff: long
 *     (0.5 m) hilt in the right hand, blades BOTH ways (+Y / -Y of the hand).
 *   rig.setSaber(rgb, on) — blade color (applies to ALL blades) / ignite state.
 *   rig.blades — array of {base:Float32Array(3), tip:Float32Array(3)} in WORLD
 *     space, refreshed every draw. 1 entry single; 2 dual (right, left);
 *     2 staff (up-blade, down-blade). Entry objects + arrays are preallocated
 *     and identity-stable (safe to cache); only the array LENGTH changes with
 *     setType (blades[0] is always the same entry).
 *   rig.basePos / rig.tipPos — aliases of blades[0].base / blades[0].tip.
 *   rig.playArc(def) -> bool   — see above. THE way to author a swing.
 *   rig.playSwing(def) -> bool — ITERATION-2 keyframe defs, kept working as a
 *     compatibility shim (JK.Bots): the def's cocked key + follow-through key are
 *     read as blade directions and converted into an arc. Never throws.
 *   rig.swingPhase() -> 0..1 while a swing is active, else -1.
 *   rig.startSwing()  — plays the default diagonal slash arc.
 *   rig.swingT (-1 idle, else seconds), rig.pose (procedural joint angles),
 *   rig.type, rig.lunge (current visual forward offset, m), rig.arc (state).
 *
 * JK.Rig itself is the player's bridge: init/update/draw run the player rig off
 * JK.Player state. Module-level mirrors of the player instance:
 *   JK.Rig.player, JK.Rig.blades, JK.Rig.tipPos/basePos (aliases),
 *   JK.Rig.setType / setSaber / playArc / playSwing / swingPhase / startSwing.
 * Old auto-consume of JK.Player.attackQueued runs ONLY while !JK.Sabers.
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
var TWO_PI = Math.PI * 2;

/* ---------------- arc engine tunables ---------------- */
var BACK_FRAC   = 0.07;   /* anticipation overshoot past a0 (fraction of the arc) */
var SETTLE_FRAC = 0.035;   /* follow-through settles back this much of the arc */
var CEIL_Y      = 2.42;   /* m above the feet the blade tip is pulled under: you
                             cannot hold a saber overhead at arm's length, the
                             elbow tucks — and it keeps chops off the "antenna" */
var COIL_R      = 0.26;   /* radius shrink while coiled (blade pulled in) */
var OVER_R      = 0.03;   /* slight over-extension at the end of the strike */
var PULL_R      = 0.10;   /* radius pull-in while recovering to guard */
var LEAD        = 0.26;   /* blade leads the radial direction, rad (whip feel) */
var TW_GAIN     = 0.60;   /* chest yaw follow */
var LN_GAIN     = 0.34;   /* chest pitch follow */
var LEAN_SIGN   = 1;      /* +lean tips the chest BACK in this rig */
var BLEND_IN    = 0.045;  /* s, MINIMUM ease out of the pose we came from. The
                             anticipation absorbs it: the blend runs over the
                             wind-up, so guard -> coil is ONE continuous move
                             instead of a snap plus a slow cock-back. */
var BLEND_OUT   = 0.14;   /* s, ease back to procedural AFTER dur (phase already -1) */
var DUAL_PHASE  = 0.12;   /* left blade trails the right by this fraction of dur */

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
/* Flat contact-shadow disc: centre + an inner ring held at the dark colour +
   an outer ring painted the LIT SAND colour, so gouraud interpolation fades the
   rim into the ground and the blob has no visible edge. The core shader has no
   alpha blending for opaque geometry, so the gradient has to live in the vertex
   colours; measured sand under the character reads (0.75, 0.54, 0.28). */
function bakedDisc(rad, segs, cr, cg, cb, er, eg, eb){
  var P = [0, 0, 0], N = [0, 1, 0], C = [cr, cg, cb], I = [];
  var inner = rad * 0.44, i, a;
  for (i = 0; i < segs; i++){                       /* ring 1: still dark */
    a = i / segs * TWO_PI;
    P.push(Math.cos(a) * inner, 0, Math.sin(a) * inner);
    N.push(0, 1, 0); C.push(cr, cg, cb);
  }
  for (i = 0; i < segs; i++){                       /* ring 2: sand, invisible */
    a = i / segs * TWO_PI;
    P.push(Math.cos(a) * rad, 0, Math.sin(a) * rad);
    N.push(0, 1, 0); C.push(er, eg, eb);
  }
  for (i = 0; i < segs; i++){
    var n = (i + 1) % segs;
    I.push(0, 1 + i, 1 + n);                                        /* fan  */
    I.push(1 + i, 1 + segs + i, 1 + segs + n);                      /* skirt */
    I.push(1 + i, 1 + segs + n, 1 + n);
  }
  return { pos: new Float32Array(P), nrm: new Float32Array(N),
           col: new Float32Array(C), idx: new Uint16Array(I) };
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
      bakedBox(0.24, 0.15, 0.05, 1,1,1, 0, 0.235, 0.145)])),  /* back of head (+Z) */
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
    /* shadow: emissive pre-shaded patch (core shader only blends in additive
       mode, so an opaque "pre-shaded" patch reads as a shadow with zero core
       edits). A ROUND blob that fades into the sand at the rim — the old
       hard-edged box read as a hole cut in the ground. */
    shadow: GL.mesh(bakedDisc(0.62, 14, 0.405, 0.290, 0.150, 0.753, 0.537, 0.278))
  };
}
var CORE_OPTS = { emissive: 1, nofog: true };
var SHADOW_OPTS = { emissive: 1 };

/* ---------------- small helpers ---------------- */
function num(v, d){ return (typeof v === 'number' && v === v) ? v : d; }
function clamp(v, lo, hi){ return v < lo ? lo : (v > hi ? hi : v); }
function smooth(s){
  if (s < 0) s = 0; else if (s > 1) s = 1;
  return s * s * (3 - 2 * s);
}
function copy3(o, a){ o[0] = a[0]; o[1] = a[1]; o[2] = a[2]; return o; }
function lerp3(o, a, b, t){
  o[0] = a[0] + (b[0] - a[0]) * t;
  o[1] = a[1] + (b[1] - a[1]) * t;
  o[2] = a[2] + (b[2] - a[2]) * t;
  return o;
}
function norm3(o){
  var l = Math.sqrt(o[0]*o[0] + o[1]*o[1] + o[2]*o[2]);
  if (l < 1e-6){ o[0] = 0; o[1] = 1; o[2] = 0; return o; }
  o[0] /= l; o[1] /= l; o[2] /= l; return o;
}
function max0(x){ return x > 0 ? x : 0; }
function ez(c, t, k){ return c + (t - c) * k; }

/* ======================= ARC ENGINE ========================================
 * An arc is a rotation of the blade about `pivot` in the plane whose normal is
 * `axis` (all body-local). The plane's basis (u,v) is derived from the axis so
 * arcDefs stay readable: u (angle 0) points UP, or FORWARD when the axis is
 * vertical; v = axis X u, so positive angles follow the right-hand rule.
 * Zero allocation after create(): every intermediate lives in a module scratch.
 * ========================================================================== */
var AV = new Float32Array(3);      /* scratch: radial (pivot->blade middle) dir */
var A2 = new Float32Array(2);      /* scratch: [a0, a1] out of dirsToArc        */

function setBasis(a, x, y, z){
  var l = Math.sqrt(x * x + y * y + z * z);
  if (!(l > 1e-6)){ x = -1; y = 0; z = 0; l = 1; }   /* default: sagittal chop */
  x /= l; y /= l; z /= l;
  a.n[0] = x; a.n[1] = y; a.n[2] = z;
  var ux, uy, uz;
  if (y < 0.965 && y > -0.965){       /* angle 0 = UP, projected into the plane */
    ux = -x * y; uy = 1 - y * y; uz = -z * y;
  } else {                            /* vertical axis: angle 0 = FORWARD (-Z) */
    ux = x * z; uy = y * z; uz = z * z - 1;
  }
  l = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
  ux /= l; uy /= l; uz /= l;
  a.u[0] = ux; a.u[1] = uy; a.u[2] = uz;
  a.v[0] = y * uz - z * uy;           /* v = axis X u */
  a.v[1] = z * ux - x * uz;
  a.v[2] = x * uy - y * ux;
}

/* Build a plane + [a0,a1] (into A2) that sweeps direction s -> direction e.
 * Used by the playSwing shim and the default slash. */
function dirsToArc(a, sx, sy, sz, ex, ey, ez){
  var l = Math.sqrt(sx*sx + sy*sy + sz*sz) || 1; sx /= l; sy /= l; sz /= l;
  l = Math.sqrt(ex*ex + ey*ey + ez*ez) || 1; ex /= l; ey /= l; ez /= l;
  var cx = sy*ez - sz*ey, cy = sz*ex - sx*ez, cz = sx*ey - sy*ex;
  var cl = Math.sqrt(cx*cx + cy*cy + cz*cz);
  var dp = sx*ex + sy*ey + sz*ez, ang;
  if (cl < 1e-3){                     /* parallel: swing in the plane s x up */
    cx = -sz; cy = 0; cz = sx;
    if (cx*cx + cz*cz < 1e-4){ cx = 1; cy = 0; cz = 0; }
    ang = 1.3;
  } else {
    ang = Math.atan2(cl, dp);
  }
  setBasis(a, cx, cy, cz);
  A2[0] = Math.atan2(sx*a.v[0] + sy*a.v[1] + sz*a.v[2],
                     sx*a.u[0] + sy*a.u[1] + sz*a.u[2]);
  A2[1] = A2[0] + ang;
  return A2;
}

/* the classic default slash: high outside right -> low across to the left */
var DEFAULT_ARC = {
  dur: 0.40, pivot: new Float32Array([0.06, 1.34, -0.04]), radius: 1.02,
  axis: new Float32Array(3), a0: 0, a1: 1.6, tilt: 0,
  windup: 0.28, recover: 0.26, lunge: 0.16, name: 'SLASH'
};
(function(){
  var tmp = { n: DEFAULT_ARC.axis, u: new Float32Array(3), v: new Float32Array(3) };
  dirsToArc(tmp, 0.52, 0.60, -0.60, -0.60, -0.34, -0.72);
  DEFAULT_ARC.a0 = A2[0]; DEFAULT_ARC.a1 = A2[1];
})();

/* Sample the arc at phase p (0..1) for one side, all in body-local space.
 *   om <- blade MIDDLE (what the IK blends through), od <- blade direction,
 *   oh <- the hand that puts the blade there, AV <- radial dir (torso follow).
 *   sgn -1 mirrors everything across the body's YZ plane (dual off hand). */
function arcSample(a, p, oh, od, om, type, sgn){
  var d = a.a1 - a.a0, wu = a.windup, rc = a.recover;
  var back = a.a0 - BACK_FRAC * d;
  var ang, rs, s;
  if (p < wu){                                     /* anticipation: coil back */
    s = smooth(p / wu);
    ang = a.a0 + (back - a.a0) * s;
    rs = 1 - COIL_R * (0.55 + 0.45 * s);   /* already coiled at p=0: the blade
                                              takes the SHORT way into the cock */
  } else if (p < 1 - rc){                          /* strike: snap, then decel */
    var span = 1 - rc - wu;
    s = span > 1e-4 ? (p - wu) / span : 1;
    if (s > 1) s = 1;
    /* strike curve: 3/4 of a "snap" (angular speed peaks a third of the way in,
     * then decelerates) + 1/4 smoothstep so the follow-through is not all dead
     * time. Both terms start and end at zero speed, so no jerk at either edge. */
    var e = 0.75 * (s * s * (6 - 8 * s + 3 * s * s)) + 0.25 * (s * s * (3 - 2 * s));
    ang = back + (a.a1 - back) * e;
    var x = s * 1.8; if (x > 1) x = 1;
    rs = (1 - COIL_R) + (COIL_R + OVER_R) * smooth(x);   /* arm extends */
  } else {                                         /* follow-through -> guard */
    s = smooth(rc > 1e-4 ? (p - (1 - rc)) / rc : 1);
    ang = a.a1 - SETTLE_FRAC * d * s;
    rs = (1 + OVER_R) - PULL_R * s;
  }
  var bang = ang + (d >= 0 ? LEAD : -LEAD);        /* blade leads the sweep */
  var c = Math.cos(ang), si = Math.sin(ang);
  AV[0] = a.u[0]*c + a.v[0]*si;
  AV[1] = a.u[1]*c + a.v[1]*si;
  AV[2] = a.u[2]*c + a.v[2]*si;
  c = Math.cos(bang); si = Math.sin(bang);
  od[0] = a.u[0]*c + a.v[0]*si;
  od[1] = a.u[1]*c + a.v[1]*si;
  od[2] = a.u[2]*c + a.v[2]*si;
  var r = a.radius * rs;
  if (AV[1] > 0.04){          /* elbow tucks as the blade goes overhead */
    var cap = (CEIL_Y - a.pivot[1] - od[1] * BLADE_LEN * 0.5) / AV[1];
    if (cap < 0.30) cap = 0.30;
    var k = 0.35, h = 0.5 + 0.5 * (cap - r) / k;
    if (h < 0) h = 0; else if (h > 1) h = 1;
    r = cap + (r - cap) * h - k * h * (1 - h);      /* smooth min(r, cap) */
  }
  /* the off hand never holds a staff, so only the right side uses STAFF_TOP */
  var ho = (sgn > 0 && type === 'staff' ? STAFF_TOP : HILT_TOP) + BLADE_LEN * 0.5;
  om[0] = a.pivot[0] + AV[0]*r;
  om[1] = a.pivot[1] + AV[1]*r;
  om[2] = a.pivot[2] + AV[2]*r;
  oh[0] = om[0] - od[0]*ho;
  oh[1] = om[1] - od[1]*ho;
  oh[2] = om[2] - od[2]*ho;
  if (sgn < 0){
    oh[0] = -oh[0]; od[0] = -od[0]; om[0] = -om[0]; AV[0] = -AV[0];
  }
}

/* advance the arc clock and refresh this frame's targets */
function arcUpdate(r, dt){
  var a = r.arc;
  a.t += dt;
  if (a.active && a.t >= a.dur) a.active = false;
  if (a.t >= a.dur + BLEND_OUT){
    a.live = false; a.wIn = 0; a.wOut = 0; a.lungeCur = 0;
    return;
  }
  var p = a.t / a.dur; if (p > 1) p = 1; else if (p < 0) p = 0;
  a.wIn = smooth(a.t / a.blendIn);
  a.wOut = a.t <= a.dur ? 1 : smooth(1 - (a.t - a.dur) / BLEND_OUT);

  arcSample(a, p, a.hR, a.dR, a.mR, r.type, 1);
  a.twist = TW_GAIN * -AV[0];                 /* chest rotates into the swing */
  a.lean  = LN_GAIN * LEAN_SIGN * AV[1];      /* overheads arch, then hunch */
  if (a.mirror){
    var pl = (a.t - DUAL_PHASE * a.dur) / a.dur;
    if (pl < 0) pl = 0; else if (pl > 1) pl = 1;
    arcSample(a, pl, a.hL, a.dL, a.mL, r.type, -1);
  }

  var lp = 0;                                  /* lunge pushes during the strike */
  if (p > a.windup){
    var sp = 1 - a.recover - a.windup; if (sp < 1e-3) sp = 1e-3;
    var s = (p - a.windup) / sp; if (s > 1) s = 1;
    lp = smooth(s * 2 > 1 ? 1 : s * 2);
    if (p > 1 - a.recover)
      lp *= 1 - 0.7 * smooth((p - (1 - a.recover)) / (a.recover || 1e-3));
  }
  a.lungeCur = a.lungeAmt * lp * a.wOut;
}

/* Body-local blade middle + direction of the PROCEDURAL arm pose. Used only when
 * a new arc starts and the rig has not been drawn recently (off-screen bots), so
 * the blend still has a real pose to come out of instead of popping. */
var mLocA = M.make();
function fkLocal(r, side, outM, outD){
  var p = r.pose;
  M.ident(mLocA);
  M.tr(mLocA, 0, HIP_Y + p.bob + PELV2TORSO, 0);
  M.ry(mLocA, p.twist); M.rx(mLocA, p.lean);
  M.tr(mLocA, side * SH_X, SH_Y, 0);
  if (side > 0){ M.rz(mLocA, p.sprR); M.ry(mLocA, p.syR); M.rx(mLocA, p.aSwR); }
  else { M.rz(mLocA, -p.sprL); M.ry(mLocA, p.syL); M.rx(mLocA, p.aSwL); }
  M.tr(mLocA, 0, -UARM, 0); M.rx(mLocA, side > 0 ? p.elbR : p.elbL);
  M.tr(mLocA, 0, -LARM, 0); M.rx(mLocA, side > 0 ? p.wrist : p.wrL);
  if (side > 0) M.rz(mLocA, p.wrr);
  var ho = (r.type === 'staff' ? STAFF_TOP : HILT_TOP) + BLADE_LEN * 0.5;
  outD[0] = mLocA[4]; outD[1] = mLocA[5]; outD[2] = mLocA[6];
  outM[0] = mLocA[12] + outD[0] * ho;
  outM[1] = mLocA[13] + outD[1] * ho;
  outM[2] = mLocA[14] + outD[2] * ho;
}

function playArc(def){
  var a = this.arc;
  if (a.active && a.t < a.dur * CHAIN_FRAC) return false;   /* not chainable yet */
  if (!def) def = DEFAULT_ARC;
  var pv = def.pivot, ax = def.axis;
  a.pivot[0] = pv ? num(pv[0],  0.06) :  0.06;
  a.pivot[1] = pv ? num(pv[1],  1.34) :  1.34;
  a.pivot[2] = pv ? num(pv[2], -0.04) : -0.04;
  a.radius = clamp(num(def.radius, 1.02), 0.45, 1.70);
  setBasis(a, ax ? num(ax[0], -1) : -1, ax ? num(ax[1], 0) : 0, ax ? num(ax[2], 0) : 0);
  a.a0 = num(def.a0, -0.9);
  a.a1 = num(def.a1, 1.9);
  var d = a.a1 - a.a0;                          /* keep the sweep sane */
  if (d > 3.4) a.a1 = a.a0 + 3.4;
  else if (d < -3.4) a.a1 = a.a0 - 3.4;
  else if (d < 0.3 && d > -0.3) a.a1 = a.a0 + (d < 0 ? -0.3 : 0.3);
  a.tilt = num(def.tilt, 0);
  var wu = clamp(num(def.windup, 0.28), 0.05, 0.50);
  var rc = clamp(num(def.recover, 0.24), 0.02, 0.45);
  if (wu + rc > 0.82){ var k = 0.82 / (wu + rc); wu *= k; rc *= k; }
  a.windup = wu; a.recover = rc;
  a.lungeAmt = clamp(num(def.lunge, 0), -0.4, 1.2);
  a.dur = clamp(num(def.dur, SWING_DUR), 0.10, 3);
  /* the anticipation IS the blend out of the previous pose */
  a.blendIn = Math.max(BLEND_IN, wu * a.dur * 0.9);
  a.mirror = (this.type === 'dual') || !!def.mirror;
  a.name = def.name || '';
  a.t = 0; a.active = true; a.live = true;
  a.wIn = 0; a.wOut = 1; a.lungeCur = 0;
  /* Blend FROM whatever the blade is doing right now (idle guard, or the middle
     of the previous arc when chaining) so nothing ever teleports. The live pose
     is only known after a draw, so ignore it if this rig has been advanced
     without being rendered (off-screen bots) — a stale pose would pop. */
  if (a.hasCur && a.snapAge <= 2){
    copy3(a.snapM, a.curM); copy3(a.snapD, a.curD);
    copy3(a.snapML, a.curML); copy3(a.snapDL, a.curDL);
  } else {
    fkLocal(this,  1, a.snapM,  a.snapD);
    fkLocal(this, -1, a.snapML, a.snapDL);
  }
  arcUpdate(this, 0);
  this.swingT = 0;
  return true;
}

/* ---- compatibility shim: iteration-2 keyframe defs -> an arc -------------- */
var SHIM_AXIS = new Float32Array(3);
var SHIM = { dur: 0.4, pivot: new Float32Array([0.06, 1.34, -0.04]), radius: 1.02,
  axis: SHIM_AXIS, a0: 0, a1: 1.6, tilt: 0, windup: 0.28, recover: 0.24,
  lunge: 0, name: '', mirror: false };
var SHIM_BASIS = { n: SHIM_AXIS, u: new Float32Array(3), v: new Float32Array(3) };
var SD0 = new Float32Array(3), SD1 = new Float32Array(3);

/* Where the idle guard points the blade (body-local, unit): up-forward ~38 deg.
 * The tip has to travel from here into the arc's cocked pose, so an a0 far from
 * this costs real path — see the AUTHORING NOTE in the header. */
var GUARD_DIR = new Float32Array([-0.09, 0.62, -0.78]);

/* pull d toward the guard until it is at most `lim` radians away (shim only:
 * playArc always honours the author's a0 exactly) */
function limitFromGuard(d, lim){
  var c = d[0]*GUARD_DIR[0] + d[1]*GUARD_DIR[1] + d[2]*GUARD_DIR[2];
  if (c > 1) c = 1; else if (c < -1) c = -1;
  var ang = Math.acos(c);
  if (ang <= lim || ang < 1e-4) return;
  var t = 1 - lim / ang;
  d[0] += (GUARD_DIR[0] - d[0]) * t;
  d[1] += (GUARD_DIR[1] - d[1]) * t;
  d[2] += (GUARD_DIR[2] - d[2]) * t;
  norm3(d);
}

/* a key's (shoulder pitch, shoulder yaw) read as a blade direction from the chest */
function keyDir(o, sp, sy){
  var el = clamp(sp * 0.62 - 0.32, -1.15, 1.30);   /* elevation */
  var az = clamp(sy * 1.15, -1.45, 1.45);          /* azimuth, + = left */
  var ce = Math.cos(el);
  o[0] = -ce * Math.sin(az);
  o[1] = Math.sin(el);
  o[2] = -ce * Math.cos(az);
}

function playSwing(def){
  if (!def || !def.keys || !def.keys.length) return this.playArc(DEFAULT_ARC);
  var keys = def.keys, n = keys.length, i, k, t;
  var kS = null, tS = 0, best = -1, kE = null, tE = -1, lg = 0;
  for (i = 0; i < n; i++){
    k = keys[i]; if (!k) continue;
    t = num(k.t, n > 1 ? i / (n - 1) : 0.5);
    if (t <= 0.40){                       /* the cocked / wind-up key */
      var m = Math.abs(num(k.sy, 0)) + Math.abs(num(k.sp, 0.5) - 0.5) * 0.55;
      if (m > best){ best = m; kS = k; tS = t; }
    }
    if (t <= 0.86 && t > tE){ tE = t; kE = k; }   /* the follow-through key */
    var lu = Math.abs(num(k.lunge, 0)); if (lu > lg) lg = lu;
  }
  if (!kS){ kS = keys[0]; tS = num(kS.t, 0); }
  if (!kE || kE === kS){ kE = keys[n - 1]; tE = num(kE.t, 1); }
  keyDir(SD0, num(kS.sp, 0.5), num(kS.sy, 0));
  keyDir(SD1, num(kE.sp, 0.5), num(kE.sy, 0));
  limitFromGuard(SD0, 0.95);       /* keep the cock-back reachable from guard */
  dirsToArc(SHIM_BASIS, SD0[0], SD0[1], SD0[2], SD1[0], SD1[1], SD1[2]);
  SHIM.a0 = A2[0];
  SHIM.a1 = A2[0] + clamp(A2[1] - A2[0], 1.40, 2.00);   /* readable sweep */
  SHIM.dur = num(def.dur, SWING_DUR);
  SHIM.windup = clamp(tS + 0.08, 0.14, 0.42);
  SHIM.recover = clamp(1 - tE - 0.04, 0.10, 0.38);
  SHIM.lunge = lg;
  SHIM.mirror = !!def.mirror;
  SHIM.name = def.name || '';
  return this.playArc(SHIM);
}

function swingPhase(){
  var a = this.arc;
  return a.active ? a.t / a.dur : -1;
}
function startSwing(){ return this.playArc(DEFAULT_ARC); }

/* ======================= TWO-BONE IK ======================================= */
var ikE = new Float32Array(3);   /* elbow */
var ikH = new Float32Array(3);   /* reached (clamped) hand position */
var ikN = new Float32Array(3);   /* bend-plane normal */

/* Solve upper/lower so the hand lands on T (clamped into reach). `pole` is a
 * unit-ish direction the elbow is pushed toward — stable = no inside-out snap. */
function solveIK(S, T, upper, lower, pole){
  var dx = T[0] - S[0], dy = T[1] - S[1], dz = T[2] - S[2];
  var L = Math.sqrt(dx*dx + dy*dy + dz*dz);
  if (L < 1e-4){                       /* target AT the shoulder: aim down-pole */
    dx = pole[0]; dy = pole[1]; dz = pole[2];
    L = Math.sqrt(dx*dx + dy*dy + dz*dz);
    if (L < 1e-4){ dx = 0; dy = -1; dz = 0; L = 1; }
  }
  var nx = dx / L, ny = dy / L, nz = dz / L;
  var maxL = (upper + lower) * 0.995;
  var minL = Math.abs(upper - lower) + 0.06;
  if (L > maxL) L = maxL; else if (L < minL) L = minL;
  ikH[0] = S[0] + nx * L; ikH[1] = S[1] + ny * L; ikH[2] = S[2] + nz * L;
  /* in-plane component of the pole */
  var d = pole[0]*nx + pole[1]*ny + pole[2]*nz;
  var qx = pole[0] - nx*d, qy = pole[1] - ny*d, qz = pole[2] - nz*d;
  var ql = Math.sqrt(qx*qx + qy*qy + qz*qz);
  if (ql < 1e-3){                      /* pole parallel to the reach: any perp */
    qx = -nz; qy = 0; qz = nx;
    ql = Math.sqrt(qx*qx + qz*qz);
    if (ql < 1e-3){ qx = 1; qy = 0; qz = 0; ql = 1; }
  }
  qx /= ql; qy /= ql; qz /= ql;
  var ca = (L*L + upper*upper - lower*lower) / (2 * L * upper);
  if (ca > 1) ca = 1; else if (ca < -1) ca = -1;
  var sa = Math.sqrt(1 - ca*ca);
  ikE[0] = S[0] + upper * (ca*nx + sa*qx);
  ikE[1] = S[1] + upper * (ca*ny + sa*qy);
  ikE[2] = S[2] + upper * (ca*nz + sa*qz);
  ikN[0] = ny*qz - nz*qy;              /* unit: n and q are orthonormal */
  ikN[1] = nz*qx - nx*qz;
  ikN[2] = nx*qy - ny*qx;
}

/* m <- orthonormal frame at o with the given X and Y axes (Z = X x Y) */
function setFrame(m, ox, oy, oz, xx, xy, xz, yx, yy, yz){
  m[0] = xx; m[1] = xy; m[2] = xz; m[3] = 0;
  m[4] = yx; m[5] = yy; m[6] = yz; m[7] = 0;
  m[8]  = xy*yz - xz*yy;
  m[9]  = xz*yx - xx*yz;
  m[10] = xx*yy - xy*yx;
  m[11] = 0;
  m[12] = ox; m[13] = oy; m[14] = oz; m[15] = 1;
}

/* ---------------- instance setters ---------------- */
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

/* ---------------- per-instance animation step ---------------- */
function advance(dt, t, anim, speed){
  var p = this.pose, a = this.arc;
  var sp = speed || 0;

  var stride = 2.2 + sp * 0.16;
  if (stride < 2.4) stride = 2.4; else if (stride > 3.6) stride = 3.6;
  this.phase += sp * dt * TWO_PI / stride;
  if (this.phase > TWO_PI) this.phase -= TWO_PI;
  var ph = this.phase;

  var lSwL, lSwR, kneeL, kneeR, aSwL, aSwR, sprL, sprR, elbL, elbR, wrist;
  var lean, twist, bob, head;
  var syR = 0, syL = 0, wrL = 0, wrr = 0;

  if (anim === 'run' || anim === 'sprint'){
    var fast = anim === 'sprint';
    var A = fast ? 0.96 : 0.70;               /* +-55 deg / +-40 deg hips */
    var s1 = Math.sin(ph);
    var kAmp = fast ? 1.35 : 1.05;
    lSwL = A * s1;             lSwR = -A * s1;
    kneeL = -(0.22 + kAmp * max0(Math.cos(ph + 0.5)));
    kneeR = -(0.22 + kAmp * max0(-Math.cos(ph + 0.5)));
    aSwL = 0.06 - (fast ? 0.85 : 0.55) * s1;  /* counter-swing */
    aSwR = 0.42 + (fast ? 0.40 : 0.26) * s1;  /* saber arm carries a guard */
    sprL = 0.14; sprR = 0.16;
    elbL = 0.60; elbR = 0.70;
    wrist = -2.02;                            /* blade angled up and FORWARD */
    lean = fast ? 0.26 : 0.14;
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
  } else {                                    /* idle: breathe, saber on guard */
    lSwL = 0.05; lSwR = -0.05;
    kneeL = -0.09; kneeR = -0.09;
    aSwL = 0.10; aSwR = 0.30;
    sprL = 0.10; sprR = 0.14;
    elbL = 0.28; elbR = 0.45;
    wrist = -1.65 + 0.05 * Math.sin(t * 1.1); /* hilt at the hip, blade up-forward */
    lean = 0.04; twist = 0;
    bob = 0.013 * Math.sin(t * 1.7);
    head = 0.03 * Math.sin(t * 0.7);
  }

  /* ---- saber-type grip overrides (procedural layer) ---- */
  if (this.type === 'dual' && this.saberOn){
    /* Left hand carries a live blade: it mirrors the saber guard (blade up and
       FORWARD, no floppy counter-swing) so a mirrored arc does not have to whip
       the left blade across the body just to get started. */
    if (anim === 'run' || anim === 'sprint'){
      aSwL = 0.42 - 0.26 * Math.sin(ph);
      sprL = 0.16; elbL = 0.70; syL = -0.10; wrL = -2.02;
    } else if (anim === 'idle'){
      aSwL = 0.30; sprL = 0.14; elbL = 0.45; syL = -0.12;
      wrL = -1.65 + 0.05 * Math.sin(t * 1.3);
    }
  } else if (this.type === 'staff'){
    /* Maul carry: angled across the body, but kept near the saber guard so a
       swing does not have to whip 2.9 m of blade across the screen to start. */
    if (anim === 'idle'){
      aSwR = 0.40; syR = 0.30; sprR = 0.06; elbR = 0.50;
      wrist = -1.35; wrr = 0.45;
      twist += 0.10;
      aSwL = 0.28; sprL = 0.24; elbL = 0.55;  /* off hand up and ready */
    } else if (anim === 'run' || anim === 'sprint'){
      aSwR = 0.36 + 0.18 * Math.sin(ph);      /* calm carry, blade tilted */
      sprR = 0.10; elbR = 0.55; wrist = -1.40; wrr = 0.30;
    }
  }

  /* ---- arc lifecycle ---- */
  a.snapAge++;
  if (a.live) arcUpdate(this, dt);
  var w = a.live ? a.wIn * a.wOut : 0;
  if (a.live){
    twist = twist * (1 - w) + a.twist * w;    /* torso follows the arc */
    lean  = lean  * (1 - w) + a.lean  * w;
    if (!a.mirror){                           /* off arm counterbalances */
      aSwL += 0.30 * w; sprL += 0.28 * w; syL += 0.22 * w;
    }
    wrr = 0;
  }

  /* exponential ease toward targets (~0.12 s blend) */
  var kA = 1 - Math.exp(-26 * dt);            /* limbs */
  var kB = 1 - Math.exp(-14 * dt);            /* body mass */
  var kT = a.live ? 1 - Math.exp(-40 * dt) : kB;   /* torso snaps in a swing */
  p.lSwL = ez(p.lSwL, lSwL, kA);   p.lSwR = ez(p.lSwR, lSwR, kA);
  p.kneeL = ez(p.kneeL, kneeL, kA); p.kneeR = ez(p.kneeR, kneeR, kA);
  p.aSwL = ez(p.aSwL, aSwL, kA);   p.sprL = ez(p.sprL, sprL, kA);
  p.elbL = ez(p.elbL, elbL, kA);   p.syL = ez(p.syL, syL, kA);
  p.wrL = ez(p.wrL, wrL, kA);
  p.aSwR = ez(p.aSwR, aSwR, kA);   p.sprR = ez(p.sprR, sprR, kA);
  p.elbR = ez(p.elbR, elbR, kA);   p.wrist = ez(p.wrist, wrist, kA);
  p.syR = ez(p.syR, syR, kA);      p.wrr = ez(p.wrr, wrr, kA);
  p.bob = ez(p.bob, bob, kB);      p.lean = ez(p.lean, lean, kT);
  p.twist = ez(p.twist, twist, kT); p.head = ez(p.head, head, kB);

  if (a.live){
    this.lunge = a.lungeCur;
    this.swingT = a.active ? a.t : -1;
  } else {
    this.swingT = -1;
    this.lunge = ez(this.lunge, 0, kB);       /* settle any leftover lunge */
  }
}

/* ---------------- render (module-scope matrix pool: zero alloc) ------------- */
var mRoot = M.make(), mPelv = M.make(), mTorso = M.make(), mA = M.make(), mS = M.make();
var mHR = M.make(), mHL = M.make();           /* hand frames kept for blade pass */
var mUR = M.make(), mFR = M.make();           /* right upper arm / forearm */
var mUL = M.make(), mFL = M.make();           /* left  upper arm / forearm */
/* world-space IK scratch */
var wS = new Float32Array(3), wT = new Float32Array(3), wB = new Float32Array(3),
    wP = new Float32Array(3), wX = new Float32Array(3), wY = new Float32Array(3),
    wR = new Float32Array(3), wQ = new Float32Array(3);

/* forward-kinematic arm chain from the torso frame */
function fkArm(mU, mF, mH, shx, roll, yaw, pitch, elb, wr, wroll){
  M.copy(mU, mTorso); M.tr(mU, shx, SH_Y, 0);
  M.rz(mU, roll); M.ry(mU, yaw); M.rx(mU, pitch);
  M.copy(mF, mU); M.tr(mF, 0, -UARM, 0); M.rx(mF, elb);
  M.copy(mH, mF); M.tr(mH, 0, -LARM, 0); M.rx(mH, wr); M.rz(mH, wroll);
}

/* Re-pose one arm so the hand reaches the arc target, blending out of (wIn) the
 * pose we came from and back into (wOut) the procedural FK pose in mH. */
/* Blending happens in BLADE-MIDDLE space, not hand space: a saber cocking back
 * pivots roughly about the middle of the blade (hilt drops as the tip rises), so
 * the tip takes the short way round instead of being shoved across the body. */
function ikArm(mU, mF, mH, shx, mLoc, dLoc, snapM, snapD, tilt, wIn, wOut, side, ref, ho){
  M.xp(wT, mRoot, mLoc[0], mLoc[1], mLoc[2]);          /* arc blade middle -> world */
  M.xd(wB, mRoot, dLoc[0], dLoc[1], dLoc[2]);
  if (wIn < 1){                                        /* ...from the snapshot */
    M.xp(wX, mRoot, snapM[0], snapM[1], snapM[2]);
    M.xd(wY, mRoot, snapD[0], snapD[1], snapD[2]);
    lerp3(wT, wX, wT, wIn); lerp3(wB, wY, wB, wIn);
  }
  if (wOut < 1){                                       /* ...back to procedural */
    wY[0] = mH[4];  wY[1] = mH[5];  wY[2] = mH[6];
    wX[0] = mH[12] + wY[0]*ho; wX[1] = mH[13] + wY[1]*ho; wX[2] = mH[14] + wY[2]*ho;
    lerp3(wT, wX, wT, wOut); lerp3(wB, wY, wB, wOut);
  }
  norm3(wB);
  wT[0] -= wB[0]*ho; wT[1] -= wB[1]*ho; wT[2] -= wB[2]*ho;   /* middle -> hand */
  M.xp(wS, mTorso, shx, SH_Y, 0);                      /* shoulder joint */
  M.xd(wP, mTorso, side * 0.30, -0.86, 0.44);          /* elbow pole: down-back */
  norm3(wP);
  solveIK(wS, wT, UARM, LARM, wP);
  setFrame(mU, wS[0], wS[1], wS[2], ikN[0], ikN[1], ikN[2],
    (wS[0] - ikE[0]) / UARM, (wS[1] - ikE[1]) / UARM, (wS[2] - ikE[2]) / UARM);
  setFrame(mF, ikE[0], ikE[1], ikE[2], ikN[0], ikN[1], ikN[2],
    (ikE[0] - ikH[0]) / LARM, (ikE[1] - ikH[1]) / LARM, (ikE[2] - ikH[2]) / LARM);
  /* hand: +Y is the blade; roll it about the blade by `tilt` */
  wQ[0] = wB[1]*ref[2] - wB[2]*ref[1];
  wQ[1] = wB[2]*ref[0] - wB[0]*ref[2];
  wQ[2] = wB[0]*ref[1] - wB[1]*ref[0];
  if (wQ[0]*wQ[0] + wQ[1]*wQ[1] + wQ[2]*wQ[2] < 1e-6){ wQ[0] = ikN[0]; wQ[1] = ikN[1]; wQ[2] = ikN[2]; }
  norm3(wQ);
  var c = Math.cos(tilt), s = Math.sin(tilt);
  var xx = wQ[0]*c + (wB[1]*wQ[2] - wB[2]*wQ[1])*s;
  var xy = wQ[1]*c + (wB[2]*wQ[0] - wB[0]*wQ[2])*s;
  var xz = wQ[2]*c + (wB[0]*wQ[1] - wB[1]*wQ[0])*s;
  setFrame(mH, ikH[0], ikH[1], ikH[2], xx, xy, xz, wB[0], wB[1], wB[2]);
}

function renderRig(r, pos, yaw){
  var GL = JK.GL, p = r.pose, a = r.arc;
  var dual = r.type === 'dual', staff = r.type === 'staff';
  var HO = (staff ? STAFF_TOP : HILT_TOP) + BLADE_LEN * 0.5;   /* hand -> blade middle */

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

  /* arc influence + swing-plane reference for the blade roll */
  var arcOn = a.live && (a.wIn * a.wOut) > 0.001;
  if (arcOn){
    M.xd(wR, mRoot, a.n[0], a.n[1], a.n[2]);
    norm3(wR);
  }

  /* left arm (mirrored arc when dual) */
  fkArm(mUL, mFL, mHL, -SH_X, -p.sprL, p.syL, p.aSwL, p.elbL, p.wrL, 0);
  if (arcOn && a.mirror){
    M.xd(wR, mRoot, -a.n[0], a.n[1], a.n[2]); norm3(wR);   /* mirrored plane */
    ikArm(mUL, mFL, mHL, -SH_X, a.mL, a.dL, a.snapML, a.snapDL,
          -a.tilt, a.wIn, a.wOut, -1, wR, HILT_TOP + BLADE_LEN * 0.5);
    M.xd(wR, mRoot, a.n[0], a.n[1], a.n[2]); norm3(wR);
  }
  GL.draw(MESH.uarm, mUL, r.oTunic);
  GL.draw(MESH.larm, mFL, r.oTunic);
  GL.draw(MESH.hand, mHL, r.oSkin);
  if (dual) GL.draw(MESH.hilt, mHL, null);

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

  /* right (saber) arm */
  fkArm(mUR, mFR, mHR, SH_X, p.sprR, p.syR, p.aSwR, p.elbR, p.wrist, p.wrr);
  if (arcOn)
    ikArm(mUR, mFR, mHR, SH_X, a.mR, a.dR, a.snapM, a.snapD,
          a.tilt, a.wIn, a.wOut, 1, wR, HO);
  GL.draw(MESH.uarm, mUR, r.oTunic);
  GL.draw(MESH.larm, mFR, r.oTunic);
  GL.draw(MESH.hand, mHR, r.oSkin);
  GL.draw(staff ? MESH.hiltS : MESH.hilt, mHR, null);

  /* --- remember the effective hand poses (body-local) so the next arc can
     blend out of exactly what we are drawing right now --- */
  var cy = Math.cos(yaw), sy = Math.sin(yaw), dx, dy, dz;
  dx = mHR[12] + mHR[4]*HO - px; dy = mHR[13] + mHR[5]*HO - pos[1];
  dz = mHR[14] + mHR[6]*HO - pz;
  a.curM[0] = cy*dx - sy*dz; a.curM[1] = dy; a.curM[2] = sy*dx + cy*dz;
  a.curD[0] = cy*mHR[4] - sy*mHR[6]; a.curD[1] = mHR[5];
  a.curD[2] = sy*mHR[4] + cy*mHR[6];
  dx = mHL[12] + mHL[4]*HO - px; dy = mHL[13] + mHL[5]*HO - pos[1];
  dz = mHL[14] + mHL[6]*HO - pz;
  a.curML[0] = cy*dx - sy*dz; a.curML[1] = dy; a.curML[2] = sy*dx + cy*dz;
  a.curDL[0] = cy*mHL[4] - sy*mHL[6]; a.curDL[1] = mHL[5];
  a.curDL[2] = sy*mHL[4] + cy*mHL[6];
  a.hasCur = true; a.snapAge = 0;

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
  var rig = {
    pose: { bob: 0, lean: 0.04, twist: 0, head: 0,
      lSwL: 0.05, lSwR: -0.05, kneeL: -0.09, kneeR: -0.09,
      aSwL: 0.10, aSwR: 0.30, sprL: 0.10, sprR: 0.14,
      elbL: 0.28, elbR: 0.45, wrist: -1.65,
      syL: 0, syR: 0, wrL: 0, wrr: 0 },
    phase: 0,
    swingT: -1,
    lunge: 0,
    type: 'single',
    arc: {
      live: false, active: false, t: 0, dur: SWING_DUR,
      pivot: new Float32Array([0.06, 1.34, -0.04]), radius: 1.02,
      u: new Float32Array(3), v: new Float32Array(3), n: new Float32Array(3),
      a0: 0, a1: 1.6, tilt: 0, windup: 0.28, recover: 0.24,
      lungeAmt: 0, lungeCur: 0, mirror: false, name: '', blendIn: BLEND_IN,
      wIn: 0, wOut: 0, twist: 0, lean: 0, snapAge: 99,
      hR: new Float32Array(3), dR: new Float32Array([0, 1, 0]), mR: new Float32Array(3),
      hL: new Float32Array(3), dL: new Float32Array([0, 1, 0]), mL: new Float32Array(3),
      snapD: new Float32Array([0, 1, 0]), snapDL: new Float32Array([0, 1, 0]),
      snapM: new Float32Array(3), snapML: new Float32Array(3),
      curM: new Float32Array(3), curD: new Float32Array([0, 1, 0]),
      curML: new Float32Array(3), curDL: new Float32Array([0, 1, 0]),
      hasCur: false
    },
    saberOn: true,
    saberCol: col3(null, [0.2, 0.9, 0.3]),
    basePos: new Float32Array(3),
    tipPos: new Float32Array(3),
    advance: advance,
    draw: instanceDraw,
    startSwing: startSwing,
    playArc: playArc,
    playSwing: playSwing,
    swingPhase: swingPhase,
    setType: setType,
    setSaber: setSaber
  };
  setBasis(rig.arc, -1, 0, 0);
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
  DEFAULT_ARC: DEFAULT_ARC,
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
          if (player.playArc(DEFAULT_ARC)) P.attackQueued = false;
        } else if (P.attackQueued === undefined &&
                   JK.Input && JK.Input.state && JK.Input.state.attack){
          player.startSwing();
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
  playArc: function(def){ return player ? player.playArc(def) : false; },
  playSwing: function(def){ return player ? player.playSwing(def) : false; },
  swingPhase: function(){ return player ? player.swingPhase() : -1; }
};
})();
