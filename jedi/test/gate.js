#!/usr/bin/env node
/* QUALITY GATE — one command, one scorecard for the whole game.
 *
 *   node jedi/test/gate.js [htmlPath]
 *
 * Runs every harness, plus a live performance benchmark under busy combat, and
 * prints a scorecard with a single pass/fail. This is the yardstick the quality
 * loop measures itself against, so every check must be objective and cheap
 * enough to run every iteration.
 */
var path = require('path');
var fs = require('fs');
var cp = require('child_process');
var { chromium } = require('playwright-core');

var HTML = process.argv[2] || path.resolve(__dirname, '..', 'index.html');
var OUT = process.env.GATE_OUT ||
  '/tmp/claude-0/-home-user-scratch/8c008425-1aae-59d5-be90-ea10419b1795/scratchpad/gate';
fs.mkdirSync(OUT, { recursive: true });

var results = [];
function record(name, pass, detail){
  results.push({ name: name, pass: !!pass, detail: detail });
  console.log((pass ? '  PASS  ' : '  FAIL  ') + name.padEnd(26) + (detail || ''));
}
function runNode(script, args){
  var r = cp.spawnSync('node', [path.join(__dirname, script)].concat(args || []),
    { encoding: 'utf8', timeout: 180000 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
function json(out){
  var i = out.indexOf('{');
  if (i < 0) return null;
  try { return JSON.parse(out.slice(i)); } catch (e) { return null; }
}

/* ---- performance + liveness benchmark: busy combat on an iPhone viewport ---- */
async function benchmark(){
  var browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox']
  });
  var page = await browser.newPage({ viewport: { width: 844, height: 390 },
    hasTouch: true, isMobile: true });
  var errors = [];
  page.on('pageerror', function(e){ errors.push(e.message); });
  page.on('console', function(m){ if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('file://' + HTML);
  await page.tap('#begin');
  await page.waitForTimeout(800);

  await page.evaluate(function(){
    window.__ft = [];
    var last = 0;
    window.__raf = function tick(now){
      if (last) window.__ft.push(now - last);
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(window.__raf);

    /* Headless uses SwiftShader (CPU rasterization), so wall-clock frame time is
     * fill-rate bound and tells us almost nothing about a real iPhone GPU. The
     * two numbers that DO transfer are the JavaScript cost per frame and the
     * draw-call count, so measure those and gate on them instead. */
    window.__draws = 0;
    var realDraw = JK.GL.draw;
    JK.GL.draw = function(){ window.__draws++; return realDraw.apply(JK.GL, arguments); };
    window.__js = 0;
    var SYS = ['Terrain','Input','Player','Rig','Sabers','Powers','Bots','Blaster',
               'Hero','Fx','ForceFx','Audio','Hud','Ui','Combat'];
    for (var i = 0; i < SYS.length; i++){
      (function(o){
        if (!o) return;
        ['update','draw'].forEach(function(fn){
          if (typeof o[fn] !== 'function') return;
          var orig = o[fn];
          o[fn] = function(){
            var t = performance.now();
            var r = orig.apply(o, arguments);
            window.__js += performance.now() - t;
            return r;
          };
        });
      })(JK[SYS[i]]);
    }
    /* drag the fight to us so the benchmark is genuinely busy */
    var L = (JK.Bots && JK.Bots.list) || [];
    var P = JK.Player;
    for (var i = 0; i < L.length; i++){
      if (!L[i] || !L[i].pos) continue;
      var a = i / Math.max(1, L.length) * Math.PI * 2;
      L[i].pos[0] = P.pos[0] + Math.cos(a) * 11;
      L[i].pos[2] = P.pos[2] + Math.sin(a) * 11;
      if (JK.Terrain) L[i].pos[1] = JK.Terrain.height(L[i].pos[0], L[i].pos[2]);
    }
  });

  /* 12 s of continuous attacking + force powers + movement */
  var t0 = Date.now();
  while (Date.now() - t0 < 12000){
    await page.evaluate(function(){
      JK.Player.attackQueued = true;
      if (JK.Input && JK.Input.state){
        JK.Input.state.moveX = Math.sin(Date.now() / 900);
        JK.Input.state.moveY = Math.cos(Date.now() / 900);
        JK.Input.state.force = Math.random() < 0.25;
      }
    });
    await page.waitForTimeout(120);
  }
  await page.screenshot({ path: path.join(OUT, 'benchmark.png') });

  var perf = await page.evaluate(function(){
    var f = window.__ft.slice(10).sort(function(a, b){ return a - b; });
    if (!f.length) return null;
    var sum = 0;
    for (var i = 0; i < f.length; i++) sum += f[i];
    var n = window.__ft.length || 1;
    return {
      frames: f.length,
      meanMs: +(sum / f.length).toFixed(2),
      p50: +f[(f.length * 0.5) | 0].toFixed(2),
      p95: +f[(f.length * 0.95) | 0].toFixed(2),
      worst: +f[f.length - 1].toFixed(2),
      jsMs: +(window.__js / n).toFixed(2),
      draws: +(window.__draws / n).toFixed(0),
      bots: (JK.Bots && JK.Bots.list || []).length,
      ents: (JK.Combat && JK.Combat.ents || []).length,
      hp: JK.game.hp, kills: JK.game.kills || 0,
      nan: !isFinite(JK.Player.pos[0]) || !isFinite(JK.Player.pos[1]) || !isFinite(JK.Player.pos[2])
    };
  });
  await browser.close();
  return { perf: perf, errors: errors };
}

(async function(){
  console.log('\n=== DUNE RAIDER quality gate ===');
  console.log('build: ' + HTML + '  (' +
    (fs.existsSync(HTML) ? (fs.statSync(HTML).size / 1024).toFixed(0) + ' KB' : 'MISSING') + ')\n');

  var r = runNode('smoke.js', [path.join(OUT, 'smoke')]);
  var d = json(r.out);
  record('boot / no console errors', r.code === 0 && d && !d.errors.length,
    d && d.state ? 'bots=' + d.state.bots : '');

  r = runNode('interact.js', [path.join(OUT, 'interact')]);
  d = json(r.out);
  record('touch controls', r.code === 0 && d && !d.errors.length,
    d ? 'moved ' + d.movedMeters + 'm, ' + d.runAnim : '');

  r = runNode('combat_ui.js', [path.join(OUT, 'combat')]);
  d = json(r.out);
  var uniq = d ? new Set(d.attackNames).size : 0;
  record('12 attacks / saber menu', d && uniq === 12 && !d.errors.length &&
    d.dual && d.dual.blades === 2 && d.staff && d.staff.blades === 2,
    uniq + '/12 unique, dual+staff ok');

  r = runNode('camera_probe.js', [path.join(OUT, 'camera'), HTML]);
  d = json(r.out);
  record('camera auto-follow', r.code === 0,
    d && d.strafeLeft ? 'align ' + d.strafeLeft.alignDeg + 'deg in ' +
      d.strafeLeft.alignSeconds + 's, drift ' + d.strafeLeft.headingDriftDeg : '');

  var swingPass = 0, swingWorst = '';
  for (var s = 0; s < 3; s++){
    for (var dir = 0; dir < 4; dir++){
      var rr = runNode('swing_probe.js', [path.join(OUT, 'sw' + s + dir), s, dir, HTML]);
      var dd = json(rr.out);
      if (rr.code === 0) swingPass++;
      else if (dd) swingWorst += ' ' + (dd.attack || (s + '/' + dir));
    }
  }
  record('12 saber swing arcs', swingPass === 12,
    swingPass + '/12 pass' + (swingWorst ? ' — failing:' + swingWorst : ''));

  var b = await benchmark();
  var p = b.perf;
  record('no runtime errors in combat', !b.errors.length,
    b.errors.length ? b.errors[0].slice(0, 70) : 'clean over 12s');
  /* Gate on the device-independent numbers. Wall-clock is printed for context
   * but never fails the build: headless is software-rasterized, an iPhone is not. */
  record('JS cost per frame', p && p.jsMs <= 4 && !p.nan,
    p ? p.jsMs + 'ms js | wall ' + p.meanMs + 'ms p95 ' + p.p95 + ' (SwiftShader, not a GPU)' : 'no data');
  record('draw calls per frame', p && p.draws <= 200,
    p ? p.draws + ' calls | bots ' + p.bots + ' ents ' + p.ents : 'no data');

  var passed = results.filter(function(x){ return x.pass; }).length;
  console.log('\n  SCORE  ' + passed + '/' + results.length +
    (passed === results.length ? '  ALL GREEN' : '  <-- regressions'));
  fs.writeFileSync(path.join(OUT, 'scorecard.json'),
    JSON.stringify({ results: results, perf: p, when: new Date().toISOString() }, null, 2));
  process.exit(passed === results.length ? 0 : 1);
})().catch(function(e){ console.error('GATE FAIL: ' + e.message); process.exit(2); });
