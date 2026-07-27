// Reads real pixel values out of the render targets and sweeps exposure, so
// "the frame is dark" can be attributed to scene radiance vs. the grade.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'shots', 'values');
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

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', String(e).slice(0, 400)));

await page.goto(`http://127.0.0.1:${port}/index.html?shot=hero`, { waitUntil: 'commit' });
await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 260000, polling: 500 });

// Render the world into a fresh HDR target we own, then read it back. This is
// the actual scene radiance, before any post touches it.
const scene = await page.evaluate(async () => {
  const THREE = (await import('/vendor/three/three.module.js'));
  const g = window.__GAME;
  const rt = new THREE.WebGLRenderTarget(960, 540, {
    type: THREE.FloatType, colorSpace: THREE.LinearSRGBColorSpace,
  });
  g.renderer.setRenderTarget(rt);
  g.renderer.clear();
  g.renderer.render(g.scene, g.camera);
  const buf = new Float32Array(960 * 540 * 4);
  g.renderer.readRenderTargetPixels(rt, 0, 0, 960, 540, buf);
  g.renderer.setRenderTarget(null);

  // Sample rows: readRenderTargetPixels is bottom-up, so row 0 is the floor.
  const sample = (fx, fy) => {
    const x = Math.floor(fx * 959), y = Math.floor((1 - fy) * 539);
    const i = (y * 960 + x) * 4;
    return [buf[i], buf[i + 1], buf[i + 2]].map((v) => +v.toFixed(4));
  };
  let mn = Infinity, mx = -Infinity, sum = 0, nan = 0;
  for (let i = 0; i < buf.length; i += 4) {
    const l = 0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2];
    if (!Number.isFinite(l)) { nan++; continue; }
    mn = Math.min(mn, l); mx = Math.max(mx, l); sum += l;
  }
  rt.dispose();
  return {
    skyUpper: sample(0.5, 0.12),
    buildingFace: sample(0.5, 0.45),
    groundNear: sample(0.5, 0.88),
    groundMid: sample(0.35, 0.72),
    minLuma: +mn.toFixed(5),
    maxLuma: +mx.toFixed(3),
    meanLuma: +(sum / (buf.length / 4)).toFixed(4),
    nonFinite: nan,
  };
});
console.log('SCENE RADIANCE (linear):', JSON.stringify(scene, null, 2));

for (const e of [1, 2, 4, 8, 16]) {
  await page.evaluate((exp) => {
    const g = window.__GAME;
    g.post.exposure = exp;
    g.post.composer.render(1 / 60);
  }, e);
  await page.screenshot({ path: path.join(OUT, `exposure-${String(e).padStart(2, '0')}.png`) });
  console.log(`exposure ${e}  bytes=${fs.statSync(path.join(OUT, `exposure-${String(e).padStart(2, '0')}.png`)).size}`);
}

await browser.close();
server.close();
