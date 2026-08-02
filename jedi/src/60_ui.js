/* JK.Ui — saber customization menu + combat HUD feedback. Owner: ui agent.
 *
 * Creates ALL of its DOM + one <style> element at init() (no template.html edits).
 * 2002-LucasArts visual language: chunky 2px bevel borders, #6a705a olive frames,
 * #101408 panels, Trebuchet MS, #ffd76a gold headings.
 *
 *   - "SABER" round button (52 px, tbtn-look) top-left under the stance tag row;
 *     tap toggles the LIGHTSABER panel. Game keeps running behind the panel.
 *   - Panel: TYPE row (SINGLE/DUAL/STAFF -> JK.Rig.setType), 6 color presets,
 *     R/G/B sliders (0-255, 44 px touch rows) + live glowing preview strip.
 *     Every change -> JK.Rig.setSaber([r,g,b] 0..1) instantly.
 *   - Persistence: localStorage 'jk_saber_type' (string) and 'jk_saber_rgb'
 *     (JSON [0..1 floats]); every access is try/catch (iOS private mode throws).
 *   - Feedback line under #stanceTag: attack-name flash on new JK.Sabers.attackId
 *     and gold "-NN" on JK.Combat.lastHit changes (CSS animation; DOM touched
 *     ONLY on change, never per frame).
 *   - update(): syncs #hpFill/#fpFill widths from JK.game (only when changed).
 *
 * The panel/button live directly on <body> (z 6/7) because #hud (z3) is its own
 * stacking context below .tbtn (z4). touchstart/touchmove stopPropagation at the
 * panel boundary so the document-level handlers in 20_input.js never see them
 * (input's document touchmove preventDefaults, which would kill the panel's
 * native pan-y scroll). touchend/touchcancel are deliberately ALLOWED to bubble:
 * iOS can coalesce several fingers into ONE event (see the ownsTouch note in
 * 20_input.js) — swallowing an end that also carries a stick/button finger
 * would leave input with a stuck identifier (run-forever stick, stuck
 * attackHeld). Bubbling ends are safe: input filters by identifiers it owns,
 * and menu touches are never claimed by it.
 *
 * NOTE: 90_main.js SYSTEMS has no 'Ui' entry; while no dedicated Hud module
 * exists we defensively alias JK.Hud = JK.Ui so main drives init/update.
 */
