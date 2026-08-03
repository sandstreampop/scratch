/* JK.Sabers — stance + attack system (the Jedi Outcast heart). Owner: sabers agent.
 *
 * Three stances (JK.Player.stanceIdx): 0 LIGHT / 1 MEDIUM / 2 STRONG.
 * Twelve hand-authored ARCS (4 per stance), picked AT PRESS by stick direction:
 * neutral / forward (moveY>0.4, wins ties) / left (moveX<-0.4) / right (moveX>0.4).
 *
 * EXPORTS (contract — see CONVENTIONS.md "ITERATION 2 CONTRACTS"):
 *   STANCES        [{name,color,dmg,dur,knock,chainAt,act0,act1}] (act* = dmg window)
 *   stanceName(i)  -> 'LIGHT'|'MEDIUM'|'STRONG'
 *   active()       -> true during damage-active frames of a swing
 *   sweeps         array, one entry PER BLADE while active: {pb,pt,cb,ct,dmg,knock,name}
 *                  pb/pt = prev base/tip, cb/ct = cur base/tip — COPIES (never aliases
 *                  of rig.blades). First active frame: prev == cur (no teleport sweep).
 *   sweep          sweeps[0] or null
 *   attackName     name of current/last swing ('' before first)
 *   attackId       int, increments once per accepted swing (Combat dedupes on it)
 *
 * Consumes JK.Player.attackQueued; drives the player rig via rig.playArc (see the
 * SWING REWORK CONTRACT). Updates #stanceTag text + color on stance change.
 *
 * ===================== HOW THE TWELVE ARE AUTHORED =====================
 * Per the SWING REWORK CONTRACT nobody hand-writes joint angles: an attack is the
 * BLADE'S ARC and 40_character.js solves the arm to match. What a player actually
 * SEES is where the blade TIP travels, so that is what this table states: the tip's
 * start and end direction from the chest pivot, in degrees:
 *
 *      tip(elevation, azimuth)   elevation +up / -down,  azimuth + = character's LEFT
 *      so tip(38, 40) = high on the left, tip(-40,-48) = low on the right,
 *         tip(0, -52) = straight out to the right at chest height.
 *
 * arcFromTips() turns that pair into the (axis, a0, a1) the engine wants. It has to
 * undo two engine behaviours to land the tip where the table says:
 *   - the tip TRAILS the arc angle by ~6 deg (the tip is a blend of the arm's radial
 *     vector and the blade, and the blade LEADs the radial by 0.26 rad), and
 *   - the strike starts BACK_FRAC (7%) of the arc BEHIND a0 (the anticipation).
 * Everything else (pivot, radius, windup/recover, lunge) is per stance, overridden
 * per attack where the attack's identity needs it.
 *
 * MEASURED (jedi/test/swing_probe.js, all twelve): the tip sweeps 87-91 deg in LIGHT,
 * 99-145 in MEDIUM, 101-143 in STRONG — over 0.30 / 0.42 / 0.62 s. That ratio is the
 * stance feel: LIGHT is a tight fast flick, STRONG is a slow full-body heave.
 */
