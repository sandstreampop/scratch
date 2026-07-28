// Why does the occlusion buffer come back white?
//
// GTAO is off because OUTPUT.Denoise measured 1.0 everywhere at every radius
// tried. That is a symptom with at least two candidate causes — a horizon
// search that finds no occluders because the geometry really is unoccluded, or
// one that cannot see them because the depth buffer has no precision left at
// the distances involved. A 0.10/700 frustum spends almost all of its depth
// range in the first few metres of a 700 m scene.
//
// Sweeping the near plane separates them. If the buffer stays white as the
// near plane climbs, the search is wrong. If occlusion appears, the frustum
// was the problem and the camera is the thing to change.
//
// Usage: node tools/ao.mjs [preset]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.png': 'image/png', '.json': 'application/json',
};

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      const file = path.join(ROOT, p === '/' ? 'index.html' : p);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); res.end('nope'); return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const preset = process.argv[2] || 'sunlit';
const server = await serve();
const port = server.address().port;
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.on('pageerror', (e) => console.error('PAGEERROR', String(e).slice(0, 200)));
await page.goto(`http://127.0.0.1:${port}/index.html?shot=${preset}`, { timeout: 60000 });
await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 300000, polling: 500 });

const out = await page.evaluate(async () => {
  const g = window.__GAME;
  const gtao = g.post.gtao;
  const cam = g.camera;

  const canvas = g.renderer.domElement;
  const off = document.createElement('canvas');
  off.width = 160; off.height = 90;
  const ctx = off.getContext('2d', { willReadFrequently: true });

  // Denoise is the occlusion factor alone: 1 is unoccluded, 0 fully occluded.
  const OUT = gtao.constructor.OUTPUT;
  const prevOutput = gtao.output;
  const prevEnabled = gtao.enabled;
  gtao.enabled = true;
  gtao.output = OUT.Denoise;

  const sample = () => {
    g.render(1 / 60);
    ctx.drawImage(canvas, 0, 0, off.width, off.height);
    const d = ctx.getImageData(0, 0, off.width, off.height).data;
    let sum = 0, min = 255, occluded = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const v = d[i];
      sum += v; n++;
      if (v < min) min = v;
      if (v < 245) occluded++;
    }
    return { mean: +(sum / n).toFixed(1), min, occludedPct: +(100 * occluded / n).toFixed(1) };
  };

  const rows = [];
  const nearWas = cam.near, farWas = cam.far;
  rows.push({ diag: true,
    postDisabled: g.post.postDisabled,
    gtaoInChain: g.post.composer.passes.indexOf(gtao),
    passes: g.post.composer.passes.length,
    outputEnum: JSON.stringify(OUT),
  });

  for (const [near, far, ssr, radius] of [
    [0.10, 700, false, 0.6],
    [0.10, 700, true, 0.6],
    [0.25, 700, false, 0.6],
    [0.50, 700, false, 0.6],
    [1.00, 700, false, 0.6],
    [0.25, 400, false, 0.6],
    [0.25, 400, true, 0.6],
    [0.25, 400, false, 1.5],
  ]) {
    cam.near = near; cam.far = far; cam.updateProjectionMatrix();
    gtao.updateGtaoMaterial({
      radius, distanceExponent: 1.0, thickness: 1.0, scale: 1.1,
      samples: 16, distanceFallOff: 1.0, screenSpaceRadius: ssr,
    });
    rows.push({ near, far, screenSpaceRadius: ssr, radius, ...sample() });
  }

  cam.near = nearWas; cam.far = farWas; cam.updateProjectionMatrix();
  gtao.output = prevOutput;
  gtao.enabled = prevEnabled;
  return rows;
});

const diag = out.find((r) => r.diag);
console.log('diagnostics: ' + JSON.stringify(diag));
console.log('\nocclusion buffer (255 = nothing occluded anywhere)\n');
console.log('  near   far   ssr    radius   mean   min   pixels occluded');
for (const r of out.filter((x) => !x.diag)) {
  console.log(`  ${String(r.near).padEnd(6)} ${String(r.far).padEnd(5)} `
    + `${String(r.screenSpaceRadius).padEnd(6)} ${String(r.radius).padEnd(8)} `
    + `${String(r.mean).padStart(5)}  ${String(r.min).padStart(4)}   ${r.occludedPct}%`);
}

await browser.close();
server.close();
