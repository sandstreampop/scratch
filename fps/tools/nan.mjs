// Isolates the source of non-finite pixels by disabling one material feature
// at a time and re-measuring, all within a single page load.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', String(e).slice(0, 300)));

await page.goto(`http://127.0.0.1:${port}/index.html?shot=hero`, { waitUntil: 'commit' });
await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 260000, polling: 500 });

await page.evaluate(async () => {
  const THREE = await import('/vendor/three/three.module.js');
  const g = window.__GAME;
  const W = 480, H = 270;
  const rt = new THREE.WebGLRenderTarget(W, H, {
    type: THREE.FloatType, colorSpace: THREE.LinearSRGBColorSpace,
  });
  const buf = new Float32Array(W * H * 4);

  window.__measure = () => {
    g.renderer.setRenderTarget(rt);
    g.renderer.clear();
    g.renderer.render(g.scene, g.camera);
    g.renderer.readRenderTargetPixels(rt, 0, 0, W, H, buf);
    g.renderer.setRenderTarget(null);
    let bad = 0;
    for (let i = 0; i < buf.length; i += 4) {
      if (!Number.isFinite(buf[i]) || !Number.isFinite(buf[i + 1]) || !Number.isFinite(buf[i + 2])) bad++;
    }
    return { bad, total: W * H, pct: +(100 * bad / (W * H)).toFixed(1) };
  };

  // Collect every distinct material in the world scene.
  window.__mats = new Set();
  g.scene.traverse((o) => {
    if (!o.material) return;
    (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => window.__mats.add(m));
  });
  window.__mats = [...window.__mats];
});

const run = async (label, fn) => {
  const r = await page.evaluate(fn);
  console.log(`${label.padEnd(34)} nonFinite=${r.pct}%  (${r.bad}/${r.total})`);
};

await run('baseline', () => window.__measure());

// Is the environment map itself poisoned?
const env = await page.evaluate(() => {
  const g = window.__GAME;
  const t = g.atmosphere.envTarget;
  const w = t.width, h = t.height;
  const buf = new Float32Array(w * h * 4);
  try { g.renderer.readRenderTargetPixels(t, 0, 0, w, h, buf); }
  catch (e) { return { error: String(e).slice(0, 120) }; }
  let bad = 0, mx = -Infinity;
  for (let i = 0; i < buf.length; i += 4) {
    for (let k = 0; k < 3; k++) {
      const v = buf[i + k];
      if (!Number.isFinite(v)) { bad++; break; }
      if (v > mx) mx = v;
    }
  }
  return { w, h, texels: w * h, nonFinite: bad, pct: +(100 * bad / (w * h)).toFixed(2), max: +mx.toFixed(2) };
});
console.log('PMREM env target:', JSON.stringify(env));

await run('normal mips off', () => {
  const THREE_LinearFilter = 1006;
  window.__mats.forEach((m) => {
    if (m.normalMap) { m.normalMap.minFilter = THREE_LinearFilter; m.normalMap.needsUpdate = true; }
  });
  return window.__measure();
});

await run('normal mips back on', () => {
  const LinearMipmapLinear = 1008;
  window.__mats.forEach((m) => {
    if (m.normalMap) { m.normalMap.minFilter = LinearMipmapLinear; m.normalMap.needsUpdate = true; }
  });
  return window.__measure();
});

await run('anisotropy 1', () => {
  window.__mats.forEach((m) => {
    for (const k of ['map', 'normalMap', 'aoMap']) {
      if (m[k]) { m[k]._aniso = m[k].anisotropy; m[k].anisotropy = 1; m[k].needsUpdate = true; }
    }
  });
  return window.__measure();
});

await run('anisotropy restored', () => {
  window.__mats.forEach((m) => {
    for (const k of ['map', 'normalMap', 'aoMap']) {
      if (m[k] && m[k]._aniso) { m[k].anisotropy = m[k]._aniso; m[k].needsUpdate = true; }
    }
  });
  return window.__measure();
});

await run('normalScale = 0', () => {
  window.__mats.forEach((m) => { if (m.normalScale) m.normalScale.set(0, 0); });
  return window.__measure();
});

await run('normalScale = 1', () => {
  window.__mats.forEach((m) => { if (m.normalScale) m.normalScale.set(1, 1); });
  return window.__measure();
});

await run('envMapIntensity 0', () => {
  window.__mats.forEach((m) => { if (m.envMapIntensity !== undefined) m.envMapIntensity = 0; });
  return window.__measure();
});

await run('envMapIntensity 1', () => {
  window.__mats.forEach((m) => { if (m.envMapIntensity !== undefined) m.envMapIntensity = 1; });
  return window.__measure();
});

// Which objects are producing the bad pixels?
const culprits = await page.evaluate(() => {
  const g = window.__GAME;
  const hidden = [];
  const groups = [];
  g.scene.traverse((o) => {
    if (o.isMesh || o.isInstancedMesh || o.isPoints) groups.push(o);
  });
  return groups.slice(0, 0).length + hidden.length;
});
void culprits;

await browser.close();
server.close();
