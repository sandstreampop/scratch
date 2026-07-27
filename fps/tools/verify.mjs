// Playability acceptance test.
//
// Asserts the things that actually decide whether the game is playable on a
// phone, rather than merely that the page loaded: the canvas draws real
// content, a thumb drag moves the player, a drag on the right turns the
// camera, and the fire button consumes ammunition.
//
//   node tools/verify.mjs [--dist] [--engine=chromium|webkit] [--desktop]
//
// --dist       test the built bundle in dist/ instead of the source tree
// --engine     which browser engine; webkit is the closest available stand-in
//              for iOS Safari and is only installable on the CI runner
// --desktop    use a desktop viewport with mouse/keyboard instead of touch

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const useDist = args.includes('--dist');
const desktop = args.includes('--desktop');
const engineName = (args.find((a) => a.startsWith('--engine=')) || '--engine=chromium').split('=')[1];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, '..');
const ROOT = useDist ? path.join(PROJECT, 'dist') : PROJECT;
const SHOTS = path.join(PROJECT, 'shots', 'verify');

if (!fs.existsSync(path.join(ROOT, 'index.html'))) {
  console.error(`verify: no index.html in ${ROOT}${useDist ? ' — run `node build.mjs` first' : ''}`);
  process.exit(1);
}

// playwright-core locally, full playwright in CI where browsers are managed.
let pw;
try { pw = await import('playwright'); } catch { pw = await import('playwright-core'); }
const engine = pw[engineName];
if (!engine) { console.error(`verify: unknown engine "${engineName}"`); process.exit(1); }

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.map': 'application/json',
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// iPhone 13 in landscape — the orientation the game asks for.
const IPHONE = {
  viewport: { width: 844, height: 390 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 '
    + '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
};
const DESKTOP = { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 };

const launchOptions = { headless: true, args: [] };
if (engineName === 'chromium') {
  launchOptions.args = ['--no-sandbox', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'];
  if (fs.existsSync('/opt/pw-browsers/chromium')) {
    launchOptions.executablePath = '/opt/pw-browsers/chromium';
  }
}

fs.mkdirSync(SHOTS, { recursive: true });

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const browser = await engine.launch(launchOptions);
const context = await browser.newContext(desktop ? DESKTOP : { ...IPHONE, isMobile: engineName !== 'firefox' });
const page = await context.newPage();

const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });

const label = `${engineName}-${desktop ? 'desktop' : 'iphone'}`;
let exitCode = 0;

