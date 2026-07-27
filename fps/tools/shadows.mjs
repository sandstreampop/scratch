// Where does the light in a shadowed pixel actually come from?
//
// Half of a captured frame sits at luma 0, and an analytic estimate of the
// ambient alone puts shadowed sand near 150. One of the two is wrong, and
// arguing about it from the PRESET constants is how the last three lighting
// bugs survived. This drives the real game and turns contributions off one at
// a time, reading back the composed frame after each, so the term responsible
// is measured rather than inferred.
//
// Usage: node tools/shadows.mjs [preset]
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
      const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      const file = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); res.end('nope'); return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const preset = process.argv[2] || 'cross';
const server = await serve();
const port = server.address().port;
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--disable-dev-shm-usage', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
page.on('pageerror', (e) => console.error('PAGEERROR', String(e).slice(0, 200)));
await page.goto(`http://127.0.0.1:${port}/index.html?shot=${preset}`, { timeout: 60000 });
await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 300000, polling: 500 });

const report = await page.evaluate(async () => {
  const g = window.__GAME;
  const atmos = g.atmosphere;

  // Read the composed frame straight off the canvas. This is the pixel a
  // player sees, after post and the tone curve, which is the thing in dispute.
  const canvas = g.renderer.domElement;
  const off = document.createElement('canvas');
  off.width = 200; off.height = 112;
  const ctx = off.getContext('2d', { willReadFrequently: true });

  const frame = () => {
    g.render(1 / 60);
    ctx.drawImage(canvas, 0, 0, off.width, off.height);
    const d = ctx.getImageData(0, 0, off.width, off.height).data;
    let sum = 0, dark = 0, n = 0;
    // Lower two thirds only: the top is sky and would mask what the ground does.
    for (let y = (off.height / 3) | 0; y < off.height; y++) {
      for (let x = 0; x < off.width; x++) {
        const i = (y * off.width + x) * 4;
        const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        sum += l; n++; if (l < 6) dark++;
      }
    }
    return { meanLuma: +(sum / n).toFixed(1), crushed: +(100 * dark / n).toFixed(1) };
  };

  const out = { steps: [] };
  const push = (name, extra = {}) => out.steps.push({ name, ...frame(), ...extra });

  push('as shipped');

  // Each term off in turn. Whatever barely moves the number is not the term
  // holding those pixels up, and whatever moves it a lot is.
  const sunI = atmos.sun.intensity;
  atmos.sun.intensity = 0;
  push('sun off');
  atmos.sun.intensity = sunI;

  const hemiI = atmos.hemi.intensity;
  atmos.hemi.intensity = 0;
  push('hemisphere off');
  atmos.hemi.intensity = hemiI;

  const fillI = atmos.bounce.intensity;
  atmos.bounce.intensity = 0;
  push('fill off');
  atmos.bounce.intensity = fillI;

  const env = g.scene.environment;
  g.scene.environment = null;
  push('environment off');
  g.scene.environment = env;

  // Everything but the environment, to size the IBL on its own.
  atmos.sun.intensity = 0; atmos.hemi.intensity = 0; atmos.bounce.intensity = 0;
  push('environment only');
  atmos.sun.intensity = sunI; atmos.hemi.intensity = hemiI; atmos.bounce.intensity = fillI;

  // Shadow casting off: separates "no light reaches it" from "the shadow map
  // says it is occluded".
  g.renderer.shadowMap.enabled = false;
  push('shadows off');
  g.renderer.shadowMap.enabled = true;

  // The tone curve, isolated. If shadow detail exists in linear and dies here,
  // the grade is the culprit rather than the lighting.
  const grade = g.post.grade?.uniforms;
  if (grade) {
    const e = grade.uExposure.value;
    grade.uExposure.value = e * 4;
    push('exposure x4', { note: 'if this recovers detail, the light is there' });
    grade.uExposure.value = e;
  }

  out.settings = {
    exposure: grade ? grade.uExposure.value : null,
    sunIntensity: sunI,
    hemiIntensity: hemiI,
    fillIntensity: fillI,
    environmentIntensity: g.scene.environmentIntensity,
    tier: g.quality.tierName,
    bufferType: g.post.bufferType,
    postDisabled: g.post.postDisabled,
  };
  return out;
});

console.log(`preset: ${preset}`);
console.log(JSON.stringify(report.settings, null, 2));
console.log('\n  contribution                mean luma   crushed <6');
for (const s of report.steps) {
  console.log(`  ${s.name.padEnd(26)} ${String(s.meanLuma).padStart(7)}   ${String(s.crushed).padStart(7)}%`
    + (s.note ? `   ${s.note}` : ''));
}

await browser.close();
server.close();
