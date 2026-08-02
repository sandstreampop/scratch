/* JK.Input — touch-first controls + desktop fallback. Owner: input agent.
 *
 * FINAL STATE SHAPE — JK.Input.state, snapshotted exactly once per update(dt).
 * Consumers read it after Input.update has run for the frame (main runs Input
 * before Player). Same object identity forever — safe to cache a reference.
 *
 *   {
 *     moveX, moveY   // -1..1 virtual stick. moveY = +1 means FORWARD (away
 *                    //   from camera). Keyboard diagonals are normalized.
 *     lookDX, lookDY // look-drag pixels accumulated since the LAST update,
 *                    //   then reset each snapshot. +DX = drag right, +DY = drag down.
 *     jump,          // edge: TRUE only on the first frame after a press
 *     attack,        //   (touch button touchstart / key down / mouse down;
 *     force,         //   never repeat-fires while held)
 *     stanceTap,     // edge: stance-cycle tap (Q / #btnStance)
 *     forceTap,      // edge: force-select tap (R / mousewheel)
 *     attackHeld,    // held: TRUE while #btnAtk is touched or LMB is down
 *     forceHeld,     // held: TRUE while #btnForce is touched or E is down
 *     runHeld,       // held: TRUE while sprinting (stick deflection > 0.92
 *                    //   of radius, or Shift on desktop)
 *     run,           // legacy alias, always === runHeld
 *     stance,        // running tap counter for stance cycling (consumers
 *     forceSel       //   take modulo; monotonically increasing ints)
 *   }
 *
 * Touch: #stickL (left 45%) = dynamic virtual stick (origin where the finger
 * lands, #stickUI shown there). Right half of the canvas = look drag. Buttons
 * #btnJump #btnAtk #btnForce #btnStance. Multi-touch tracked by identifier so
 * move + look + ATK all work at once. Desktop: WASD/arrows, Shift run,
 * Space jump, mouse-drag look, LMB attack, E force, Q stance, R/wheel force-select.
 */
