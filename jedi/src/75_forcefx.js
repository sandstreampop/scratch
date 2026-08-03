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
 *   JK.ForceFx.grip(target, t)       the choke: a TETHER from the player's saber
 *                                    hand to the victim, two fat counter-rotating
 *                                    bands (the inner one billboarded so it is
 *                                    always a full hoop), two prisms of glow, and
 *                                    thrashing motes — call EVERY frame; target
 *                                    may be a vec3 (chest point) OR a JK.Combat
 *                                    entity ({pos,height}). STOP calling it and
 *                                    the aura times out within GRIP_HOLD and
 *                                    fires a RELEASE shockwave by itself — that
 *                                    is the only "let go" signal available, since
 *                                    JK.Powers' contract ends at
 *                                    onForce('gripRelease').
 *   JK.ForceFx.speed(on)             ghost after-images + CSS vignette (latched)
 *   init() / update(dt, t) / draw()  lifecycle (90_main SYSTEMS slot 'ForceFx')
 *   clear()                          drop every live effect (respawn / tests)
 *   active()                         live effect count (harnesses)
 *
 * RENDERING BUDGET / RULES
 *   - Every element this module draws is a BOX placed by a model matrix written
 *     by hand into module-scope scratch (no M.mul) — cols are X, Y, Z, T. See
 *     seg()/cube()/col(), and the ghost matrix in drawGhosts.
 *   - ONE DRAW CALL for the entire module. Every box is additive + emissive +
 *     nofog, which is exactly the case JK.GL.dynamic collapses without changing
 *     a pixel, so they are CPU-transformed into one shared vertex buffer and go
 *     out as a single drawElements — see the batching note above emitBox.
 *     Per-effect driver calls, measured on frozen frames, before -> after:
 *     grip 54 -> 0, two grips 109 -> 0, one push/pull wave 35 -> 0, four waves
 *     134 -> 0, one lightning arc ~26 -> 0, four arcs 105 -> 0, speed ghosts
 *     7 -> 0, and the whole module 1 call when anything at all is live. A
 *     hand-composed worst case (2 grips + 4 arcs + 4 waves + speed + 24 bolts
 *     + 4 parries) went 474 draws/frame -> 57, against a 200-call budget, and
 *     busy combat with PUSH selected went 164 mean / 206 peak -> 136 / 146,
 *     with the peak no longer depending on which power is in the player's hand.
 *   - Zero allocation per frame. Pools are preallocated with hard caps:
 *     4 waves x 16 shards, 4 arcs x 9 links (+1-2 forks), 2 grips, 14 ghosts.
 *     Ghosts are spent on DISTANCE as well as time — see GHOST_MIN_D. BOXES is
 *     sized to every pool being full at once; emitBox never overruns it.
 *   - Additive + nofog means the sand can occlude the effects (the depth TEST
 *     still runs) but the fog can never grey them out. No trailing "reset" draw:
 *     JK.GL.beginFrame restores depthMask(true) before it clears, so leaving GL
 *     in additive state here is harmless (JK.Fx relies on the same thing).
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

/* ---- GRIP: the weakest power on screen, rebuilt ----------------------------
 * Measured on a frozen still with a bot 6 m out: the old aura (3 thin rings of 8
 * shards, r 0.55-0.9 m, plus 7 tiny motes) changed 0.48% of the screen — a white
 * sparkle on the victim's chest — while push/pull/speed change 4-5%. It cost 58
 * boxes to do it, so the answer could not be "more of the same".
 * Re-measured independently against the identical frame with no grip in it:
 * 0.73% of the screen from behind the player, 2.12% from the side — and the
 * frames read as a man wrapped in a cage of light on a leash.
 * Fewer, FATTER, BIGGER elements, plus the two things that were missing
 * entirely: a TETHER from the player's hand to the victim (so the player can see
 * that HE is doing this), and a RELEASE burst when the choke ends.
 * Draw budget is spent, not raised: 2 fat rings instead of 3 thin ones pays for
 * the tether, so the whole effect still fits in ~54 boxes — which, since the
 * module batches, is ~54 boxes inside ONE driver call. */
var GRIP_MAX   = 2;
var GRIP_HOLD  = 0.16;   /* s a grip aura survives without a refresh */
var GRIP_RINGS = 2;      /* two fat bands read at 6 m; three thin ones did not */
var GRIP_SEG   = 7;      /* shards per aura ring */
var GRIP_MOTES = 8;
var GRIP_W     = 0.085;  /* m: shard cross-section (was 0.046 — under 2 px out there) */
var GRIP_R0    = 1.15;   /* x g.r: inner band radius */
var GRIP_R1    = 1.62;   /* x g.r: outer band radius */
var GRIP_AUR0  = 0.78;   /* x g.r: girth of the tall glow prism */
var GRIP_AUR1  = 1.28;   /* x g.r: girth of the flat chest-height one */
var GRIP_AUR_A = 0.055;  /* alpha per aura prism (additive, front+back faces) */
var GRIP_POP   = 0.16;   /* s the bands take to snap open on the lock */

