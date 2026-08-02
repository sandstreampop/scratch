/* JK.Sabers — stance + attack system (the Jedi Outcast heart). Owner: sabers agent.
 *
 * Three stances (JK.Player.stanceIdx): 0 LIGHT / 1 MEDIUM / 2 STRONG.
 * Twelve authored swings (4 per stance), picked AT PRESS by stick direction:
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
 * Consumes JK.Player.attackQueued; drives the player rig via playSwing (instance
 * rig.playSwing per contract, JK.Rig.playSwing bridge, or degraded startSwing while
 * the character agent is mid-build). Updates #stanceTag text + color on stance change.
 */
(function(){
'use strict';

/* ================= stance table (contract fields + damage window) ========== */
var STANCES = [
  { name: 'LIGHT',  color: '#f0d028', dmg: 12, dur: 0.30, knock: 2, chainAt: 0.45,
    act0: 0.18, act1: 0.72 },   /* fast flurry: buffers chains early */
  { name: 'MEDIUM', color: '#f0ead2', dmg: 22, dur: 0.42, knock: 4, chainAt: 0.60,
    act0: 0.25, act1: 0.80 },   /* classic JKO arcs */
  { name: 'STRONG', color: '#f0563a', dmg: 40, dur: 0.62, knock: 7, chainAt: 0.75,
    act0: 0.30, act1: 0.88 }    /* huge commitment, long lethal window */
];

/* ================= swing authoring ========================================= */
/* Key fields all explicit so the rig never guesses defaults:
 * sp/sy/sr shoulder pitch/yaw/roll, el elbow, wr wrist, ty/tp torso yaw/pitch,
 * lunge meters forward. Convention (matches rig's old slash): +sp raises the arm
 * up/over, +ty twists torso toward the character's RIGHT. */
function K(t, sp, sy, sr, el, wr, ty, tp, lunge){
  return { t: t, sp: sp, sy: sy, sr: sr, el: el, wr: wr, ty: ty, tp: tp,
           lunge: lunge || 0 };
}
function guard(t){ return K(t, 0.45, 0, 0.15, 0.60, -0.60, 0, 0.04, 0); }
function mkDef(name, stance, keys, mirror){
  return { name: name, dur: STANCES[stance].dur, keys: keys, mirror: !!mirror };
}

/* DEFS[stance][dir]; dir: 0 neutral, 1 forward, 2 left, 3 right */
var DEFS = [
  [ /* ---------- LIGHT (0.30 s): quick wrist slashes, small torso ---------- */
    mkDef('FLURRY CROSS', 0, [            /* cross-slash R->L; mirrored = dual flurry */
      K(0.00, 0.50, -0.25,  0.50, 0.70, -0.50,  0.25,  0.05, 0),
      K(0.22, 1.10, -0.60,  0.75, 0.95, -0.85,  0.38,  0.02, 0),
      K(0.55, 0.30,  0.70, -0.25, 0.20,  0.40, -0.38,  0.12, 0),
      guard(1)
    ], true),
    mkDef('VIPER LUNGE', 0, [              /* straight thrust, small hop in */
      K(0.00, 0.30, -0.15,  0.30, 1.15, -0.90,  0.30, -0.05, 0),
      K(0.30, 1.35, -0.05,  0.10, 0.08, -0.15, -0.15,  0.25, 0.50),
      K(0.60, 1.28, -0.05,  0.14, 0.15, -0.22, -0.12,  0.22, 0.34),
      guard(1)
    ]),
    mkDef('SNAP CUT LEFT', 0, [            /* short diagonal, high-right to low-left */
      K(0.00, 0.60, -0.30,  0.60, 0.75, -0.70,  0.20,  0.02, 0),
      K(0.25, 1.25, -0.50,  0.80, 0.70, -0.90,  0.30, -0.04, 0),
      K(0.58, 0.10,  0.55, -0.20, 0.30,  0.30, -0.32,  0.14, 0),
      guard(1)
    ]),
    mkDef('SNAP CUT RIGHT', 0, [           /* short diagonal, high-left to low-right */
      K(0.00, 0.60,  0.30, -0.10, 0.75, -0.70, -0.20,  0.02, 0),
      K(0.25, 1.25,  0.55, -0.30, 0.70, -0.90, -0.30, -0.04, 0),
      K(0.58, 0.10, -0.50,  0.85, 0.30,  0.30,  0.32,  0.14, 0),
      guard(1)
    ])
  ],
  [ /* ---------- MEDIUM (0.42 s): classic JKO arcs, torso yaw -------------- */
    mkDef('HORIZON ARC', 1, [              /* shoulder-high horizontal R->L */
      guard(0),
      K(0.18, 0.90, -0.80,  1.10, 0.55, -0.70,  0.50, -0.06, 0),
      K(0.42, 0.95,  0.00,  0.45, 0.15, -0.10,  0.00,  0.08, 0.10),
      K(0.66, 0.85,  0.80, -0.35, 0.20,  0.30, -0.55,  0.12, 0),
      guard(1)
    ]),
    mkDef('SKYFALL CHOP', 1, [             /* overhead chop with a step */
      K(0.00, 0.55,  0.00,  0.25, 0.80, -0.70,  0.08, -0.06, 0),
      K(0.32, 2.60, -0.15,  0.35, 0.95, -0.85,  0.12, -0.22, 0),
      K(0.62, 0.55,  0.00,  0.20, 0.10,  0.50, -0.05,  0.42, 0.40),
      guard(1)
    ]),
    mkDef('RISING TALON', 1, [             /* dips low-right, carves up-left */
      K(0.00, 0.15, -0.30,  0.60, 0.50, -0.40,  0.30,  0.10, 0),
      K(0.28,-0.45, -0.50,  0.90, 0.65, -0.60,  0.45,  0.16, 0),
      K(0.60, 1.70,  0.60, -0.30, 0.30,  0.25, -0.45, -0.10, 0.15),
      K(0.80, 1.90,  0.65, -0.35, 0.45,  0.10, -0.50, -0.12, 0),
      guard(1)
    ]),
    mkDef('FALLING STAR', 1, [             /* cocks high-left, falls to low-right */
      guard(0),
      K(0.30, 2.10,  0.70, -0.40, 0.85, -0.90, -0.50, -0.15, 0),
      K(0.62,-0.25, -0.55,  1.00, 0.20,  0.45,  0.50,  0.30, 0.12),
      guard(1)
    ])
  ],
  [ /* ---------- STRONG (0.62 s): cinematic heaves, full-body -------------- */
    mkDef('DUNE CYCLONE', 2, [             /* massive 180-deg horizontal w/ wind-up */
      guard(0),
      K(0.14, 0.80, -0.90,  1.20, 0.80, -0.80,  0.85, -0.10, 0),
      K(0.30, 0.90, -1.00,  1.30, 0.75, -0.90,  0.95, -0.14, 0),   /* coiled hold */
      K(0.55, 1.00,  0.00,  0.55, 0.10, -0.05, -0.20,  0.10, 0.15),
      K(0.75, 0.90,  0.95, -0.50, 0.25,  0.40, -0.95,  0.16, 0),
      guard(1)
    ]),
    mkDef('METEOR SMASH', 2, [             /* leaping overhead smash */
      K(0.00, 0.40,  0.00,  0.40, 1.00, -0.80,  0.10, -0.30, 0),
      K(0.26, 2.80, -0.10,  0.30, 1.05, -1.00,  0.15, -0.35, 0.10),
      K(0.52, 0.35,  0.00,  0.15, 0.05,  0.55, -0.10,  0.55, 0.80),
      K(0.72, 0.25,  0.00,  0.15, 0.15,  0.60, -0.08,  0.50, 0.55), /* buried */
      guard(1)
    ]),
    mkDef('SANDSTORM SWEEP', 2, [          /* torso-driven arc, low-right to up-left */
      guard(0),
      K(0.20,-0.50, -0.70,  1.15, 0.70, -0.70,  0.80,  0.18, 0),
      K(0.50, 0.60,  0.10,  0.50, 0.15, -0.10, -0.10,  0.05, 0.20),
      K(0.72, 1.60,  0.80, -0.45, 0.30,  0.30, -0.85, -0.15, 0),
      guard(1)
    ]),
    mkDef('AVALANCHE', 2, [                /* high-left heave crashing to low-right */
      guard(0),
      K(0.22, 2.30,  0.85, -0.50, 0.90, -1.00, -0.80, -0.20, 0),
      K(0.50, 0.90,  0.00,  0.50, 0.10,  0.20,  0.10,  0.30, 0.25),
      K(0.72,-0.55, -0.70,  1.10, 0.30,  0.50,  0.85,  0.35, 0),
      guard(1)
    ])
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

/* --- defensive bridges to the character agent's iteration-2 rig API ------- */
function tryPlay(d){
  var R = JK.Rig;
  if (!R) return false;
  var p = R.player;
  if (p && p.playSwing) return p.playSwing(d) !== false;   /* contract instance API */
  if (R.playSwing) return R.playSwing(d) !== false;        /* module bridge */
  if (R.startSwing){ R.startSwing(); return true; }        /* degraded: old fixed slash */
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
