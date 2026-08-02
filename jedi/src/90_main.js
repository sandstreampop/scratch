/* JK.main — boot + game loop. Owner: core. */
(function(){
'use strict';
var SYSTEMS = ['Terrain', 'Input', 'Player', 'Rig', 'Sabers', 'Powers', 'Bots', 'Fx', 'Hud'];
var last = 0, t0 = 0, started = false;

JK.game = { hp: 100, hpMax: 100, force: 100, forceMax: 100, over: false, kills: 0 };

JK.msg = function(text, secs){
  var el = document.getElementById('msg');
  if (!el) return;
  el.textContent = text;
  el.classList.add('on');
  clearTimeout(JK.msg._t);
  JK.msg._t = setTimeout(function(){ el.classList.remove('on'); }, (secs || 2) * 1000);
};

function each(fn){
  for (var i = 0; i < SYSTEMS.length; i++){
    var s = JK[SYSTEMS[i]];
    if (s && s[fn]) s[fn].apply(s, Array.prototype.slice.call(arguments, 1));
  }
}

function frame(now){
  requestAnimationFrame(frame);
  if (!last) { last = now; t0 = now; return; }
  var dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  var t = (now - t0) / 1000;
  each('update', dt, t);
  JK.GL.beginFrame(0.86, 0.72, 0.52);
  each('draw');
}

function fail(msg){
  var el = document.getElementById('err');
  el.style.display = 'block';
  el.textContent = msg;
}

function boot(){
  if (started) return;
  started = true;
  try {
    if (!JK.GL.init(document.getElementById('gl'))) { fail('WebGL unavailable on this device.'); return; }
    each('init');
    document.getElementById('start').classList.add('gone');
    requestAnimationFrame(frame);
  } catch (e) {
    fail('Boot error: ' + (e && e.message ? e.message : e));
  }
}

window.addEventListener('error', function(ev){
  if (!started) return;
  var el = document.getElementById('err');
  if (el.style.display !== 'block'){ el.style.display = 'block'; el.textContent = 'Error: ' + ev.message; }
});

document.addEventListener('DOMContentLoaded', function(){
  var b = document.getElementById('begin');
  b.addEventListener('click', boot);
  b.addEventListener('touchend', function(e){ e.preventDefault(); boot(); }, {passive:false});
});
document.addEventListener('gesturestart', function(e){ e.preventDefault(); });
document.addEventListener('contextmenu', function(e){ e.preventDefault(); });
})();