var TETH_LINKS = 6;      /* hand -> victim cord, links */
var TETH_W     = 0.060;  /* m core cross-section at the hand end */
var TETH_GLOW  = 2.1;
var TETH_AMP   = 0.045;  /* x length: lateral writhe of the cord */
var TETH_SAG   = 0.030;  /* x length: gravity-ish droop in the middle */
var TETH_BOW   = 0.105;  /* x length: slow revolving bow — see drawTether */

var REL_DUR    = 0.34;   /* s: the release shockwave */
var REL_R      = 2.7;    /* m: how far it opens */
var REL_MIN    = 0.10;   /* s a grip must have held before a release is shown */

var GHOSTS     = 14;     /* speed after-image ring buffer slots */
var GHOST_DT   = 0.042;  /* s between samples */
var GHOST_LIFE = 0.34;   /* s a sample stays visible */
var SPEED_TAIL = 0.30;   /* s of trailing ghosts after speed ends */
/* An after-image is a MOTION streak: it only means anything where the player
 * HAS BEEN. Sampling on a timer alone stacked every live slot on one spot the
 * moment he stood still (or crept along on a half-pushed stick) and the ~6
 * overlapping additive silhouettes erased the character — measured on the
 * torso: rgb(122,84,44) -> rgb(185,191,173), luminance 91 -> 187, hue gone.
 * So: a sample also costs DISTANCE, and any ghost still sitting on top of the
 * player fades out instead of adding to him. Sprinting (14 m/s => 0.7 m per
 * sample) is untouched — the trail is entirely behind him at that spacing. */
var GHOST_MIN_D = 0.26;  /* m the player must travel to earn a new sample */
var GHOST_NEAR  = 0.24;  /* m from the player: ghost fully suppressed */
var GHOST_FAR   = 0.52;  /* m from the player: ghost at full strength */

/* pale blue-white palette — the Force is cold and bright */
var C_HOT  = [1.00, 1.00, 1.00];
var C_PALE = [0.78, 0.90, 1.00];
var C_BLUE = [0.40, 0.66, 1.00];
var C_CYAN = [0.52, 0.94, 1.00];
var C_VIO  = [0.68, 0.60, 1.00];

/* ============================== state ============================== */
/* Hard cap on boxes queued in one frame, sized to EVERY pool being full at once:
 *   waves  4 x (16 shards x 2 passes) + 4 core flashes            = 132
 *   grips  2 x (tether 6x2 + 2 flares + bands 2x7x2 + 2 prisms
 *                + 8 motes + 2 choke)                             = 108
 *   arcs   4 x (9 links x2 + 2 forks x3 + 4 flares)               = 112
 *   ghosts 14 x 5 body boxes                                      =  70
 * = 422, rounded up. emitBox drops anything past it rather than letting
 * JK.GL clamp the batch (which would lose whole primitives silently). */
var BOXES = 448;
var batch = null;                               /* built ONCE at init */
var built = false;
var now = 0;

/* ---- scratch (never reallocated) ---- */
var MTX  = M.make();
var TINT = new Float32Array(3);
var BOPT = { emissive: 1, additive: true, nofog: true };  /* the one batch draw */
var PX = new Float32Array(3);                    /* perpendicular basis X */
var PZ = new Float32Array(3);                    /* perpendicular basis Z */
var HAND = new Float32Array(3);                  /* saber-hand world point */
var GP   = new Float32Array(3);                  /* resolved grip point */
var NODES = new Float32Array(ARC_NODES * 3);     /* arc polyline scratch */
var FNODES = new Float32Array((FORK_LINKS + 1) * 3);
var TNODES = new Float32Array((TETH_LINKS + 1) * 3);  /* grip tether polyline */
var RPOS = new Float32Array(3);                  /* release burst origin */
var RDIR = new Float32Array(3);                  /* release burst normal */

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
var gLx = 0, gLy = 0, gLz = 0, gHave = false;   /* last SAMPLED position */
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

/* A box spun about Y with independent girth and height — a turning PRISM. Two of
 * these, counter-rotating at low alpha, are how the grip gets volume for two
 * draw calls. Spun on two axes it looked like a tumbling crate (the flat top face
 * gives the game away over open sand); kept upright and turning, it reads as a
 * column of light around a body, which is the shape a body actually is. */
