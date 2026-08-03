#!/usr/bin/env node
/* Per-system CPU profiler.
 *
 *   node jedi/test/profile.js [htmlPath]
 *
 * Headless runs use SwiftShader (CPU rasterization), so total frame time is
 * dominated by fill rate and says little about a real iPhone GPU. What DOES
 * transfer is the JavaScript cost of each system's update() and draw(), and the
 * number of draw calls issued per frame. This wraps both and attributes them,
 * so optimisation work can be aimed at whatever is actually expensive.
 */
var path = require('path');
var { chromium } = require('playwright-core');
var HTML = process.argv[2] || path.resolve(__dirname, '..', 'index.html');

(async function(){
  var browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox']
  });
  var page = await browser.newPage({ viewport: { width: 844, height: 390 },
    hasTouch: true, isMobile: true });
  var errors = [];
  page.on('pageerror', function(e){ errors.push(e.message); });
  await page.goto('file://' + HTML);
  await page.tap('#begin');
  await page.waitForTimeout(800);

  await page.evaluate(function(){
    var SYS = ['Terrain','Input','Player','Rig','Sabers','Powers','Bots',
               'Blaster','Hero','Fx','ForceFx','Audio','Hud','Ui','Combat'];
    window.__prof = {};
    window.__draws = 0;
    window.__frames = 0;

    /* count draw calls */
    var realDraw = JK.GL.draw;
    JK.GL.draw = function(){ window.__draws++; return realDraw.apply(JK.GL, arguments); };

    function wrap(objName, fn){
      var o = JK[objName];
      if (!o || typeof o[fn] !== 'function') return;
      var orig = o[fn];
      var key = objName + '.' + fn;
      window.__prof[key] = 0;
      o[fn] = function(){
        var t = performance.now();
        var r = orig.apply(o, arguments);
        window.__prof[key] += performance.now() - t;
        return r;
      };
    }
    for (var i = 0; i < SYS.length; i++){ wrap(SYS[i], 'update'); wrap(SYS[i], 'draw'); }

    var rafCount = function tick(){ window.__frames++; requestAnimationFrame(tick); };
    requestAnimationFrame(rafCount);

    /* pull the fight in close so this is a worst-case frame */
    var L = (JK.Bots && JK.Bots.list) || [], P = JK.Player;
    for (var j = 0; j < L.length; j++){
      if (!L[j] || !L[j].pos) continue;
      var a = j / Math.max(1, L.length) * Math.PI * 2;
      L[j].pos[0] = P.pos[0] + Math.cos(a) * 10;
      L[j].pos[2] = P.pos[2] + Math.sin(a) * 10;
      if (JK.Terrain) L[j].pos[1] = JK.Terrain.height(L[j].pos[0], L[j].pos[2]);
    }
  });

  var t0 = Date.now();
  while (Date.now() - t0 < 10000){
    await page.evaluate(function(){
      JK.Player.attackQueued = true;
      if (JK.Input && JK.Input.state){
        JK.Input.state.moveX = Math.sin(Date.now() / 800);
        JK.Input.state.moveY = Math.cos(Date.now() / 800);
        JK.Input.state.force = Math.random() < 0.3;
      }
    });
    await page.waitForTimeout(110);
  }

  var out = await page.evaluate(function(){
    var f = window.__frames || 1;
    var rows = [], total = 0;
    for (var k in window.__prof){
      var ms = window.__prof[k] / f;
      if (ms > 0.001) rows.push({ system: k, msPerFrame: +ms.toFixed(3) });
      total += ms;
    }
    rows.sort(function(a, b){ return b.msPerFrame - a.msPerFrame; });
    return {
      frames: f,
      jsMsPerFrame: +total.toFixed(2),
      drawCallsPerFrame: +(window.__draws / f).toFixed(1),
      bots: (JK.Bots && JK.Bots.list || []).length,
      particles: (JK.Fx && JK.Fx.live) ? JK.Fx.live() : null,
      top: rows.slice(0, 12)
    };
  });
  out.errors = errors.slice(0, 5);
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})().catch(function(e){ console.error('PROFILE FAIL: ' + e.message); process.exit(2); });