(function(){
'use strict';

/* ================= stance table (contract fields + damage window) ========== */
/* act0/act1 bracket the STRIKE, not the whole swing: each stance's windup ends at
 * `windup` (0.16 / 0.18 / 0.24 below) and the blade needs a further ~20% of the
 * strike to accelerate out of the coil, so damage goes live once the blade is
 * genuinely out in front and travelling, and stays live through the follow-through. */
var STANCES = [
  { name: 'LIGHT',  color: '#f0d028', dmg: 12, dur: 0.30, knock: 2, chainAt: 0.45,
    act0: 0.26, act1: 0.86 },   /* fast flurry: buffers chains early */
  { name: 'MEDIUM', color: '#f0ead2', dmg: 22, dur: 0.42, knock: 4, chainAt: 0.60,
    act0: 0.28, act1: 0.86 },   /* classic JKO arcs */
  { name: 'STRONG', color: '#f0563a', dmg: 40, dur: 0.62, knock: 7, chainAt: 0.75,
    act0: 0.32, act1: 0.88 }    /* huge commitment, long lethal window */
];

/* ================= arc authoring helpers (run ONCE at load) ================ */
var DEG = Math.PI / 180;
var TIP_LAG = 0.105;   /* rad the tip trails the arc angle (blade LEAD vs radial) */
var BACK    = 0.07;    /* engine's anticipation overshoot, fraction of the arc     */

/* unit direction from elevation / azimuth in degrees (+az = character's LEFT) */
function dir(el, az){
  el *= DEG; az *= DEG;
  var c = Math.cos(el);
  return [-c * Math.sin(az), Math.sin(el), -c * Math.cos(az)];
}
/* swing-plane basis, IDENTICAL to setBasis() in 40_character.js: angle 0 points UP,
 * or FORWARD when the axis is vertical; positive angles follow the right-hand rule */
function basis(x, y, z){
  var l = Math.sqrt(x * x + y * y + z * z) || 1;
  x /= l; y /= l; z /= l;
  var ux, uy, uz;
  if (y < 0.965 && y > -0.965){ ux = -x * y; uy = 1 - y * y; uz = -z * y; }
  else { ux = x * z; uy = y * z; uz = z * z - 1; }
  l = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
  ux /= l; uy /= l; uz /= l;
  return { n: [x, y, z], u: [ux, uy, uz],
           v: [y * uz - z * uy, z * ux - x * uz, x * uy - y * ux] };
}
/* the plane + angles whose TIP travels from direction s to direction e */
function arcFromTips(s, e){
  var l = Math.sqrt(s[0]*s[0] + s[1]*s[1] + s[2]*s[2]) || 1;
  var sx = s[0]/l, sy = s[1]/l, sz = s[2]/l;
  l = Math.sqrt(e[0]*e[0] + e[1]*e[1] + e[2]*e[2]) || 1;
  var ex = e[0]/l, ey = e[1]/l, ez = e[2]/l;
  var cx = sy*ez - sz*ey, cy = sz*ex - sx*ez, cz = sx*ey - sy*ex;
  var b = basis(cx, cy, cz);
  var delta = Math.atan2(Math.sqrt(cx*cx + cy*cy + cz*cz), sx*ex + sy*ey + sz*ez);
  var d  = (delta + 0.017) / (1 + BACK);        /* 0.017: tip lag differs start/end */
  var a0 = Math.atan2(sx*b.v[0] + sy*b.v[1] + sz*b.v[2],
                      sx*b.u[0] + sy*b.u[1] + sz*b.u[2]) + BACK * d - TIP_LAG;
  return { axis: b.n, a0: a0, a1: a0 + d };
}

/* per-stance body defaults: pivot (chest, body-local, origin at the FEET), arm
 * radius, and the wind-up / recovery fractions that give each stance its weight */
var BODY = [
  { pivot: [0.06, 1.40, -0.08], radius: 1.02, windup: 0.16, recover: 0.18 }, /* LIGHT  */
  { pivot: [0.05, 1.44, -0.10], radius: 1.18, windup: 0.18, recover: 0.20 }, /* MEDIUM */
  { pivot: [0.04, 1.40, -0.12], radius: 1.32, windup: 0.24, recover: 0.22 }  /* STRONG */
];

/* A(stance, name, tipStart, tipEnd, lunge, tilt, overrides) -> arcDef */
function A(st, name, s, e, lunge, tilt, o){
  var b = BODY[st], r = arcFromTips(dir(s[0], s[1]), dir(e[0], e[1]));
  o = o || {};
  return { name: name, dur: STANCES[st].dur,
           pivot: o.pivot || b.pivot,
           radius: o.radius || b.radius,
           axis: r.axis, a0: r.a0, a1: r.a1,
           tilt: tilt || 0,
           windup: o.windup || b.windup,
           recover: o.recover || b.recover,
           lunge: lunge || 0,
           mirror: !!o.mirror };
}

/* DEFS[stance][dir]; dir: 0 neutral, 1 forward, 2 left, 3 right.
 * Every "left" attack finishes on the character's LEFT and every "right" attack on
 * the RIGHT, so the stick direction always predicts where the blade ends up. */
var DEFS = [
  [ /* ------- LIGHT (0.30 s): compact, close to the body, chains fast --------- */
    /* tight diagonal cross-slash, high-right -> low-left; the off hand mirrors it
       (and a DUAL saber turns it into a real two-blade flurry) */
    A(0, 'FLURRY CROSS',   [ 42, -32], [-28,  30], 0.12,  0.50, { mirror: true }),
    /* a THRUST: barely any arc (45 deg), the blade drops to level and the whole
       body drives 1.15 m forward — the tip ends ~3 m in front of the player */
    A(0, 'VIPER LUNGE',    [ 34,  -8], [-10,  -3], 1.15,  0.00, { radius: 1.34 }),
    /* short flat diagonal off the right shoulder, finishing out past the left hip */
    A(0, 'SNAP CUT LEFT',  [ 14, -46], [-10,  42], 0.14,  0.30),
    /* the same flick reversed: starts up on the LEFT, finishes out past the right */
    A(0, 'SNAP CUT RIGHT', [ 18,  34], [-12, -48], 0.14, -0.30)
  ],
  [ /* ------- MEDIUM (0.42 s): the classic readable arcs -------------------- */
    /* true horizontal sweep: the plane is exactly level (axis +Y) so the tip holds
       shoulder height for the whole 145 deg, right side across the front to left */
    A(1, 'HORIZON ARC',    [  0, -52], [  0,  86], 0.20,  0.00),
    /* overhead chop: the blade goes up over the head (the engine's ceiling holds
       the tip at 2.42 m) and comes down the front to knee height, with a step in */
    A(1, 'SKYFALL CHOP',   [ 58,  -8], [-44,  -3], 0.60,  0.00),
    /* rising cut: dips low outside the right knee and carves up to high-left */
    A(1, 'RISING TALON',   [-14, -38], [ 33,  52], 0.22,  0.40),
    /* the fall: cocks high over the left shoulder and drops to the low right */
    A(1, 'FALLING STAR',   [ 38,  40], [-40, -48], 0.24, -0.40)
  ],
  [ /* ------- STRONG (0.62 s): huge, heavy, torso-driven -------------------- */
    /* the cyclone: the longest wind-up in the game (24% of a 0.62 s swing) coils the
       blade back past the right shoulder, then it whips 143 deg around the front and
       carries through past the LEFT shoulder — twice the travel of a LIGHT cut */
    A(2, 'DUNE CYCLONE',   [  6, -40], [ -6,  96], 0.45,  0.00),
    /* leaping smash: overhead, straight down the front, 1.10 m of lunge behind it;
       the tip finishes at the sand ~2.5 m in front */
    A(2, 'METEOR SMASH',   [ 50,  -8], [-46,  -3], 1.10,  0.00, { radius: 1.30 }),
    /* wide diagonal heave: high outside the right, down across the body to low-left */
    A(2, 'SANDSTORM SWEEP',[ 36, -40], [-40,  52], 0.35,  0.40),
    /* its mirror: high over the left shoulder, crashing down to the low right */
    A(2, 'AVALANCHE',      [ 38,  42], [-42, -50], 0.35, -0.40)
  ]
];

/* ================= sweep pool (zero alloc per frame) ======================= */
var MAXB = 2;                     /* max blades: dual/staff have 2 */
var pool = [];
(function(){
  for (var i = 0; i < MAXB; i++)
    pool.push({ pb: new Float32Array(3), pt: new Float32Array(3),
                cb: new Float32Array(3), ct: new Float32Array(3),
                dmg: 0, knock: 0, name: '' });
})();
var sweeps = [];                  /* exposed; holds pool refs while active */
var FB = [{ base: null, tip: null }];  /* fallback wrapper for pre-contract rig */

/* ================= internal state ========================================== */
var swinging = false;             /* a swing lifecycle is in flight */
var clock = 0, curDur = 0.42;     /* fallback phase clock (rig phase preferred) */
var phase = 0;
var curDef = null, curStance = 1, curChain = 0.6;
var wasActive = false, lastN = 0; /* sweep continuity across frames */
var activeFlag = false;
var attackId = 0, attackName = '';
var pendingDir = 0, wasQueued = false;
var lastStance = -1, tagEl = null;

function copy3(o, a){ o[0] = a[0]; o[1] = a[1]; o[2] = a[2]; }

function pickDir(st){
  if (!st) return 0;
  var mx = st.moveX || 0, my = st.moveY || 0;
  if (my > 0.4) return 1;          /* forward wins ties over sides */
  if (mx < -0.4) return 2;
  if (mx > 0.4) return 3;
  return 0;
}

/* --- defensive bridges to the character agent's rig API ------------------- */
function tryPlay(d){
  var R = JK.Rig;
  if (!R) return false;
  var p = R.player;
  if (p && p.playArc) return p.playArc(d) !== false;        /* contract instance API */
  if (R.playArc) return R.playArc(d) !== false;             /* module bridge */
  if (p && p.playSwing) return p.playSwing(d) !== false;    /* degraded: keyframe rig */
  if (R.playSwing) return R.playSwing(d) !== false;
  if (R.startSwing){ R.startSwing(); return true; }         /* degraded: fixed slash */
  return false;
}
function rigPhase(){                                       /* 0..1, -1 idle, -2 unknown */
  var R = JK.Rig, p = R && R.player;
  if (p && p.swingPhase) return p.swingPhase();
  if (R && R.swingPhase) return R.swingPhase();
  return -2;
}
function getBlades(){
  var R = JK.Rig;
  if (!R) return null;
  var p = R.player;
  if (p && p.blades && p.blades.length) return p.blades;   /* contract */
  if (R.blades && R.blades.length) return R.blades;
  if (R.basePos && R.tipPos){                              /* pre-contract single */
    FB[0].base = R.basePos; FB[0].tip = R.tipPos;
    return FB;
  }
  return null;
}

function tagStance(i){
  if (!tagEl) tagEl = document.getElementById('stanceTag');
  if (!tagEl) return;
  tagEl.textContent = STANCES[i].name + ' STANCE';
  tagEl.style.color = STANCES[i].color;
}

function clearSweeps(S){
  sweeps.length = 0;
  wasActive = false; lastN = 0; activeFlag = false;
  S.sweep = null;
}

/* ================= module =================================================== */
var Sabers = JK.Sabers = {
  STANCES: STANCES,
  DEFS: DEFS,
  sweeps: sweeps,
  sweep: null,
  attackName: '',
  attackId: 0,

  stanceName: function(i){
    i = i | 0; i %= 3; if (i < 0) i += 3;
    return STANCES[i].name;
  },

  active: function(){ return activeFlag && sweeps.length > 0; },

  init: function(){
    swinging = false; clock = 0; phase = 0; curDef = null;
    attackId = 0; attackName = '';
    pendingDir = 0; wasQueued = false;
    tagEl = null; lastStance = -1;
    clearSweeps(this);
    this.attackId = 0; this.attackName = '';
    var P = JK.Player;
    var si = P ? (P.stanceIdx | 0) : 1;
    si %= 3; if (si < 0) si += 3;
    lastStance = si;
    tagStance(si);                 /* take over the tag (adds stance color) */
  },

  update: function(dt, t){
    var S = Sabers;
    var P = JK.Player;
    var st = (JK.Input && JK.Input.state) || null;
    var i;

    if (!P){ clearSweeps(S); return; }   /* standalone testing only */

    /* ---- stance watch -> #stanceTag (Player wrote text; we restyle after) ---- */
    var si = P.stanceIdx | 0; si %= 3; if (si < 0) si += 3;
    if (si !== lastStance){ lastStance = si; tagStance(si); }

    /* ---- latch attack direction AT PRESS (fresh press re-latches) ---- */
    if (P.attackQueued && (!wasQueued || (st && st.attack)))
      pendingDir = pickDir(st);

    /* ---- swing lifecycle: prefer rig's phase, fall back to our clock ---- */
    if (swinging){
      clock += dt;
      var rp = rigPhase();
      if (rp >= 0) phase = rp;
      else if (rp === -1){          /* rig says done (ignore 1st-frame ordering) */
        if (clock > 0.05) swinging = false;
        else phase = curDur > 0 ? clock / curDur : 1;
      } else {                      /* degraded rig: run our own clock */
        phase = curDur > 0 ? clock / curDur : 1;
        if (phase >= 1) swinging = false;
      }
    }

    /* ---- start / chain a swing (retry each frame until the rig accepts) ---- */
    if (P.attackQueued && (!swinging || phase >= curChain)){
      var d = DEFS[si][pendingDir];
      if (tryPlay(d)){
        P.attackQueued = false;     /* consumed */
        swinging = true; clock = 0; phase = 0;
        curDef = d; curStance = si; curDur = d.dur;
        curChain = STANCES[si].chainAt;
        attackId++; attackName = d.name;
        wasActive = false; lastN = 0;   /* new swing: no carryover sweep */
      }
    }

    /* ---- damage-active window: capture per-blade sweep segments ---- */
    var act = false;
    if (swinging && curDef){
      var stc = STANCES[curStance];
      if (phase >= stc.act0 && phase <= stc.act1) act = true;
    }
    if (act){
      var blades = getBlades();
      var n = blades ? blades.length : 0;
      if (n > MAXB) n = MAXB;
      var m = 0;
      for (i = 0; i < n; i++){
        var b = blades[i];
        if (!b || !b.base || !b.tip) continue;
        var e = pool[m];
        if (wasActive && m < lastN){       /* continue: shift cur -> prev */
          e.pb.set(e.cb); e.pt.set(e.ct);
          copy3(e.cb, b.base); copy3(e.ct, b.tip);
        } else {                           /* first active frame: prev == cur */
          copy3(e.cb, b.base); copy3(e.ct, b.tip);
          e.pb.set(e.cb); e.pt.set(e.ct);
        }
        e.dmg = STANCES[curStance].dmg;
        e.knock = STANCES[curStance].knock;
        e.name = attackName;
        m++;
      }
      sweeps.length = m;
      for (i = 0; i < m; i++) sweeps[i] = pool[i];
      wasActive = m > 0; lastN = m;
      activeFlag = m > 0;
      S.sweep = m > 0 ? sweeps[0] : null;
    } else {
      clearSweeps(S);
    }

    S.attackName = attackName;
    S.attackId = attackId;
    wasQueued = !!P.attackQueued;
  }
};
})();