function col(m, x, y, z, rw, rh, a){
  var ca = Math.cos(a) * rw, sa = Math.sin(a) * rw;
  m[0] = ca;  m[1] = 0;  m[2] = -sa; m[3] = 0;
  m[4] = 0;   m[5] = rh; m[6] = 0;   m[7] = 0;
  m[8] = sa;  m[9] = 0;  m[10] = ca; m[11] = 0;
  m[12] = x; m[13] = y; m[14] = z; m[15] = 1;
}

/* ======================= THE BATCH (one draw call) ===================
 * WHY: this module used to issue one JK.GL.draw per box — 54 back-to-back
 * driver calls for a single grip, 134 for four push waves, 105 for four
 * lightning arcs. On iOS Safari every WebGL entry point is marshalled across a
 * process boundary, so that COUNT, not the 12 triangles behind each call, is the
 * frame-time spike, and 200 calls/frame is the whole game's budget.
 *
 * Why the pixels come out identical rather than merely similar (the same three
 * reasons the particle batch in 55_combat.js relies on):
 *  1. emissive = 1 makes the shader's lit term drop out (vCol = base), so
 *     NORMALS are never read — they are written once at build time and a box can
 *     be 8 shared corners / 12 triangles instead of 24 split verts. CULL_FACE is
 *     off, so front and back faces still both accumulate.
 *  2. nofog = true pins the fog factor at 1, so the shader reduces to
 *     dst += aC * uTint * uAlpha. Per-element tint and alpha therefore multiply
 *     into the vertex colour exactly: aC = rgb*alpha, uTint = 1, uAlpha = 1.
 *  3. Additive blending runs with depthMask(false) and the depth TEST is per
 *     fragment, so collapsing the draws cannot change occlusion or ordering.
 * Sand still occludes the effects, and the ONE draw is still issued through
 * JK.GL.draw so the profiler counts it honestly. */
var CUBE_TRI = [0,1,3, 0,3,2,   4,5,7, 4,7,6,   0,1,5, 0,5,4,
                2,3,7, 2,7,6,   0,2,6, 0,6,4,   1,3,7, 1,7,5];

/* Queue one box. `m` is a model matrix (cols X, Y, Z, T); the box occupies the
 * local cell centred on (lx,ly,lz) with half-extents (hx,hy,hz), so a seg()
 * matrix passes (0,0.5,0) and a cube()/col() one passes (0,0,0). Colour is
 * folded to rgb*alpha here — nothing per-box reaches a uniform. */
function emitBox(m, lx, ly, lz, hx, hy, hz, r, g, b){
  var h = batch;
  if (!h || h.n + 8 > h.max) return;             /* full: drop, never overrun */
  var x0 = m[0], y0 = m[1], z0 = m[2];           /* column X */
  var x1 = m[4], y1 = m[5], z1 = m[6];           /* column Y */
  var x2 = m[8], y2 = m[9], z2 = m[10];          /* column Z */
  var cx = m[12] + x0 * lx + x1 * ly + x2 * lz;
  var cy = m[13] + y0 * lx + y1 * ly + y2 * lz;
  var cz = m[14] + z0 * lx + z1 * ly + z2 * lz;
  var e0x = x0 * hx, e0y = y0 * hx, e0z = z0 * hx;
  var e1x = x1 * hy, e1y = y1 * hy, e1z = z1 * hy;
  var e2x = x2 * hz, e2y = y2 * hz, e2z = z2 * hz;
  var V = h.v, o = h.n * 9;
  for (var q = 0; q < 8; q++){                   /* sign bits: 1=+x, 2=+y, 4=+z */
    var sx = (q & 1) ? 1 : -1, sy = (q & 2) ? 1 : -1, sz = (q & 4) ? 1 : -1;
    V[o]     = cx + sx * e0x + sy * e1x + sz * e2x;
    V[o + 1] = cy + sx * e0y + sy * e1y + sz * e2y;
    V[o + 2] = cz + sx * e0z + sy * e1z + sz * e2z;
    V[o + 6] = r; V[o + 7] = g; V[o + 8] = b;    /* o+3..o+5: normal, fixed */
    o += 9;
  }
  h.n += 8; h.ni += 36;
}

/* Queue MTX tinted by TINT at alpha `a`. yoff 0.5 for a seg() matrix (its local
 * box spans y in [0,1]), 0 for a cube()/col() one. */
