// Binary-searches the scene graph for the objects that render non-finite
// pixels, then reports their geometry/material makeup.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript' };
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

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium', headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 320, height: 180 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', String(e).slice(0, 300)));
await page.goto(`http://127.0.0.1:${port}/index.html?shot=hero`, { waitUntil: 'commit' });
await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 260000, polling: 500 });

await page.evaluate(async () => {
  const THREE = await import('/vendor/three/three.module.js');
  const g = window.__GAME;
  const W = 320, H = 180;
  const rt = new THREE.WebGLRenderTarget(W, H, { type: THREE.FloatType, colorSpace: THREE.LinearSRGBColorSpace });
  const buf = new Float32Array(W * H * 4);

  window.__objs = [];
  g.scene.traverse((o) => {
    if (o.isMesh || o.isInstancedMesh || o.isPoints) window.__objs.push(o);
  });

  window.__measureWith = (visibleIdx) => {
    const set = new Set(visibleIdx);
    window.__objs.forEach((o, i) => { o.visible = set.has(i); });
    g.renderer.setRenderTarget(rt);
    g.renderer.clear();
    g.renderer.render(g.scene, g.camera);
    g.renderer.readRenderTargetPixels(rt, 0, 0, W, H, buf);
    g.renderer.setRenderTarget(null);
    let bad = 0;
    for (let i = 0; i < buf.length; i += 4) {
      if (!Number.isFinite(buf[i]) || !Number.isFinite(buf[i + 1]) || !Number.isFinite(buf[i + 2])) bad++;
    }
    return bad;
  };
  window.__describe = (i) => {
    const o = window.__objs[i];
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    const g2 = o.geometry;
    return {
      index: i,
      name: o.name || '(unnamed)',
      type: o.type,
      geometry: g2?.type,
      hasUV: !!g2?.attributes?.uv,
      hasNormal: !!g2?.attributes?.normal,
      material: m?.type,
      normalMap: !!m?.normalMap,
      aoMap: !!m?.aoMap,
      roughnessMap: !!m?.roughnessMap,
      metalness: m?.metalness,
      roughness: m?.roughness,
      transmission: m?.transmission,
    };
  };
  return window.__objs.length;
});

const count = await page.evaluate(() => window.__objs.length);
const measure = (idx) => page.evaluate((a) => window.__measureWith(a), idx);

const all = Array.from({ length: count }, (_, i) => i);
console.log('objects:', count, 'all-visible bad =', await measure(all));
console.log('none-visible bad =', await measure([]));

// Find every individual object that is bad on its own (rendered alone).
const bad = [];
for (let i = 0; i < count; i++) {
  const n = await measure([i]);
  if (n > 0) bad.push({ i, n });
}
console.log(`\n${bad.length} object(s) emit NaN when rendered alone:`);
for (const b of bad.slice(0, 25)) {
  const d = await page.evaluate((i) => window.__describe(i), b.i);
  console.log(`  bad=${String(b.n).padStart(6)}  ${JSON.stringify(d)}`);
}

await browser.close();
server.close();
