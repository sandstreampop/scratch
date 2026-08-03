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
 *   - BODY CLEARANCE IS AUTOMATIC. You do not have to keep an arc away from the
 *     character: whatever the arc (and whatever pose the blend into it passes
 *     through), the weapon is slid clear of a no-go volume around the
 *     head/chest/hips — see BODY_RX. Wind-ups therefore coil over the SHOULDER
 *     rather than the sternum, which reads better anyway. Measured clearance and
 *     its LIMITS are stated at BODY_RX; the slide is PLANNED per swing (PROF_N),
 *     never reacted to, because a correction that arrives in one frame is a
 *     visible teleport of the weapon.
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
/* Shoulder socket. The torso is 0.40 wide (half 0.20), so a shoulder at 0.26
 * put the 0.12-wide upper arm's inner face EXACTLY on the torso's side plane:
 * every roll/yaw of the arm then swung it clear and opened a visible slot at
 * the socket (box/box SAT over 109k shoulder orientations: worst separation
 * 0.020 m, at roll -1.75 / yaw 1.57 — i.e. the airborne pose). The
 * socket now sits INSIDE the torso's side plane and the arm mesh carries a
 * near-cubic deltoid centred on the joint (see buildMeshes), whose smallest
 * half-extent (SH_CAP) is what guarantees the weld: whatever the arm's
 * orientation, the deltoid's surface is at least SH_CAP from the joint, so it
 * always crosses the torso side plane at 0.20.  0.245 - 0.083 = 0.162 < 0.20,
 * i.e. 0.038 m of overlap in EVERY pose, and the deltoid always covers the
 * joint itself. */
var SH_X = 0.245, SH_Y = 0.44;     /* shoulder offset in torso frame */
var SH_CAP = 0.083;                /* deltoid min half-extent (see above) */
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
var LUNGE_CARRY = 0.22;   /* s to unload a chained-out-of lunge (see arcUpdate) */
var POSE_DT   = 1 / 60;   /* last advance()'s dt: one frame is one dt for every
                             rig in the game, so this is shared, not per-rig    */

/* ---------------- body clearance (the weapon never cuts its owner) ---------
 * The weapon is a 1.4 m line (2.9 m for a staff) rigidly attached to a hand that
 * the arc engine swings around a pivot INSIDE the chest. Left alone it goes
 * through its owner. So a no-go volume around the spine is defined, and the WHOLE
 * WEAPON is translated in the body's XZ plane by exactly the amount needed to
 * leave it. The translation is derived from the violation, so it is identically
 * zero for the whole strike (the blade is a metre out by then) and the arc the
 * player reads is untouched: only the coil moves, from over the sternum to over
 * the shoulder — which is where a saber is actually cocked, so the anticipation
 * reads stronger, not flatter.
 *
 * TWO THINGS MAKE THAT HARDER THAN IT SOUNDS, and both were live defects here:
 *   1. The translation must be CONTINUOUS IN TIME. A correction that switches on
 *      in one frame IS a teleport of the weapon — see clearPush's history note:
 *      0.50 m of hand movement in a single 60 fps frame, a 358 m/s wind-up tip
 *      speed against a 36 m/s strike, on three of the twelve attacks. So it is
 *      PLANNED for the whole swing up front and rate-limited (see PROF_N).
 *   2. Sliding OUTBOARD cannot clear a weapon that lies ACROSS the body, which
 *      is exactly what a cross-body coil is. The escape direction is therefore
 *      CHOSEN per swing out of four candidates (see playArc).
 *
 * MEASURED (independent probe: 12 attacks x 3 saber types x 121 phase samples per
 * swing, plus 3 s of each of the five procedural anims; blade AND HILT segments
 * against the head / torso / pelvis boxes rebuilt from the MODEL MATRICES
 * ACTUALLY DRAWN; head box = the full skull + hair + brow + nose envelope; the
 * player yawed off-axis so a body/world mix-up could not hide). Worst signed
 * clearance over all attacks, metres, negative = interpenetrating:
 *                head             torso            pelvis
 *   single    0.087 -> 0.087   -0.110 -> +0.012   -0.045 -> +0.072
 *   dual      0.054 -> 0.087   -0.120 -> -0.014   -0.045 -> +0.057
 *   staff     0.012 -> 0.046   -0.120 -> -0.105   -0.084 -> -0.090
 * All five procedural anims are clear by >= 0.14 m and were not touched.
 *
 * KNOWN REMAINING DEFECT — the STAFF's three cross-body attacks (SNAP CUT RIGHT,
 * FALLING STAR, AVALANCHE) still put the hilt up to 0.105 m inside the torso box
 * during the coil, at phase 0.09-0.13. Its two blades are COLLINEAR through the
 * hand, so the weapon is a 2.9 m line through the grip; on those arcs that line
 * crosses the spine at the coil with the hand itself only 0.14 m off it, and NO
 * single translation inside BODY_MAX clears it. It is the authored blade
 * ORIENTATION for a centre-gripped staff — a radial blade where a tangential one
 * is wanted — and that lives in 50_sabers.js, not in the rig. Do not try to fix
 * it by raising BODY_MAX: measured, 0.46 bought 0.01 m and cost the swing
 * probe's pathOverSpan budget. Everything else, including all of single and all
 * but one marginal frame of dual, is clear.
 */
