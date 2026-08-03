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
 *   DEFS           DEFS[stance][dir] arcDef — feed straight to rig.playArc(def)
 *                  (bots may reuse these; they are plain data, never mutated)
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
 * ===================== TWO RULES THE TABLE MUST OBEY =====================
 * 1. THE STRIKE MUST BE THE FASTEST THING ON SCREEN. The blade starts every swing
 *    at the idle guard (tip ~elevation 20, azimuth -7 from the pivot) and the engine
 *    blends guard -> a0 over the wind-up. That blend is real, visible motion: if the
 *    cocked pose is far from the guard and `windup` is short, the COCK-BACK is faster
 *    than the cut and the attack reads backwards (a flinch, then a slow push). Keep
 *      coilFromGuard(deg) / (windup * dur)  well under the strike's angular rate.
 *    Measured guard->coil distances are noted per attack below; none exceed 47 deg,
 *    and every stance now spends >= 0.08 s winding up.
 * 2. STANCE CHARACTER IS PEAK TIP SPEED, NOT JUST DURATION. Peak angular rate of the
 *    strike is ~1.67 * sweptAngle / strikeTime, where strikeTime = (1-windup-recover)
 *    * dur. LIGHT gets its speed from a SHORT strike time, STRONG gets its weight from
 *    a LONG one — so STRONG can be much wider without becoming quick.
 *
 * MEASURED, all twelve (great-circle arc / PEAK TIP SPEED / wind-up peak speed as a
 * fraction of the strike's peak — rule 1 needs that last column below 1.0):
 *      LIGHT   100-102 deg   28-32 m/s   wind-up 0.33-0.82 of the strike
 *      MEDIUM  101-128 deg   21-26 m/s   wind-up 0.47-0.77
 *      STRONG   99-140 deg   16-19 m/s   wind-up 0.43-0.69
 * So STRONG's arcs are up to 40% wider than MEDIUM's and 40% wider again than
 * LIGHT's, while its blade moves at little over HALF the speed of a LIGHT flick.
 * That is the stance triangle: fast+small, balanced, slow+huge. (VIPER LUNGE is the
 * exception on width by design — see the thrust note below.)
 */
(function(){
'use strict';

/* ================= stance table (contract fields + damage window) ========== */
/* act0/act1 bracket the STRIKE, and they are MEASURED, not guessed: they are the
 * phase band in which the blade tip is actually travelling (>= 25% of its peak
 * speed), so damage can never go live while the blade is still cocked, nor linger
 * after it has stopped at the end of the follow-through. Re-measure with
 * jedi/test/swing_probe.js if you ever retune windup/recover below. */
var STANCES = [
  { name: 'LIGHT',  color: '#f0d028', dmg: 12, dur: 0.30, knock: 2, chainAt: 0.45,
    act0: 0.33, act1: 0.82 },   /* fast flurry: buffers chains early */
  { name: 'MEDIUM', color: '#f0ead2', dmg: 22, dur: 0.42, knock: 4, chainAt: 0.60,
    act0: 0.29, act1: 0.82 },   /* classic JKO arcs */
  { name: 'STRONG', color: '#f0563a', dmg: 40, dur: 0.62, knock: 7, chainAt: 0.75,
    act0: 0.27, act1: 0.84 }    /* huge commitment, long lethal window */
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

/* Per-stance body defaults: pivot (chest, body-local, origin at the FEET), arm
 * radius, and the wind-up / recovery fractions.
 *   windup  — anticipation. Sized so the guard->coil blend NEVER outruns the strike
 *             (rule 1 above). In seconds: LIGHT 0.084, MEDIUM 0.101, STRONG 0.136.
 *   recover — settle back toward guard. The engine only unwinds SETTLE_FRAC (3.5%)
 *             of the arc here, so a long recovery is just a frozen blade: keep it
 *             short and let the strike own the phase. In seconds the STRIKE lasts
 *             LIGHT 0.174, MEDIUM 0.260, STRONG 0.409 — that 2.4x spread is what
 *             makes LIGHT whip and STRONG heave. */
var BODY = [
  { pivot: [0.06, 1.40, -0.08], radius: 1.05, windup: 0.28, recover: 0.14 }, /* LIGHT  */
  { pivot: [0.05, 1.44, -0.10], radius: 1.18, windup: 0.24, recover: 0.14 }, /* MEDIUM */
  { pivot: [0.04, 1.40, -0.12], radius: 1.34, windup: 0.22, recover: 0.12 }  /* STRONG */
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
  [ /* ------- LIGHT (0.30 s): compact, close to the body, chains fast ---------
       100-102 deg of arc in a 0.174 s strike — the fastest blade in the game
       (28-32 m/s at the tip) even though the arcs are the smallest. */
    /* tight diagonal cross-slash, high outside the right ear down past the left
       hip; the off hand mirrors it (and a DUAL saber makes it a two-blade flurry).
       coil 32 deg from guard. */
    A(0, 'FLURRY CROSS',   [ 46, -30], [-34,  40], 0.14,  0.50, { mirror: true }),
    /* a THRUST, and it must READ as one. Only 36 deg of arc — a chamber above the
       shoulder settling to LEVEL — while the BODY drives 1.2 m forward on the
       longest reach in the game (radius 1.62). Measured: the tip ends pointing 11
       deg below horizontal at chest height 3.1 m in front, i.e. an extended lunge,
       not the knee-height downward poke this used to be. `recover` is stretched to
       0.22 so the body does not snap back out of the lunge. */
    A(0, 'VIPER LUNGE',    [ 34,  -6], [ -2,  -2], 1.20,  0.00,
                           { radius: 1.62, recover: 0.22 }),
    /* flat snap off the right shoulder, finishing out past the LEFT hip.
       The exact azimuth mirror of SNAP CUT RIGHT, so the two never read alike. */
    A(0, 'SNAP CUT LEFT',  [ 18, -46], [-16,  50], 0.16,  0.30),
    /* the same flick reversed: starts up on the LEFT, finishes out past the right */
    A(0, 'SNAP CUT RIGHT', [ 18,  46], [-16, -50], 0.16, -0.30)
  ],
  [ /* ------- MEDIUM (0.42 s): the classic readable arcs --------------------
       101-128 deg over a 0.260 s strike (21-26 m/s). Four genuinely different
       shapes: one level, one vertical, one rising, one falling. */
    /* true horizontal sweep: the plane is exactly level (axis +Y) so the tip holds
       shoulder height for the whole 128 deg, right side across the front to left */
    A(1, 'HORIZON ARC',    [  0, -50], [  0,  78], 0.22,  0.00),
    /* overhead chop: the blade goes up over the head (the engine's ceiling holds
       the tip at 2.42 m) and comes down the front to knee height, with a step in */
    A(1, 'SKYFALL CHOP',   [ 58,  -8], [-46,  -3], 0.60,  0.00),
    /* rising cut. It has to READ as rising: the coil only dips to -8 (a low guard
       outside the right knee, not the fast plunge the eye used to mistake FOR the
       attack — this one needs the longer 0.28 wind-up to stay slower than its own
       cut) and it finishes at elevation 28, tip under 2.3 m rather than parked
       above the head like an antenna. */
    A(1, 'RISING TALON',   [ -8, -42], [ 28,  56], 0.24,  0.40, { windup: 0.28 }),
    /* the fall: cocks over the left shoulder and drops across to the low right */
    A(1, 'FALLING STAR',   [ 34,  34], [-34, -46], 0.26, -0.40)
  ],
  [ /* ------- STRONG (0.62 s): huge, heavy, torso-driven --------------------
       99-140 deg — the widest arcs in the game — but a 0.409 s strike, so the tip
       is the SLOWEST (16-19 m/s). Wide and heavy, never quick. */
    /* the cyclone: 140 deg, the biggest sweep in the game. Coils back past the
       right shoulder and carries all the way through past the LEFT shoulder —
       half again the travel of MEDIUM's horizontal and 1.4x a LIGHT cut. */
    A(2, 'DUNE CYCLONE',   [ 14, -48], [ -8,  92], 0.45,  0.00),
    /* leaping smash. Not SKYFALL CHOP slowed down: it cocks 16 deg BEHIND the right
       shoulder and crashes down slightly ACROSS the body (ending 6 deg past centre),
       a two-handed axe blow rather than a clean sagittal chop. 1.10 m of lunge. */
    A(2, 'METEOR SMASH',   [ 52, -13], [-46,   3], 1.10,  0.00, { radius: 1.30 }),
    /* scything heave: high outside the right, 123 deg down across the body and out
       past the left hip — much longer and lower than the LIGHT cross-slash */
    A(2, 'SANDSTORM SWEEP',[ 40, -38], [-44,  62], 0.35,  0.40),
    /* its opposite number, and steeper than MEDIUM's FALLING STAR: cocked higher
       over the left shoulder (50) and crashing further out to the low right (-56) */
    A(2, 'AVALANCHE',      [ 50,  30], [-46, -56], 0.35, -0.40)
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
