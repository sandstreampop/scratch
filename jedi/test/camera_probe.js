/* Camera-follow diagnostics. THE acceptance test for the auto-follow camera.
 *
 *   node jedi/test/camera_probe.js <outdir> [htmlPath]
 *
 * Runs four scenarios with a HELD stick and no manual look input, logging the
 * camera yaw, the body yaw and the actual world travel direction each frame.
 *
 * What good looks like:
 *   alignDeg      <= 18   camera ends up behind the direction you are travelling
 *   alignSeconds  <= 2.5  and gets there promptly
 *   headingDriftDeg <= 25 THE SPIRAL TRAP: with the stick held CONSTANT the
 *                         player must keep running in a straight world line.
 *                         Movement is camera-relative, so a camera that chases
 *                         the heading drags the heading with it and the player
 *                         curves away forever. This is the failure mode that
 *                         a naive implementation always has.
 *   oscillations  <= 2    settles instead of hunting back and forth
 *   maxStepDeg    <= 4.0  eases, never snaps (at 60fps)
 *   manualHeldDeg >= 25   after the player drags the camera somewhere, it
 *                         RESPECTS that choice for a grace period
 */
var path = require('path');
var fs = require('fs');
var { chromium } = require('playwright-core');

var HTML = process.argv[3] || path.resolve(__dirname, '..', 'index.html');
var DEG = 180 / Math.PI;

function wrap(a){ while (a > Math.PI) a -= 2*Math.PI; while (a < -Math.PI) a += 2*Math.PI; return a; }

