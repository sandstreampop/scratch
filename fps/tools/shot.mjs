// Headless screenshot harness for the FPS. Serves the project dir, loads the
// game in demo mode, waits for deterministic settle, captures PNGs.
//
// Usage: node tools/shot.mjs [preset ...]        (default: all presets)
//        node tools/shot.mjs smoke               (fast load + console error check)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS_DIR = path.join(ROOT, 'shots');
const PRESETS = ['hero', 'combat', 'ads', 'detail'];

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json',
};

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      let file = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); res.end('not found'); return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function main() {
  const args = process.argv.slice(2);
  const smoke = args.includes('smoke');
  const presets = smoke ? ['hero'] : (args.length ? args : PRESETS);
  fs.mkdirSync(SHOTS_DIR, { recursive: true });

  const server = await serve();
  const port = server.address().port;
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    headless: true,
    args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
           '--disable-dev-shm-usage', '--hide-scrollbars'],
  });

  const results = [];
  for (const preset of presets) {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 500)); });
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 500)));
    const t0 = Date.now();
    try {
      await page.goto(`http://127.0.0.1:${port}/index.html?shot=${preset}`, { timeout: 60000 });
      await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 240000, polling: 500 });
      const out = path.join(SHOTS_DIR, `${preset}.png`);
      if (!smoke) await page.screenshot({ path: out });
      results.push({ preset, ok: true, ms: Date.now() - t0, path: smoke ? null : out, errors });
    } catch (e) {
      results.push({ preset, ok: false, ms: Date.now() - t0, error: String(e).slice(0, 300), errors });
    }
    await page.close();
  }

  await browser.close();
  server.close();
  console.log(JSON.stringify(results, null, 2));
  if (results.some((r) => !r.ok || r.errors.length)) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