try {
  const t0 = Date.now();
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'commit', timeout: 60000 });

  // Boot: procedural generation is synchronous and slow on a cold engine.
  // __GAME exists before generation finishes; `ready` is set once the staged
  // build has completed and the start screen is interactive.
  await page.waitForFunction('!!(window.__GAME && window.__GAME.ready)',
    null, { timeout: 300000, polling: 250 });
  await page.waitForSelector('#start:not(.hidden)', { timeout: 30000 });
  const bootMs = Date.now() - t0;
  check('boots', true, `${(bootMs / 1000).toFixed(1)}s`);

  await page.screenshot({ path: path.join(SHOTS, `${label}-1-start.png`) });

  // Start the game the way a player would.
  if (desktop) {
    await page.click('#start', { force: true });
  } else {
    await page.locator('#start').dispatchEvent('touchstart');
    await page.locator('#start').dispatchEvent('touchend');
    await page.locator('#start').click({ force: true }).catch(() => {});
  }
  await page.waitForTimeout(1500);

  const started = await page.evaluate(() => !!(window.__GAME && window.__GAME.running));
  check('starts on tap', started);

  // The canvas must contain more than one colour, or we are looking at a
  // cleared buffer and calling it a render.
  const variety = await page.evaluate(async () => {
    const g = window.__GAME;
    g.render(1 / 60);
    const c = g.renderer.domElement;
    const t = document.createElement('canvas');
    t.width = 80; t.height = 45;
    const x = t.getContext('2d');
    x.drawImage(c, 0, 0, 80, 45);
    const d = x.getImageData(0, 0, 80, 45).data;
    const seen = new Set();
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) {
      seen.add((d[i] >> 3) << 10 | (d[i + 1] >> 3) << 5 | (d[i + 2] >> 3));
      sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
    }
    return { colours: seen.size, meanLuma: +(sum / (d.length / 4)).toFixed(1) };
  });
  check('renders real content', variety.colours > 24 && variety.meanLuma > 8,
    `${variety.colours} distinct colours, mean luma ${variety.meanLuma}`);

  const before = await page.evaluate(() => {
    const g = window.__GAME;
    return { x: g.player.position.x, z: g.player.position.z, yaw: g.player.yaw, ammo: g.weapon.ammo };
  });

  // Hold the control, then advance the simulation directly. Under a software
  // rasteriser a real-time hold yields about one frame, which tells us nothing
  // about whether the input is wired up — which is what this check is for.
  if (desktop) {
    await page.keyboard.down('KeyW');
  } else {
    const cx = 140, cy = 300;
    await page.evaluate(([x, y]) => {
      const c = window.__GAME.renderer.domElement;
      const mk = (type, id, px, py) => {
        const t = new Touch({ identifier: id, target: c, clientX: px, clientY: py });
        c.dispatchEvent(new TouchEvent(type, {
          touches: type === 'touchend' ? [] : [t],
          changedTouches: [t], targetTouches: type === 'touchend' ? [] : [t],
          bubbles: true, cancelable: true,
        }));
      };
      mk('touchstart', 1, x, y);
      for (let i = 1; i <= 6; i++) mk('touchmove', 1, x, y - i * 12);
      window.__release = () => mk('touchend', 1, x, y - 72);
    }, [cx, cy]);
  }

  await page.evaluate(() => {
    const g = window.__GAME;
    for (let i = 0; i < 60; i++) { g.inputManager.update(); g.step(1 / 60); }
  });

  if (desktop) await page.keyboard.up('KeyW');
  else await page.evaluate(() => window.__release());

  const afterMove = await page.evaluate(() => {
    const g = window.__GAME;
    return { x: g.player.position.x, z: g.player.position.z };
  });
  const moved = Math.hypot(afterMove.x - before.x, afterMove.z - before.z);
  check('movement input moves the player', moved > 0.3, `${moved.toFixed(2)} m`);

  // Look.
  if (desktop) {
    await page.evaluate(() => window.__GAME.player.look(220, 0));
  } else {
    await page.evaluate(() => {
      const c = window.__GAME.renderer.domElement;
      const mk = (type, px, py) => {
        const t = new Touch({ identifier: 7, target: c, clientX: px, clientY: py });
        c.dispatchEvent(new TouchEvent(type, {
          touches: type === 'touchend' ? [] : [t],
          changedTouches: [t], targetTouches: type === 'touchend' ? [] : [t],
          bubbles: true, cancelable: true,
        }));
      };
      mk('touchstart', 600, 200);
      for (let i = 1; i <= 8; i++) mk('touchmove', 600 + i * 14, 200);
      mk('touchend', 600 + 112, 200);
      // Touch look accumulates and is drained once per frame; at software
      // rasteriser speeds that frame may be a second away.
      window.__GAME.inputManager.update();
    });
  }
  await page.waitForTimeout(400);
  const afterLook = await page.evaluate(() => window.__GAME.player.yaw);
  check('look input turns the camera', Math.abs(afterLook - before.yaw) > 0.02,
    `yaw ${before.yaw.toFixed(3)} -> ${afterLook.toFixed(3)}`);

  // Fire.
  if (desktop) {
    await page.evaluate(() => { window.__GAME.input.fire = true; });
    await page.waitForTimeout(500);
    await page.evaluate(() => { window.__GAME.input.fire = false; });
  } else {
    const fire = page.locator('#btn-fire');
    if (await fire.count()) {
      await fire.dispatchEvent('touchstart');
      await page.waitForTimeout(600);
      await fire.dispatchEvent('touchend');
    }
  }
  await page.waitForTimeout(300);
  const afterFire = await page.evaluate(() => window.__GAME.weapon.ammo);
  check('fire control consumes ammunition', afterFire < before.ammo,
    `${before.ammo} -> ${afterFire}`);

  // Sustained frame rate over a couple of seconds of real play.
  const fps = await page.evaluate(() => new Promise((resolve) => {
    let frames = 0;
    const start = performance.now();
    const tick = () => {
      frames++;
      if (performance.now() - start < 2000) requestAnimationFrame(tick);
      else resolve(+(frames / ((performance.now() - start) / 1000)).toFixed(1));
    };
    requestAnimationFrame(tick);
  }));
  // Software rasterisation on a CI box says nothing about phone performance;
  // this only catches a pipeline that has stopped producing frames at all.
  check('render loop is alive', fps > 0.3, `${fps} fps (software rasteriser, not indicative)`);

  await page.screenshot({ path: path.join(SHOTS, `${label}-2-playing.png`) });

  const tier = await page.evaluate(() => window.__GAME?.quality?.tierName ?? 'unknown');
  console.log(`      quality tier: ${tier}`);

  const fatal = errors.filter((e) => !/favicon|404/i.test(e));
  check('no runtime errors', fatal.length === 0, fatal.slice(0, 2).join(' | '));
} catch (e) {
  check('completed without throwing', false, String(e).slice(0, 300));
  await page.screenshot({ path: path.join(SHOTS, `${label}-failure.png`) }).catch(() => {});
}

await browser.close();
server.close();

const failed = checks.filter((c) => !c.ok);
console.log(`\n${label}: ${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) exitCode = 1;
process.exit(exitCode);
