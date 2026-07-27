// Drives the real game and measures the lighting split, scene-referred.
// Usage: node tools/lightprobe.mjs [preset]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      const file = path.join(ROOT, p === '/' ? 'index.html' : p);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('no'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const PROBES = {
  sunlit: [
    [840, 620, 990, 660, 'sand LIT foreground'],
    [530, 620, 640, 660, 'sand SHADOW (tower leg)'],
    [300, 768, 460, 782, 'sand 0-15px under tire stack'],
    [300, 840, 460, 854, 'sand ~1m from tire stack'],
    [1180, 690, 1300, 720, 'concrete barrier top face'],
    [1420, 620, 1520, 660, 'sand LIT right'],
  ],
  detail: [
    [430, 500, 470, 515, 'sand at soldier feet'],
    [300, 560, 400, 590, 'sand open lit'],
    [520, 470, 640, 480, 'sand just below sandbag row'],
    [180, 620, 300, 660, 'sand in building shadow'],
  ],
};

const preset = process.argv[2] || 'sunlit';
const server = await serve();
const port = server.address().port;
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium', headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.error('PAGEERROR', String(e).slice(0, 300)));
await page.goto(`http://127.0.0.1:${port}/index.html?shot=${preset}`, { timeout: 60000 });
await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 300000, polling: 500 });