(function(){
'use strict';

var RADIUS = 48;          /* stick radius, px */
var RUN_FRAC = 0.92;      /* deflection fraction beyond which we sprint */
var KNOB_SCALE = 28 / 48; /* knob visual travel so it stays inside the ring */
var WHEEL_MS = 200;       /* mousewheel forceTap throttle */

var state = {
  moveX: 0, moveY: 0,
  lookDX: 0, lookDY: 0,
  jump: false, attack: false, force: false, stanceTap: false, forceTap: false,
  attackHeld: false, runHeld: false, forceHeld: false,
  run: false,
  stance: 0, forceSel: 0
};

/* --- pending edges: set by events, copied into state then cleared each update --- */
var pJump = false, pAttack = false, pForce = false, pStance = false, pForceTap = false;
var accDX = 0, accDY = 0;           /* look pixels accumulated between updates */
var cStance = 0, cForceSel = 0;     /* running tap counters */

/* --- touch stick --- */
var stickId = null, stickOX = 0, stickOY = 0;
var stickMX = 0, stickMY = 0, stickRun = false;
/* --- touch look --- */
var lookId = null, lookLX = 0, lookLY = 0;
/* --- touch buttons (attack hold) --- */
var touchAtk = false;
var touchForce = false;   /* #btnForce held (channelled force powers) */
var btns = [];  /* {el, tid, mdown, down, up} */
/* --- mouse --- */
var mouseLook = false, mouseLX = 0, mouseLY = 0, mouseAtk = false;
var lastWheel = 0;
/* --- keyboard --- */
var kFwd = false, kBack = false, kLeft = false, kRight = false, kShift = false;
var kForce = false;       /* E held */
var keyHeld = {};   /* keyCode -> bool, our own repeat guard */

var elStick = null, elUI = null, elKnob = null, elCanvas = null, elStart = null;

function overlayUp(){
  return !!(elStart && !elStart.classList.contains('gone'));
}

/* Did this Touch actually land on el? Guards against same-event multi-touch:
 * when two fingers start in one touchstart, changedTouches can contain BOTH,
 * and claiming ts[0] blindly can steal another zone's finger (e.g. #btnAtk
 * grabbing the stick finger's identifier => stuck button + stuck attackHeld). */
function ownsTouch(el, t){
  var n = t.target;
  if (!n) return true;  /* ancient UA without Touch.target: trust dispatch */
  return n === el || !!(el.contains && el.contains(n));
}

/* ---------- touch: virtual stick ---------- */
function stickStart(e){
  if (overlayUp()) return;
  e.preventDefault();
  var ts = e.changedTouches;
  for (var i = 0; i < ts.length; i++){
    var t = ts[i];
    if (stickId === null && ownsTouch(elStick, t)){
      stickId = t.identifier;
      stickOX = t.clientX; stickOY = t.clientY;
      stickMX = 0; stickMY = 0; stickRun = false;
      if (elUI){
        elUI.style.transform = 'translate(' + (stickOX - 48) + 'px,' + (stickOY - 48) + 'px)';
        elUI.classList.add('on');
        elUI.classList.remove('run');
        if (elKnob) elKnob.style.transform = 'translate(0px,0px)';
      }
    }
  }
}

/* ---------- touch: look drag (right half of canvas, not on a button) ---------- */
function lookStart(e){
  if (overlayUp()) return;
  e.preventDefault();
  var ts = e.changedTouches;
  for (var i = 0; i < ts.length; i++){
    var t = ts[i];
    if (lookId === null && t.clientX >= window.innerWidth * 0.5 && ownsTouch(elCanvas, t)){
      lookId = t.identifier;
      lookLX = t.clientX; lookLY = t.clientY;
    }
  }
}

/* ---------- document-level move/end routing by touch identifier ---------- */
function touchMove(e){
  if (overlayUp()) return;
  if (e.cancelable) e.preventDefault();
  var ts = e.changedTouches;
  for (var i = 0; i < ts.length; i++){
    var t = ts[i];
    if (t.identifier === stickId){
      var dx = t.clientX - stickOX, dy = t.clientY - stickOY;
      var len = Math.sqrt(dx * dx + dy * dy);
      var cl = len > RADIUS ? RADIUS / len : 1;
      var cx = dx * cl, cy = dy * cl;
      stickMX = cx / RADIUS;
      stickMY = -cy / RADIUS;          /* drag up = forward = +1 */
      stickRun = len > RADIUS * RUN_FRAC;
      if (elKnob) elKnob.style.transform =
        'translate(' + (cx * KNOB_SCALE) + 'px,' + (cy * KNOB_SCALE) + 'px)';
      if (elUI){
        if (stickRun) elUI.classList.add('run');
        else elUI.classList.remove('run');
      }
    } else if (t.identifier === lookId){
      accDX += t.clientX - lookLX;
      accDY += t.clientY - lookLY;
      lookLX = t.clientX; lookLY = t.clientY;
    }
  }
}

function touchEnd(e){
  if (overlayUp()) return;
  if (e.cancelable) e.preventDefault();
  var ts = e.changedTouches;
  for (var i = 0; i < ts.length; i++){
    var id = ts[i].identifier;
    if (id === stickId){
      stickId = null;
      stickMX = 0; stickMY = 0; stickRun = false;
      if (elUI){ elUI.classList.remove('on'); elUI.classList.remove('run'); }
    } else if (id === lookId){
      lookId = null;
    } else {
      for (var b = 0; b < btns.length; b++){
        if (btns[b].tid === id){
          btns[b].tid = null;
          if (!btns[b].mdown) btns[b].el.classList.remove('held');
          if (btns[b].up) btns[b].up();
        }
      }
    }
  }
}

/* ---------- touch buttons ---------- */
function bindBtn(el, down, up){
  if (!el) return;
  var b = { el: el, tid: null, mdown: false, down: down, up: up };
  btns.push(b);
  el.addEventListener('touchstart', function(e){
    if (overlayUp()) return;
    e.preventDefault();               /* kills iOS synthetic click / text select */
    if (b.tid !== null) return;
    var ts = e.changedTouches;
    for (var i = 0; i < ts.length; i++){
      if (ownsTouch(el, ts[i])){ b.tid = ts[i].identifier; break; }
    }
    if (b.tid === null) return;       /* none of the new touches landed on us */
    el.classList.add('held');
    if (down) down();
  }, {passive:false});
  /* desktop nicety: buttons also clickable with the mouse (LMB only) */
  el.addEventListener('mousedown', function(e){
    if (overlayUp() || e.button !== 0) return;
    e.preventDefault();
    if (b.mdown) return;
    b.mdown = true;
    el.classList.add('held');
    if (down) down();
  });
}

/* ---------- desktop mouse (down-drag look on canvas) ---------- */
function mouseDown(e){
  if (overlayUp()) return;
  e.preventDefault();
  mouseLook = true;
  mouseLX = e.clientX; mouseLY = e.clientY;
  if (e.button === 0){ pAttack = true; mouseAtk = true; }
}
function mouseMove(e){
  if (!mouseLook) return;
  accDX += e.clientX - mouseLX;
  accDY += e.clientY - mouseLY;
  mouseLX = e.clientX; mouseLY = e.clientY;
}
function mouseUp(e){
  mouseLook = false;
  if (e.button !== 0) return;         /* buttons are LMB-only, matching mousedown */
  mouseAtk = false;
  for (var i = 0; i < btns.length; i++){
    if (btns[i].mdown){
      btns[i].mdown = false;
      if (btns[i].tid === null) btns[i].el.classList.remove('held');
      if (btns[i].up) btns[i].up();
    }
  }
}
function wheel(e){
  e.preventDefault();
  if (overlayUp()) return;
  var now = Date.now();
  if (now - lastWheel < WHEEL_MS) return;
  lastWheel = now;
  pForceTap = true; cForceSel++;
}

/* ---------- keyboard ---------- */
function keyDown(e){
  var k = e.keyCode;
  var eat = (k === 32 || (k >= 37 && k <= 40));
  if (keyHeld[k]){ if (eat) e.preventDefault(); return; }  /* repeat guard */
  keyHeld[k] = true;
  switch (k){
    case 87: case 38: kFwd = true; break;    /* W / Up */
    case 83: case 40: kBack = true; break;   /* S / Down */
    case 65: case 37: kLeft = true; break;   /* A / Left */
    case 68: case 39: kRight = true; break;  /* D / Right */
    case 16: kShift = true; break;           /* Shift = run */
    case 32: if (!overlayUp()) pJump = true; break;                    /* Space */
    case 69: if (!overlayUp()){ pForce = true; kForce = true; } break;   /* E */
    case 81: if (!overlayUp()){ pStance = true; cStance++; } break;    /* Q */
    case 82: if (!overlayUp()){ pForceTap = true; cForceSel++; } break;/* R */
  }
  if (eat) e.preventDefault();
}
function keyUp(e){
  var k = e.keyCode;
  keyHeld[k] = false;
  switch (k){
    case 87: case 38: kFwd = false; break;
    case 83: case 40: kBack = false; break;
    case 65: case 37: kLeft = false; break;
    case 68: case 39: kRight = false; break;
    case 16: kShift = false; break;
    case 69: kForce = false; break;          /* E */
  }
}

/* ---------- safety: drop everything held when we lose focus ---------- */
function releaseAll(){
  var k;
  for (k in keyHeld) keyHeld[k] = false;
  kFwd = kBack = kLeft = kRight = kShift = false;
  mouseLook = false; mouseAtk = false; touchAtk = false;
  touchForce = false; kForce = false;
  stickId = null; stickMX = 0; stickMY = 0; stickRun = false;
  lookId = null;
  /* rAF is paused while hidden — drop pending edges + look deltas so the
   * player doesn't get a phantom jump/attack/camera-jerk on refocus */
  pJump = pAttack = pForce = pStance = pForceTap = false;
  accDX = 0; accDY = 0;
  if (elUI){ elUI.classList.remove('on'); elUI.classList.remove('run'); }
  for (var i = 0; i < btns.length; i++){
    btns[i].tid = null; btns[i].mdown = false;
    btns[i].el.classList.remove('held');
  }
}

JK.Input = {
  state: state,

  init: function(){
    elCanvas = document.getElementById('gl');
    elStick  = document.getElementById('stickL');
    elUI     = document.getElementById('stickUI');
    elKnob   = elUI ? elUI.getElementsByTagName('b')[0] : null;
    elStart  = document.getElementById('start');

    if (elStick) elStick.addEventListener('touchstart', stickStart, {passive:false});
    if (elCanvas) elCanvas.addEventListener('touchstart', lookStart, {passive:false});
    document.addEventListener('touchmove', touchMove, {passive:false});
    document.addEventListener('touchend', touchEnd, {passive:false});
    document.addEventListener('touchcancel', touchEnd, {passive:false});

    bindBtn(document.getElementById('btnJump'),
      function(){ pJump = true; }, null);
    bindBtn(document.getElementById('btnAtk'),
      function(){ pAttack = true; touchAtk = true; },
      function(){ touchAtk = false; });
    bindBtn(document.getElementById('btnForce'),
      function(){ pForce = true; touchForce = true; },
      function(){ touchForce = false; });
    bindBtn(document.getElementById('btnStance'),
      function(){ pStance = true; cStance++; }, null);

    if (elCanvas) elCanvas.addEventListener('mousedown', mouseDown);
    window.addEventListener('mousemove', mouseMove);
    window.addEventListener('mouseup', mouseUp);
    window.addEventListener('wheel', wheel, {passive:false});

    window.addEventListener('keydown', keyDown);
    window.addEventListener('keyup', keyUp);
    window.addEventListener('blur', releaseAll);
    document.addEventListener('visibilitychange', function(){
      if (document.hidden) releaseAll();
    });
  },

  update: function(dt, t){
    /* move: touch stick wins while active, else keyboard */
    var mx, my;
    if (stickId !== null){
      mx = stickMX; my = stickMY;
    } else {
      mx = (kRight ? 1 : 0) - (kLeft ? 1 : 0);
      my = (kFwd ? 1 : 0) - (kBack ? 1 : 0);
      if (mx !== 0 && my !== 0){ mx *= 0.7071; my *= 0.7071; }
    }
    state.moveX = mx;
    state.moveY = my;

    /* holds */
    state.runHeld = stickRun || kShift;
    state.run = state.runHeld;                 /* legacy alias */
    state.attackHeld = touchAtk || mouseAtk;
    state.forceHeld = touchForce || kForce;

    /* edges: pending -> state, then clear */
    state.jump = pJump;
    state.attack = pAttack;
    state.force = pForce;
    state.stanceTap = pStance;
    state.forceTap = pForceTap;
    pJump = pAttack = pForce = pStance = pForceTap = false;

    /* look: accumulated pixels since last snapshot, then reset */
    state.lookDX = accDX;
    state.lookDY = accDY;
    accDX = 0; accDY = 0;

    /* running tap counters */
    state.stance = cStance;
    state.forceSel = cForceSel;
  }
};
})();
