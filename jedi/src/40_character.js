/* JK.Rig — low-poly humanoid rig + procedural animation + lightsaber.
 * Owner: character agent.
 *
 * Shared geometry: ONE set of white part meshes built once (buildMeshes); every
 * instance draws them with per-instance palette tints — bots reuse everything.
 *
 * Instance API (for bots iteration):
 *   var rig = JK.Rig.create(palette);
 *     palette: {skin,tunic,pants,boots,belt,hair} each [r,g,b]; null => Kyle-ish.
 *   rig.draw(pos, yaw, anim, phaseInfo)
 *     pos [x,y,z] feet, yaw radians. If phaseInfo {dt,t,speed} is given, the rig
 *     advances animation first (anim: 'idle'|'run'|'sprint'|'jump'|'fall'), then
 *     renders. Omit anim/phaseInfo to just render the current pose.
 *   rig.advance(dt, t, anim, speed2D)  — step animation without rendering.
 *   rig.setSaber(rgb, on)              — blade color / ignite state.
 *   rig.startSwing()                   — 0.38 s slash (chains when >60% done).
 *   rig.swingT (-1 idle, else seconds), rig.pose (eased joint angles),
 *   rig.basePos / rig.tipPos (Float32Array(3), world blade ends, set each draw).
 *
 * JK.Rig itself is the player's bridge: init/update/draw run the player rig off
 * JK.Player state; JK.Rig.tipPos/basePos alias the player rig's blade ends.
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
var SWING_DUR = 0.38, CHAIN_FRAC = 0.6;
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
    core:  GL.mesh(bakedBox(0.04, BLADE_LEN, 0.04, 1,1,1, 0, HILT_TOP + BLADE_LEN/2, 0)),
    glow1: GL.mesh(bakedBox(0.11, BLADE_LEN + 0.08, 0.11, 1,1,1, 0, HILT_TOP + BLADE_LEN/2 + 0.02, 0)),
    glow2: GL.mesh(bakedBox(0.21, BLADE_LEN + 0.18, 0.21, 1,1,1, 0, HILT_TOP + BLADE_LEN/2 + 0.04, 0)),
    /* shadow: emissive dark-sand patch (core shader only blends in additive
       mode, so a thin "pre-shaded" opaque box reads as a shadow with zero
       core edits). */
    shadow: GL.mesh(bakedBox(0.95, 0.02, 1.05, 0.33, 0.25, 0.155, 0, 0, 0))
  };
}
var CORE_OPTS = { emissive: 1, nofog: true };
var SHADOW_OPTS = { emissive: 1 };

/* ---------------- swing keyframes: [shoulder swing, spread, elbow, wrist, torso twist] */
var SW_T = [0, 0.30, 0.62, 1.0];
var SW_K = [
  [ 0.45,  0.15, 0.60, -0.60,  0.00],   /* guard              */
  [ 2.25, -0.55, 1.00, -0.35, -0.45],   /* windup: up, across body */
  [-0.55,  0.95, 0.15,  0.55,  0.45],   /* slashed down-right */
  [ 0.45,  0.15, 0.60, -0.60,  0.00]    /* recover            */
];
var SWV = [0, 0, 0, 0, 0];
function swingEval(u){
  var i = 0;
  while (i < 2 && u > SW_T[i + 1]) i++;
  var a = SW_K[i], b = SW_K[i + 1];
  var s = (u - SW_T[i]) / (SW_T[i + 1] - SW_T[i]);
  if (s < 0) s = 0; else if (s > 1) s = 1;
  s = s * s * (3 - 2 * s);
  for (var j = 0; j < 5; j++) SWV[j] = a[j] + (b[j] - a[j]) * s;
  return SWV;
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

  /* attack swing overlays the right arm + torso twist */
  if (this.swingT >= 0){
    this.swingT += dt;
    if (this.swingT >= SWING_DUR){
      this.swingT = -1;
    } else {
      var kv = swingEval(this.swingT / SWING_DUR);
      aSwR = kv[0]; sprR = kv[1]; elbR = kv[2]; wrist = kv[3];
      twist += kv[4];
      sprL += 0.25;                           /* off arm counterbalances */
    }
  }

  /* exponential ease toward targets (~0.12 s blend) */
  var kA = 1 - Math.exp(-26 * dt);            /* limbs */
  var kB = 1 - Math.exp(-14 * dt);            /* body mass */
  var kR = this.swingT >= 0 ? 1 - Math.exp(-45 * dt) : kA;  /* saber arm snaps */
  p.lSwL = ez(p.lSwL, lSwL, kA);   p.lSwR = ez(p.lSwR, lSwR, kA);
  p.kneeL = ez(p.kneeL, kneeL, kA); p.kneeR = ez(p.kneeR, kneeR, kA);
  p.aSwL = ez(p.aSwL, aSwL, kA);   p.sprL = ez(p.sprL, sprL, kA);
  p.elbL = ez(p.elbL, elbL, kA);
  p.aSwR = ez(p.aSwR, aSwR, kR);   p.sprR = ez(p.sprR, sprR, kR);
  p.elbR = ez(p.elbR, elbR, kR);   p.wrist = ez(p.wrist, wrist, kR);
  p.bob = ez(p.bob, bob, kB);      p.lean = ez(p.lean, lean, kB);
  p.twist = ez(p.twist, twist, kR); p.head = ez(p.head, head, kB);
}

