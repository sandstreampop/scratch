// Key-to-fill ratio, measured in scene-linear light.
//
// "The frame reads flat" is a judgement; "full sun is 1.2 stops above its own
// cast shadow when a clear-sky dawn is 3 to 4" is a number you can tune
// against. Getting that number off a captured PNG means inverting the grade
// and the ACES curve, which is guesswork with a clamp in it. This avoids the
// inversion entirely: it forward-renders with the post chain switched off, so
// the only transform between scene-linear radiance and the framebuffer is the
// sRGB encode, which inverts exactly.
//
// The sun is then switched off and the same pixels are read again. The two
// readings are the key-plus-fill and the fill alone, on identical geometry
// under identical view, so their difference is the contribution of the sun and
// the ratio is the lighting ratio - no assumption about which pixels happen to
// be in shadow.
//
// Usage: node tools/ratio.mjs [preset]
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

const preset = process.argv[2] || 'detail';
const server = await serve();
const port = server.address().port;
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--disable-dev-shm-usage', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
page.on('pageerror', (e) => console.error('PAGEERROR', String(e).slice(0, 300)));
await page.goto(`http://127.0.0.1:${port}/index.html?shot=${preset}`, { timeout: 60000 });
await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 300000, polling: 500 });

const out = await page.evaluate(async () => {
  const g = window.__GAME;
  const atmos = g.atmosphere;

  // Forward render, no composer. renderer.outputColorSpace is sRGB, so the
  // framebuffer holds sRGB(scene_linear) and nothing else - no exposure, no
  // tone curve, no grade, no clamp beyond the buffer's own.
  const canvas = g.renderer.domElement;
  const off = document.createElement('canvas');
  off.width = canvas.width; off.height = canvas.height;
  const ctx = off.getContext('2d', { willReadFrequently: true });

  const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

  // A band across the lower third: ground, where cast shadows fall.
  const band = () => {
    g.renderer.setRenderTarget(null);
    g.renderer.render(g.scene, g.camera);
    ctx.drawImage(canvas, 0, 0);
    const y0 = Math.floor(off.height * 0.62), y1 = Math.floor(off.height * 0.92);
    const d = ctx.getImageData(0, y0, off.width, y1 - y0).data;
    const vals = [];
    for (let i = 0; i < d.length; i += 4) {
      const l = 0.2126 * toLinear(d[i] / 255)
        + 0.7152 * toLinear(d[i + 1] / 255)
        + 0.0722 * toLinear(d[i + 2] / 255);
      vals.push(l);
    }
    vals.sort((a, b) => a - b);
    const q = (p) => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))];
    return { p10: q(0.10), p50: q(0.50), p90: q(0.90), mean: vals.reduce((a, b) => a + b, 0) / vals.length };
  };

  const full = band();

  const sunI = atmos.sun.intensity;
  atmos.sun.intensity = 0;
  const fill = band();
  atmos.sun.intensity = sunI;

  const hemiI = atmos.hemi.intensity;
  const fillI = atmos.bounce.intensity;
  const env = g.scene.environment;

  atmos.hemi.intensity = 0;
  const noHemi = band();
  atmos.hemi.intensity = hemiI;

  atmos.bounce.intensity = 0;
  const noBounce = band();
  atmos.bounce.intensity = fillI;

  g.scene.environment = null;
  const noEnv = band();
  g.scene.environment = env;

  return {
    full, fill, noHemi, noBounce, noEnv,
    settings: {
      sunIntensity: sunI, hemiIntensity: hemiI, fillIntensity: fillI,
      environmentIntensity: g.scene.environmentIntensity,
      bounceY: +atmos.bounce.position.y.toFixed(1),
    },
  };
});

const stops = (a, b) => (b > 1e-9 ? (Math.log2(a / b)).toFixed(2) : 'inf');
const f = (v) => v.toFixed(5);

console.log(`preset: ${preset}   (scene-linear, ground band, post chain off)`);
console.log(JSON.stringify(out.settings, null, 2));
console.log(`
                       p10       p50       p90      mean
  everything on     ${f(out.full.p10)}  ${f(out.full.p50)}  ${f(out.full.p90)}  ${f(out.full.mean)}
  sun off (fill)    ${f(out.fill.p10)}  ${f(out.fill.p50)}  ${f(out.fill.p90)}  ${f(out.fill.mean)}
  hemisphere off    ${f(out.noHemi.p10)}  ${f(out.noHemi.p50)}  ${f(out.noHemi.p90)}  ${f(out.noHemi.mean)}
  fill light off    ${f(out.noBounce.p10)}  ${f(out.noBounce.p50)}  ${f(out.noBounce.p90)}  ${f(out.noBounce.mean)}
  environment off   ${f(out.noEnv.p10)}  ${f(out.noEnv.p50)}  ${f(out.noEnv.p90)}  ${f(out.noEnv.mean)}

  key : fill        ${stops(out.full.p90, out.fill.p90)} stops at p90, `
  + `${stops(out.full.p50, out.fill.p50)} at p50
  a clear-sky dawn exterior wants 3 to 4.`);

await browser.close();
server.close();