function put(m, yoff, a){
  if (!(a > 0.004)) return;                      /* NaN-safe, and skip invisible */
  emitBox(m, 0, yoff, 0, 0.5, 0.5, 0.5, TINT[0] * a, TINT[1] * a, TINT[2] * a);
}

function drawCube(x, y, z, s, col, a){
  if (a <= 0.004 || s <= 0) return;
  cube(MTX, x, y, z, s);
  tint(col);
  put(MTX, 0, a);
}

/* the humanoid after-image: local centre + half-size of each body box */
var GHOST_BOX = [
  0,  0.43, 0, 0.220, 0.430, 0.140,            /* legs  */
  0,  1.22, 0, 0.270, 0.350, 0.160,            /* torso */
  0,  1.71, 0, 0.140, 0.140, 0.130,            /* head  */
  0.34, 1.24, 0, 0.075, 0.310, 0.085,          /* arm R */
 -0.34, 1.24, 0, 0.075, 0.310, 0.085           /* arm L */
];

/* ============================== batch build ========================= */
function buildMeshes(){
  if (built || !JK.GL || !JK.GL.dynamic) return;
  var idx = new Uint16Array(BOXES * 36), i, j;
  for (i = 0; i < BOXES; i++){
    var vb = i * 8, ib = i * 36;
    for (j = 0; j < 36; j++) idx[ib + j] = vb + CUBE_TRI[j];
  }
  batch = JK.GL.dynamic(BOXES * 8, { idx: idx });
  var v = batch.v;                    /* normals: unused (emissive), set once */
  for (i = 3; i < v.length; i += 9){ v[i] = 0; v[i + 1] = 1; v[i + 2] = 0; }
  built = true;
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
  /* The ORIGIN needs the same door check as the direction below. The direction
   * was guarded and the origin was not, so pull([NaN,NaN,NaN], dir) put NaN
   * straight into r.ox/oy/oz and every one of the wave's 32 shard matrices came
   * out NaN for the whole 0.45 s — measured at 32 NaN uniform matrices a frame. */
  if (o && !(o[0] > -1e9 && o[0] < 1e9 && o[1] > -1e9 && o[1] < 1e9 &&
             o[2] > -1e9 && o[2] < 1e9)) return;
  var i, r = null, worst = 1e9;
  for (i = 0; i < RING_MAX; i++){
    var c = rings[i];
    if (!c.live){ r = c; break; }
    var rem = c.dur - c.t;                       /* else steal the oldest */
    if (rem < worst){ worst = rem; r = c; }
  }
  if (!r) return;
  r.live = true; r.kind = kind; r.t = 0;
  r.dur = kind === 1 ? PULL_DUR : (kind === 2 ? REL_DUR : PUSH_DUR);
  r.ph = rnd() * TAU;
  r.ox = o ? o[0] : 0; r.oy = o ? o[1] : 1.2; r.oz = o ? o[2] : 0;
  var dx = d ? d[0] : 0, dy = d ? d[1] : 0, dz = d ? d[2] : -1;
  var l = Math.sqrt(dx * dx + dy * dy + dz * dz);
  /* `!(l > 1e-5)` not `l < 1e-5`: a NaN component makes l NaN, and NaN fails
   * EVERY `<` test, so the old form fell through and normalised NaN/NaN into
   * the wave basis. Both degenerate cases now land on the default forward. */
  if (!(l > 1e-5)){ dx = 0; dy = 0; dz = -1; l = 1; }
  r.dx = dx / l; r.dy = dy / l; r.dz = dz / l;
  frame(r.dx, r.dy, r.dz);                       /* in-plane basis for the disc */
  r.ux = PX[0]; r.uy = PX[1]; r.uz = PX[2];
  r.vx = PZ[0]; r.vy = PZ[1]; r.vz = PZ[2];
}

