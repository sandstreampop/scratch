/* JK.Player — third-person movement physics + orbit camera. Owner: player agent.
 *
 * EXPORTS (stable identities — other modules read these every frame):
 *   pos [x,y,z]      FEET position, meters (same array object forever)
 *   yaw              facing, radians, 0 = -Z (character model heading)
 *   vel [x,y,z]      velocity m/s (same array object forever)
 *   onGround         bool
 *   speed2D          horizontal speed m/s
 *   anim             'idle' | 'run' | 'sprint' | 'jump' | 'fall'
 *   camEye/camTarget vec3 arrays (reused, never reallocated)
 *   camYaw/camPitch  camera orbit angles, radians (for aiming modules)
 *   stanceIdx        0 LIGHT / 1 MEDIUM / 2 STRONG (cycled by stance tap)
 *   attackQueued     set true on attack edge; saber module consumes+clears.
 *
 * Feel: JK2-ish — fast accel, heroic 8.5 m/s jump under 22 m/s^2 gravity,
 * camera-relative stick, body turns toward travel at 12 rad/s.
 *
 * ===========================================================================
 * AUTO-FOLLOW CAMERA — the geometry, and why this scheme cannot spiral
 * ===========================================================================
 * Movement is camera-relative. With a basis yaw B and stick (mx,my) the world
 * direction we accelerate toward is
 *
 *     dir = fwd(B)*my + right(B)*mx,
 *     fwd(B) = (-sinB, 0, -cosB),  right(B) = fwd x up = (cosB, 0, -sinB)
 *
 * Write the stick as a polar angle s = atan2(mx, my) (0 = forward, +right) and
 * expand: -dirX = r*sin(B - s), -dirZ = r*cos(B - s). The world heading of the
 * stick, h = atan2(-dirX,-dirZ), therefore collapses to a single line:
 *
 *     h = B - s                                                        (1)
 *
 * THE SPIRAL TRAP. If the basis is the raw camera yaw (B = camYaw) and we ease
 * camYaw toward h, then by (1) h moves lock-step with camYaw: dh = dcamYaw. The
 * error h - camYaw is CONSTANT, the camera chases a heading that runs away from
 * it at exactly its own rate, and the player orbits forever. Hold the stick left
 * and you drive a circle. That is the default outcome, and it is why "ease camYaw
 * toward the travel direction" — the obvious implementation — is simply wrong.
 *
 * THE FIX. Split camYaw into the part the PLAYER asked for and the part the
 * camera took by itself. `autoAccum` is the running total of AUTOMATIC yaw
 * applied since the stick was pressed, and the movement basis is
 *
 *     B = camYaw - autoAccum                                           (2)
 *
 * Automatic rotation adds the same delta to camYaw and to autoAccum, so B — and
 * hence h — is EXACTLY invariant under it (not approximately: the two terms are
 * the same number). The player keeps running a straight world line while the
 * camera slides around behind them. Manual look adds to camYaw only, so dragging
 * still steers you 1:1, which is what a third-person player expects.
 *
 * WHY IT CONVERGES. Substituting (2) into (1), the alignment error is
 *
 *     e = h - camYaw = (camYaw - autoAccum - s) - camYaw = -autoAccum - s   (3)
 *
 * It does not contain camYaw at all. Easing e to zero just means driving
 * autoAccum -> -s: the camera rotates by exactly the stick angle and stops. It
 * is a first-order system with a fixed point, not a chase. Since every step is
 * clamped to the remaining error, overshoot is impossible, so it cannot ring.
 * When the stick returns to neutral autoAccum is cleared, so the next push is
 * always plain camera-relative — no offset survives a stick release.
 *
 * MANUAL DRAGS DRAIN THE ACCUMULATOR. A drag that opposes the automatic rotation
 * cancels it in the basis as well as in camYaw, so pulling the camera back to
 * where it started also restores the control frame it had there — the auto-follow
 * becomes exactly undoable. Only the part of a drag beyond the accumulated
 * automatic rotation steers the player. Drags that go the same way as the
 * automatic rotation steer 1:1 as usual.
 *
 * NO HARD EDGES: `autoBlend`. Every condition that switches the auto-follow on
 * (speed passing the threshold, the look grace expiring, a swing ending) is a
 * step function, and multiplying a 72 deg/s correction by a step function is a
 * LURCH — the camera sits dead still and then, one frame later, is sweeping at
 * full rate. Measured on the naive gate: 0 -> 71.6 deg/s in a single frame the
 * instant the grace period ran out. So the gate drives a 0..1 blend instead:
 * it fades in over ~0.3 s with a smoothstep (zero slope at both ends, so the
 * angular VELOCITY starts and stops smoothly, not just the angle), and falls
 * ~3x faster when the auto-follow is called off. A finger on the look control
 * is absolute and zeroes the blend outright, so the camera can never take even
 * one frame away from the player's thumb.
 */
