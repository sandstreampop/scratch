/* Interaction test: drive touch controls, verify movement/jump/attack. */
var path = require('path');
var { chromium } = require('playwright-core');

(async function(){
  var outdir = process.argv[2] || path.join(__dirname, 'out');
  require('fs').mkdirSync(outdir, { recursive: true });
  var browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox']
  });
  var page = await browser.newPage({ viewport: { width: 844, height: 390 },
    hasTouch: true, isMobile: true });
  var errors = [];
  page.on('console', function(m){ if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', function(e){ errors.push('PAGEERROR: ' + e.message); });
  await page.goto('file://' + path.resolve(__dirname, '..', 'index.html'));
  await page.tap('#begin');
  await page.waitForTimeout(800);

  var p0 = await page.evaluate(function(){ return JK.Player.pos.slice(); });

  // hold virtual stick forward for 2s via CDP touch events
  var cdp = await page.context().newCDPSession(page);
  async function touch(type, points){
    await cdp.send('Input.dispatchTouchEvent', { type: type, touchPoints: points });
  }
  await touch('touchStart', [{ x: 160, y: 280, id: 1 }]);
  for (var i = 1; i <= 10; i++){
    await touch('touchMove', [{ x: 160, y: 280 - i * 6, id: 1 }]);
    await page.waitForTimeout(30);
  }
  await page.waitForTimeout(1700);
  await page.screenshot({ path: path.join(outdir, 'run.png') });
  var p1 = await page.evaluate(function(){
    return { pos: JK.Player.pos.slice(), anim: JK.Player.anim, spd: JK.Player.speed2D }; });
  await touch('touchEnd', [{ x: 160, y: 220, id: 1 }]);

  // jump
  await page.tap('#btnJump');
  await page.waitForTimeout(250);
  var pj = await page.evaluate(function(){
    return { anim: JK.Player.anim, vy: JK.Player.vel[1], onG: JK.Player.onGround }; });
  await page.screenshot({ path: path.join(outdir, 'jump.png') });
  await page.waitForTimeout(900);

  // attack swing
  await page.tap('#btnAtk');
  await page.waitForTimeout(180);
  await page.screenshot({ path: path.join(outdir, 'swing.png') });

  // camera look drag on right side
  await touch('touchStart', [{ x: 650, y: 200, id: 2 }]);
  for (var j = 1; j <= 8; j++){
    await touch('touchMove', [{ x: 650 + j * 15, y: 200, id: 2 }]);
    await page.waitForTimeout(30);
  }
  await touch('touchEnd', [{ x: 770, y: 200, id: 2 }]);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(outdir, 'look.png') });

  // stance cycle
  await page.tap('#btnStance');
  await page.waitForTimeout(120);
  var stance = await page.evaluate(function(){
    return { idx: JK.Player.stanceIdx, tag: document.getElementById('stanceTag').textContent }; });

  var moved = Math.hypot(p1.pos[0] - p0[0], p1.pos[2] - p0[2]);
  var report = { errors: errors.slice(0, 10), movedMeters: +moved.toFixed(2),
    runAnim: p1.anim, runSpeed: +p1.spd.toFixed(2),
    jump: pj, stance: stance };
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
  var ok = !errors.length && moved > 3 && (pj.vy > 1 || pj.anim === 'jump');
  process.exit(ok ? 0 : 1);
})().catch(function(e){ console.error('INTERACT FAIL: ' + e.message); process.exit(2); });