/* The no-go volume is an ELLIPTICAL column, not a circular one. The body is
 * 0.40 wide and 0.24 deep, so a circle big enough to contain it over-reaches by
 * 0.18 m in FRONT — and a blade sweeping cleanly down the front of the chest was
 * then shoved outboard for most of the strike, which is displacement the swing
 * probe counts as tip PATH (pathOverSpan) for no clearance gain at all. Measured,
 * switching to the ellipse: worst torso clearance single -0.021 -> +0.012, single
 * pelvis -0.044 -> +0.072, dual pelvis -0.045 -> +0.057, and METEOR SMASH's
 * pathOverSpan came back down off the 1.90 limit. */
var BODY_RX   = 0.29;     /* half-width (X) of the no-go ellipse  */
var BODY_RZ   = 0.225;    /* half-depth (Z). Contains every body box: the torso's
                             corner (0.20,0.12) sits at 0.76 of the ellipse and the
                             hair's nape (0.1225,0.1725) at 0.77.               */
var IRX2 = 1 / (BODY_RX * BODY_RX), IRZ2 = 1 / (BODY_RZ * BODY_RZ);
var BODY_Y0   = 0.80;     /* bottom: underside of the hips box                   */
var BODY_Y1   = 1.88;     /* top: crown of the hair                              */
var BODY_FADE = 0.16;     /* smooth ends, so the push never steps                */
var BODY_MAX  = 0.38;     /* never displace the weapon further than this         */
var BODY_DEEP = 0.20;     /* how far INTO the ellipse (normalised, 0 at the wall,
                             1 at the spine) the push fades in over. 0.20 reaches
                             full strength by the body-box envelope (0.77), so the
                             boxes always get the whole push while the outer shell
                             is a soft landing instead of a step.               */
var WEAP_N    = 22;       /* samples along the weapon (~0.07 m apart)            */
var HILT_BOT  = 0.15;     /* the weapon also exists BELOW the hand: the hilt box
                             runs to -0.14 (pommel) in hand space, and it used to
                             be excluded from the clearance test entirely — which
                             is where every single/dual interpenetration measured
                             in this file lived. See clearPush's callers.        */
/* ---- the clearance slide is PLANNED, not reacted to -----------------------
 * clearPush is continuous but its gradient is not gentle: it asks for ~0.25 m
 * over the 5 cm of blade travel the depth fade spans, and a blade moving at
 * 20 m/s crosses that in 2 ms. Applied raw it is a pop; rate-limited reactively
 * it arrives too late and the hilt is already through the chest (measured both
 * ways: raw -> 0.50 m of hand movement in one 60 fps frame; reactive-only at
 * 3.4 m/s -> the torso box back to -0.120 m).
 *
 * So the whole slide is worked out ONCE per swing. A swing's pose is a known
 * function of time — arcSample blended against the pose it started from — so
 * playArc walks the entire swing, asks clearPush what it needs at PROF_N+1
 * instants, and stores the answer as a profile. The profile is then dilated by
 * one step and SLOPE-LIMITED in both directions, which can only ever RAISE a
 * sample: the slide therefore starts moving BEFORE the blade needs it (the
 * anticipation absorbs it, exactly as the pose blend does) and never changes
 * faster than PUSH_RATE. Clearance is preserved by construction, and the
 * runtime cost is one lerp.
 * A rate-limited REACTIVE term is still kept as a floor, for the pose the plan
 * cannot know: a rig posed by something other than the arc it was given. */
var PROF_N    = 24;       /* profile samples across dur + BLEND_OUT */
var PUSH_EASE = 40;       /* 1/s ease on the reactive floor (tau 25 ms) */
var PUSH_DROP = 8.0;      /* m/s the slide may UNLOAD at. Higher than PUSH_RATE
                             on purpose: the load happens during the wind-up,
                             where the eye is looking for the cock-back, while the
                             unload happens under the follow-through, where the
                             whole arm is already sweeping back to guard. Clamping
                             both at PUSH_RATE cost 0.03 m of torso clearance in
                             the blend-out for no visible gain.               */