(function(){
'use strict';

/* ---------------- tuning ---------------- */
var WALK_SPEED   = 5.0;    /* m/s */
var SPRINT_SPEED = 8.0;    /* m/s */
var ACCEL_GND    = 40;     /* m/s^2 toward desired vel on ground */
var ACCEL_AIR    = 12;     /* ~30% air control */
var DECEL_GND    = 30;     /* m/s^2 friction when no input on ground */
var TURN_RATE    = 12;     /* rad/s body yaw toward move dir */
var ATTACK_TURN_RATE = 26; /* rad/s — snap to the aim when swinging */
var GRAVITY      = 22;     /* m/s^2 */
var JUMP_VY      = 8.5;    /* m/s — heroic */
var BODY_R       = 0.55;   /* player capsule radius vs obstacle circles */
var SNAP_DOWN    = 0.6;    /* max ground drop we glue to before going airborne */
var STEEP_TAN    = 0.7;    /* uphill grade where slow-down starts (~35 deg) */
var LOOK_SENS    = 0.0045; /* rad per pixel */
var PITCH_MIN    = -1.1, PITCH_MAX = 0.5;
var CAM_DIST     = 4.2, CAM_DIST_SPRINT = 4.8;
var CAM_UP       = 1.55;   /* target height above feet */
var CAM_SMOOTH   = 10;     /* /s exp smoothing on eye */
var DIST_SMOOTH  = 4;      /* /s easing on orbit distance */
var CAM_CLEAR    = 0.35;   /* eye min height above terrain */
var EDGE_SPRING  = 10;     /* /s soft pushback at world border */
var PI = Math.PI, TWO_PI = PI * 2;

/* --- auto-follow tuning (see the header derivation) ---
 * The rate is ERROR-PROPORTIONAL (gentle when nearly aligned, firm when the
 * player is running hard away from the camera) and SPEED-SCALED (a sprint pulls
 * the camera behind roughly 2.4x faster than a trudge), then hard-capped so a
 * single frame can never snap. The cap is a RATE, so 20 fps and 60 fps travel
 * the same arc per second; AUTO_MAX_RATE * the 0.05 s dt clamp = 3.6 deg, which
 * stays under the probe's 4 deg/frame ceiling even on the worst allowed frame. */
var AUTO_MIN_SPD  = 1.5;   /* m/s — below this the camera never moves by itself */
var AUTO_DEAD     = 0.175; /* rad (10 deg) deadzone: no micro-jitter when aligned */
/* GAIN vs CAP — they buy different things, so tune them apart.
 * A recentre is two phases: a CAPPED sweep while the error is large (rate =
 * AUTO_MAX_RATE, this is the part the eye reads as "the camera is moving"),
 * then an EXPONENTIAL settle once AUTO_GAIN*err drops under the cap. Measured
 * on a 74 deg manual-drag recovery at gain 3.0: 0.4 s of sweep and 1.06 s of
 * settle — the tail was two thirds of the wait, and it is the phase where the
 * camera is barely moving, so it just reads as "not there yet". Raising the
 * gain shortens that tail (time constant 1/gain) and CANNOT make the camera
 * faster: the cap clamps every step regardless, so "never snaps" is untouched.
 * Nor can it overshoot at any dt — the step is a fraction of the error left. */
var AUTO_GAIN     = 4.5;   /* 1/s error-proportional gain at full sprint */
var AUTO_MAX_RATE = 1.25;  /* rad/s ceiling at full sprint (~72 deg/s) */
var AUTO_SLOW     = 0.42;  /* gain+cap scale at AUTO_MIN_SPD (1.0 at sprint) */
var AUTO_RISE     = 3.2;   /* 1/s — auto-follow fades IN over ~0.31 s, never steps on */
var AUTO_FALL     = 9.0;   /* 1/s — and out ~3x faster when it is called off */
var LOOK_GRACE    = 0.9;   /* s hands-off after the last manual look pixel */
var PITCH_NEUTRAL = -0.2;  /* rad — framing that shows the ground ahead */
var PITCH_GAIN    = 1.1;   /* 1/s easing toward PITCH_NEUTRAL */
var PITCH_RATE    = 0.45;  /* rad/s cap on the levelling */
var PITCH_DEAD    = 0.05;  /* rad — leave small manual pitches alone */

/* ---------------- exported arrays (allocated once) ---------------- */
var pos = [0, 0, 6];
var vel = [0, 0, 0];
var camEye = [0, 3, 11];
var camTarget = [0, 1.55, 6];

/* ---------------- internal state ---------------- */
var yaw = 0, camYaw = 0, camPitch = -0.26, camDist = CAM_DIST;
/* autoAccum: total AUTOMATIC camera yaw applied since the stick was pressed.
 * The movement basis is camYaw - autoAccum, so automatic rotation is invisible
 * to the stick and the player's world heading is preserved (see header). */
var autoAccum = 0;
/* autoBlend: 0..1 authority of the auto-follow this frame. Ramped, never gated,
 * so no condition change can hand the camera a step in angular velocity. */
var autoBlend = 0;
var lookIdle = 99;              /* s since the player last moved the camera */
var onGround = true, speed2D = 0, anim = 'idle';
var stanceIdx = 1;              /* template default: MEDIUM */
var lastStanceCt = 0;
var stanceEl = null;
var STANCE_NAMES = ['LIGHT STANCE', 'MEDIUM STANCE', 'STRONG STANCE'];
var EMPTY = [];
var NULL_STATE = { moveX: 0, moveY: 0, lookDX: 0, lookDY: 0,
  jump: false, attack: false, force: false, run: false, stance: 0 };
var DES_EYE = [0, 0, 0];        /* scratch: desired eye before smoothing */

/* ---------------- helpers ---------------- */
/* Fold any angle into [-PI, PI]. Must NOT be a single +/-2PI nudge: lookDX is
 * pixels accumulated since the previous update, so one long mouse flick across a
 * dropped frame is easily worth more than a full turn (2PI / LOOK_SENS = 1396 px)
 * and a one-shot nudge leaves camYaw permanently out of range for every module
 * that reads it (Audio pans off it, Powers casts along it). Round-based, so it is
 * exact in one step whatever the input, and allocation-free. */
function wrapPi(a){ return a - TWO_PI * Math.round(a / TWO_PI); }

function gh(x, z){                       /* defensive ground height */
  var T = JK.Terrain;
  return (T && T.height) ? T.height(x, z) : 0;
}

function softEdge(i, S, dt){             /* soft pushback on axis i (0 or 2) */
  var p = pos[i], over = 0;
  if (p > S) over = p - S; else if (p < -S) over = p + S;
  if (over !== 0){
    var k = EDGE_SPRING * dt; if (k > 1) k = 1;
    pos[i] = p - over * k;
    if (over * vel[i] > 0) vel[i] *= 1 - k;         /* bleed outward speed */
    if (pos[i] > S + 8) pos[i] = S + 8;             /* hard sanity cap */
    else if (pos[i] < -S - 8) pos[i] = -S - 8;
  }
}

/* camera pose from camYaw/camPitch/camDist. snap=true skips smoothing. */
function placeCamera(dt, snap){
  camTarget[0] = pos[0];
  camTarget[1] = pos[1] + CAM_UP;
  camTarget[2] = pos[2];
  var cp = Math.cos(camPitch), sp = Math.sin(camPitch);
  var fx = -Math.sin(camYaw) * cp, fy = sp, fz = -Math.cos(camYaw) * cp;
  DES_EYE[0] = camTarget[0] - fx * camDist;
  DES_EYE[1] = camTarget[1] - fy * camDist;
  DES_EYE[2] = camTarget[2] - fz * camDist;
  var k = snap ? 1 : 1 - Math.exp(-CAM_SMOOTH * dt);
  camEye[0] += (DES_EYE[0] - camEye[0]) * k;
  camEye[1] += (DES_EYE[1] - camEye[1]) * k;
  camEye[2] += (DES_EYE[2] - camEye[2]) * k;
  var floor = gh(camEye[0], camEye[2]) + CAM_CLEAR;  /* never under the sand */
  if (camEye[1] < floor) camEye[1] = floor;
}

function mirror(P){                      /* copy scalars onto the export */
  P.yaw = yaw; P.onGround = onGround; P.speed2D = speed2D; P.anim = anim;
  P.camYaw = camYaw; P.camPitch = camPitch; P.stanceIdx = stanceIdx;
}

/* ---------------- module ---------------- */
JK.Player = {
  pos: pos, yaw: 0, vel: vel, onGround: true, speed2D: 0, anim: 'idle',
  camEye: camEye, camTarget: camTarget,
  camYaw: 0, camPitch: -0.26,
  stanceIdx: 1,
  attackQueued: false,

  /* --- hooks for JK.Powers / JK.Bots (iteration 3+) ---
   * speedMul  multiplies walk/sprint target speed (Force Speed). Default 1.
   * jumped    true only on the frame the player left the ground by jumping.
   * impulse() adds world-space velocity (knockback, Force Jump); an upward
   *           impulse also unsticks the player from the ground the same frame. */
  speedMul: 1,
  jumped: false,
  impulse: function(vx, vy, vz){
    vel[0] += vx || 0; vel[1] += vy || 0; vel[2] += vz || 0;
    if (vy > 0){ onGround = false; pos[1] += 0.02; }
  },

  init: function(){
    pos[0] = 0; pos[2] = 6;                      /* spawn facing origin (-Z) */
    pos[1] = gh(pos[0], pos[2]);                 /* ground at the ACTUAL spawn xz */
    vel[0] = 0; vel[1] = 0; vel[2] = 0;
    yaw = 0; camYaw = 0; camPitch = -0.26; camDist = CAM_DIST;
    autoAccum = 0; autoBlend = 0; lookIdle = 99;
    onGround = true; speed2D = 0; anim = 'idle';
    stanceIdx = 1; this.attackQueued = false;
    this.speedMul = 1; this.jumped = false;
    stanceEl = document.getElementById('stanceTag');
    if (stanceEl) stanceEl.textContent = STANCE_NAMES[stanceIdx];
    var st = JK.Input && JK.Input.state;
    lastStanceCt = st ? (st.stance | 0) : 0;
    placeCamera(0, true);
    mirror(this);
    JK.GL.setCamera(camEye, camTarget, 72);
  },

  update: function(dt, t){
    var P = JK.Player;
    var st = (JK.Input && JK.Input.state) || NULL_STATE;
    var i;

    /* ---- orbit look: drag right => orbit right, drag up => look up ----
     * A manual drag owns the camera outright, and it first DRAINS the
     * auto-follow accumulator: dragging back against an automatic rotation
     * undoes it in the control basis too (so the drag lands you exactly where
     * you would have been had the camera never recentred), and only the part
     * of the drag beyond that accumulated rotation steers the player. */
    var dYaw = -(st.lookDX || 0) * LOOK_SENS;
    var dPit = -(st.lookDY || 0) * LOOK_SENS;
    if (dYaw !== 0 || dPit !== 0){
      lookIdle = 0;
      autoBlend = 0;      /* the thumb is absolute: drop the auto-follow THIS frame,
                           * so a drag never has to share a frame with a correction */
    }
    else if (lookIdle < 99) lookIdle += dt;         /* clamped: no unbounded growth */
    if (dYaw !== 0 && autoAccum * dYaw < 0){        /* drag opposes auto rotation */
      var drain = dYaw < 0 ? -dYaw : dYaw;
      var accAbs = autoAccum < 0 ? -autoAccum : autoAccum;
      if (drain > accAbs) drain = accAbs;
      autoAccum += autoAccum > 0 ? -drain : drain;
    }
    camYaw = wrapPi(camYaw + dYaw);
    camPitch += dPit;
    if (camPitch < PITCH_MIN) camPitch = PITCH_MIN;
    else if (camPitch > PITCH_MAX) camPitch = PITCH_MAX;

    /* ---- camera-relative desired move ---- */
    var mx = st.moveX || 0, my = st.moveY || 0;
    var mag = Math.sqrt(mx * mx + my * my);
    if (mag > 1){ mx /= mag; my /= mag; mag = 1; }
    var hasMove = mag > 0.12;
    var sprinting = !!(st.runHeld !== undefined ? st.runHeld : st.run);
    /* The accumulator lives exactly as long as one stick hold. Neutral stick =>
     * the basis is plain camera-relative again, so a fresh push always runs
     * away from the camera and nothing carries over between holds. */
    if (!hasMove) autoAccum = 0;
    var baseYaw = camYaw - autoAccum;              /* == camYaw when converged-from-rest */
    var fwdX = -Math.sin(baseYaw), fwdZ = -Math.cos(baseYaw);
    /* right = fwd x up = (-fwdZ, 0, fwdX) */
    var dirX = fwdX * my - fwdZ * mx;
    var dirZ = fwdZ * my + fwdX * mx;

    var dvx = 0, dvz = 0;
    if (hasMove){
      var spd = (sprinting ? SPRINT_SPEED : WALK_SPEED) * mag * (P.speedMul || 1);
      if (onGround){
        /* uphill grade along move dir; >~50deg gets heavily slowed */
        var e = 0.4;
        var hx = (gh(pos[0] + e, pos[2]) - gh(pos[0] - e, pos[2])) / (2 * e);
        var hz = (gh(pos[0], pos[2] + e) - gh(pos[0], pos[2] - e)) / (2 * e);
        var uph = (dirX * hx + dirZ * hz) / mag;
        if (uph > STEEP_TAN){
          var kSlope = 1 - (uph - STEEP_TAN) * 1.4;  /* ~0.3 at 50deg grade */
          if (kSlope < 0.15) kSlope = 0.15;
          spd *= kSlope;
        }
      }
      var s = spd / mag;
      dvx = dirX * s; dvz = dirZ * s;
    }

    /* ---- accelerate toward desired horizontal velocity ---- */
    var ax = dvx - vel[0], az = dvz - vel[2];
    var al = Math.sqrt(ax * ax + az * az);
    var rate = hasMove ? (onGround ? ACCEL_GND : ACCEL_AIR)
                       : (onGround ? DECEL_GND : 0);
    if (al > 1e-6 && rate > 0){
      var step = rate * dt;
      if (step >= al){ vel[0] = dvx; vel[2] = dvz; }
      else { vel[0] += ax / al * step; vel[2] += az / al * step; }
    }

    /* ---- body yaw: face the aim while attacking, else face travel ----
     * A swing must land where the camera is pointing, so an attack overrides
     * the movement-facing and turns hard toward camYaw (JKO does the same). */
    var swinging = !!(JK.Rig && JK.Rig.swingPhase && JK.Rig.swingPhase() >= 0);
    var aiming = swinging || P.attackQueued;
    if (aiming || hasMove){
      var tYaw = aiming ? camYaw : Math.atan2(-dirX, -dirZ);  /* fwd(yaw)=(-sin,-cos) */
      var d = tYaw - yaw;
      d -= TWO_PI * Math.round(d / TWO_PI);
      var mt = (aiming ? ATTACK_TURN_RATE : TURN_RATE) * dt;
      if (d > mt) d = mt; else if (d < -mt) d = -mt;
      yaw += d;
      if (yaw > PI) yaw -= TWO_PI; else if (yaw < -PI) yaw += TWO_PI;
    }

    /* ---- jump / gravity / integrate ---- */
    P.jumped = false;
    if (st.jump && onGround){ vel[1] = JUMP_VY; onGround = false; P.jumped = true; }
    if (onGround) vel[1] = 0; else vel[1] -= GRAVITY * dt;
    pos[0] += vel[0] * dt;
    pos[1] += vel[1] * dt;
    pos[2] += vel[2] * dt;

    /* ---- world border: soft pushback at +/-SIZE ---- */
    var S = (JK.Terrain && JK.Terrain.SIZE) || 350;
    softEdge(0, S, dt);
    softEdge(2, S, dt);

    /* ---- push out of obstacle circles ---- */
    var obs = (JK.Terrain && JK.Terrain.obstacles) || EMPTY;
    for (i = 0; i < obs.length; i++){
      var o = obs[i];
      var dx = pos[0] - o.x, dz = pos[2] - o.z;
      var rr = o.r + BODY_R;
      var d2 = dx * dx + dz * dz;
      if (d2 < rr * rr){
        var dl = Math.sqrt(d2);
        var nx, nz;
        if (dl < 1e-4){ nx = 1; nz = 0; } else { nx = dx / dl; nz = dz / dl; }
        pos[0] = o.x + nx * rr;
        pos[2] = o.z + nz * rr;
        var vn = vel[0] * nx + vel[2] * nz;
        if (vn < 0){ vel[0] -= vn * nx; vel[2] -= vn * nz; }  /* slide */
      }
    }

    /* ---- ground collide / follow ---- */
    var gy = gh(pos[0], pos[2]);
    if (onGround){
      if (gy >= pos[1] - SNAP_DOWN) pos[1] = gy;     /* glue to the dunes */
      else onGround = false;                          /* crest launched us */
    } else if (pos[1] <= gy){
      pos[1] = gy; vel[1] = 0; onGround = true;       /* land: snap */
    }

    /* ---- derived: speed + anim hint ---- */
    speed2D = Math.sqrt(vel[0] * vel[0] + vel[2] * vel[2]);
    if (!onGround) anim = vel[1] > 0.5 ? 'jump' : 'fall';
    else if (speed2D > 6.2) anim = 'sprint';
    else if (speed2D > 0.6) anim = 'run';
    else anim = 'idle';

    /* ---- combat edges (do not consume beyond this) ---- */
    if (st.attack) P.attackQueued = true;             /* saber module clears */
    var stanceEdge;
    if (st.stanceTap !== undefined) stanceEdge = !!st.stanceTap;
    else stanceEdge = (st.stance | 0) !== lastStanceCt;
    lastStanceCt = st.stance | 0;
    if (stanceEdge){
      stanceIdx = (stanceIdx + 1) % 3;
      if (stanceEl) stanceEl.textContent = STANCE_NAMES[stanceIdx];
    }

    /* ---- AUTO-FOLLOW: ease the camera behind the way the player is GOING ----
     * Gated off unless the player is actually travelling, has hands off the
     * look control, and is not mid-swing (the body already turns to camYaw when
     * attacking — chasing it back would close a feedback loop).
     * The error is measured against the real velocity, not the stick, so a slide
     * along a rock or a shove still puts the camera where you end up going.
     * By (3) in the header this error does not depend on camYaw, so the loop has
     * a fixed point and every step is clamped to what is left of it: it eases in,
     * settles, and never overshoots or hunts.
     * Those four conditions are steps, so they drive a ramp rather than the
     * rotation itself — see autoBlend in the header. The rotation still needs
     * hasMove: autoAccum is only meaningful for the length of one stick hold, and
     * letting a fade-out tail rotate past the release would leave a stale offset
     * in the movement basis for the whole of the NEXT hold. */
    var autoOn = hasMove && !aiming && speed2D > AUTO_MIN_SPD && lookIdle >= LOOK_GRACE;
    if (autoOn){ autoBlend += AUTO_RISE * dt; if (autoBlend > 1) autoBlend = 1; }
    else { autoBlend -= AUTO_FALL * dt; if (autoBlend < 0) autoBlend = 0; }

    if (autoBlend > 0 && hasMove && speed2D > AUTO_MIN_SPD){
      /* smoothstep: the blend leaves 0 and reaches 1 with zero slope, so the
       * camera's angular VELOCITY has no corner either, not just its angle */
      var bl = autoBlend * autoBlend * (3 - 2 * autoBlend);
      var sf = (speed2D - AUTO_MIN_SPD) / (SPRINT_SPEED - AUTO_MIN_SPD);
      if (sf < 0) sf = 0; else if (sf > 1) sf = 1;
      var sc = (AUTO_SLOW + (1 - AUTO_SLOW) * sf) * bl;   /* walk gentle, sprint firm */

      var travel = Math.atan2(-vel[0], -vel[2]);
      var er = travel - camYaw;
      er -= TWO_PI * Math.round(er / TWO_PI);
      var sgn = er < 0 ? -1 : 1;
      var mErr = (er < 0 ? -er : er) - AUTO_DEAD;  /* soft deadzone: fades to 0 */
      if (mErr > 0){
        /* exponential ease (dt-exact), then a hard rate cap so it can't snap */
        var stepY = mErr * (1 - Math.exp(-AUTO_GAIN * sc * dt));
        var capY = AUTO_MAX_RATE * sc * dt;
        if (stepY > capY) stepY = capY;
        stepY *= sgn;
        camYaw = wrapPi(camYaw + stepY);
        autoAccum = wrapPi(autoAccum + stepY);     /* <-- the anti-spiral line */
      }

      /* gently level the pitch to a neutral framing so you see the ground ahead.
       * Blended by the same ramp, so hands-off levelling starts from rest too. */
      var pe = PITCH_NEUTRAL - camPitch;
      if (pe > PITCH_DEAD || pe < -PITCH_DEAD){
        var stepP = pe * (1 - Math.exp(-PITCH_GAIN * bl * dt));
        var capP = PITCH_RATE * bl * dt;
        if (stepP > capP) stepP = capP; else if (stepP < -capP) stepP = -capP;
        camPitch += stepP;
      }
    }

    /* ---- camera: springy orbit, pulls back while sprinting ---- */
    var wantDist = speed2D > 6.2 ? CAM_DIST_SPRINT : CAM_DIST;
    camDist += (wantDist - camDist) * (1 - Math.exp(-DIST_SMOOTH * dt));
    placeCamera(dt, false);

    mirror(P);
    JK.GL.setCamera(camEye, camTarget, 72);           /* END of update */
  }
};
})();
