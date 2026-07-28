import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(ROOT, p === '/' ? 'index.html' : p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('no'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const preset = process.argv[2] || 'cross';
const pts = JSON.parse(process.argv[3] || '[[1100,420]]');
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage', '--hide-scrollbars'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', e => console.error('PAGEERROR', String(e).slice(0,300)));
await page.goto(`http://127.0.0.1:${port}/index.html?shot=${preset}`, { timeout: 60000 });
await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 300000, polling: 500 });
const out = await page.evaluate(async ({pts}) => {
  const THREE = await import('/vendor/three/three.module.js');
  const g = window.__GAME;
  const rc = new THREE.Raycaster();
  const targets = [];
  g.scene.traverse(o => { if (o.isMesh || o.isInstancedMesh) targets.push(o); });
  const res = [];
  // sample a texture at uv
  function sampleMap(tex, u, v) {
    if (!tex || !tex.image || !tex.image.data) return null;
    const { data, width, height } = tex.image;
    const rx = tex.repeat.x, ry = tex.repeat.y;
    let x = Math.floor(((u * rx) % 1 + 1) % 1 * width);
    let y = Math.floor(((v * ry) % 1 + 1) % 1 * height);
    const i = (y * width + x) * 4;
    return [data[i], data[i+1], data[i+2]];
  }
  for (const [px, py] of pts) {
    const ndc = new THREE.Vector2((px / 1600) * 2 - 1, -((py / 900) * 2 - 1));
    rc.setFromCamera(ndc, g.camera);
    const hits = rc.intersectObjects(targets, false);
    const h = hits.find(x => x.object.visible && x.distance > 0.5);
    if (!h) { res.push({ px, py, miss: true }); continue; }
    const m = Array.isArray(h.object.material) ? h.object.material[0] : h.object.material;
    const uv = h.uv || { x: 0, y: 0 };
    const texel = m.map ? sampleMap(m.map, uv.x, uv.y) : null;
    // stats over the whole albedo map (encoded bytes)
    let stat = null;
    if (m.map && m.map.image && m.map.image.data) {
      const d = m.map.image.data; let sr=0,sg=0,sb=0,n=0,mr=0,mg=0,mb=0;
      for (let i=0;i<d.length;i+=4){sr+=d[i];sg+=d[i+1];sb+=d[i+2];n++;
        if(d[i]>mr)mr=d[i]; if(d[i+1]>mg)mg=d[i+1]; if(d[i+2]>mb)mb=d[i+2];}
      stat = { meanEnc: [sr/n/255, sg/n/255, sb/n/255].map(v=>+v.toFixed(3)),
               maxEnc: [mr/255, mg/255, mb/255].map(v=>+v.toFixed(3)) };
    }
    res.push({ px, py, dist: +h.distance.toFixed(2),
      obj: h.object.name || h.object.type,
      geo: h.object.geometry.type,
      parent: h.object.parent?.name || h.object.parent?.type,
      worldPos: h.point.toArray().map(v=>+v.toFixed(2)),
      matColorLinear: m.color ? [m.color.r, m.color.g, m.color.b].map(v=>+v.toFixed(4)) : null,
      matColorHex: m.color ? '#'+m.color.getHexString(THREE.SRGBColorSpace) : null,
      uv: [+uv.x.toFixed(3), +uv.y.toFixed(3)],
      texelEnc: texel,
      mapStat: stat,
      roughness: m.roughness, metalness: m.metalness,
    });
  }
  return res;
}, { pts });
console.log(JSON.stringify(out, null, 1));
await browser.close(); server.close();
