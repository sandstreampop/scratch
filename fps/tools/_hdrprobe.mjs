import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = '/home/user/scratch/fps';
const OUT = '/tmp/claude-0/-home-user-scratch/04050bce-8cd4-5b27-8bb2-a86253a2ff74/scratchpad/probe';
fs.mkdirSync(OUT, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f = path.join(ROOT, p === '/' ? 'index.html' : p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium', headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage', '--hide-scrollbars'],
});

const preset = process.argv[2] || 'hero';
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', String(e).slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[' + m.type() + ']', m.text().slice(0, 240)); });
await page.goto(`http://127.0.0.1:${port}/index.html?shot=${preset}`, { waitUntil: 'commit' });
await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 300000, polling: 500 });

await page.evaluate(() => { window.__FORCE_FLASH = true; }).catch(()=>{});
const r = await page.evaluate(async () => {
  const THREE = await import('/vendor/three/three.module.js');
  const g = window.__GAME;
  const post = g.post;
  const out = { bufferType: post.bufferType === THREE.HalfFloatType ? 'half' : (post.bufferType === THREE.UnsignedByteType ? 'byte' : String(post.bufferType)), postDisabled: post.postDisabled };
  out.exposure = post.grade.uniforms.uExposure.value;
  out.contrast = post.grade.uniforms.uContrast.value;
  out.bloom = { strength: post.bloom.strength, radius: post.bloom.radius, threshold: post.bloom.threshold, smoothWidth: post.bloom.highPassUniforms?.smoothWidth?.value, enabled: post.bloom.enabled };

  const W = 1600, H = 900;
  if (location.search.includes('FORCEFLASH') || window.__FORCE_FLASH) {
    const w = g.weapon;
    w._flash = 1;
    w.flashLight.intensity = 26; w.flashBounce.intensity = 11;
    w.flashCone.material.opacity = 1; w.flashCone.visible = true; w.flashCone.scale.setScalar(0.7);
    for (let i = 0; i < w.flashMaterials.length; i++) {
      w.flashMaterials[i].opacity = Math.min(1, 1.15 - i * 0.22);
      w.flashSprites.children[i].scale.setScalar(0.50 + i * 0.16);
    }
    w.flashSprites.visible = true;
    out.forcedFlash = w.flashMaterials.map((m) => m.opacity);
  }
  // ---- pass prefix up to and including the viewmodel: the HDR frame bloom sees
  const all = [...post.composer.passes];
  const names = all.map((p) => p.constructor.name);
  out.passes = names;
  const vmIdx = names.indexOf('ViewmodelPass');
  const bloomIdx = names.indexOf('UnrealBloomPass');
  post.composer.passes = all.slice(0, bloomIdx); // everything before bloom
  post.composer.render(1 / 60);
  const readHalf = (target) => {
    const buf = new Uint16Array(W * H * 4);
    g.renderer.readRenderTargetPixels(target, 0, 0, W, H, buf);
    const f = new Float32Array(W * H * 3);
    for (let i = 0, j = 0; i < buf.length; i += 4, j += 3) {
      f[j] = THREE.DataUtils.fromHalfFloat(buf[i]);
      f[j + 1] = THREE.DataUtils.fromHalfFloat(buf[i + 1]);
      f[j + 2] = THREE.DataUtils.fromHalfFloat(buf[i + 2]);
    }
    return f;
  };
  const stats = (f) => {
    let mx = -1, mxi = 0, above085 = 0, above1 = 0, above2 = 0, sum = 0;
    const lu = new Float32Array(W * H);
    for (let p = 0; p < W * H; p++) {
      const l = 0.2126 * f[p * 3] + 0.7152 * f[p * 3 + 1] + 0.0722 * f[p * 3 + 2];
      lu[p] = l; sum += l;
      if (l > mx) { mx = l; mxi = p; }
      if (l > 0.85) above085++; if (l > 1) above1++; if (l > 2) above2++;
    }
    const srt = Float32Array.from(lu).sort();
    return { max: +mx.toFixed(3), maxAt: [mxi % W, (H - 1) - Math.floor(mxi / W)], maxRGB: [f[mxi*3], f[mxi*3+1], f[mxi*3+2]].map(v=>+v.toFixed(3)),
      mean: +(sum / (W * H)).toFixed(4), pxAbove085: above085, pxAbove1: above1, pxAbove2: above2,
      p999: +srt[Math.floor(0.999 * W * H)].toFixed(3), p9999: +srt[Math.floor(0.9999 * W * H)].toFixed(3) };
  };
  const bufA = post.composer.readBuffer, bufB = post.composer.writeBuffer;
  const fa = readHalf(bufA), fb = readHalf(bufB);
  const sa = stats(fa), sb = stats(fb);
  out.preBloom = sa.mean > sb.mean ? sa : sb;
  const f = sa.mean > sb.mean ? fa : fb;
  // coarse grid of max luma (screen orientation)
  const GX=20, GY=12; const grid=Array.from({length:GY},()=>new Array(GX).fill(0));
  const cnt=Array.from({length:GY},()=>new Array(GX).fill(0));
  for(let p2=0;p2<W*H;p2++){
    const sx=p2%W, sy=(H-1)-Math.floor(p2/W);
    const l=0.2126*f[p2*3]+0.7152*f[p2*3+1]+0.0722*f[p2*3+2];
    const gy=Math.floor(sy*GY/H), gx=Math.floor(sx*GX/W);
    if(l>grid[gy][gx]) grid[gy][gx]=l;
    if(l>0.85) cnt[gy][gx]++;
  }
  out.maxGrid = grid.map(r=>r.map(v=>+v.toFixed(2)));
  out.overThresholdGrid = cnt;
  out.sample = (sx,sy)=>0;
  const at=(sx,sy)=>{const p2=((H-1-sy)*W+sx); return [f[p2*3],f[p2*3+1],f[p2*3+2]].map(v=>+v.toFixed(3));};
  out.samples = {};
  const pts = JSON.parse(document.body.dataset.pts||'[]');
  for (const [nm,sx,sy] of pts) out.samples[nm]=at(sx,sy);
  post.composer.passes = all;
  return out;
});
fs.writeFileSync(path.join(OUT, preset+'.json'), JSON.stringify(r));
console.log(preset,'bufferType',r.bufferType,'exposure',r.exposure,'contrast',r.contrast,'bloomThreshold',r.bloom.threshold);
console.log('preBloom', JSON.stringify(r.preBloom));

// bloom on / off screenshots
for (const on of [true, false]) {
  await page.evaluate((v) => { const g = window.__GAME; g.post.bloom.enabled = v; g.post.composer.render(1/60); }, on);
  await page.screenshot({ path: path.join(OUT, `${preset}-bloom-${on ? 'on' : 'off'}.png`) });
}
await browser.close();
server.close();
