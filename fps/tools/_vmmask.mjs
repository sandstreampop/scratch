// Renders the viewmodel silhouette alone, to measure its screen footprint and
// triangle count. node tools/_vmmask.mjs <preset>
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };

function serve() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      const file = path.join(ROOT, p === '/' ? 'index.html' : p);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

const preset = process.argv[2] || 'sunlit';
const server = await serve();
const port = server.address().port;
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium', headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 300)));
await page.goto(`http://127.0.0.1:${port}/index.html?shot=${preset}`, { timeout: 60000 });
await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 240000, polling: 500 });

const out = await page.evaluate(async () => {
  const THREE = await import('/vendor/three/three.module.js');
  const g = window.__GAME;
  const w = g.weapon;
  // stats
  let tris = 0, verts = 0, meshes = 0, draws = 0;
  const mats = new Set();
  w.scene.traverse((o) => {
    if (!o.isMesh && !o.isInstancedMesh) return;
    meshes++;
    const n = o.isInstancedMesh ? o.count : 1;
    draws += 1;
    const gm = o.geometry;
    const idx = gm.index ? gm.index.count : gm.attributes.position.count;
    tris += (idx / 3) * n;
    verts += gm.attributes.position.count * n;
    if (o.material) mats.add(o.material);
  });
  // silhouette render
  const r = g.renderer;
  const prevTarget = r.getRenderTarget();
  const white = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const prevBg = w.scene.background;
  const prevOv = w.scene.overrideMaterial;
  w.scene.background = new THREE.Color(0x000000);
  w.scene.overrideMaterial = white;
  const rt = new THREE.WebGLRenderTarget(1600, 900);
  r.setRenderTarget(rt);
  r.setClearColor(0x000000, 1);
  r.clear(true, true, true);
  r.render(w.scene, w.camera);
  const buf = new Uint8Array(1600 * 900 * 4);
  r.readRenderTargetPixels(rt, 0, 0, 1600, 900, buf);
  r.setRenderTarget(prevTarget);
  w.scene.background = prevBg;
  w.scene.overrideMaterial = prevOv;
  window.__MASK = Array.from(buf.filter((_, i) => i % 4 === 0));
  let lit = 0, minx = 1e9, maxx = -1, miny = 1e9, maxy = -1;
  const rowsBottom = new Array(900).fill(0);
  for (let y = 0; y < 900; y++) for (let x = 0; x < 1600; x++) {
    const i = (y * 1600 + x) * 4;
    if (buf[i] > 20) {
      lit++; rowsBottom[y]++;
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
    }
  }
  // note: readRenderTargetPixels is bottom-up
  rt.dispose(); white.dispose();
  // per-mesh breakdown
  const parts = [];
  w.scene.traverse((o) => {
    if (!o.isMesh && !o.isInstancedMesh) return;
    const gm = o.geometry;
    const idx = gm.index ? gm.index.count : gm.attributes.position.count;
    const n = o.isInstancedMesh ? o.count : 1;
    gm.computeBoundingBox();
    const bb = gm.boundingBox;
    const sz = [bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z];
    parts.push({ t: gm.type, tris: (idx / 3) * n, mm: sz.map((v) => +(v * 1000).toFixed(1)) });
  });
  parts.sort((a, b) => b.tris - a.tris);
  const tiny = parts.filter((p) => Math.max(...p.mm) < 5);
  return {
    top: parts.slice(0, 8),
    tinyCount: tiny.length, tinyTris: tiny.reduce((s, p) => s + p.tris, 0),
    tris, verts, meshes, draws, materials: mats.size,
    coverage: lit / (1600 * 900),
    bboxGL: { minx, maxx, minyFromBottom: miny, maxyFromBottom: maxy },
    fov: w.camera.fov,
    modelPos: w.model.position.toArray(),
    modelRot: [w.model.rotation.x, w.model.rotation.y, w.model.rotation.z],
  };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
server.close();
