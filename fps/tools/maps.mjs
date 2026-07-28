// What is actually bound to the materials in the running scene?
//
// Four blind judges independently reported that every surface reads as a flat
// diffuse colour with no roughness, metalness or normal variation. The source
// says otherwise: textures.js authors albedo, ORM and normal maps for a dozen
// samplers. Exactly one of those can be true, and the question is settled by
// asking the live scene rather than by reading either one.
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
await page.goto(`http://127.0.0.1:${port}/index.html?shot=sunlit`, { timeout: 60000 });
await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 300000, polling: 500 });

const out = await page.evaluate(() => {
  const g = window.__GAME;
  const seen = new Map();
  const add = (scene, tag) => scene.traverse((o) => {
    if (!o.isMesh && !o.isInstancedMesh) return;
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
      if (!m || seen.has(m.uuid)) continue;
      seen.set(m.uuid, {
        scene: tag,
        name: m.name || m.type,
        map: !!m.map,
        normalMap: !!m.normalMap,
        roughnessMap: !!m.roughnessMap,
        metalnessMap: !!m.metalnessMap,
        aoMap: !!m.aoMap,
        roughness: typeof m.roughness === 'number' ? +m.roughness.toFixed(2) : null,
        metalness: typeof m.metalness === 'number' ? +m.metalness.toFixed(2) : null,
        // Repeat tells us whether one texel covers a centimetre or a metre.
        repeat: m.map ? [+m.map.repeat.x.toFixed(2), +m.map.repeat.y.toFixed(2)] : null,
        mapSize: m.map?.image ? [m.map.image.width, m.map.image.height] : null,
        normalScale: m.normalScale ? +m.normalScale.x.toFixed(2) : null,
      });
    }
  });
  add(g.scene, 'world');
  add(g.weapon.scene, 'viewmodel');
  return [...seen.values()];
});

const bare = out.filter((m) => !m.map);
const noNormal = out.filter((m) => m.map && !m.normalMap);
const noRough = out.filter((m) => m.map && !m.roughnessMap);

console.log(`materials in scene: ${out.length}`);
console.log(`  no albedo map at all : ${bare.length}`);
console.log(`  albedo but no normal : ${noNormal.length}`);
console.log(`  albedo but no rough  : ${noRough.length}`);
console.log('\n  scene      name                     map  nrm  rgh  mtl   rough  metal  repeat        texels');
for (const m of out) {
  console.log(`  ${m.scene.padEnd(10)} ${String(m.name).slice(0, 22).padEnd(24)} `
    + `${m.map ? ' Y ' : ' . '}  ${m.normalMap ? 'Y' : '.'}    ${m.roughnessMap ? 'Y' : '.'}    `
    + `${m.metalnessMap ? 'Y' : '.'}   ${String(m.roughness ?? '-').padStart(5)}  `
    + `${String(m.metalness ?? '-').padStart(5)}  ${String(m.repeat ?? '-').padEnd(12)}  `
    + `${m.mapSize ? m.mapSize.join('x') : '-'}`);
}

await browser.close();
server.close();
