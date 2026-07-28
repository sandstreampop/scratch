// Is the post chain actually running in the frames we capture?
//
// tools/ao.mjs reported post.postDisabled true at 640x360, which would mean
// every screenshot reviewed so far had no bloom, no sun shafts, no tone curve
// and no antialiasing in it. That contradicts the fact that changing
// PRESET.exposure visibly moved the captures. One of those is wrong and it
// matters a great deal which, so this asks at the resolution the screenshot
// harness actually uses.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };

const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(ROOT, p === '/' ? 'index.html' : p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('nope'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--disable-dev-shm-usage', '--hide-scrollbars'],
});

for (const [w, h, label] of [[1600, 900, 'screenshot harness'], [844, 390, 'iPhone landscape'], [640, 360, 'ao probe']]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const notes = [];
  page.on('console', (m) => { const t = m.text(); if (/post|degrad|fallback|composit/i.test(t)) notes.push(t.slice(0, 160)); });
  page.on('pageerror', (e) => notes.push(`ERR ${String(e).slice(0, 120)}`));
  await page.goto(`http://127.0.0.1:${port}/index.html?shot=sunlit`, { timeout: 60000 });
  await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 300000, polling: 500 });
  const s = await page.evaluate(() => {
    const p = window.__GAME.post;
    return {
      postDisabled: p.postDisabled,
      bufferType: p.bufferType === 1016 ? 'HalfFloat' : p.bufferType === 1009 ? 'UnsignedByte' : p.bufferType,
      msaaSamples: p.msaaSamples,
      bloom: p.bloom?.enabled,
      shafts: p.shafts?.enabled,
      smaa: p.smaa?.enabled,
      gtao: p.gtao?.enabled,
      exposure: p.grade?.uniforms?.uExposure?.value,
    };
  });
  console.log(`${label} (${w}x${h}): ${JSON.stringify(s)}`);
  if (notes.length) console.log(`   console: ${notes.slice(0, 4).join(' | ')}`);
  await page.close();
}

await browser.close();
server.close();
