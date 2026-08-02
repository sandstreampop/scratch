/* JK.Powers — the FIVE force powers, the force pool, and the power selector.
 * Owner: powers agent (70_powers.js). Implements the ITERATION 3+4 contract.
 *
 * FORCE POOL (owned here): JK.game.force / JK.game.forceMax (100). Regen 14/s,
 * starting 0.8 s after the last spend (channelling spends every frame, so it
 * never regens mid-channel).
 *
 * POWER TABLE
 *   0 PUSH      25      instant   10 m / 75 deg cone   onForce('push', dir, 9)
 *                                                      + JK.Blaster.repel + droid onHit(10)
 *   1 PULL      20      instant   10 m / 75 deg cone   onForce('pull', dir, 7) + droid onHit(6)
 *   2 SPEED     10/s    channel   self                 JK.Player.speedMul = 1.75
 *   3 LIGHTNING 26/s    channel   14 m / 45 deg, x3    onForce('lightning', dir, 55*dt)
 *   4 GRIP      20/s    channel   12 m / 45 deg, x1    'grip' -> 'gripHold' 14*dt ->
 *                                                      'gripRelease' 12 (throw along camera)
 *   PUSH/PULL share a 0.55 s per-power cooldown. Not enough force (or no grip
 *   target) => JK.Audio.play('forceFail') + the selected slot flashes red.
 *   Entities WITHOUT onForce (the training droids) still react: push/pull knock
 *   them via onHit(10 / 6, dir, 'force'), lightning and grip choke them through
 *   onHit as well — GRIP prefers an onForce target and only falls back to a
 *   plain one when the cone holds nothing liftable.
 *
 * AIMING: everything aims down the CAMERA yaw (JK.Player.camYaw), not the body
 * yaw — you throw people where you are LOOKING, which is what JKO feels like.
 * Cone tests are horizontal (chest-to-chest for the direction handed to bots).
 *
 * INPUT: JK.Input.state.forceTap (or the forceSel counter) cycles the selection
 * (desktop R / wheel; this module also binds 1..5 for direct picks);
 * state.force (edge) casts an instant power / STARTS a channel; state.forceHeld
 * keeps a channel alive. A channel ends on release, on empty force, when the
 * power is switched, or when JK.Hero dies — every exit path restores
 * JK.Player.speedMul = 1 and sends exactly one 'gripRelease'.
 *
 * UI: this module builds its OWN DOM (a 5-slot chunky strip on the right edge,
 * above #btnForce; it never touches template.html or 60_ui.js) plus a <style>.
 * It also mirrors "FORCE PUSH  25" into #forceTag. DOM is written ONLY on change.
 *
 * EXPORTS
 *   init() / update(dt, t)                (no draw — JK.ForceFx renders)
 *   POWERS   [{id,name,label,cost,channel,range,cone,cd}]  (read-only table)
 *   NAMES    ['PUSH','PULL','SPEED','LIGHTNING','GRIP']
 *   sel      int 0..4 currently selected   select(i) / cycle(d)
 *   canCast(i) -> bool                     cast(i) -> bool (fire/start now)
 *   stop()   ends any channel cleanly      channelling / channelT / gripTarget
 *   aim / origin  Float32Array(3) scratch (read-only): yaw forward + chest point
 *
 * Zero per-frame allocation: every vector, target list and matrix is preallocated.
 */
