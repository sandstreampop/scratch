import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = '/tmp/claude-0/-home-user-scratch/04050bce-8cd4-5b27-8bb2-a86253a2ff74/scratchpad/c';
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
const server = await serve();
const port = server.address().port;
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium', headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 300)));
await page.goto(`http://127.0.0.1:${port}/index.html?shot=${process.env.PRE||'ads'}`, { timeout: 60000 });
await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 240000, polling: 500 });

const audit = await page.evaluate(() => {
  const w = window.__GAME.weapon;
  const mats = new Map();
  let withNormal = 0, total = 0;
  w.scene.traverse((o) => {
    if (!o.isMesh && !o.isInstancedMesh) return;
    const m = o.material;
    if (!mats.has(m)) {
      mats.set(m, true); total++;
      if (m.normalMap) withNormal++;
    }
  });
  // world comparison
  let wTotal = 0, wNormal = 0;
  const seen = new Set();
  window.__GAME.scene.traverse((o) => {
    if (!o.isMesh && !o.isInstancedMesh) return;
    const arr = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of arr) { if (!m || seen.has(m)) continue; seen.add(m); wTotal++; if (m.normalMap) wNormal++; }
  });
  return { vmMaterials: total, vmWithNormalMap: withNormal, worldMaterials: wTotal, worldWithNormalMap: wNormal };
});
console.log(JSON.stringify(audit));

// hide the lens discs, re-render, capture
await page.evaluate(() => {
  const w = window.__GAME.weapon;
  window.__hidden = [];
  w.scene.traverse((o) => {
    if (o.isMesh && o.material && o.material.isMeshPhysicalMaterial && o.material.alphaMap) {
      o.visible = false; window.__hidden.push(o);
    }
  });
  window.__GAME.render(1 / 60);
});
await page.screenshot({ path: `${OUT}/${process.env.PRE||'ads'}_noglass.png` });

// also hide the whole optic + reticle so we can see the raw world behind it
await page.evaluate(() => {
  const w = window.__GAME.weapon;
  w.model.visible = false;
  window.__GAME.render(1 / 60);
});
await page.screenshot({ path: `${OUT}/${process.env.PRE||'ads'}_noweapon.png` });
console.log('done');
await browser.close();
server.close();