function drawRing(r){
  var p = r.t / r.dur; if (p > 1) p = 1; if (p < 0) p = 0;
  var pull = r.kind === 1, rel = r.kind === 2;
  var e, rad, adv, alpha, stretch, w, ip = 1 - p;

  if (rel){
    /* GRIP RELEASE: a hoop that snaps open around the victim as the choke lets
     * go. Same machinery as the push wave, but centred ON the victim (adv 0) and
     * opening from something already body-sized, so it reads as "let go of him"
     * rather than "a wave arrived from somewhere". */
    e = 1 - ip * ip * ip;
    rad = 0.45 + REL_R * e;
    adv = 0;
    alpha = ip * ip;
    stretch = 0.92;
    w = 0.075 + 0.13 * ip;
  } else if (!pull){
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
    else if (rel) tintLerp(C_HOT, C_VIO, p);     /* the grip's own colour */
    else tintLerp(C_HOT, C_BLUE, p);
    put(MTX, 0.5, alpha);

    widen(MTX, 2.9);                             /* fat additive halo, same matrix */
    tint(pull ? C_BLUE : (rel ? C_VIO : C_PALE));
    put(MTX, 0.5, alpha * 0.34);
  }

  if (rel){
    /* the snap: one hot cube on the victim, gone in a third of the wave */
    if (p < 0.34){
      var q = 1 - p / 0.34;
      drawCube(r.ox, r.oy, r.oz, 0.34 + 0.75 * q, C_HOT, q * q * 0.7);
    }
    return;
  }

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
    tint(core); put(MTX, 0.5, a);
    if (glowK > 0){
      widen(MTX, glowK);
      tint(glow); put(MTX, 0.5, a * 0.30);
    }
  }
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
  /* `!(len > 0.05)` not `len < 0.05`: a non-finite endpoint makes len NaN, and
   * NaN fails EVERY `<` test, so the old form fell through and sprayed NaN model
   * matrices through the whole chain. Same defensive form as spawnRing. */
  if (!(len > 0.05)) return;
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
  var a = p.pos, lift = 0;
  if (a && a !== p && a.length >= 3) lift = (p.height || 1.8) * 0.55;   /* feet -> chest */
  else {
    a = a && a.length >= 3 ? a : p;
    /* `a.length < 3` is NOT the negation of `a.length >= 3`: an object with no
     * length at all ({pos:null}, a bare entity record) yields undefined, and
     * `undefined < 3` is FALSE — the old guard let it straight through and every
     * model matrix built from it came out NaN. Test the positive form. */
    if (!a || !(a.length >= 3)) return false;
  }
  var x = a[0], y = a[1] + lift, z = a[2];
  /* one caller-garbage check at the door beats NaN spraying through ~58 model
   * matrices a frame with no way to tell where it came from */
  if (!(x > -1e9 && x < 1e9 && y > -1e9 && y < 1e9 && z > -1e9 && z < 1e9)) return false;
  out[0] = x; out[1] = y; out[2] = z;
  return true;
}

/* THE TETHER — the bit that was missing. A writhing cord from the player's saber
 * hand to the victim's chest, with a bright pulse crawling up it toward the
 * victim so the direction of the force is unmistakable. 6 links x (core + glow)
 * plus two flare cubes at the hand: 14 boxes, and it is the single most legible
 * element of the whole effect because it crosses a lot of screen. */
function drawTether(g, cx, cy, cz, a){
  handPoint(HAND);
  var ax = HAND[0], ay = HAND[1], az = HAND[2];
  var dx = cx - ax, dy = cy - ay, dz = cz - az;
  var len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!(len > 0.45)) return;                     /* NaN-safe, and skip degenerate */
  frame(dx / len, dy / len, dz / len);
  var u1x = PX[0], u1y = PX[1], u1z = PX[2];
  var u2x = PZ[0], u2y = PZ[1], u2z = PZ[2];
  var amp = TETH_AMP * len, sag = TETH_SAG * len;
  /* THE BOW. A cord that is only jittered stays inside its own axis, and when the
   * victim is straight ahead that axis points down the lens: measured on a
   * head-on grip the whole tether occupied a couple of pixels. So the cord also
   * bows sideways by a body's width, in a direction that slowly revolves around
   * the axis — from any camera angle some of that bow is across the screen. Free:
   * it only moves the nodes that were being computed anyway. */
  var bow = TETH_BOW * len + 0.12;
  var bs = now * 1.6, bc = Math.cos(bs) * bow, bn = Math.sin(bs) * bow;
  var i, k;
  for (i = 0; i <= TETH_LINKS; i++){
    var s = i / TETH_LINKS;
    var env = Math.sin(s * PI);
    var o1 = (bc + Math.sin(s * 5.2 - now * 6.5) * amp) * env;
    var o2 = (bn + Math.cos(s * 4.1 + now * 5.1) * amp * 0.8) * env;
    k = i * 3;
    TNODES[k]     = ax + dx * s + u1x * o1 + u2x * o2;
    TNODES[k + 1] = ay + dy * s + u1y * o1 + u2y * o2 - sag * env;
    TNODES[k + 2] = az + dz * s + u1z * o1 + u2z * o2;
  }
  var ph = (now * 1.15) % 1;                     /* pulse crawling toward him */
  for (i = 0; i < TETH_LINKS; i++){
    k = i * 3;
    var sc = (i + 0.5) / TETH_LINKS;
    /* Fattest in MID-SPAN. Fattest at the hand made a white wedge (perspective
     * already doubles that end); fattest at the victim washed his silhouette out
     * the way the speed ghosts once erased the player. Mid-span is empty air. */
    var w = TETH_W * (0.80 + 0.75 * Math.sin(sc * PI * 0.9));
    if (!seg2(MTX, TNODES[k], TNODES[k + 1], TNODES[k + 2],
              TNODES[k + 3], TNODES[k + 4], TNODES[k + 5], w)) continue;
    var d = sc - ph; if (d < 0) d += 1;
    var hot = d < 0.20 ? 1 - d / 0.20 : 0;
    tintLerp(C_PALE, C_HOT, hot);
    put(MTX, 0.5, a * (0.72 + 0.28 * hot));
    widen(MTX, TETH_GLOW);
    tintLerp(C_VIO, C_CYAN, hot);
    put(MTX, 0.5, a * 0.14);
  }
  /* the hand doing the work */
  var pu = 0.8 + 0.2 * Math.sin(now * 17);
  drawCube(ax, ay, az, 0.17 * pu, C_HOT, a * 0.85);
  drawCube(ax, ay, az, 0.44 * pu, C_VIO, a * 0.30);
}