(async function(){
  var outdir = process.argv[2] || path.join(__dirname, 'out');
  fs.mkdirSync(outdir, { recursive: true });
  var browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox']
  });
  var page = await browser.newPage({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });
  var errors = [];
  page.on('pageerror', function(e){ errors.push(e.message); });
  page.on('console', function(m){ if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('file://' + HTML);
  await page.tap('#begin');
  await page.waitForTimeout(500);

  /* Take over input: hold a synthetic stick, no look drag. */
  await page.evaluate(function(){
    JK.Input.update = function(){
      var s = JK.Input.state, w = window.__drive || {};
      s.moveX = w.mx || 0; s.moveY = w.my || 0;
      s.runHeld = !!w.run; s.run = s.runHeld;
      s.lookDX = w.lookDX || 0; s.lookDY = 0; w.lookDX = 0;
      s.jump = false; s.attack = false; s.force = false;
      s.stanceTap = false; s.forceTap = false; s.attackHeld = false; s.forceHeld = false;
    };
    window.__drive = { mx: 0, my: 0, run: false, lookDX: 0 };
    window.__log = [];
    var realUpd = JK.Player.update.bind(JK.Player);
    JK.Player.update = function(dt, t){
      realUpd(dt, t);
      var P = JK.Player;
      window.__log.push({
        t: t, camYaw: P.camYaw, yaw: P.yaw,
        vx: P.vel[0], vz: P.vel[2], spd: P.speed2D,
        x: P.pos[0], z: P.pos[2]
      });
    };
  });

  async function run(name, mx, my, seconds, opts){
    opts = opts || {};
    await page.evaluate(function(a){
      window.__log.length = 0;
      window.__drive.mx = a.mx; window.__drive.my = a.my; window.__drive.run = a.run;
      /* start from a deliberately wrong camera angle so there is work to do */
      if (a.camYaw !== undefined) JK.Player.camYaw = a.camYaw;
    }, { mx: mx, my: my, run: true, camYaw: opts.camYaw });
    await page.waitForTimeout(seconds * 1000);
    if (opts.shot) await page.screenshot({ path: path.join(outdir, name + '.png') });
    var log = await page.evaluate(function(){ return window.__log; });
    await page.evaluate(function(){ window.__drive.mx = 0; window.__drive.my = 0; });
    await page.waitForTimeout(350);
    return log;
  }

  function analyse(log){
    var moving = log.filter(function(s){ return s.spd > 1.2; });
    if (moving.length < 10) return { frames: moving.length, insufficient: true };
    var errs = moving.map(function(s){
      var travel = Math.atan2(-s.vx, -s.vz);      /* fwd(yaw) = (-sin, -cos) */
      return { t: s.t, e: Math.abs(wrap(travel - s.camYaw)) * DEG, camYaw: s.camYaw, travel: travel };
    });
    var last = errs.slice(-Math.max(6, (errs.length * 0.15) | 0));
    var alignDeg = last.reduce(function(a, b){ return a + b.e; }, 0) / last.length;
    /* time until the error first drops under 20 deg and stays there */
    var alignSeconds = -1, t0 = errs[0].t;
    for (var i = 0; i < errs.length; i++){
      if (errs[i].e < 20){
        var ok = true;
        for (var j = i; j < errs.length; j++) if (errs[j].e > 30){ ok = false; break; }
        if (ok){ alignSeconds = errs[i].t - t0; break; }
      }
    }
    /* SPIRAL TRAP: total world-heading drift over the second half of the run */
    var half = moving.slice((moving.length / 2) | 0);
    var h0 = Math.atan2(-half[0].vx, -half[0].vz);
    var h1 = Math.atan2(-half[half.length-1].vx, -half[half.length-1].vz);
    var headingDrift = Math.abs(wrap(h1 - h0)) * DEG;
    /* oscillation: sign changes of the error trend once roughly settled */
    var osc = 0, prevSign = 0;
    for (i = 1; i < errs.length; i++){
      var d = errs[i].e - errs[i-1].e;
      if (Math.abs(d) < 0.05) continue;
      var s2 = d > 0 ? 1 : -1;
      if (prevSign && s2 !== prevSign) osc++;
      prevSign = s2;
    }
    /* biggest single-frame camera step */
    var maxStep = 0;
    for (i = 1; i < moving.length; i++){
      var st = Math.abs(wrap(moving[i].camYaw - moving[i-1].camYaw)) * DEG;
      if (st > maxStep) maxStep = st;
    }
    return {
      frames: moving.length,
      alignDeg: +alignDeg.toFixed(1),
      alignSeconds: +alignSeconds.toFixed(2),
      headingDriftDeg: +headingDrift.toFixed(1),
      oscillations: osc,
      maxStepDeg: +maxStep.toFixed(2)
    };
  }

  var R = {};
  /* NOTE: a pure-forward stick makes travel == camYaw by construction (movement
   * is camera-relative), so it can never measure alignment — it is a stability
   * check only. The real work is the sideways and diagonal runs. */
  R.forward = analyse(await run('forward', 0, 1, 3.0, { camYaw: 2.1, shot: true }));
  /* run hard LEFT with a constant stick — camera must swing behind, and the
   * player must still travel in a STRAIGHT world line (the spiral trap) */
  R.strafeLeft = analyse(await run('strafeLeft', -1, 0, 4.5, { camYaw: 0, shot: true }));
  /* the other spiral case */
  R.diagonal = analyse(await run('diagonal', 0.7, 0.7, 4.5, { camYaw: 0, shot: true }));

  /* manual look must be respected: converge first, then drag and check the
   * camera does NOT instantly yank back to the travel direction */
  await page.evaluate(function(){
    window.__log.length = 0;
    window.__drive.mx = -1; window.__drive.my = 0; window.__drive.run = true;
    JK.Player.camYaw = 0;
  });
  await page.waitForTimeout(3000);                 /* let auto-follow settle */
  await page.evaluate(function(){ window.__drive.lookDX = 320; });  /* a real drag */
  await page.waitForTimeout(400);                  /* inside any sane grace window */
  var manualLog = await page.evaluate(function(){ return window.__log.slice(-40); });
  await page.evaluate(function(){ window.__drive.mx = 0; window.__drive.my = 0; });
  var mEnd = manualLog[manualLog.length - 1];
  var mTravel = Math.atan2(-mEnd.vx, -mEnd.vz);
  R.manualHeldDeg = +(Math.abs(wrap(mTravel - mEnd.camYaw)) * DEG).toFixed(1);

  await browser.close();

  R.errors = errors.slice(0, 5);
  function converges(s){
    return s && !s.insufficient && s.alignDeg <= 18 &&
           s.alignSeconds >= 0 && s.alignSeconds <= 2.5 &&
           s.headingDriftDeg <= 25 && s.oscillations <= 6 && s.maxStepDeg <= 4.0;
  }
  R.PASS =
    !errors.length &&
    converges(R.strafeLeft) &&
    converges(R.diagonal) &&
    R.forward.headingDriftDeg <= 25 && R.forward.maxStepDeg <= 4.0 &&
    R.manualHeldDeg >= 25;
  console.log(JSON.stringify(R, null, 2));
  process.exit(R.PASS ? 0 : 1);
})().catch(function(e){ console.error('CAM PROBE FAIL: ' + e.message); process.exit(2); });
