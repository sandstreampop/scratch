var path = require('path');
var { chromium } = require('playwright-core');
(async function(){
  var browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
  var page = await browser.newPage({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });
  var errors = [];
  page.on('pageerror', function(e){ errors.push(e.message); });
  await page.goto('file://' + path.resolve(__dirname, '..', 'index.html'));
  await page.tap('#begin');
  await page.waitForTimeout(500);
  await page.evaluate(function(){ JK.Input.update = function(){}; JK.Player.update = function(){}; });
  var names = [];
  var dirs = [[0,0],[0,1],[-1,0],[1,0]];
  for (var s = 0; s < 3; s++){
    for (var d = 0; d < 4; d++){
      await page.evaluate(function(a){
        JK.Player.stanceIdx = a.s;
        JK.Input.state.moveX = a.mx; JK.Input.state.moveY = a.my;
        JK.Player.attackQueued = true;
      }, { s: s, mx: dirs[d][0], my: dirs[d][1] });
      await page.waitForTimeout(800);
      names.push(await page.evaluate(function(){ return JK.Sabers.attackName; }));
    }
  }
  console.log(JSON.stringify({ errors: errors, names: names }));
  await browser.close();
})().catch(function(e){ console.error('FAIL ' + e.message); process.exit(2); });