function drawGrip(g){
  var a = g.life / (GRIP_HOLD * 0.6); if (a > 1) a = 1;
  if (a <= 0.02) return;
  var age = now - g.born;
  var pop = age < GRIP_POP ? age / GRIP_POP : 1;  /* bands snap open on the lock */
  pop = pop * pop * (3 - 2 * pop);
  /* THRASHING: the victim is fighting it, so everything lurches together on one
   * shared shudder (two incommensurate frequencies => never a clean loop). */
  var cx = g.x + Math.sin(now * 13.7) * 0.05 + Math.sin(now * 7.1) * 0.03;
  var cy = g.y + Math.sin(now * 11.3 + 1.7) * 0.055;
  var cz = g.z + Math.cos(now * 12.1 + 0.6) * 0.05;
  var pulse = 1 + 0.13 * Math.sin(now * 9.4);
  var i, k;

  drawTether(g, cx, cy, cz, a);

  /* two fat counter-rotating bands, wobbling on their axes like a caught animal */
  for (k = 0; k < GRIP_RINGS; k++){
    var rad = (GRIP_R0 + (GRIP_R1 - GRIP_R0) * k) * g.r * pulse * (0.5 + 0.5 * pop);
    var tilt = k * 1.15 + Math.sin(now * 1.9 + k * 2.1) * 0.30;
    var spin = now * (2.2 - 1.5 * k) + k * 2.1;
    var yoff = (k - 0.5) * 0.14 + Math.sin(now * 2.3 + k) * 0.05;
    var ct = Math.cos(tilt), stl = Math.sin(tilt);
    var cs = Math.cos(spin), ss = Math.sin(spin);
    /* ring plane basis: horizontal ring tilted about X, then yawed by spin */
    var e1x = cs,          e1y = 0,   e1z = -ss;
    var e2x = ct * ss,     e2y = stl, e2z = ct * cs;
    /* ...except the INNER band, which is billboarded to the camera so it is
     * always a full hoop. A tumbling gyroscope is alive, but it spends part of
     * every cycle edge-on, and edge-on a ring of shards reads as the same little
     * asterisk this rebuild exists to kill. One guaranteed circle + one tumbling
     * ring = legible from every angle and still not static. */
    if (k === 0 && JK.GL && JK.GL.eye){
      var ex = cx - JK.GL.eye[0], ey = cy - JK.GL.eye[1], ez = cz - JK.GL.eye[2];
      var el = Math.sqrt(ex * ex + ey * ey + ez * ez);
      if (el > 0.5){
        frame(ex / el, ey / el, ez / el);      /* PX,PZ span the screen plane */
        e1x = PX[0] * cs + PZ[0] * ss; e1y = PX[1] * cs + PZ[1] * ss; e1z = PX[2] * cs + PZ[2] * ss;
        e2x = -PX[0] * ss + PZ[0] * cs; e2y = -PX[1] * ss + PZ[1] * cs; e2z = -PX[2] * ss + PZ[2] * cs;
      }
    }
    var step = TAU / GRIP_SEG;
    var w = GRIP_W + 0.022 * k;
    for (i = 0; i < GRIP_SEG; i++){
      var an = i * step + spin * 0.5;
      var ca = Math.cos(an), sa = Math.sin(an);
      var bx = cx + (e1x * ca + e2x * sa) * rad;
      var by = cy + yoff + (e1y * ca + e2y * sa) * rad;
      var bz = cz + (e1z * ca + e2z * sa) * rad;
      var tx = -e1x * sa + e2x * ca;
      var ty = -e1y * sa + e2y * ca;
      var tz = -e1z * sa + e2z * ca;
      var len = step * rad * 0.86;                /* nearly closed: a band, not dots */
      var h = len * 0.5;
      seg(MTX, bx - tx * h, by - ty * h, bz - tz * h, tx, ty, tz, w, len);
      tintLerp(C_PALE, C_VIO, GRIP_RINGS > 1 ? k / (GRIP_RINGS - 1) : 0);
      put(MTX, 0.5, a * (0.78 - 0.12 * k));
      widen(MTX, 2.6);
      tint(C_BLUE);
      put(MTX, 0.5, a * 0.16);
    }
  }

  /* VOLUME for two boxes: two counter-rotating prisms of glow around the
   * body — a tall one down the whole figure and a wide flat one at the chest.
   * This is what turns a sparkle into "he is held inside something". */
  col(MTX, cx, cy, cz, GRIP_AUR0 * g.r * pulse, 2.25, now * 0.8);
  tint(C_CYAN); put(MTX, 0, a * GRIP_AUR_A * 1.15);
  col(MTX, cx, cy, cz, GRIP_AUR1 * g.r, 1.15, -now * 0.6 + 0.8);
  tint(C_VIO); put(MTX, 0, a * GRIP_AUR_A);

  /* motes torn off the body — pure formula, no state, no allocation */
  for (i = 0; i < GRIP_MOTES; i++){
    var mp = (now * 0.62 + i * 0.1371) % 1;
    var ang = i * 2.3999 + now * 1.35;
    var mr = g.r * 1.25 * (1 - 0.45 * mp);
    var mx = cx + Math.cos(ang) * mr + Math.sin(now * 15 + i) * 0.04;
    var my = cy - 0.80 + mp * 1.95;
    var mz = cz + Math.sin(ang) * mr;
    drawCube(mx, my, mz, 0.100 * (1 - 0.45 * mp), C_CYAN, a * Math.sin(mp * PI) * 0.9);
  }

  /* the choke itself */
  drawCube(cx, cy, cz, 0.26 + 0.06 * Math.sin(now * 15), C_HOT, a * 0.42);
  drawCube(cx, cy, cz, 0.66 + 0.10 * Math.sin(now * 15), C_VIO, a * 0.13);
}