function startSwing(){
  if (this.swingT < 0 || this.swingT > SWING_DUR * CHAIN_FRAC) this.swingT = 0;
}

function setSaber(rgb, on){
  if (rgb){ this.saberCol[0] = rgb[0]; this.saberCol[1] = rgb[1]; this.saberCol[2] = rgb[2]; }
  if (on !== undefined) this.saberOn = !!on;
}

/* ---------------- render (module-scope matrix pool: zero alloc) ------------- */
var mRoot = M.make(), mPelv = M.make(), mTorso = M.make(), mA = M.make(), mS = M.make();

function renderRig(r, pos, yaw){
  var GL = JK.GL, p = r.pose;

  /* --- ground shadow first (also guarantees frame starts non-additive) --- */
  var gx = pos[0], gz = pos[2], gy = 0, dhx = 0, dhz = 0, e = 0.6;
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
  M.ident(mRoot); M.tr(mRoot, pos[0], pos[1], pos[2]); M.ry(mRoot, yaw);

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

  /* left arm */
  M.copy(mA, mTorso); M.tr(mA, -SH_X, SH_Y, 0); M.rz(mA, -p.sprL); M.rx(mA, p.aSwL);
  GL.draw(MESH.uarm, mA, r.oTunic);
  M.tr(mA, 0, -UARM, 0); M.rx(mA, p.elbL);
  GL.draw(MESH.larm, mA, r.oTunic);
  M.tr(mA, 0, -LARM, 0);
  GL.draw(MESH.hand, mA, r.oSkin);

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

  /* right (saber) arm — hand frame ends up in mA */
  M.copy(mA, mTorso); M.tr(mA, SH_X, SH_Y, 0); M.rz(mA, p.sprR); M.rx(mA, p.aSwR);
  GL.draw(MESH.uarm, mA, r.oTunic);
  M.tr(mA, 0, -UARM, 0); M.rx(mA, p.elbR);
  GL.draw(MESH.larm, mA, r.oTunic);
  M.tr(mA, 0, -LARM, 0); M.rx(mA, p.wrist);
  GL.draw(MESH.hand, mA, r.oSkin);
  GL.draw(MESH.hilt, mA, null);

  /* world blade ends for combat (valid every frame, on or off) */
  M.xp(r.basePos, mA, 0, HILT_TOP, 0);
  M.xp(r.tipPos, mA, 0, HILT_TOP + BLADE_LEN, 0);

  if (r.saberOn){
    GL.draw(MESH.glow2, mA, r.oGlow2);        /* faint outer shell */
    GL.draw(MESH.glow1, mA, r.oGlow1);        /* hot inner shell */
    GL.draw(MESH.core, mA, CORE_OPTS);        /* opaque core LAST: restores
                                                 blend/depthMask state */
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
      aSwL: 0.10, aSwR: 0.38, sprL: 0.10, sprR: 0.14,
      elbL: 0.28, elbR: 0.55, wrist: -0.60 },
    phase: 0,
    swingT: -1,
    saberOn: true,
    saberCol: col3(null, [0.2, 0.9, 0.3]),
    basePos: new Float32Array(3),
    tipPos: new Float32Array(3),
    advance: advance,
    draw: instanceDraw,
    startSwing: startSwing,
    setSaber: setSaber
  };
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

  init: function(){
    buildMeshes();
    player = create(null);
    this.player = player;
    this.pose = player.pose;
    this.tipPos = player.tipPos;
    this.basePos = player.basePos;
  },

  update: function(dt, t){
    if (!player) return;
    var P = JK.Player;
    var anim = 'idle', sp = 0;
    if (P){
      anim = P.anim || 'idle';
      sp = P.speed2D || 0;
      /* consume queued attacks; keep buffered until the current swing chains */
      if (P.attackQueued){
        if (player.swingT < 0 || player.swingT > SWING_DUR * CHAIN_FRAC){
          P.attackQueued = false;
          player.startSwing();
        }
      } else if (P.attackQueued === undefined &&
                 JK.Input && JK.Input.state && JK.Input.state.attack){
        player.startSwing();   /* fallback until player module queues attacks */
      }
    }
    player.advance(dt, t, anim, sp);
  },

  draw: function(){
    if (!player || !JK.Player || !JK.Player.pos) return;
    renderRig(player, JK.Player.pos, JK.Player.yaw || 0);
  },

  setSaber: function(rgb, on){ if (player) player.setSaber(rgb, on); },
  startSwing: function(){ if (player) player.startSwing(); }
};
})();