(function(){
'use strict';

var LS_TYPE = 'jk_saber_type', LS_RGB = 'jk_saber_rgb';
var TYPES = ['single', 'dual', 'staff'];
var TYPE_LABELS = ['SINGLE', 'DUAL', 'STAFF'];
var PRESETS = [                    /* contract colors, 0-255 */
  [47, 124, 240],                  /* blue   #2f7cf0 */
  [51, 224, 90],                   /* green  #33e05a */
  [240, 52, 40],                   /* red    #f03428 */
  [160, 74, 240],                  /* purple #a04af0 */
  [240, 208, 40],                  /* yellow #f0d028 */
  [240, 138, 40]                   /* orange #f08a28 */
];
var CHANNELS = ['R', 'G', 'B'];

/* ---------------- state ---------------- */
var inited = false, open = false;
var btn = null, panel = null, prevEl = null;
var typeEls = [null, null, null];
var slid = [null, null, null], vals = [null, null, null];
var feedName = null, feedDmg = null;
var curType = 'single';
var cur = [51, 230, 77];           /* current color 0-255 (rig default green-ish) */
var F3 = [0, 0, 0];                /* reusable 0..1 push array */
var typePushed = false, colPushed = false;   /* retry-until-rig-exists flags */

/* per-frame caches (bars + feedback: DOM writes only on change) */
var hpEl = null, fpEl = null;
var cHp = -1, cHpMax = -1, cFp = -1, cFpMax = -1;
var lastAtkId = 0, lastHitT = null, lastHitD = null;

/* ---------------- style ---------------- */
var CSS = [
'#jkuBtn { position:absolute; z-index:6; left:12px; top:44px;',
'  left:calc(12px + env(safe-area-inset-left)); top:calc(44px + env(safe-area-inset-top));',
'  width:52px; height:52px; border-radius:50%;',
'  border:2px solid rgba(200,210,170,.35); background:rgba(20,26,12,.35);',
'  color:rgba(220,228,190,.85); font:700 9px/48px "Trebuchet MS","Verdana",sans-serif;',
'  text-align:center; letter-spacing:.08em; pointer-events:auto; touch-action:none;',
'  -webkit-user-select:none; user-select:none; }',
'#jkuBtn.dn { transform:scale(.92); background:rgba(160,200,90,.25); }',
'#jkuBtn.on { border-color:#ffd76a; color:#ffd76a; box-shadow:0 0 10px rgba(255,190,60,.35); }',
'#jkuPanel { position:absolute; z-index:7; display:none; left:12px; top:102px;',
'  left:calc(12px + env(safe-area-inset-left)); top:calc(102px + env(safe-area-inset-top));',
'  width:300px; max-width:calc(100vw - 24px);',
'  max-width:calc(100vw - 24px - env(safe-area-inset-left) - env(safe-area-inset-right));',
'  max-height:calc(100vh - 118px);',
'  max-height:calc(100vh - 118px - env(safe-area-inset-top) - env(safe-area-inset-bottom));',
'  overflow-y:auto; -webkit-overflow-scrolling:touch;',
'  background:#101408; border:2px solid #6a705a; border-radius:2px;',
'  box-shadow:inset 0 0 0 2px #000, inset 0 0 0 3px #3a4030, 3px 3px 0 rgba(0,0,0,.55);',
'  padding:10px 10px 12px; pointer-events:auto; touch-action:pan-y;',
'  font:700 11px/1.4 "Trebuchet MS","Verdana",sans-serif; color:#d8e0c8;',
'  letter-spacing:.06em; -webkit-user-select:none; user-select:none; }',
'.jku-h { font-size:14px; color:#ffd76a; letter-spacing:.22em; text-align:center;',
'  text-shadow:1px 1px 0 #000; border-bottom:2px solid #6a705a; padding-bottom:6px;',
'  margin:2px 0 8px; }',
'.jku-sec { font-size:9px; color:#b8a878; letter-spacing:.18em; margin:10px 0 4px; }',
'.jku-row { display:flex; }',
'.jku-wrap { flex-wrap:wrap; }',
'.jku-type { flex:1; height:44px; line-height:40px; text-align:center; font-size:10px;',
'  background:#1d2412; color:#c8d0b0; margin-right:6px; cursor:pointer; border:2px solid;',
'  border-color:#8a9070 #3a4030 #3a4030 #8a9070; letter-spacing:.1em; }',
'.jku-type.dn { background:#2a3018; }',
'.jku-type.sel { background:#3a2e14; color:#ffd76a;',
'  border-color:#ffd76a #8a6a20 #8a6a20 #ffd76a; }',
'.jku-sw { width:40px; height:40px; margin:0 6px 6px 0; cursor:pointer; border:2px solid;',
'  border-color:#8a9070 #3a4030 #3a4030 #8a9070; }',
'.jku-sw.dn { border-color:#fff; }',
'.jku-srow { display:flex; align-items:center; height:44px; }',
'.jku-lab { width:16px; font-size:12px; color:#ffd76a; }',
'.jku-val { width:32px; text-align:right; font-size:11px; color:#e8d9a0; }',
'.jku-sl { -webkit-appearance:none; appearance:none; flex:1; min-width:0; height:44px;',
'  margin:0 4px; padding:0; background:transparent; touch-action:none; border:0; }',
'.jku-sl::-webkit-slider-runnable-track { height:10px; background:#181c10;',
'  border:2px solid #6a705a; }',
'.jku-sl::-webkit-slider-thumb { -webkit-appearance:none; width:26px; height:26px;',
'  margin-top:-8px; background:#c8b878; border:2px solid;',
'  border-color:#f0e6c0 #6a5a30 #6a5a30 #f0e6c0; }',
'.jku-sl::-moz-range-track { height:10px; background:#181c10; border:2px solid #6a705a; }',
'.jku-sl::-moz-range-thumb { width:26px; height:26px; border-radius:0; background:#c8b878;',
'  border:2px solid #f0e6c0; }',
'#jkuPrev { height:22px; margin-top:8px; border:2px solid #6a705a; }',
'#jkuFeed { position:absolute; top:46px; top:calc(46px + env(safe-area-inset-top));',
'  left:0; right:0; text-align:center; pointer-events:none; }',
'#jkuName { font-size:12px; color:#f0ead2; letter-spacing:.14em; margin-right:8px; }',
'#jkuDmg { font-size:14px; color:#ffd76a; }',
'.jku-flash { display:inline-block; opacity:0; }',
'.jku-flash.on { animation:jkuFade .9s ease-out forwards; }',
'@keyframes jkuFade { 0% { opacity:1; transform:translateY(0); }',
'  60% { opacity:.95; } 100% { opacity:0; transform:translateY(-8px); } }'
].join('\n');

/* ---------------- tiny DOM helpers ---------------- */
function mk(tag, cls, parent){
  var el = document.createElement(tag);
  if (cls) el.className = cls;
  if (parent) parent.appendChild(el);
  return el;
}
function clamp255(v){
  v = Math.round(v);
  if (!(v >= 0)) v = 0; else if (v > 255) v = 255;   /* !(>=0) also catches NaN */
  return v;
}
function stopOnly(e){ e.stopPropagation(); }
function eat(e){                       /* swallow: game never sees it, no ghost click */
  e.stopPropagation();
  if (e.cancelable) e.preventDefault();
}

/* Did this Touch actually land on el? Same guard as 20_input.js: an iOS event
 * can coalesce several new/moved/ended fingers into one changedTouches list,
 * so [0] may belong to the stick/look/ATK finger, not to us. */
function ownsTouch(el, t){
  var n = t.target;
  if (!n) return true;                 /* ancient UA without Touch.target */
  return n === el || !!(el.contains && el.contains(n));
}
function hasTouch(ts, id){
  if (id === null || !ts) return false;
  for (var i = 0; i < ts.length; i++) if (ts[i].identifier === id) return true;
  return false;
}

/* Block game-feeding events at the panel/button boundary. touchstart/touchmove
 * STOP here (input's document touchmove preventDefaults => would kill native
 * pan-y scroll; starts must never leak toward game zones). touchend/touchcancel
 * are NOT stopped — a coalesced end may carry ANOTHER finger's release that
 * 20_input.js's document touchEnd must see to clear its identifiers; letting
 * ends bubble is harmless because input ignores ids it never claimed. */
function shield(el){
  var i;
  var tev = ['touchstart', 'touchmove'];
  for (i = 0; i < tev.length; i++) el.addEventListener(tev[i], stopOnly, {passive:false});
  var mev = ['mousedown', 'mousemove', 'mouseup', 'click', 'wheel', 'keydown', 'keyup'];
  for (i = 0; i < mev.length; i++) el.addEventListener(mev[i], stopOnly, {passive:false});
}

/* iOS-safe tap. touchstart+touchend preventDefault kills the synthetic click
 * (no touchend+click double fire); the click handler is the desktop path, with
 * a time guard in case a non-cancelable touchend let a ghost click through.
 * The touch is latched by identifier so a coalesced event can't trigger us
 * with someone else's finger, and ends/cancels bubble on (see shield note). */
var GHOST_MS = 700;
function tap(el, fn){
  var tid = null, lastTouchT = 0;
  el.addEventListener('touchstart', function(e){
    eat(e);
    if (tid !== null) return;                  /* one finger owns the control */
    var ts = e.changedTouches;
    for (var i = 0; i < ts.length; i++){
      if (ownsTouch(el, ts[i])){ tid = ts[i].identifier; break; }
    }
    if (tid !== null) el.classList.add('dn');
  }, {passive:false});
  el.addEventListener('touchend', function(e){
    if (e.cancelable) e.preventDefault();      /* kill iOS synthetic click */
    if (!hasTouch(e.changedTouches, tid)) return;   /* not our finger */
    tid = null;
    lastTouchT = Date.now();
    el.classList.remove('dn');
    fn();
  }, {passive:false});
  el.addEventListener('touchcancel', function(e){
    if (!hasTouch(e.changedTouches, tid)) return;
    tid = null;
    lastTouchT = Date.now();
    el.classList.remove('dn');
  }, {passive:false});
  el.addEventListener('mousedown', function(e){ stopOnly(e); el.classList.add('dn'); });
  el.addEventListener('mouseup', function(e){ stopOnly(e); el.classList.remove('dn'); });
  el.addEventListener('click', function(e){
    eat(e);
    if (Date.now() - lastTouchT < GHOST_MS) return;  /* ghost click: already fired */
    fn();
  });
}

/* ---------------- rig bridge (defensive vs mid-build siblings) ----------------
 * Prefer the contract instance API (rig.setType/setSaber). The module-level
 * bridges in 40_character.js exist BEFORE Rig.init() and silently no-op while
 * their player slot is still null — report that as failure so the update()
 * retry loop actually retries (a rig without a 'player' slot is trusted). */
function rigSetType(t){
  var R = JK.Rig;
  if (!R) return false;
  if (R.player && R.player.setType){ R.player.setType(t); return true; }
  if (R.setType){ R.setType(t); return R.player !== null; }
  return false;
}
function rigSetSaber(f){
  var R = JK.Rig;
  if (!R) return false;
  if (R.player && R.player.setSaber){ R.player.setSaber(f); return true; }
  if (R.setSaber){ R.setSaber(f); return R.player !== null; }
  return false;
}

/* ---------------- apply + persist ---------------- */
function saveType(){
  try { localStorage.setItem(LS_TYPE, curType); } catch (e) {}
}
function saveColor(){
  try {
    localStorage.setItem(LS_RGB, JSON.stringify([
      Math.round(cur[0] / 255 * 1000) / 1000,
      Math.round(cur[1] / 255 * 1000) / 1000,
      Math.round(cur[2] / 255 * 1000) / 1000
    ]));
  } catch (e) {}
}

function applyType(t, save){
  if (TYPES.indexOf(t) < 0) t = 'single';
  curType = t;
  typePushed = rigSetType(t);
  for (var i = 0; i < 3; i++){
    var el = typeEls[i];
    if (el) el.className = TYPES[i] === t ? 'jku-type sel' : 'jku-type';
  }
  if (save) saveType();
}

function applyColor(save){
  var r = cur[0], g = cur[1], b = cur[2];
  F3[0] = r / 255; F3[1] = g / 255; F3[2] = b / 255;
  colPushed = rigSetSaber(F3);
  if (prevEl){
    prevEl.style.background = 'rgb(' + r + ',' + g + ',' + b + ')';
    prevEl.style.boxShadow = '0 0 16px 3px rgba(' + r + ',' + g + ',' + b + ',.85), ' +
      'inset 0 0 6px rgba(255,255,255,.35)';
  }
  for (var i = 0; i < 3; i++){
    if (slid[i] && +slid[i].value !== cur[i]) slid[i].value = '' + cur[i];
    if (vals[i]) vals[i].textContent = '' + cur[i];
  }
  if (save) saveColor();
}

function setOpen(o){
  open = !!o;
  if (panel) panel.style.display = open ? 'block' : 'none';
  if (btn){
    if (open) btn.classList.add('on'); else btn.classList.remove('on');
  }
}

/* ---------------- sliders ----------------
 * iOS Safari + ancestor touch-action:none makes native range touch-drag flaky,
 * so touches drive the value manually (deterministic); mouse uses the native
 * 'input' path. The driving touch is latched by identifier: a coalesced event's
 * changedTouches[0] can be the STICK finger moving under the open panel, and
 * feeding its X here would yank the color around. Rect math only runs during
 * menu interaction — not per frame. */
function bindSlider(inp, idx){
  var tid = null;
  function fromX(clientX){
    var rc = inp.getBoundingClientRect();
    var tw = 30;                                /* thumb width incl. borders */
    var w = rc.width - tw;
    var v = clamp255(w > 0 ? (clientX - rc.left - tw / 2) / w * 255 : 0);
    if (v !== cur[idx]){ cur[idx] = v; applyColor(false); }
  }
  inp.addEventListener('touchstart', function(e){
    eat(e);
    if (tid !== null) return;                   /* one finger drives the slider */
    var ts = e.changedTouches;
    for (var i = 0; i < ts.length; i++){
      if (ownsTouch(inp, ts[i])){ tid = ts[i].identifier; fromX(ts[i].clientX); break; }
    }
  }, {passive:false});
  inp.addEventListener('touchmove', function(e){
    var ts = e.changedTouches;
    for (var i = 0; i < ts.length; i++){
      if (ts[i].identifier === tid){ eat(e); fromX(ts[i].clientX); return; }
    }
    /* foreign finger only: leave it for the panel shield / input module */
  }, {passive:false});
  inp.addEventListener('touchend', function(e){
    if (e.cancelable) e.preventDefault();       /* no ghost click; DO bubble (shield note) */
    if (!hasTouch(e.changedTouches, tid)) return;
    tid = null;
    applyColor(true);
  }, {passive:false});
  inp.addEventListener('touchcancel', function(e){
    if (!hasTouch(e.changedTouches, tid)) return;
    tid = null;
    applyColor(true);
  }, {passive:false});
  inp.addEventListener('mousedown', stopOnly);  /* no preventDefault: keep native drag */
  inp.addEventListener('input', function(){
    var v = clamp255(+inp.value || 0);
    if (v !== cur[idx]){ cur[idx] = v; applyColor(false); }
  });
  inp.addEventListener('change', function(){ applyColor(true); });
}

/* restart the one-shot fade animation (DOM touched only on change) */
function flash(el){
  el.classList.remove('on');
  void el.offsetWidth;                          /* reflow -> animation restarts */
  el.classList.add('on');
}

/* ---------------- DOM build ---------------- */
function build(){
  var d = document, i;

  var style = d.createElement('style');
  style.textContent = CSS;
  (d.head || d.getElementsByTagName('head')[0]).appendChild(style);

  /* feedback line under #stanceTag/#forceTag (inside #hud: inherits HUD font) */
  var hud = d.getElementById('hud');
  var feed = mk('div', null, null);
  feed.id = 'jkuFeed';
  feedName = mk('span', 'jku-flash', feed); feedName.id = 'jkuName';
  feedDmg = mk('span', 'jku-flash', feed); feedDmg.id = 'jkuDmg';
  (hud || d.body).appendChild(feed);

  /* SABER toggle button */
  btn = mk('div', null, d.body);
  btn.id = 'jkuBtn';
  btn.textContent = 'SABER';
  shield(btn);
  tap(btn, function(){ setOpen(!open); });

  /* panel */
  panel = mk('div', null, d.body);
  panel.id = 'jkuPanel';
  shield(panel);

  mk('div', 'jku-h', panel).textContent = 'LIGHTSABER';

  mk('div', 'jku-sec', panel).textContent = 'TYPE';
  var trow = mk('div', 'jku-row', panel);
  for (i = 0; i < 3; i++){
    (function(k){
      var b = mk('div', 'jku-type', trow);
      b.textContent = TYPE_LABELS[k];
      if (k === 2) b.style.marginRight = '0';
      typeEls[k] = b;
      tap(b, function(){ applyType(TYPES[k], true); });
    })(i);
  }

  mk('div', 'jku-sec', panel).textContent = 'COLOR';
  var srow = mk('div', 'jku-row jku-wrap', panel);
  for (i = 0; i < PRESETS.length; i++){
    (function(p){
      var sw = mk('div', 'jku-sw', srow);
      sw.style.background = 'rgb(' + p[0] + ',' + p[1] + ',' + p[2] + ')';
      tap(sw, function(){
        cur[0] = p[0]; cur[1] = p[1]; cur[2] = p[2];
        applyColor(true);                       /* sliders sync inside applyColor */
      });
    })(PRESETS[i]);
  }

  for (i = 0; i < 3; i++){
    var row = mk('div', 'jku-srow', panel);
    mk('span', 'jku-lab', row).textContent = CHANNELS[i];
    var inp = d.createElement('input');
    inp.type = 'range'; inp.min = '0'; inp.max = '255'; inp.step = '1';
    inp.value = '' + cur[i];
    inp.className = 'jku-sl';
    row.appendChild(inp);
    vals[i] = mk('span', 'jku-val', row);
    vals[i].textContent = '' + cur[i];
    slid[i] = inp;
    bindSlider(inp, i);
  }

  prevEl = mk('div', null, panel);
  prevEl.id = 'jkuPrev';
}

/* ---------------- persisted settings ---------------- */
function loadSettings(){
  var t = null, rgb = null, raw = null;
  try { t = localStorage.getItem(LS_TYPE); } catch (e) {}
  try {
    raw = localStorage.getItem(LS_RGB);
    if (raw) rgb = JSON.parse(raw);
  } catch (e) { rgb = null; }

  if (rgb && rgb.length === 3 &&
      typeof rgb[0] === 'number' && typeof rgb[1] === 'number' && typeof rgb[2] === 'number'){
    cur[0] = clamp255(rgb[0] * 255);
    cur[1] = clamp255(rgb[1] * 255);
    cur[2] = clamp255(rgb[2] * 255);
  } else {
    /* no stored color: mirror whatever the rig is currently wearing */
    var R = JK.Rig, sc = R && R.player && R.player.saberCol;
    if (sc){
      cur[0] = clamp255(sc[0] * 255);
      cur[1] = clamp255(sc[1] * 255);
      cur[2] = clamp255(sc[2] * 255);
    }
  }

  if (TYPES.indexOf(t) >= 0) curType = t;
  else {
    var R2 = JK.Rig;
    if (R2 && R2.player && TYPES.indexOf(R2.player.type) >= 0) curType = R2.player.type;
  }
}

/* ---------------- module ---------------- */
var Ui = JK.Ui = {
  init: function(){
    if (inited) return;
    inited = true;

    loadSettings();          /* read BEFORE build so sliders spawn at the value */
    build();
    applyType(curType, false);   /* Rig.init already ran (40 < 60 in SYSTEMS) */
    applyColor(false);
    setOpen(false);

    /* HUD hooks + baselines */
    hpEl = document.getElementById('hpFill');
    fpEl = document.getElementById('fpFill');
    cHp = cHpMax = cFp = cFpMax = -1;
    var ft = document.getElementById('forceTag');
    if (ft) ft.textContent = '';                  /* placeholder until Powers */
    var S = JK.Sabers;
    lastAtkId = S ? (S.attackId | 0) : 0;
    var lh = JK.Combat && JK.Combat.lastHit;      /* don't replay a stale hit */
    lastHitT = lh ? lh.t : null;
    lastHitD = lh ? lh.dmg : null;
  },

  update: function(dt, t){
    /* ---- bars: write width ONLY when the value changed ---- */
    var g = JK.game;
    if (g){
      if (hpEl && (g.hp !== cHp || g.hpMax !== cHpMax)){
        cHp = g.hp; cHpMax = g.hpMax;
        var wh = (cHpMax > 0 ? cHp / cHpMax : 0) * 100;
        if (!(wh > 0)) wh = 0; else if (wh > 100) wh = 100;
        hpEl.style.width = wh.toFixed(1) + '%';
      }
      if (fpEl && (g.force !== cFp || g.forceMax !== cFpMax)){
        cFp = g.force; cFpMax = g.forceMax;
        var wf = (cFpMax > 0 ? cFp / cFpMax : 0) * 100;
        if (!(wf > 0)) wf = 0; else if (wf > 100) wf = 100;
        fpEl.style.width = wf.toFixed(1) + '%';
      }
    }

    /* ---- attack name flash on new swing id ---- */
    var S = JK.Sabers;
    if (S && S.attackId !== lastAtkId){
      lastAtkId = S.attackId;
      if (feedName && S.attackName){
        feedName.textContent = S.attackName;
        flash(feedName);
      }
    }

    /* ---- gold damage pop on JK.Combat.lastHit change ---- */
    var lh = JK.Combat && JK.Combat.lastHit;
    if (lh && (lh.t !== lastHitT || lh.dmg !== lastHitD)){
      lastHitT = lh.t; lastHitD = lh.dmg;
      if (feedDmg){
        feedDmg.textContent = '-' + Math.round(lh.dmg || 0);
        flash(feedDmg);
      }
    }

    /* ---- standalone-test resilience: if the rig showed up late, push once ---- */
    if ((!typePushed || !colPushed) && JK.Rig){
      if (!typePushed) typePushed = rigSetType(curType);
      if (!colPushed){
        F3[0] = cur[0] / 255; F3[1] = cur[1] / 255; F3[2] = cur[2] / 255;
        colPushed = rigSetSaber(F3);
      }
    }
  },

  /* small conveniences for harnesses / future modules */
  isOpen: function(){ return open; },
  toggle: function(){ setOpen(!open); }
};

/* main's SYSTEMS list drives 'Hud' (there is no 'Ui' slot). Claim it only if
 * no dedicated Hud module exists — a later 7x_hud.js would overwrite this. */
if (!JK.Hud) JK.Hud = Ui;
})();
