/* Headless smoke test: load jedi/index.html, tap ENTER, run ~2s, screenshot,
   report console errors + basic state. Usage: node jedi/test/smoke.js [outdir] */
var path = require('path');
var { chromium } = require('playwright-core');

(async function(){
  var outdir = process.argv[2] || path.join(__dirname, 'out');
  require('fs').mkdirSync(outdir, { recursive: true });
  var browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox']
  });
  var page = await browser.newPage({ viewport: { width: 844, height: 390 }, // iPhone-ish landscape
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    hasTouch: true, isMobile: true });
  var errors = [];
  page.on('console', function(m){ if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', function(e){ errors.push('PAGEERROR: ' + e.message); });
  await page.goto('file://' + path.resolve(__dirname, '..', 'index.html'));
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(outdir, '0_start.png') });
  await page.tap('#begin');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(outdir, '1_game.png') });
  var state = await page.evaluate(function(){
    var errEl = document.getElementById('err');
    return {
      errShown: errEl && errEl.style.display === 'block' ? errEl.textContent : null,
      startGone: document.getElementById('start').classList.contains('gone'),
      canvasW: document.getElementById('gl').width,
      player: window.JK && JK.Player ? { pos: Array.prototype.slice.call(JK.Player.pos), anim: JK.Player.anim } : null,
      terrainH: window.JK && JK.Terrain && JK.Terrain.height ? JK.Terrain.height(10, 10) : null,
      bots: window.JK && JK.Bots && JK.Bots.list ? JK.Bots.list.length : null
    };
  });
  // simulate touch move on left stick for 1.5s
  try {
    await page.touchscreen.tap(180, 300);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(outdir, '2_after_tap.png') });
  } catch (e) {}
  console.log(JSON.stringify({ errors: errors.slice(0, 10), state: state }, null, 2));
  await browser.close();
  if (errors.length || (state && state.errShown)) process.exit(1);
})().catch(function(e){ console.error('SMOKE FAIL: ' + e.message); process.exit(2); });