const out = await page.evaluate(async (probes) => {
  const THREE = await import('/vendor/three/three.module.js');
  const g = window.__GAME;
  const atmos = g.atmosphere;
  const post = g.post;
  const R = {};

  R.camera = { pos: g.camera.position.toArray().map((v) => +v.toFixed(2)), fov: g.camera.fov };
  const fwd = new THREE.Vector3(); g.camera.getWorldDirection(fwd);
  R.camera.forward = fwd.toArray().map((v) => +v.toFixed(3));
  R.sunDir = atmos.sunDirection.toArray().map((v) => +v.toFixed(4));
  R.sunElevDeg = +(Math.asin(atmos.sunDirection.y) * 180 / Math.PI).toFixed(2);
  const sc = atmos.sun.shadow.camera;
  R.shadow = {
    mapSize: atmos.sun.shadow.mapSize.toArray(),
    left: sc.left, right: sc.right, top: sc.top, bottom: sc.bottom, near: sc.near, far: sc.far,
    bias: atmos.sun.shadow.bias, normalBias: atmos.sun.shadow.normalBias,
    radius: atmos.sun.shadow.radius, blurSamples: atmos.sun.shadow.blurSamples,
    shadowMapType: g.renderer.shadowMap.type, enabled: g.renderer.shadowMap.enabled,
    lightPos: atmos.sun.position.toArray().map((v) => +v.toFixed(2)),
    targetPos: atmos.sun.target.position.toArray().map((v) => +v.toFixed(2)),
  };
  R.lights = {
    sunI: atmos.sun.intensity, hemiI: atmos.hemi.intensity, fillI: atmos.bounce.intensity,
    envIntensity: g.scene.environmentIntensity, envMeanRadiance: atmos.envMeanRadiance,
    envPeak: atmos.envPeak, iblFallback: !!atmos.iblFallback,
    fillPos: atmos.bounce.position.toArray().map((v) => +v.toFixed(1)),
  };
  R.gtaoEnabled = post.gtao.enabled;

  sc.updateMatrixWorld();
  R.enemies = [];
  for (const e of g.director.enemies) {
    let casters = 0, meshes = 0;
    e.group.traverse((o) => { if (o.isMesh) { meshes++; if (o.castShadow) casters++; } });
    const box = new THREE.Box3().setFromObject(e.group);
    const feet = new THREE.Vector3(box.min.x, box.min.y, box.min.z).applyMatrix4(sc.matrixWorldInverse);
    R.enemies.push({
      pos: e.group.position.toArray().map((v) => +v.toFixed(2)),
      distToCam: +e.group.position.distanceTo(g.camera.position).toFixed(1),
      meshes, casters, visible: e.group.visible,
      lightSpace: feet.toArray().map((v) => +v.toFixed(1)),
      insideXY: Math.abs(feet.x) <= sc.right && Math.abs(feet.y) <= sc.top,
      depthOK: (-feet.z) >= sc.near && (-feet.z) <= sc.far,
    });
  }

  const passes = post.composer.passes;
  const was = passes.map((p) => p.enabled);
  const prevRTS = post.composer.renderToScreen;
  post.composer.renderToScreen = false;
  for (const p of passes) p.enabled = false;
  post.renderPass.enabled = true;

  function grab() {
    post.composer.render(1 / 60);
    const t = post.composer.readBuffer;
    const half = post.bufferType === THREE.HalfFloatType;
    const arr = half ? new Uint16Array(t.width * t.height * 4) : new Uint8Array(t.width * t.height * 4);
    g.renderer.readRenderTargetPixels(t, 0, 0, t.width, t.height, arr);
    return { arr, half, w: t.width, h: t.height };
  }
  function sample(f, x0, y0, x1, y1) {
    let r = 0, gg = 0, b = 0, n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const yy = f.h - 1 - y;
      const i = (yy * f.w + x) * 4;
      const c = (k) => (f.half ? THREE.DataUtils.fromHalfFloat(f.arr[i + k]) : f.arr[i + k] / 255);
      r += c(0); gg += c(1); b += c(2); n++;
    }
    return [r / n, gg / n, b / n];
  }
  R.bufferType = post.bufferType === THREE.HalfFloatType ? 'half' : 'byte';

  const full = grab();
  const sunI = atmos.sun.intensity, hemiI = atmos.hemi.intensity, fillI = atmos.bounce.intensity, envI = g.scene.environmentIntensity;
  atmos.sun.intensity = 0;
  const noSun = grab();
  atmos.sun.intensity = sunI;
  atmos.hemi.intensity = 0; atmos.bounce.intensity = 0; g.scene.environmentIntensity = 0;
  const sunOnly = grab();
  atmos.hemi.intensity = 0; atmos.bounce.intensity = fillI; atmos.sun.intensity = 0;
  const fillOnly = grab();
  atmos.hemi.intensity = hemiI; atmos.bounce.intensity = 0;
  const hemiOnly = grab();
  atmos.hemi.intensity = 0; g.scene.environmentIntensity = envI;
  const envOnly = grab();
  atmos.hemi.intensity = hemiI; atmos.bounce.intensity = fillI; atmos.sun.intensity = sunI; g.scene.environmentIntensity = envI;

  const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  R.probes = probes.map((p) => {
    const f = sample(full, p[0], p[1], p[2], p[3]);
    const a = sample(noSun, p[0], p[1], p[2], p[3]);
    const s = sample(sunOnly, p[0], p[1], p[2], p[3]);
    const fi = sample(fillOnly, p[0], p[1], p[2], p[3]);
    const he = sample(hemiOnly, p[0], p[1], p[2], p[3]);
    const en = sample(envOnly, p[0], p[1], p[2], p[3]);
    const r4 = (v) => v.map((x) => +x.toFixed(4));
    return {
      label: p[4], full: r4(f), ambient: r4(a), sunOnly: r4(s), fillOnly: r4(fi), hemiOnly: r4(he), envOnly: r4(en),
      Yfull: +lum(f).toFixed(4), Yamb: +lum(a).toFixed(4), Ysun: +lum(s).toFixed(4),
      Yfill: +lum(fi).toFixed(4), Yhemi: +lum(he).toFixed(4), Yenv: +lum(en).toFixed(4),
    };
  });

  for (let i = 0; i < passes.length; i++) passes[i].enabled = was[i];
  post.composer.renderToScreen = prevRTS;
  return R;
}, PROBES[preset] || []);

console.log(JSON.stringify(out, null, 2));
await browser.close();
server.close();
