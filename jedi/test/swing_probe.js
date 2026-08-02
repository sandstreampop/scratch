/* Swing diagnostics + filmstrip. THE acceptance test for saber swing quality.
 *
 *   node jedi/test/swing_probe.js <outdir> [stance] [dir] [htmlPath]
 *     stance 0 LIGHT / 1 MEDIUM / 2 STRONG   dir 0 neutral / 1 fwd / 2 left / 3 right
 *
 * Samples the blade in PLAYER-LOCAL space every frame of the swing
 * (+X = player's right, +Y = up, -Z = the way the player faces) and writes
 * <outdir>/strip.png — a single tiled filmstrip you can open and LOOK at.
 *
 * A good swing (all four must hold):
 *   frontFraction    >= 0.55   blade spends most of the swing in front of the body
 *   tipSpan          >= 1.8 m  the tip actually travels somewhere
 *   pathOverSpan     <= 1.9    one directed sweep, not a back-and-forth waggle
 *   maxTipHeight     <= 2.6 m  not waving above the head like an antenna
 */
var path = require('path');
var fs = require('fs');
var { chromium } = require('playwright-core');

var STANCE = +(process.argv[3] || 1);
var DIR = +(process.argv[4] || 0);
var HTML = process.argv[5] || path.resolve(__dirname, '..', 'index.html');

(async function(){
  var outdir = process.argv[2] || path.join(__dirname, 'out');
  fs.mkdirSync(outdir, { recursive: true });
  var browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox']
  });
  var page = await browser.newPage({ viewport: { width: 640, height: 640 }, hasTouch: true });
  var errors = [];
  page.on('pageerror', function(e){ errors.push(e.message); });
  await page.goto('file://' + HTML);
  await page.tap('#begin');
  await page.waitForTimeout(500);

  await page.evaluate(function(){
    JK.Input.update = function(){};
    var realUpdate = JK.Player.update;
    JK.Player.update = function(dt, t){
      var p = JK.Player.pos;
      /* fixed 3/4-front camera: an arc in front of the body reads clearly */
      JK.GL.setCamera([p[0] + 4.0, p[1] + 1.9, p[2] + 4.0], [p[0], p[1] + 1.1, p[2]], 55);
    };
    JK.Player.yaw = 0; JK.Player.anim = 'idle'; JK.Player.speed2D = 0;
    window.__samples = [];
    var origDraw = JK.Rig.draw;
    JK.Rig.draw = function(){
      origDraw.apply(JK.Rig, arguments);
      var b = JK.Rig.blades && JK.Rig.blades[0];
      if (!b) return;
      var p = JK.Player.pos, y = JK.Player.yaw;
      var c = Math.cos(-y), s = Math.sin(-y);
      function loc(v){
        var dx = v[0] - p[0], dy = v[1] - p[1], dz = v[2] - p[2];
        return [dx * c + dz * s, dy, -dx * s + dz * c];
      }
      window.__samples.push({ ph: JK.Rig.swingPhase(), base: loc(b.base), tip: loc(b.tip) });
    };
  });

  await page.waitForTimeout(250);
  await page.evaluate(function(a){
    window.__samples.length = 0;
    JK.Player.stanceIdx = a.s;
    JK.Input.state.moveX = a.mx; JK.Input.state.moveY = a.my;
    JK.Player.attackQueued = true;
  }, { s: STANCE, mx: DIR === 2 ? -1 : DIR === 3 ? 1 : 0, my: DIR === 1 ? 1 : 0 });

  var CELL = 300, N = 8;
  var frames = [];
  for (var i = 0; i < N; i++){
    await page.waitForTimeout(55);
    frames.push((await page.screenshot({
      clip: { x: 170, y: 140, width: CELL, height: CELL + 60 } })).toString('base64'));
  }
  await page.waitForTimeout(400);

  var data = await page.evaluate(function(){
    return { samples: window.__samples, name: JK.Sabers ? JK.Sabers.attackName : '?' };
  });

  /* tile the frames into one strip using the browser (no image libs available) */
  var strip = await page.evaluate(async function(a){
    var cv = document.createElement('canvas');
    cv.width = a.cell * a.n; cv.height = a.cell + 60;
    var cx = cv.getContext('2d');
    cx.fillStyle = '#111'; cx.fillRect(0, 0, cv.width, cv.height);
    for (var i = 0; i < a.imgs.length; i++){
      await new Promise(function(res){
        var im = new Image();
        im.onload = function(){ cx.drawImage(im, i * a.cell, 0); res(); };
        im.onerror = function(){ res(); };
        im.src = 'data:image/png;base64,' + a.imgs[i];
      });
      cx.fillStyle = '#ff0'; cx.font = 'bold 16px monospace';
      cx.fillText('' + i, i * a.cell + 8, 22);
    }
    return cv.toDataURL('image/png').split(',')[1];
  }, { imgs: frames, cell: CELL, n: N });
  fs.writeFileSync(path.join(outdir, 'strip.png'), Buffer.from(strip, 'base64'));
  await browser.close();

  var S = data.samples.filter(function(s){ return s.ph >= 0; });
  function d3(a, b){ var x=a[0]-b[0], y=a[1]-b[1], z=a[2]-b[2]; return Math.sqrt(x*x+y*y+z*z); }
  var pathLen = 0, front = 0, span = 0, maxY = -9, i, j;
  for (i = 0; i < S.length; i++){
    if (i > 0) pathLen += d3(S[i].tip, S[i-1].tip);
    if (S[i].tip[2] < -0.25) front++;
    if (S[i].tip[1] > maxY) maxY = S[i].tip[1];
    for (j = 0; j < i; j++){ var sp = d3(S[i].tip, S[j].tip); if (sp > span) span = sp; }
  }
  var n = S.length || 1;
  var r = {
    attack: data.name, stance: STANCE, dir: DIR, frames: S.length, errors: errors,
    frontFraction: +(front / n).toFixed(2),
    tipSpan: +span.toFixed(2),
    pathOverSpan: +(pathLen / (span || 1)).toFixed(2),
    maxTipHeight: +maxY.toFixed(2),
    tipStart: S.length ? S[0].tip.map(function(v){ return +v.toFixed(2); }) : null,
    tipMid: S.length ? S[(n/2)|0].tip.map(function(v){ return +v.toFixed(2); }) : null,
    tipEnd: S.length ? S[S.length-1].tip.map(function(v){ return +v.toFixed(2); }) : null
  };
  r.PASS = r.frontFraction >= 0.55 && r.tipSpan >= 1.8 &&
           r.pathOverSpan <= 1.9 && r.maxTipHeight <= 2.6 && !errors.length;
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.PASS ? 0 : 1);
})().catch(function(e){ console.error('PROBE FAIL: ' + e.message); process.exit(2); });
