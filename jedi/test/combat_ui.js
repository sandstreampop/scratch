/* Iteration-2 feature test: 12 stance attacks, droid hits, saber menu, RGB picker. */
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
  await page.waitForTimeout(600);

  // freeze input snapshots so we can drive state directly
  await page.evaluate(function(){ JK.Input.update = function(){}; });

  // --- 12 attacks: set stance + stick dir, queue attack, read attackName ---
  var names = [];
  var dirs = [[0,0],[0,1],[-1,0],[1,0]]; // neutral, fwd, left, right
  for (var s = 0; s < 3; s++){
    for (var d = 0; d < 4; d++){
      var nm = await page.evaluate(function(a){
        JK.Player.stanceIdx = a.s;
        JK.Input.state.moveX = a.mx; JK.Input.state.moveY = a.my;
        JK.Player.attackQueued = true;
        return null;
      }, { s: s, mx: dirs[d][0], my: dirs[d][1] });
      await page.waitForTimeout(750); // let swing start+finish
      nm = await page.evaluate(function(){ return JK.Sabers.attackName; });
      names.push(s + ':' + nm);
    }
  }

  // --- droid combat: teleport next to a droid, mash attack, verify damage ---
  await page.evaluate(function(){
    JK.Input.state.moveX = 0; JK.Input.state.moveY = 0;
    var es = JK.Combat.ents, dp = null;
    for (var i = 0; i < es.length; i++) if (es[i].team === 'enemy'){ dp = es[i].pos; break; }
    if (dp){
      JK.Player.pos[0] = dp[0] - 1.1; JK.Player.pos[2] = dp[2];
      JK.Player.pos[1] = JK.Terrain.height(JK.Player.pos[0], JK.Player.pos[2]);
      JK.Player.yaw = -Math.PI / 2 * 0 + Math.atan2(-(dp[0] - JK.Player.pos[0]), -(dp[2] - JK.Player.pos[2]));
      JK.Player.stanceIdx = 1;
    }
  });
  for (var i = 0; i < 8; i++){
    await page.evaluate(function(){ JK.Player.attackQueued = true; });
    await page.waitForTimeout(420);
  }
  await page.screenshot({ path: path.join(outdir, 'fight.png') });
  var combat = await page.evaluate(function(){
    var es = JK.Combat.ents, minHp = 1e9, enemies = 0;
    for (var i = 0; i < es.length; i++) if (es[i].team === 'enemy'){ enemies++; if (es[i].hp < minHp) minHp = es[i].hp; }
    return { enemies: enemies, minHp: minHp, lastHit: JK.Combat.lastHit ? JK.Combat.lastHit.dmg : null,
             swingId: JK.Combat.swingId };
  });

  // --- saber menu: open, DUAL then STAFF, red via sliders (one at a time) ---
  await page.evaluate(function(){
    var els = document.querySelectorAll('body > *');
    for (var i = 0; i < els.length; i++)
      if ((els[i].textContent || '').trim() === 'SABER') els[i].setAttribute('data-t', 'saberbtn');
    var all = document.querySelectorAll('body *');
    for (var j = 0; j < all.length; j++){
      var t = (all[j].textContent || '').trim();
      if (all[j].children.length === 0){
        if (t === 'DUAL') all[j].setAttribute('data-t', 'dualbtn');
        if (t === 'STAFF') all[j].setAttribute('data-t', 'staffbtn');
      }
    }
  });
  await page.tap('[data-t="saberbtn"]');
  await page.waitForTimeout(300);
  await page.tap('[data-t="dualbtn"]');
  await page.waitForTimeout(200);
  var dual = await page.evaluate(function(){
    return { type: JK.Rig.player.type, blades: JK.Rig.player.blades.length }; });
  await page.tap('[data-t="staffbtn"]');
  await page.waitForTimeout(200);
  var staff = await page.evaluate(function(){
    return { type: JK.Rig.player.type, blades: JK.Rig.player.blades.length }; });
  // sliders: change one at a time like a real user
  var color = await page.evaluate(function(){
    var rs = document.querySelectorAll('input[type=range]');
    function setOne(el, v){ el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }
    setOne(rs[0], 255); setOne(rs[1], 20); setOne(rs[2], 20);
    return Array.prototype.slice.call(JK.Rig.player.saberCol);
  });
  await page.tap('[data-t="saberbtn"]'); // close
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(outdir, 'staff_red.png') });

  var report = { errors: errors.slice(0, 8), attackNames: names, combat: combat,
    dual: dual, staff: staff, colorAfterRGB: color };
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
  var uniq = {}; names.forEach(function(n){ uniq[n] = 1; });
  var ok = !errors.length && Object.keys(uniq).length === 12 && combat.minHp < 60 &&
    dual.blades === 2 && staff.blades === 2 && color[0] === 1 && color[1] < 0.1;
  process.exit(ok ? 0 : 1);
})().catch(function(e){ console.error('TEST FAIL: ' + e.message); process.exit(2); });
