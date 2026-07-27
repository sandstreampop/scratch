// Attribute scene radiance to individual light sources.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = '/home/user/scratch/fps';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png' };
const PRESET_NAME = process.argv[2] || 'sunlit';

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
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', String(e).slice(0, 400)));
await page.goto(`http://127.0.0.1:${port}/index.html?shot=${PRESET_NAME}`, { waitUntil: 'commit' });
await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 260000, polling: 500 });

const out = await page.evaluate(async () => {
  const THREE = await import('/vendor/three/three.module.js');
  const g = window.__GAME;
  const W = 800, H = 450;
  const rt = new THREE.WebGLRenderTarget(W, H, { type: THREE.FloatType, colorSpace: THREE.LinearSRGBColorSpace });
  const buf = new Float32Array(W * H * 4);

  const points = {
    skyHigh: [0.30, 0.12],
    groundNear: [0.35, 0.92],
    groundMid: [0.30, 0.72],
    groundFar: [0.42, 0.56],
    wallLeft: [0.06, 0.52],
    wallCenter: [0.33, 0.50],
    midFrame: [0.55, 0.60],
  };

  function grab() {
    g.renderer.setRenderTarget(rt);
    g.renderer.clear();
    g.renderer.render(g.scene, g.camera);
    g.renderer.readRenderTargetPixels(rt, 0, 0, W, H, buf);
    g.renderer.setRenderTarget(null);
    const res = {};
    for (const [k, [fx, fy]] of Object.entries(points)) {
      const x = Math.floor(fx * (W - 1)), y = Math.floor((1 - fy) * (H - 1));
      const i = (y * W + x) * 4;
      res[k] = [buf[i], buf[i + 1], buf[i + 2]].map((v) => +v.toFixed(4));
    }
    // whole-frame stats excluding sky rows (top 40%)
    let sum = 0, n = 0, below = 0;
    for (let y = Math.floor(H * 0.42); y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = ((H - 1 - y) * W + x) * 4;
        const l = 0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2];
        sum += l; n++;
        if (l < 0.002) below++;
      }
    }
    res._lowerFrameMeanRadiance = +(sum / n).toFixed(5);
    res._lowerFrameFracBelow0002 = +(below / n).toFixed(4);
    return res;
  }

  const atm = g.atmosphere;
  const results = {};
  results.all = grab();

  // sun only
  const hemiI = atm.hemi.intensity, bounceI = atm.bounce.intensity, env = g.scene.environment;
  atm.hemi.intensity = 0; atm.bounce.intensity = 0; g.scene.environment = null;
  results.sunOnly = grab();

  // hemi only
  atm.sun.intensity = 0; atm.hemi.intensity = hemiI;
  results.hemiOnly = grab();

  // bounce only
  atm.hemi.intensity = 0; atm.bounce.intensity = bounceI;
  results.bounceOnly = grab();

  // env only
  atm.bounce.intensity = 0; g.scene.environment = env;
  results.envOnly = grab();

  // restore
  atm.sun.intensity = 4.4; atm.hemi.intensity = hemiI; atm.bounce.intensity = bounceI;

  // env map irradiance readback: sample the PMREM source texture average
  const srcData = atm.envSource.image.data;
  let sr = 0, sg = 0, sb = 0, up = 0;
  const w = atm.envSource.image.width, h = atm.envSource.image.height;
  for (let y = 0; y < h; y++) {
    const elev = ((y + 0.5) / h - 0.5) * Math.PI;
    const sy = Math.sin(elev);
    if (sy <= 0) continue;
    const wgt = sy * Math.cos(elev); // cosine-weighted for an up normal
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      sr += srcData[i] * wgt; sg += srcData[i + 1] * wgt; sb += srcData[i + 2] * wgt; up += wgt;
    }
  }
  const envAvgUp = [sr / up, sg / up, sb / up].map((v) => +v.toFixed(4));

  return {
    results,
    envAvgUpRadiance: envAvgUp,
    envIntensity: g.scene.environmentIntensity,
    envIsSet: !!g.scene.environment,
    bufferType: g.post.bufferType === THREE.HalfFloatType ? 'half' : 'byte',
    exposure: g.post.exposure,
    sunIntensity: atm.sun.intensity,
    sunColor: atm.sun.color.getHexString(),
  };
});

console.log(JSON.stringify(out, null, 2));
await browser.close();
server.close();
