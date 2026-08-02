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

/* ---------------- exported arrays (allocated once) ---------------- */
var pos = [0, 0, 6];
var vel = [0, 0, 0];
var camEye = [0, 3, 11];
var camTarget = [0, 1.55, 6];

/* ---------------- internal state ---------------- */
var yaw = 0, camYaw = 0, camPitch = -0.26, camDist = CAM_DIST;
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

    /* ---- orbit look: drag right => orbit right, drag up => look up ---- */
    camYaw -= (st.lookDX || 0) * LOOK_SENS;
    if (camYaw > PI) camYaw -= TWO_PI; else if (camYaw < -PI) camYaw += TWO_PI;
    camPitch -= (st.lookDY || 0) * LOOK_SENS;
    if (camPitch < PITCH_MIN) camPitch = PITCH_MIN;
    else if (camPitch > PITCH_MAX) camPitch = PITCH_MAX;

    /* ---- camera-relative desired move ---- */
    var mx = st.moveX || 0, my = st.moveY || 0;
    var mag = Math.sqrt(mx * mx + my * my);
    if (mag > 1){ mx /= mag; my /= mag; mag = 1; }
    var hasMove = mag > 0.12;
    var sprinting = !!(st.runHeld !== undefined ? st.runHeld : st.run);
    var fwdX = -Math.sin(camYaw), fwdZ = -Math.cos(camYaw);
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

    /* ---- body yaw eases toward travel direction (shortest arc) ---- */
    if (hasMove){
      var tYaw = Math.atan2(-dirX, -dirZ);           /* fwd(yaw)=(-sin,-cos) */
      var d = tYaw - yaw;
      d -= TWO_PI * Math.round(d / TWO_PI);
      var mt = TURN_RATE * dt;
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

    /* ---- camera: springy orbit, pulls back while sprinting ---- */
    var wantDist = speed2D > 6.2 ? CAM_DIST_SPRINT : CAM_DIST;
    camDist += (wantDist - camDist) * (1 - Math.exp(-DIST_SMOOTH * dt));
    placeCamera(dt, false);

    mirror(P);
    JK.GL.setCamera(camEye, camTarget, 72);           /* END of update */
  }
};
})();
