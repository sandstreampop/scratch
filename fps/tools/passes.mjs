// Renders every prefix of the composer's pass chain and captures each one,
// so the exact pass that breaks the image is identifiable rather than guessed.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'shots', 'passes');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png' };

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

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', String(e).slice(0, 400)));
page.on('console', (m) => { if (m.type() === 'error') console.log('[err]', m.text().slice(0, 220)); });

await page.goto(`http://127.0.0.1:${port}/index.html?shot=${process.argv[2] || 'hero'}`, { waitUntil: 'commit' });
await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 260000, polling: 500 });

const names = await page.evaluate(() => {
  window.__ALL_PASSES = [...window.__GAME.post.composer.passes];
  return window.__ALL_PASSES.map((p) => p.constructor.name);
});
console.log('PASSES:', names.join(' -> '));

for (let n = 1; n <= names.length; n++) {
  await page.evaluate((count) => {
    const g = window.__GAME;
    g.post.composer.passes = window.__ALL_PASSES.slice(0, count);
    g.post.composer.render(1 / 60);
  }, n);
  const label = `${String(n).padStart(2, '0')}-${names[n - 1]}`;
  await page.screenshot({ path: path.join(OUT, `${label}.png`) });
  const size = fs.statSync(path.join(OUT, `${label}.png`)).size;
  console.log(`${label}  bytes=${size}`);
}

await browser.close();
server.close();
