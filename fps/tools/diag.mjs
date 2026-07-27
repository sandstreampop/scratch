// Pipeline bisection. Loads the game once, then drives window.__GAME to
// capture the same frame with different passes disabled, so a black or wrong
// frame can be attributed to a specific stage without a reload per variant.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'shots', 'diag');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png' };

const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f = path.join(ROOT, p === '/' ? 'index.html' : p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    res.writeHead(404); res.end('nf'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', (m) => console.log(`[${m.type()}]`, m.text().slice(0, 220)));
page.on('pageerror', (e) => console.log('PAGEERROR:', String(e).slice(0, 400)));

await page.goto(`http://127.0.0.1:${port}/index.html?shot=${process.argv[2] || 'hero'}`, { waitUntil: 'commit' });
await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 260000, polling: 500 });
console.log('ready');

// Scene statistics — cheap way to prove geometry actually exists and is lit.
const stats = await page.evaluate(() => {
  const g = window.__GAME;
  const cam = g.camera;
  let meshes = 0, tris = 0;
  g.scene.traverse((o) => { if (o.isMesh || o.isInstancedMesh) meshes++; });
  return {
    cameraPos: cam.position.toArray().map((v) => +v.toFixed(2)),
    cameraDir: cam.getWorldDirection(new (Object.getPrototypeOf(cam.position).constructor)()).toArray().map((v) => +v.toFixed(3)),
    sunDir: g.atmosphere.sunDirection.toArray().map((v) => +v.toFixed(3)),
    meshes,
    hasEnvironment: !!g.scene.environment,
    playerHealth: Math.round(g.player.health),
    playerY: +g.player.position.y.toFixed(2),
    groundY: +g.level.groundHeight(g.player.position.x, g.player.position.z).toFixed(2),
    enemies: g.director.enemies.length,
    drawCalls: g.renderer.info.render.calls,
    triangles: g.renderer.info.render.triangles,
    skyScale: g.atmosphere.sky.scale.x,
    fogDensity: g.scene.fog?.density,
    exposure: g.renderer.toneMappingExposure,
  };
});
console.log('STATS', JSON.stringify(stats, null, 2));

const variants = [
  ['00-raw-scene', () => {
    const g = window.__GAME;
    g.renderer.setRenderTarget(null);
    g.renderer.clear();
    g.renderer.render(g.scene, g.camera);
  }],
  ['01-no-post-with-weapon', () => {
    const g = window.__GAME;
    g.renderer.setRenderTarget(null);
    g.renderer.clear();
    g.renderer.render(g.scene, g.camera);
    g.renderer.autoClear = false;
    g.renderer.clearDepth();
    g.renderer.render(g.weapon.scene, g.weapon.camera);
    g.renderer.autoClear = true;
  }],
  ['02-composer-gtao-off', () => {
    const g = window.__GAME;
    g.post.gtao.enabled = false;
    g.post.shafts.enabled = true;
    g.post.bloom.enabled = true;
    g.post.grade.enabled = true;
    g.render(1 / 60);
  }],
  ['03-composer-gtao-on', () => {
    const g = window.__GAME;
    g.post.gtao.enabled = true;
    g.render(1 / 60);
  }],
  ['04-no-shafts', () => {
    const g = window.__GAME;
    g.post.shafts.enabled = false;
    g.render(1 / 60);
  }],
  ['05-no-grade', () => {
    const g = window.__GAME;
    g.post.shafts.enabled = true;
    g.post.grade.enabled = false;
    g.render(1 / 60);
  }],
  ['06-full', () => {
    const g = window.__GAME;
    g.post.grade.enabled = true;
    g.render(1 / 60);
  }],
];

for (const [name, fn] of variants) {
  try {
    await page.evaluate(fn);
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    // Mean luminance tells us "black vs not" without opening the file.
    const lum = await page.evaluate(() => {
      const c = window.__GAME.renderer.domElement;
      const t = document.createElement('canvas');
      t.width = 64; t.height = 36;
      const x = t.getContext('2d');
      x.drawImage(c, 0, 0, 64, 36);
      const d = x.getImageData(0, 0, 64, 36).data;
      let s = 0;
      for (let i = 0; i < d.length; i += 4) s += (d[i] + d[i + 1] + d[i + 2]) / 3;
      return +(s / (d.length / 4)).toFixed(1);
    });
    console.log(`${name}  meanLuma=${lum}`);
  } catch (e) {
    console.log(`${name}  FAILED ${String(e).slice(0, 200)}`);
  }
}

await browser.close();
server.close();