(function(){
'use strict';

/* ============================ tuning ============================ */
var FORCE_MAX    = 100;
var REGEN_RATE   = 14;      /* force / s */
var REGEN_DELAY  = 0.8;     /* s after the last spend */
var CHEST        = 1.25;    /* caster chest height above feet (m) */
var CHEST_FRAC   = 0.55;    /* target chest = pos[1] + height*0.55 (contract) */

var SPEED_MUL    = 1.75;
var PUSH_POWER   = 9;       /* onForce scalar (m/s of impulse for bots) */
var PULL_POWER   = 7;
var PUSH_DMG     = 10;      /* droids: no onForce, so they take a knock instead */
var PULL_DMG     = 6;
var LIGHT_DPS    = 55;      /* damage / s per target */
var LIGHT_MAX    = 3;       /* simultaneous lightning targets */
var LIGHT_RETRIG = 0.45;    /* s between 'lightning' audio retriggers */
var LIGHT_FALL   = 8.0;     /* m: arc length when nothing is in the cone */
var GRIP_DPS     = 14;      /* choke damage / s */
var GRIP_THROW   = 12;      /* release impulse handed to the bot */
var GRIP_BREAK   = 18;      /* m: grip snaps beyond this */
var GRIP_LIFT    = 0.40;    /* upward bias mixed into the throw direction */
var MIN_START    = 0.5;     /* s of channel you must be able to afford to start */

var DEG = Math.PI / 180;
var COS_WIDE   = Math.cos(75 * DEG);   /* push / pull */
var COS_NARROW = Math.cos(45 * DEG);   /* lightning / grip */

var PUSH = 0, PULL = 1, SPEED = 2, LIGHTNING = 3, GRIP = 4;

var POWERS = [
  { id:0, name:'PUSH',      label:'PUSH',  cost:25, channel:false, range:10, cone:75, cd:0.55 },
  { id:1, name:'PULL',      label:'PULL',  cost:20, channel:false, range:10, cone:75, cd:0.55 },
  { id:2, name:'SPEED',     label:'SPEED', cost:10, channel:true,  range:0,  cone:0,  cd:0 },
  { id:3, name:'LIGHTNING', label:'LTNG',  cost:26, channel:true,  range:14, cone:45, cd:0 },
  { id:4, name:'GRIP',      label:'GRIP',  cost:20, channel:true,  range:12, cone:45, cd:0 }
];
var NAMES = ['PUSH', 'PULL', 'SPEED', 'LIGHTNING', 'GRIP'];
var NPOW = 5;

/* ============================ state ============================ */
var PL = null;                       /* JK.Player */
var sel = 0;
var mode = -1;                       /* channelled power id, -1 = none */
var channelT = 0;
var gripTarget = null, gripSent = false;
var lightSnd = 0;                    /* retrigger timer */
var sinceSpend = 99;
var cool = [0, 0, 0, 0, 0];
var lastSelCt = 0;
var speedOn = false;                 /* our speedMul/ForceFx.speed latch */
var inited = false;

/* ---- scratch (never reallocated) ---- */
var FWD    = new Float32Array(3);    /* horizontal camera forward (aim) */
var ORIGIN = new Float32Array(3);    /* caster chest, world */
var DIR    = new Float32Array(3);    /* caster -> entity, unit */
var TO     = new Float32Array(3);    /* fx endpoint */
var FROM   = new Float32Array(3);    /* fx start (hand) */
var THROW  = new Float32Array(3);    /* grip release direction */
/* GPOS doubles as a vec3 AND an entity-ish {pos} so ForceFx.grip works whether
 * it was written against grip(pos3, t) or grip(entity) — costs nothing. */
var GPOS   = [0, 0, 0];
GPOS.pos = GPOS; GPOS.radius = 0.55; GPOS.height = 1.8;

var HITS = new Array(32);
var HITD = new Float32Array(32);
var nHits = 0;
(function(){ for (var i = 0; i < 32; i++) HITS[i] = null; })();

var NULL_STATE = { force:false, forceHeld:false, forceTap:false, forceSel:0 };

/* ============================ tiny bridges ============================ */
function game(){
  var g = JK.game;
  if (!g) g = JK.game = { hp:100, hpMax:100, force:FORCE_MAX, forceMax:FORCE_MAX, kills:0 };
  return g;
}
function snd(name){
  var A = JK.Audio;
  if (A && typeof A.play === 'function') A.play(name);
}
function heroDead(){
  return !!(JK.Hero && JK.Hero.dead);
}
function fxOn(){ return JK.ForceFx; }

/* ============================ force pool ============================ */
function spend(n){
  var g = game();
  g.force -= n;
  if (!(g.force > 0)) g.force = 0;
  sinceSpend = 0;
}
function affords(p){
  var g = game();
  var d = POWERS[p];
  return g.force >= (d.channel ? d.cost * MIN_START : d.cost);
}

/* ============================ aiming / targeting ============================ */
/* Camera yaw forward, horizontal. Player camYaw: fwd = (-sin, 0, -cos). */
function updateAim(){
  var cy = (PL && PL.camYaw) || 0;
  FWD[0] = -Math.sin(cy); FWD[1] = 0; FWD[2] = -Math.cos(cy);
  ORIGIN[0] = PL.pos[0];
  ORIGIN[1] = PL.pos[1] + CHEST;
  ORIGIN[2] = PL.pos[2];
}

/* Full camera forward (with pitch) + a lift bias — the grip throw vector. */
function throwDir(out){
  var cy = (PL && PL.camYaw) || 0, cp = (PL && PL.camPitch) || 0;
  var cc = Math.cos(cp);
  var x = -Math.sin(cy) * cc, y = Math.sin(cp) + GRIP_LIFT, z = -Math.cos(cy) * cc;
  var l = Math.sqrt(x * x + y * y + z * z) || 1;
  out[0] = x / l; out[1] = y / l; out[2] = z / l;
  return out;
}

/* Unit direction from the caster's chest to the entity's chest (contract dir3). */
function dirTo(e, out){
  var ey = e.pos[1] + (e.height || 1.8) * CHEST_FRAC;
  var dx = e.pos[0] - ORIGIN[0], dy = ey - ORIGIN[1], dz = e.pos[2] - ORIGIN[2];
  var l = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (l < 1e-4){ out[0] = FWD[0]; out[1] = 0; out[2] = FWD[2]; return out; }
  out[0] = dx / l; out[1] = dy / l; out[2] = dz / l;
  return out;
}
function chestOf(e, out){
  out[0] = e.pos[0];
  out[1] = e.pos[1] + (e.height || 1.8) * CHEST_FRAC;
  out[2] = e.pos[2];
  return out;
}
/* Horizontal distance from the caster to an entity. */
function distTo(e){
  var dx = e.pos[0] - ORIGIN[0], dz = e.pos[2] - ORIGIN[2];
  return Math.sqrt(dx * dx + dz * dz);
}

/* Fill HITS/HITD with live non-player entities inside range + cone. */
function scan(range, cosHalf, needForce){
  nHits = 0;
  var C = JK.Combat, ents = C && C.ents;
  if (!ents || !ents.length) return 0;
  var r2 = range * range;
  for (var i = 0; i < ents.length; i++){
    if (nHits >= 32) break;
    var e = ents[i];
    if (!e || !e.pos || e.team === 'player') continue;
    if (!(e.hp > 0)) continue;                       /* dead things are skipped */
    if (needForce && typeof e.onForce !== 'function') continue;
    var dx = e.pos[0] - ORIGIN[0], dz = e.pos[2] - ORIGIN[2];
    var d2 = dx * dx + dz * dz;
    if (d2 > r2) continue;
    var d = Math.sqrt(d2);
    if (d > 0.25 && (dx * FWD[0] + dz * FWD[2]) / d < cosHalf) continue;
    HITS[nHits] = e; HITD[nHits] = d; nHits++;
  }
  return nHits;
}

/* Partial selection sort: the k nearest hits end up at the front of HITS. */
function nearestFirst(k){
  if (k > nHits) k = nHits;
  for (var a = 0; a < k; a++){
    var best = a;
    for (var b = a + 1; b < nHits; b++) if (HITD[b] < HITD[best]) best = b;
    if (best !== a){
      var te = HITS[a]; HITS[a] = HITS[best]; HITS[best] = te;
      var td = HITD[a]; HITD[a] = HITD[best]; HITD[best] = td;
    }
  }
}

/* Where the lightning leaves the body: the saber hand if the rig has drawn a
 * sane blade this frame, otherwise a point off the chest. */
function handPoint(out){
  var R = JK.Rig, b = R && R.blades && R.blades[0] && R.blades[0].base;
  if (b){
    var dx = b[0] - PL.pos[0], dy = b[1] - PL.pos[1], dz = b[2] - PL.pos[2];
    if (dy > 0.2 && dy < 2.6 && dx * dx + dz * dz < 4){
      out[0] = b[0]; out[1] = b[1]; out[2] = b[2];
      return out;
    }
  }
  var rx = -FWD[2], rz = FWD[0];                     /* right = fwd x up */
  out[0] = PL.pos[0] + FWD[0] * 0.28 + rx * 0.32;
  out[1] = PL.pos[1] + 1.30;
  out[2] = PL.pos[2] + FWD[2] * 0.28 + rz * 0.32;
  return out;
}

/* ============================ the powers ============================ */
function castPush(){
  var i, e, F = fxOn();
  spend(POWERS[PUSH].cost);
  cool[PUSH] = POWERS[PUSH].cd;
  snd('push');
  if (F && F.push) F.push(ORIGIN, FWD);
  if (JK.Blaster && typeof JK.Blaster.repel === 'function') JK.Blaster.repel(ORIGIN, FWD);
  scan(POWERS[PUSH].range, COS_WIDE, false);
  for (i = 0; i < nHits; i++){
    e = HITS[i];
    dirTo(e, DIR);
    if (typeof e.onForce === 'function') e.onForce('push', DIR, PUSH_POWER);
    else if (typeof e.onHit === 'function') e.onHit(PUSH_DMG, DIR, 'force');
    HITS[i] = null;
  }
  nHits = 0;
  return true;
}

function castPull(){
  var i, e, F = fxOn();
  spend(POWERS[PULL].cost);
  cool[PULL] = POWERS[PULL].cd;
  snd('pull');
  if (F && F.pull) F.pull(ORIGIN, FWD);
  scan(POWERS[PULL].range, COS_WIDE, false);
  for (i = 0; i < nHits; i++){
    e = HITS[i];
    dirTo(e, DIR);
    if (typeof e.onForce === 'function') e.onForce('pull', DIR, PULL_POWER);
    else if (typeof e.onHit === 'function') e.onHit(PULL_DMG, DIR, 'force');
    HITS[i] = null;
  }
  nHits = 0;
  return true;
}

function setSpeed(on){
  var F = fxOn();
  if (on === speedOn){
    if (on && PL) PL.speedMul = SPEED_MUL;           /* re-assert every frame */
    return;
  }
  speedOn = on;
  if (PL) PL.speedMul = on ? SPEED_MUL : 1;
  if (F && F.speed) F.speed(on);
}

/* Lock the nearest gripable entity in front. Returns it or null. */
function acquireGrip(){
  scan(POWERS[GRIP].range, COS_NARROW, true);
  if (!nHits){
    /* nothing with onForce: allow anything solid (droids just get shaken) */
    scan(POWERS[GRIP].range, COS_NARROW, false);
  }
  if (!nHits) return null;
  nearestFirst(1);
  var e = HITS[0];
  for (var i = 0; i < nHits; i++) HITS[i] = null;
  nHits = 0;
  return e;
}

function releaseGrip(){
  var e = gripTarget;
  gripTarget = null;
  Powers.gripTarget = null;
  if (e && gripSent){
    throwDir(THROW);
    if (typeof e.onForce === 'function') e.onForce('gripRelease', THROW, GRIP_THROW);
  }
  gripSent = false;
}

/* Start a channelled power. Returns true if it took. */
function startChannel(p){
  if (p === GRIP){
    var tgt = acquireGrip();
    if (!tgt) return false;                          /* nothing to choke: fail */
    gripTarget = tgt;
    Powers.gripTarget = tgt;
    gripSent = false;
  }
  mode = p;
  channelT = 0;
  Powers.channelling = true;
  Powers.channelT = 0;
  if (p === SPEED){ setSpeed(true); snd('speed'); }
  else if (p === LIGHTNING){ snd('lightning'); lightSnd = LIGHT_RETRIG; }
  else if (p === GRIP){ snd('grip'); }
  refreshSlots();
  return true;
}

/* End the active channel. ALWAYS restores speedMul and sends one gripRelease. */
function endChannel(){
  if (mode < 0){
    if (speedOn) setSpeed(false);                    /* paranoia: never stick */
    return;
  }
  var p = mode;
  mode = -1;
  channelT = 0;
  Powers.channelling = false;
  Powers.channelT = 0;
  if (p === SPEED) setSpeed(false);
  if (p === GRIP) releaseGrip();
  if (speedOn) setSpeed(false);
  refreshSlots();
}

/* One frame of the active channel. Returns false when it should end. */
function tickChannel(dt, t){
  var g = game(), F = fxOn(), i, e, d;
  var p = mode;
  var rate = POWERS[p].cost;

  if (g.force <= 0) return false;
  spend(rate * dt);
  channelT += dt;
  Powers.channelT = channelT;

  if (p === SPEED){
    setSpeed(true);
    return true;
  }

  if (p === LIGHTNING){
    lightSnd -= dt;
    if (lightSnd <= 0){ snd('lightning'); lightSnd = LIGHT_RETRIG; }
    handPoint(FROM);
    scan(POWERS[LIGHTNING].range, COS_NARROW, false);
    var n = nHits < LIGHT_MAX ? nHits : LIGHT_MAX;
    if (n > 0){
      nearestFirst(n);
      for (i = 0; i < n; i++){
        e = HITS[i];
        dirTo(e, DIR);
        d = LIGHT_DPS * dt;
        if (typeof e.onForce === 'function') e.onForce('lightning', DIR, d);
        else if (typeof e.onHit === 'function') e.onHit(d, DIR, 'force');
        if (F && F.lightning){ chestOf(e, TO); F.lightning(FROM, TO); }
      }
    } else if (F && F.lightning){                    /* crackle into the dunes */
      TO[0] = ORIGIN[0] + FWD[0] * LIGHT_FALL;
      TO[1] = ORIGIN[1] + 0.15;
      TO[2] = ORIGIN[2] + FWD[2] * LIGHT_FALL;
      F.lightning(FROM, TO);
    }
    for (i = 0; i < nHits; i++) HITS[i] = null;
    nHits = 0;
    return true;
  }

  /* GRIP: stay on the SAME entity even if it leaves the cone. */
  e = gripTarget;
  if (!e || !e.pos || !(e.hp > 0)) return false;
  if (distTo(e) > GRIP_BREAK) return false;
  dirTo(e, DIR);
  if (typeof e.onForce === 'function'){
    if (!gripSent){ e.onForce('grip', DIR, 0); gripSent = true; }
    e.onForce('gripHold', DIR, GRIP_DPS * dt);
  } else if (typeof e.onHit === 'function'){
    gripSent = true;                                 /* so release still fires */
    e.onHit(GRIP_DPS * dt, DIR, 'force');
  }
  if (F && F.grip){
    chestOf(e, GPOS);
    GPOS.radius = e.radius || 0.55;
    GPOS.height = e.height || 1.8;
    F.grip(GPOS, t);
  }
  return true;
}

/* Fire the selected power (instant) or start its channel. */
function fire(p){
  if (p < 0 || p >= NPOW) return false;
  var d = POWERS[p];
  if (heroDead()) return false;
  if (cool[p] > 0){ failFlash(p); return false; }
  if (!affords(p)){ failFlash(p); snd('forceFail'); return false; }
  if (d.channel){
    if (mode === p) return true;
    if (mode >= 0) endChannel();
    if (!startChannel(p)){ failFlash(p); snd('forceFail'); return false; }
    return true;
  }
  if (mode >= 0) endChannel();
  return p === PUSH ? castPush() : castPull();
}

/* ============================ selector UI ============================ */
var bar = null;
var slots = [null, null, null, null, null];
var stKey = [-1, -1, -1, -1, -1];    /* cached visual state bitmask per slot */
var dn  = [false, false, false, false, false];
var lo  = [false, false, false, false, false];
var tagEl = null, tagText = '';

var CSS = [
'#jkpBar { position:absolute; z-index:5; width:58px; pointer-events:auto;',
'  right:calc(14px + env(safe-area-inset-right));',
'  bottom:calc(276px + env(safe-area-inset-bottom));',
'  font:700 9px/1 "Trebuchet MS","Verdana",sans-serif; letter-spacing:.06em;',
'  text-shadow:1px 1px 0 #000; touch-action:none;',
'  -webkit-user-select:none; user-select:none; }',
'.jkp-s { position:relative; height:40px; margin-bottom:3px; background:#1d2412;',
'  border:2px solid; border-color:#8a9070 #3a4030 #3a4030 #8a9070; color:#c8d0b0;',
'  text-align:center; box-shadow:1px 1px 0 rgba(0,0,0,.5); cursor:pointer; }',
'.jkp-s:last-child { margin-bottom:0; }',
'.jkp-n { position:absolute; left:3px; top:2px; font-size:8px; color:#7a8064; }',
'.jkp-l { display:block; padding-top:10px; font-size:9px; letter-spacing:.08em; }',
'.jkp-c { display:block; margin-top:4px; font-size:8px; color:#8ad4ff; opacity:.8; }',
'.jkp-s.sel { background:#3a2e14; color:#ffd76a;',
'  border-color:#ffd76a #8a6a20 #8a6a20 #ffd76a;',
'  box-shadow:0 0 10px rgba(255,190,60,.35), 1px 1px 0 rgba(0,0,0,.5); }',
'.jkp-s.sel .jkp-n { color:#c8a860; }',
'.jkp-s.lo { opacity:.4; }',
'.jkp-s.dn { transform:scale(.94); }',
'.jkp-s.act { background:#123a3a; color:#9fe8ff;',
'  border-color:#9fe8ff #206070 #206070 #9fe8ff;',
'  box-shadow:0 0 14px rgba(120,220,255,.5), 1px 1px 0 rgba(0,0,0,.5); }',
'.jkp-s.fail { animation:jkpFail .45s ease-out; }',
'@keyframes jkpFail { 0% { background:#5a1810; border-color:#ff8a6a;',
'    box-shadow:0 0 14px rgba(255,90,50,.7); }',
'  100% { background:#1d2412; box-shadow:1px 1px 0 rgba(0,0,0,.5); } }',
'@media (max-height:620px) { #jkpBar { bottom:calc(272px + env(safe-area-inset-bottom));',
'    width:52px; } .jkp-s { height:32px; margin-bottom:2px; }',
'  .jkp-l { padding-top:6px; } .jkp-c { margin-top:2px; } }'
].join('\n');

function mk(tag, cls2, parent){
  var el = document.createElement(tag);
  if (cls2) el.className = cls2;
  if (parent) parent.appendChild(el);
  return el;
}
function stopOnly(e){ e.stopPropagation(); }
function eat(e){ e.stopPropagation(); if (e.cancelable) e.preventDefault(); }

/* Keep every menu touch away from 20_input.js's document/window handlers. */
function shield(el){
  var i;
  var tev = ['touchstart', 'touchmove', 'touchend', 'touchcancel'];
  for (i = 0; i < tev.length; i++) el.addEventListener(tev[i], stopOnly, {passive:false});
  var mev = ['mousedown', 'mousemove', 'mouseup', 'click', 'wheel'];
  for (i = 0; i < mev.length; i++) el.addEventListener(mev[i], stopOnly, {passive:false});
}

/* Slot visuals are keyed by a 4-bit mask so the per-frame refresh compares INTS
 * (no string built, no DOM written) unless something actually changed. */
function slotKey(i){
  return (i === sel ? 1 : 0) | (mode === i ? 2 : 0) | (lo[i] ? 4 : 0) | (dn[i] ? 8 : 0);
}
function slotClass(k){
  var s = 'jkp-s';
  if (k & 1) s += (k & 2) ? ' sel act' : ' sel';
  if (k & 4) s += ' lo';
  if (k & 8) s += ' dn';
  return s;
}
function refreshSlots(){
  for (var i = 0; i < NPOW; i++){
    var el = slots[i];
    if (!el) continue;
    var k = slotKey(i);
    if (k !== stKey[i]){ stKey[i] = k; el.className = slotClass(k); }
  }
}
function failFlash(i){
  var el = slots[i];
  if (!el) return;
  var base = slotClass(slotKey(i));
  el.className = base;
  void el.offsetWidth;                    /* reflow: restart the one-shot anim */
  el.className = base + ' fail';
  stKey[i] = -1;                          /* next state change repaints cleanly */
}

function syncTag(){
  var d = POWERS[sel];
  tagText = 'FORCE ' + d.name + '  ' + d.cost + (d.channel ? '/S' : '');
  if (tagEl && tagEl.textContent !== tagText) tagEl.textContent = tagText;
}

function bindSlot(el, i){
  el.addEventListener('touchstart', function(e){ eat(e); dn[i] = true; refreshSlots(); }, {passive:false});
  el.addEventListener('touchend', function(e){ eat(e); dn[i] = false; select(i); }, {passive:false});
  el.addEventListener('touchcancel', function(e){ stopOnly(e); dn[i] = false; refreshSlots(); }, {passive:false});
  el.addEventListener('mousedown', function(e){ stopOnly(e); dn[i] = true; refreshSlots(); });
  el.addEventListener('mouseup', function(e){ stopOnly(e); dn[i] = false; refreshSlots(); });
  el.addEventListener('click', function(e){ eat(e); select(i); });
}

function build(){
  var d = document, i;
  if (d.getElementById('jkpBar')) return;
  var style = d.createElement('style');
  style.textContent = CSS;
  (d.head || d.getElementsByTagName('head')[0]).appendChild(style);

  bar = mk('div', null, d.body);
  bar.id = 'jkpBar';
  shield(bar);
  for (i = 0; i < NPOW; i++){
    var s = mk('div', 'jkp-s', bar);
    mk('span', 'jkp-n', s).textContent = '' + (i + 1);
    mk('span', 'jkp-l', s).textContent = POWERS[i].label;
    mk('span', 'jkp-c', s).textContent = POWERS[i].channel
      ? POWERS[i].cost + '/S' : '' + POWERS[i].cost;
    slots[i] = s;
    stKey[i] = -1;
    bindSlot(s, i);
  }

  /* desktop nicety: 1..5 pick a power directly (20_input.js leaves these free) */
  if (typeof window !== 'undefined' && window.addEventListener){
    window.addEventListener('keydown', function(e){
      var k = e.keyCode;
      if (k >= 49 && k <= 53) select(k - 49);
    });
  }
}

function select(i){
  i = i | 0;
  if (i < 0) i = 0; else if (i >= NPOW) i = NPOW - 1;
  if (i !== sel){
    if (mode >= 0) endChannel();       /* switching cancels the channel cleanly */
    sel = i;
    Powers.sel = sel;
    snd('select');
    syncTag();
  }
  refreshSlots();
  return sel;
}

/* ============================ module ============================ */
var Powers = JK.Powers = {
  POWERS: POWERS,
  NAMES: NAMES,
  sel: 0,
  channelling: false,
  channelT: 0,
  gripTarget: null,
  aim: FWD,                            /* read-only scratch */
  origin: ORIGIN,                      /* read-only scratch */

  init: function(){
    var g = game();
    if (!(g.forceMax > 0)) g.forceMax = FORCE_MAX;
    g.force = g.forceMax;
    sinceSpend = 99;

    PL = JK.Player || null;
    if (PL) PL.speedMul = 1;           /* never boot with a stuck multiplier */
    speedOn = false;

    mode = -1; channelT = 0; gripTarget = null; gripSent = false;
    Powers.channelling = false; Powers.channelT = 0; Powers.gripTarget = null;
    for (var i = 0; i < NPOW; i++){ cool[i] = 0; lo[i] = false; dn[i] = false; }
    nHits = 0;

    sel = 0; Powers.sel = 0;
    var st = JK.Input && JK.Input.state;
    lastSelCt = st ? (st.forceSel | 0) : 0;

    if (!inited){ build(); inited = true; }
    tagEl = document.getElementById('forceTag');
    syncTag();
    refreshSlots();
  },

  update: function(dt, t){
    var g = game(), i;
    if (!PL || !PL.pos) PL = JK.Player || null;
    if (!PL || !PL.pos) return;        /* player module not up yet: nothing to aim */
    var st = (JK.Input && JK.Input.state) || NULL_STATE;

    updateAim();

    /* ---- cooldowns + regen ---- */
    for (i = 0; i < NPOW; i++) if (cool[i] > 0){ cool[i] -= dt; if (cool[i] < 0) cool[i] = 0; }
    sinceSpend += dt;
    if (sinceSpend >= REGEN_DELAY && g.force < g.forceMax){
      g.force += REGEN_RATE * dt;
      if (g.force > g.forceMax) g.force = g.forceMax;
    }

    /* ---- selection: forceTap edge (or the forceSel counter) ---- */
    var selEdge;
    if (st.forceTap !== undefined) selEdge = !!st.forceTap;
    else { selEdge = (st.forceSel | 0) !== lastSelCt; }
    lastSelCt = st.forceSel | 0;
    if (selEdge) select((sel + 1) % NPOW);

    /* ---- death cancels everything, including a live grip ---- */
    if (heroDead()){
      if (mode >= 0) endChannel();
      else if (speedOn) setSpeed(false);
    } else {
      var held = st.forceHeld === undefined ? !!st.force : !!st.forceHeld;
      if (mode < 0 && st.force) fire(sel);       /* instant cast or channel start */
      if (mode >= 0){                            /* a channel started NOW also ticks */
        if (!held){ endChannel(); }
        else if (!tickChannel(dt, t)){
          var wasEmpty = g.force <= 0;
          endChannel();
          if (wasEmpty){ snd('forceFail'); failFlash(sel); }
        }
      }
    }

    /* ---- DOM: only on change ---- */
    for (i = 0; i < NPOW; i++){
      var d = POWERS[i];
      var need = d.channel ? d.cost * MIN_START : d.cost;
      var isLo = g.force < need;
      if (isLo !== lo[i]) lo[i] = isLo;
    }
    refreshSlots();
    if (tagEl){ if (tagEl.textContent !== tagText) tagEl.textContent = tagText; }
    else { tagEl = document.getElementById('forceTag'); if (tagEl) tagEl.textContent = tagText; }
  },

  /* ---- small public API (also used by harnesses) ---- */
  select: select,
  cycle: function(d){ return select(((sel + (d === undefined ? 1 : d)) % NPOW + NPOW) % NPOW); },
  name: function(i){ return NAMES[(i | 0) % NPOW]; },
  canCast: function(i){
    i = i | 0;
    return !heroDead() && i >= 0 && i < NPOW && cool[i] <= 0 && affords(i);
  },
  cast: function(i){ return fire(i === undefined ? sel : (i | 0)); },
  stop: function(){ endChannel(); },
  cooldown: function(i){ return cool[(i | 0) % NPOW]; }
};
})();