var REACT_MAX = 0.06;     /* m the reactive floor may exceed the plan by */
var PUSH_RATE = 7.0;      /* m/s ceiling on how fast the slide may LOAD.
                             0.117 m per 60 fps frame — still under HALF of the
                             0.20-0.26 m the arcs' own wind-up moves the hand in a
                             frame, so the correction can never be what the eye
                             follows. Measured: dropping it to 4.5 changed the
                             worst one-frame hand movement by at most 0.03 m and
                             cost 0.04 m of torso clearance, so 7.0 it is. */

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
    /* Head. The skull used to be a bare tan box with a lid on it, which reads as
       a crate at any distance; a brow ridge and a nose cost 48 vertices in the
       SAME merged mesh (no extra draw call) and give the face a direction. The
       neck is thicker/taller than before so the 3 cm band between the torso top
       (0.53) and the skull bottom is filled instead of showing daylight. */
    head: GL.mesh(G.merge([
      bakedBox(0.115, 0.14, 0.115, 1,1,1, 0, 0.02, 0),        /* neck */
      bakedBox(0.22, 0.26, 0.24, 1,1,1, 0, 0.17, 0.01),       /* skull */
      bakedBox(0.19, 0.035, 0.04, 1,1,1, 0, 0.245, -0.112),   /* brow ridge */
      bakedBox(0.055, 0.075, 0.06, 1,1,1, 0, 0.145, -0.128)])),/* nose */
    /* Hair: cap + nape + temple slabs. The temples are what make it read as a
       head of hair rather than a tan box wearing a plank. */
    hair: GL.mesh(G.merge([
      bakedBox(0.245, 0.09, 0.265, 1,1,1, 0, 0.315, -0.005),  /* cap */
      bakedBox(0.245, 0.20, 0.055, 1,1,1, 0, 0.205, 0.145),   /* nape (+Z) */
      bakedBox(0.05, 0.145, 0.20, 1,1,1,  0.108, 0.245, 0.03),/* temple R */
      bakedBox(0.05, 0.145, 0.20, 1,1,1, -0.108, 0.245, 0.03)])),/* temple L */
    torso: GL.mesh(bakedBox(0.40, 0.50, 0.24, 1,1,1, 0, 0.28, 0)),
    hips:  GL.mesh(bakedBox(0.32, 0.18, 0.21, 1,1,1, 0, -0.035, 0)),
    belt:  GL.mesh(bakedBox(0.36, 0.09, 0.25, 1,1,1, 0, 0.075, 0)),
    /* upper arm + DELTOID centred on the shoulder joint. The deltoid is the
       fix for the detached-arm slot: near-cubic, so its surface is >= SH_CAP
       from the joint under ANY orientation, which is more than the 0.045 the
       joint sits outboard of the torso's side plane. It also reads as a
       shoulder instead of the hard L-shaped step the bare arm box made. */
    uarm:  GL.mesh(G.merge([
      bakedBox(0.12, 0.34, 0.13, 1,1,1, 0, -0.13, 0),
      bakedBox(2 * (SH_CAP + 0.001), 2 * SH_CAP, 0.176, 1,1,1, 0, 0, 0)])),
    /* forearm + elbow ball: the bare boxes only overlapped 0.03 m, so a hard
       elbow bend (the coil folds it past 2 rad) notched the outside of the joint */
    larm:  GL.mesh(G.merge([
      bakedBox(0.10, 0.30, 0.11, 1,1,1, 0, -0.12, 0),
      bakedBox(0.115, 0.115, 0.12, 1,1,1, 0, 0, 0)])),
    hand:  GL.mesh(bakedBox(0.095, 0.11, 0.10, 1,1,1, 0, -0.01, 0)),
    uleg:  GL.mesh(bakedBox(0.15, 0.46, 0.16, 1,1,1, 0, -0.19, 0)),
    /* shin + knee ball (same reason as the elbow; the run cycle bends 1.6 rad) */
    lleg:  GL.mesh(G.merge([
      bakedBox(0.125, 0.42, 0.135, 1,1,1, 0, -0.17, 0),
      bakedBox(0.132, 0.132, 0.142, 1,1,1, 0, 0, 0)])),
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
/* Blend a -> b about a CENTRE, keeping the distance from that centre equal to the
 * lerp of the two distances instead of cutting the chord between them.
 * WHY THIS EXISTS: the arc's pivot is inside the chest and both blend endpoints
 * are ~1 m out from it, so a straight lerp of the blade's middle dips ~0.25 m
 * toward the pivot at the halfway point — i.e. THROUGH the sternum. That is the
 * single biggest source of measured self-clipping: on the cross-body attacks the
 * hilt was at the centre of the torso box at phase 0.08-0.20, in the middle of
 * the guard->coil blend, where BOTH endpoints are individually clean. Swinging
 * the hand around the chest instead of through it fixes it at the source, for
 * every attack at once, and needs no sliding at all. `o` may alias `a` or `b`. */
/* Blend a -> b about a CENTRE, keeping the distance from that centre equal to the
 * lerp of the two distances instead of cutting the chord between them.
 * WHY THIS EXISTS: the arc's pivot is inside the chest and both blend endpoints
 * are ~1 m out from it, so a straight lerp of the blade's middle dips ~0.25 m
 * toward the pivot at the halfway point — i.e. THROUGH the sternum. That is a
 * large share of the measured self-clipping: on the cross-body attacks the hilt
 * was at the centre of the torso box at phase 0.08-0.20, in the middle of the
 * guard->coil blend, where BOTH endpoints are individually clean. Swinging the
 * hand around the chest instead of through it fixes it at the source, for every
 * attack at once, and costs no sliding at all. `o` may alias `a` or `b`. */