/* THE RELEASE. JK.Powers has no ForceFx call for letting go (its contract ends
 * at onForce('gripRelease')), so the visual is driven from the aura's own death:
 * a grip that stops being refreshed times out inside GRIP_HOLD, and that is
 * exactly the moment the player let go. Anything that ends a channel — release,
 * empty force pool, the victim dying, switching power — lands here, so the choke
 * can never just evaporate. */
function releaseBurst(g){
  if (now - g.born < REL_MIN) return;             /* a one-frame graze: no bang */
  var P = JK.Player;
  var px = P && P.pos ? P.pos[0] : g.x;
  var py = P && P.pos ? P.pos[1] + 1.25 : g.y;
  var pz = P && P.pos ? P.pos[2] : g.z + 1;
  RPOS[0] = g.x; RPOS[1] = g.y; RPOS[2] = g.z;
  RDIR[0] = g.x - px; RDIR[1] = g.y - py; RDIR[2] = g.z - pz;
  spawnRing(2, RPOS, RDIR);                       /* hoop faces along the throw */
  if (JK.Fx){
    if (JK.Fx.burst) JK.Fx.burst(RPOS, 14, C_CYAN);
    if (JK.Fx.sparks) JK.Fx.sparks(RPOS, 10, C_PALE);
  }
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

/* `force` lays one down unconditionally (the frame Force Speed latches on);
 * otherwise the player must have MOVED since the last one. gLast is only
 * advanced by a sample that actually happened, so a slow walker gets his ghost
 * the instant he has covered the distance rather than on the next 42 ms tick. */
function sampleGhost(force){
  var P = JK.Player;
  if (!P || !P.pos) return;
  if (!force && gHave){
    var dx = P.pos[0] - gLx, dy = P.pos[1] - gLy, dz = P.pos[2] - gLz;
    if (dx * dx + dy * dy + dz * dz < GHOST_MIN_D * GHOST_MIN_D) return;
  }
  var k = gHead * 4;
  gPos[k] = P.pos[0]; gPos[k + 1] = P.pos[1]; gPos[k + 2] = P.pos[2];
  gPos[k + 3] = P.yaw || 0;
  gT[gHead] = now;
  gHead = (gHead + 1) % GHOSTS;
  gLx = P.pos[0]; gLy = P.pos[1]; gLz = P.pos[2]; gHave = true;
  gLast = now;
}

function drawGhosts(){
  var fade = 1;
  if (!speedOn){
    var off = now - speedOffT;
    if (off > SPEED_TAIL) return;
    fade = 1 - off / SPEED_TAIL;
  }
  /* current body position, so an after-image sitting ON the player (he stopped,
   * or curled back through his own trail) fades instead of bleaching him */
  var P = JK.Player, near = !!(P && P.pos);
  var px = near ? P.pos[0] : 0, py = near ? P.pos[1] : 0, pz = near ? P.pos[2] : 0;
  for (var i = 0; i < GHOSTS; i++){
    var age = now - gT[i];
    if (age <= 0.03 || age > GHOST_LIFE) continue;    /* skip the newest sample */
    var k = i * 4;
    var s = 1 - age / GHOST_LIFE;
    var a = s * s * 0.30 * fade;
    if (near){
      var qx = gPos[k] - px, qy = gPos[k + 1] - py, qz = gPos[k + 2] - pz;
      var q2 = qx * qx + qy * qy + qz * qz;
      if (q2 < GHOST_FAR * GHOST_FAR){
        if (q2 <= GHOST_NEAR * GHOST_NEAR) continue;
        a *= (Math.sqrt(q2) - GHOST_NEAR) / (GHOST_FAR - GHOST_NEAR);
      }
    }
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
    var r = TINT[0] * a, gg = TINT[1] * a, bb = TINT[2] * a;
    for (var q = 0; q < 30; q += 6)             /* five body boxes, one frame */
      emitBox(MTX, GHOST_BOX[q], GHOST_BOX[q+1], GHOST_BOX[q+2],
              GHOST_BOX[q+3], GHOST_BOX[q+4], GHOST_BOX[q+5], r, gg, bb);
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
    speedOn = false; ForceFx.speedOn = false; speedOffT = -9;
    gLast = -9; gHave = false;
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
    /* One caller-garbage check at the door, exactly as gripPoint does: a single
     * non-finite endpoint used to make len NaN and spray ~28 NaN model matrices
     * a frame, every frame the channel was held, with nothing to say where they
     * came from. Measured: 8 NaN uniform matrices per frame per bad arc. */
    if (!(from[0] > -1e9 && from[0] < 1e9 && from[1] > -1e9 && from[1] < 1e9 &&
          from[2] > -1e9 && from[2] < 1e9 && to[0] > -1e9 && to[0] < 1e9 &&
          to[1] > -1e9 && to[1] < 1e9 && to[2] > -1e9 && to[2] < 1e9)) return;
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
    var i, g = null, best = 1e9, same = false;
    for (i = 0; i < GRIP_MAX; i++){
      var c = grips[i];
      if (c.life > 0){
        var dx = c.x - GP[0], dy = c.y - GP[1], dz = c.z - GP[2];
        if (dx * dx + dy * dy + dz * dz < 12.25){ g = c; same = true; break; }  /* same victim */
      }
      if (c.life < best){ best = c.life; g = c; }   /* else: recycle the faintest */
    }
    if (!g) g = grips[0];
    /* Anything that is NOT a refresh of the same victim restarts the pop — a
     * fresh lock, and also a live slot STOLEN for a different victim, which the
     * old `g.life <= 0` test missed: the bands stayed wide open, so the second
     * simultaneous choke never snapped shut on anybody. */
    if (!same) g.born = now;
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
    if (on){ gLast = -9; gHave = false; sampleGhost(true); }
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
      if (g.life > 0){
        g.life -= dt;
        /* the frame the choke times out IS the frame the player let go */
        if (g.life <= 0){ g.life = 0; releaseBurst(g); }
      }
    }
    if (speedOn && now - gLast >= GHOST_DT) sampleGhost();
  },

  draw: function(){
    if (!built || !JK.GL || !JK.GL.gl) return;
    var i;
    JK.GL.reset(batch);          /* counts decide what is drawn: never stale */
    drawGhosts();
    for (i = 0; i < RING_MAX; i++) if (rings[i].live) drawRing(rings[i]);
    for (i = 0; i < GRIP_MAX; i++) if (grips[i].life > 0) drawGrip(grips[i]);
    for (i = 0; i < ARC_MAX; i++) if (arcs[i].life > 0) drawArc(arcs[i]);
    /* the whole module, however much of it is alight, in ONE driver call */
    if (batch.ni) JK.GL.draw(batch, null, BOPT);
  }
};
})();