var blC = new Float32Array(3);     /* the centre, set by the caller */
function arcLerp(o, a, b, t){
  var ax = a[0]-blC[0], ay = a[1]-blC[1], az = a[2]-blC[2];
  var bx = b[0]-blC[0], by = b[1]-blC[1], bz = b[2]-blC[2];
  var ra = Math.sqrt(ax*ax + ay*ay + az*az);
  var rb = Math.sqrt(bx*bx + by*by + bz*bz);
  var cx = ax + (bx-ax)*t, cy = ay + (by-ay)*t, cz = az + (bz-az)*t;
  var rc = Math.sqrt(cx*cx + cy*cy + cz*cz);
  if (rc > 1e-4){
    var k = (ra + (rb-ra)*t) / rc;
    cx *= k; cy *= k; cz *= k;
  }
  o[0] = blC[0]+cx; o[1] = blC[1]+cy; o[2] = blC[2]+cz;
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
var ESC_C = new Float32Array(8);   /* scratch: 4 candidate escapes, (x,z) pairs */

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

/* How far the weapon has to slide along the body-local XZ direction (ex,ez) so
 * that no part of it is inside the no-go volume — the BODY_RX/BODY_RZ ellipse,
 * between BODY_Y0 and BODY_Y1. All arguments are BODY-LOCAL: the hand at
 * (hx,hy,hz), the blade direction (dx,dy,dz), and the weapon occupying `lo`..`hi`
 * metres along it (`lo` is NEGATIVE: the pommel is behind the hand).
 * Zero allocation, ~25 flops a sample.
 *
 * ONLY SAMPLES ACTUALLY INSIDE THE CAPSULE ASK FOR ANYTHING, and what they ask
 * for is the LARGER root of P + t*e outside the no-go ellipse (P = the sample in
 * the body's XZ plane) — the least travel that gets the sample out AND keeps it
 * out. Inside the ellipse that root always exists and is always positive, so
 * there is no branch to step over. The demand
 * fades in with penetration DEPTH over BODY_DEEP, so a sample crossing the
 * ellipse wall asks for nothing at the wall — which is what makes the whole
 * function continuous in time, hence pop-free. A clean pose is left EXACTLY
 * alone: push is identically zero, so idle/run/guard are untouched.
 *
 * WHAT THIS REPLACED, AND WHY (measured, all 12 attacks x 3 saber types,
 * 161 samples a swing, plus a one-frame-displacement probe at 60 fps):
 *   - The old version treated a sample that was out the FAR side as a CAP on the
 *     whole weapon's travel. That cap STEPPED: one sample crossing the far
 *     tangent flipped its contribution from "clamp everything to ~0" to
 *     "displace clear across the body", so the entire weapon teleported up to BODY_MAX in
 *     a single frame. Measured on the three cross-body attacks (SNAP CUT RIGHT,
 *     FALLING STAR, AVALANCHE — one in every stance): 0.50 m of HAND movement in
 *     one 60 fps frame at phase 0.056, a peak wind-up tip speed of 358 m/s
 *     against a 36 m/s strike. Those attacks read as a flinch, then a cut. No
 *     swing-probe metric sees a one-frame pop; only differentiating the tip does.
 *   - The cap was also what left the staff's hilt at the exact centre of the
 *     chest (-0.120 m, the deepest penetration the torso box admits) on those
 *     same three attacks: clearing one end of a centre-gripped staff drove the
 *     other end in, so the cap gave up and pushed nothing at all.
 * Travel is capped by BODY_MAX; the escape DIRECTION (see playArc) is what keeps
 * the demand small — a cross-body arc escapes mostly FORWARD, in front of the
 * chest, because no amount of sideways sliding can clear a blade that lies
 * across the sternum. */
function clearPush(hx, hy, hz, dx, dy, dz, lo, hi, steps, ex, ez){
  var push = 0, i, s, x, y, z, w, b, q, t;
  for (i = 0; i <= steps; i++){
    s = lo + (hi - lo) * (i / steps);
    y = hy + dy * s;
    w = 1;
    if (y < BODY_Y0) w = (y - BODY_Y0 + BODY_FADE) / BODY_FADE;
    else if (y > BODY_Y1) w = (BODY_Y1 + BODY_FADE - y) / BODY_FADE;
    if (w <= 0) continue;                     /* above the hair / below the hips */
    if (w > 1) w = 1;
    w = w * w * (3 - 2 * w);                  /* smooth fade at the capsule ends */
    x = hx + dx * s; z = hz + dz * s;
    q = (x * x) * IRX2 + (z * z) * IRZ2;      /* < 1 == inside the ellipse */
    if (q >= 1) continue;                     /* clear: asks for nothing */
    if (1 - q < BODY_DEEP){                   /* fade in with depth */
      var f = (1 - q) / BODY_DEEP;
      w *= f * f * (3 - 2 * f);
    }
    /* least t >= 0 that puts P + t*e outside the ellipse: the larger root of
       A t^2 + 2 B t + (q - 1) >= 0. Inside means q < 1, so the root always
       exists and is always positive — there is no branch to step over. */
    var A = ex * ex * IRX2 + ez * ez * IRZ2;
    if (A < 1e-9) continue;
    b = x * ex * IRX2 + z * ez * IRZ2;
    t = ((Math.sqrt(b * b - A * (q - 1)) - b) / A) * w;
    if (t > push) push = t;
  }
  return push;                    /* RAW: callers apply the BODY_MAX ceiling, and
                                     buildProf scores the raw total so a candidate
                                     that saturates loses to one that fits */
}

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
  /* Carry the PREVIOUS swing's lunge out instead of dropping it. Without this,
     chaining out of a lunging attack reset the visual forward offset to 0 in a
     single frame and the whole drawn body teleported: measured 1.29 m of hand
     movement in one 60 fps frame on VIPER LUNGE (1.20 m of lunge) -> FLURRY
     CROSS, the most-used LIGHT combo in the game. The carry starts at exactly
     the offset we already had (so t = 0 is continuous) and eases out over
     LUNGE_CARRY — its own constant, not the pose blend, because a LIGHT chain's
     blend is only 76 ms and unloading a metre that fast is its own artefact. */
  var cw = a.t < LUNGE_CARRY ? 1 - smooth(a.t / LUNGE_CARRY) : 0;
  a.lungeCur = a.lungeAmt * lp * a.wOut + a.lungeCarry * cw;
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

/* ---- the planned clearance slide (see PROF_N) ------------------------------ */
var pfH = new Float32Array(3), pfD = new Float32Array(3), pfM = new Float32Array(3);
var pfFM = new Float32Array(3), pfFD = new Float32Array(3);
var PROF_A = new Float32Array(PROF_N + 1), PROF_B = new Float32Array(PROF_N + 1);

/* Walk the whole swing for one arm and fill `out` with the slide clearPush wants
 * at each instant, then dilate + slope-limit. Returns the peak. `sgn` +1 right /
 * -1 left (mirrored, phase-lagged by DUAL_PHASE exactly as arcUpdate does).
 * Reproduces ikArm's blend arithmetic — blade MIDDLE space, wIn out of the pose
 * we came from, wOut back into the procedural pose. Zero allocation. */
function buildProf(r, a, sgn, snapM, snapD, ho, ex, ez, out){
  var sf = (sgn > 0 && r.type === 'staff');
  var top = sf ? STAFF_TOP : HILT_TOP;
  var lo = sf ? -(top + BLADE_LEN) : -HILT_BOT, hi = top + BLADE_LEN;
  var ns = sf ? 2 * WEAP_N : WEAP_N;
  var tot = a.dur + BLEND_OUT, dtp = tot / PROF_N, i, t, p, wi, wo, l;
  var score = 0, raw;
  var mx0, my0, mz0, dx0, dy0, dz0;
  fkLocal(r, sgn, pfFM, pfFD);            /* where the blend-out is heading */
  blC[0] = sgn * a.pivot[0]; blC[1] = a.pivot[1]; blC[2] = a.pivot[2];
  for (i = 0; i <= PROF_N; i++){
    t = i * dtp;
    p = (sgn < 0 ? t - DUAL_PHASE * a.dur : t) / a.dur;
    if (p < 0) p = 0; else if (p > 1) p = 1;
    wi = smooth(t / a.blendIn);
    wo = t <= a.dur ? 1 : smooth(1 - (t - a.dur) / BLEND_OUT);
    arcSample(a, p, pfH, pfD, pfM, r.type, sgn);
    dx0 = pfD[0]; dy0 = pfD[1]; dz0 = pfD[2];
    if (wi < 1){
      arcLerp(pfM, snapM, pfM, wi);
      dx0 = snapD[0] + (dx0 - snapD[0]) * wi;
      dy0 = snapD[1] + (dy0 - snapD[1]) * wi;
      dz0 = snapD[2] + (dz0 - snapD[2]) * wi;
    }
    if (wo < 1){
      arcLerp(pfM, pfFM, pfM, wo);
      dx0 = pfFD[0] + (dx0 - pfFD[0]) * wo;
      dy0 = pfFD[1] + (dy0 - pfFD[1]) * wo;
      dz0 = pfFD[2] + (dz0 - pfFD[2]) * wo;
    }
    l = Math.sqrt(dx0*dx0 + dy0*dy0 + dz0*dz0);
    if (l < 1e-6){ dx0 = 0; dy0 = 1; dz0 = 0; } else { dx0 /= l; dy0 /= l; dz0 /= l; }
    mx0 = pfM[0]; my0 = pfM[1]; mz0 = pfM[2];
    raw = clearPush(mx0 - dx0*ho, my0 - dy0*ho, mz0 - dz0*ho,
                    dx0, dy0, dz0, lo, hi, ns, ex, ez);
    score += raw + 6 * max0(raw - BODY_MAX);   /* travel, saturation weighs 7x */
    out[i] = raw > BODY_MAX ? BODY_MAX : raw;
  }
  /* dilate one step: a need that peaks BETWEEN samples is still covered */
  PROF_B.set(out);
  for (i = 0; i <= PROF_N; i++){
    if (i > 0 && PROF_B[i-1] > out[i]) out[i] = PROF_B[i-1];
    if (i < PROF_N && PROF_B[i+1] > out[i]) out[i] = PROF_B[i+1];
  }
  /* Slope-limit both ways at PUSH_RATE. The two passes only RAISE samples, so no
     clearance is lost, and the backward pass is what makes the slide start moving
     BEFORE the blade needs it — the anticipation absorbs the move exactly as it
     absorbs the pose blend. */
  var lim = PUSH_RATE * dtp;
  for (i = PROF_N - 1; i >= 0; i--) if (out[i] < out[i+1] - lim) out[i] = out[i+1] - lim;
  for (i = 1; i <= PROF_N; i++) if (out[i] < out[i-1] - lim) out[i] = out[i-1] - lim;
  /* Both ENDS must be exactly zero, and the ramps out of them re-clamped. t = 0 is
     last frame's pose, which needs no slide at all; t = dur + BLEND_OUT is the
     procedural pose, ditto, and it is the frame the arc stops driving the arm — so
     any slide still applied there vanishes in one frame. Starting or ending
     anywhere but zero IS a pop. This is the one step that can cost clearance: a
     slide that could not be pre-charged in time arrives a frame or two late.
     Deliberate trade — a few cm of hilt inside a tunic for two frames is
     invisible; a 0.39 m one-frame jump of the saber is the most visible artefact
     this rig can produce, and was the defect this whole path exists to remove. */
  out[0] = 0; out[PROF_N] = 0;
  for (i = 1; i <= PROF_N; i++) if (out[i] > out[i-1] + lim) out[i] = out[i-1] + lim;
  var dn = PUSH_DROP * dtp;
  for (i = PROF_N - 1; i >= 0; i--) if (out[i] > out[i+1] + dn) out[i] = out[i+1] + dn;
  return score;
}

function profAt(prof, t, tot){
  if (!(tot > 0)) return 0;
  var u = t / tot * PROF_N;
  if (u <= 0) return prof[0];
  if (u >= PROF_N) return prof[PROF_N];
  var i = u | 0;
  return prof[i] + (prof[i+1] - prof[i]) * (u - i);
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
  a.wIn = 0; a.wOut = 1;
  a.lungeCarry = this.lunge;        /* see arcUpdate: no 1-frame body teleport */
  a.lungeCur = a.lungeCarry;
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
  /* --- escape direction for the body-clearance slide (see BODY_RX) -----------
     A unit direction in the body's XZ plane, decided ONCE per swing so it can
     NEVER flicker mid-arc — that is what makes the slide continuous in TIME.
     Four candidates are scored by walking the WHOLE swing (buildProf) and the
     one whose worst demand is smallest wins; ties go to the earlier candidate,
     so outboard — the pose a saber actually cocks in — keeps every arc that
     already worked:
       0  OUTBOARD over the coil's shoulder
       1  straight FORWARD, in front of the chest
       2/3 the two PERPENDICULARS to the weapon at the coil. For a straight
           weapon a perpendicular slide is exact AND minimal: every sample lies
           on one line, so it makes the whole line tangent to the capsule at
           once and cannot fix one end of a blade while opening the other.
     Outboard is what this used to do unconditionally, and it CANNOT clear a coil
     that lies across the body: on the staff's three cross-body coils it runs
     along the weapon (the hand itself ends up 0.138 m from the spine, inside the
     torso box) and asks for 0.404 m of travel, past the BODY_MAX ceiling — which
     is why the rear blade sat 0.108 m inside the chest. A perpendicular clears
     the same pose with 0.162 m. */
  var cr = a.a0 - BACK_FRAC * (a.a1 - a.a0);
  var rxx = a.u[0] * Math.cos(cr) + a.v[0] * Math.sin(cr);
  arcSample(a, wu, a.hR, a.dR, a.mR, this.type, 1);   /* pose at the coil */
  ESC_C[0] = rxx < -0.20 ? -1 : 1; ESC_C[1] = 0;      /* outboard */
  ESC_C[2] = 0; ESC_C[3] = -1;                        /* forward  */
  var bl = Math.sqrt(a.dR[0] * a.dR[0] + a.dR[2] * a.dR[2]);
  if (bl > 0.30){
    ESC_C[4] =  a.dR[2] / bl; ESC_C[5] = -a.dR[0] / bl;
    ESC_C[6] = -ESC_C[4];     ESC_C[7] = -ESC_C[5];
  } else {                                            /* vertical coil: no XZ axis */
    ESC_C[4] = ESC_C[5] = ESC_C[6] = ESC_C[7] = 0;
  }
  a.profT = a.dur + BLEND_OUT;
  var HOR = (this.type === 'staff' ? STAFF_TOP : HILT_TOP) + BLADE_LEN * 0.5;
  var bestN = 1e9, ci, nd;
  for (ci = 0; ci < 8; ci += 2){
    if (ESC_C[ci] === 0 && ESC_C[ci + 1] === 0) continue;
    nd = buildProf(this, a, 1, a.snapM, a.snapD, HOR, ESC_C[ci], ESC_C[ci + 1], PROF_A);
    if (nd < bestN * 0.995){          /* clearly less total travel over the swing */
      bestN = nd; a.escX = ESC_C[ci]; a.escZ = ESC_C[ci + 1];
      a.prof.set(PROF_A);
    }
    if (bestN <= 1e-4) break;                         /* already clear: done */
  }
  if (a.mirror)
    buildProf(this, a, -1, a.snapML, a.snapDL, HILT_TOP + BLADE_LEN * 0.5,
              -a.escX, a.escZ, a.profL);
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
var IK_SOFT = 0.07;              /* m: below this reach the direction is damped
                                    toward the pole — see solveIK. Kept SMALL:
                                    it is a guard against a degenerate target,
                                    and every millimetre of range it covers is
                                    a millimetre of authored pose it perturbs.
                                    0.12 cost 0.05 of METEOR SMASH's
                                    pathOverSpan budget for no measured gain.  */
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
  /* Near the shoulder the reach DIRECTION is ill-conditioned: the hand is clamped
     out to minL anyway, so a millimetre of target wobble would swing it through a
     large angle. Fade the direction toward the (always stable) pole as the target
     closes in. Measured: with the body-clearance slide able to drive a target to
     within 0.05 m of the shoulder, this was worth 26 m/s of spurious tip speed on
     METEOR SMASH's wind-up. Continuous, and a no-op beyond IK_SOFT. */
  if (L < IK_SOFT){
    var g = L / IK_SOFT; g = g * g * (3 - 2 * g);
    var pw = (1 - g) / (Math.sqrt(pole[0]*pole[0] + pole[1]*pole[1] + pole[2]*pole[2]) || 1);
    var bx = nx * g + pole[0] * pw, by = ny * g + pole[1] * pw, bz = nz * g + pole[2] * pw;
    var bn = Math.sqrt(bx*bx + by*by + bz*bz);
    if (bn > 1e-3){ nx = bx / bn; ny = by / bn; nz = bz / bn; }
  }
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
  if (dt > 1e-5) POSE_DT = dt;      /* renderRig eases the clearance slide */

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
    /* MEASURED: the old airborne wrist (-0.35) laid the blade back ACROSS the
       body — the saber ran through the character's own head (0.040 m INTO the
       head box, 0.099 with a dual) for the whole of every jump, which in a game
       with a force jump is most of the time. The off arm still flings back for
       the leap; the saber arm now carries the blade up-forward and OUTBOARD
       (shoulder yawed out, wrist flexed), which clears by 0.54 m and reads as a
       Jedi about to bring the blade down. */
    lSwL = 0.55; lSwR = 0.10;
    kneeL = -1.50; kneeR = -0.75;
    aSwL = -0.55; aSwR = -0.20;
    sprL = 0.85; sprR = 0.55;
    elbL = 0.45; elbR = 0.60;
    syR = -0.35; wrist = -1.35;
    lean = -0.06; bob = 0; twist = 0; head = 0.10;
  } else if (anim === 'fall'){                /* limbs spread */
    lSwL = 0.35; lSwR = -0.18;
    kneeL = -0.45; kneeR = -0.25;
    aSwL = -0.15; aSwR = 0.05;
    sprL = 1.05; sprR = 0.70;
    elbL = 0.35; elbR = 0.50;
    syR = -0.32; wrist = -1.45;                /* same fix as jump (was -0.50) */
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
    } else {
      /* airborne: mirror the saber arm exactly, or the second blade lies back
         across the head the same way the first one used to (measured -0.094 m
         into the head box). The left arm's ROLL is already negated by the
         renderer, so it is the YAW that has to flip. */
      aSwL = aSwR; sprL = sprR; elbL = elbR; syL = -syR; wrL = wrist;
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
  else { a.pu[0] = 0; a.pu[1] = 0; }   /* no arc, no slide: never carry one over */
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
function ikArm(mU, mF, mH, shx, mLoc, dLoc, snapM, snapD, tilt, wIn, wOut, side, ref,
               ho, ex, ez, pu2, pi, plan){
  M.xp(wT, mRoot, mLoc[0], mLoc[1], mLoc[2]);          /* arc blade middle -> world */
  M.xd(wB, mRoot, dLoc[0], dLoc[1], dLoc[2]);
  if (wIn < 1){                                        /* ...from the snapshot */
    M.xp(wX, mRoot, snapM[0], snapM[1], snapM[2]);
    M.xd(wY, mRoot, snapD[0], snapD[1], snapD[2]);
    arcLerp(wT, wX, wT, wIn); lerp3(wB, wY, wB, wIn);
  }
  if (wOut < 1){                                       /* ...back to procedural */
    wY[0] = mH[4];  wY[1] = mH[5];  wY[2] = mH[6];
    wX[0] = mH[12] + wY[0]*ho; wX[1] = mH[13] + wY[1]*ho; wX[2] = mH[14] + wY[2]*ho;
    arcLerp(wT, wX, wT, wOut); lerp3(wB, wY, wB, wOut);
  }
  norm3(wB);
  wT[0] -= wB[0]*ho; wT[1] -= wB[1]*ho; wT[2] -= wB[2]*ho;   /* middle -> hand */
  /* --- body clearance (see BODY_RX): slide the weapon clear until none of it
     is inside its owner. Enforced HERE, on the BLENDED pose that is about to be
     drawn, not on the arc's target — measured, the frames that put the hilt in
     the sternum were the guard->coil blend (wIn 0.35..0.85), where the pose is a
     lerp of two individually clean poses through the middle of the chest. Only
     the drawn pose is what the player sees, so only the drawn pose is checked. */
  var ox = wT[0] - mRoot[12], oy = wT[1] - mRoot[13], oz = wT[2] - mRoot[14];
  var top = ho - BLADE_LEN * 0.5, sf = top > HILT_TOP + 0.01;   /* sf: staff */
  var pu = clearPush(
    ox*mRoot[0] + oy*mRoot[1] + oz*mRoot[2], oy,       /* hand, body-local */
    ox*mRoot[8] + oy*mRoot[9] + oz*mRoot[10],
    wB[0]*mRoot[0] + wB[1]*mRoot[1] + wB[2]*mRoot[2], wB[1],   /* blade dir */
    wB[0]*mRoot[8] + wB[1]*mRoot[9] + wB[2]*mRoot[10],
    /* the weapon runs from the POMMEL, behind the hand, to the tip — a staff is
       live (and long) both ways. Excluding the grip is what let the hilt through
       the chest on 8 of 12 single-saber attacks; see HILT_BOT. */
    sf ? -(top + BLADE_LEN) : -HILT_BOT, top + BLADE_LEN,
    sf ? 2 * WEAP_N : WEAP_N, ex, ez);
  /* ease the slide toward what clearPush asked for (see PUSH_EASE). The state is
     per ARM and survives across swings, so chaining carries the current slide
     instead of resetting it — the guard needs no slide at all, so a swing always
     starts and ends at zero and nothing pops at either edge. */
  if (pu > BODY_MAX) pu = BODY_MAX;
  var cur = pu2[pi], lim = PUSH_RATE * POSE_DT;
  pu -= (pu - cur) * Math.exp(-PUSH_EASE * POSE_DT);
  if (pu - cur > lim) pu = cur + lim; else if (cur - pu > lim) pu = cur - lim;
  if (plan > pu) pu = plan;           /* the PLANNED slide (see PROF_N) leads it */
  else if (pu > plan + REACT_MAX) pu = plan + REACT_MAX;
  pu2[pi] = pu;                       /* state tracks what was APPLIED, so the
                                         reactive term can only ever ADD to the
                                         plan, at a bounded rate, never lag it —
                                         and never by more than REACT_MAX, so the
                                         plan's zeroed ENDS cannot be undone */
  if (pu > 0.0002){                   /* body X/Z in world = mRoot columns 0 / 2 */
    var pux = pu * ex, puz = pu * ez;
    wT[0] += pux*mRoot[0] + puz*mRoot[8];
    wT[1] += pux*mRoot[1] + puz*mRoot[9];
    wT[2] += pux*mRoot[2] + puz*mRoot[10];
  }
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
    M.xp(blC, mRoot, -a.pivot[0], a.pivot[1], a.pivot[2]); /* arcLerp centre */
    ikArm(mUL, mFL, mHL, -SH_X, a.mL, a.dL, a.snapML, a.snapDL,
          -a.tilt, a.wIn, a.wOut, -1, wR, HILT_TOP + BLADE_LEN * 0.5, -a.escX, a.escZ,
          a.pu, 1, profAt(a.profL, a.t, a.profT));
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
  if (arcOn) M.xp(blC, mRoot, a.pivot[0], a.pivot[1], a.pivot[2]);
  if (arcOn)
    ikArm(mUR, mFR, mHR, SH_X, a.mR, a.dR, a.snapM, a.snapD,
          a.tilt, a.wIn, a.wOut, 1, wR, HO, a.escX, a.escZ, a.pu, 0,
          profAt(a.prof, a.t, a.profT));
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
      a0: 0, a1: 1.6, tilt: 0, windup: 0.28, recover: 0.24, escX: 1, escZ: 0,
      lungeAmt: 0, lungeCur: 0, lungeCarry: 0, pu: new Float32Array(2),
      prof: new Float32Array(PROF_N + 1), profL: new Float32Array(PROF_N + 1),
      profT: SWING_DUR + BLEND_OUT,
      mirror: false, name: '', blendIn: BLEND_IN,
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
