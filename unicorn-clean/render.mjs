// Renders index.html frame-by-frame to an MP4 (deterministic timeline).
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const FFMPEG = process.env.FFMPEG, FPS = +(process.env.FPS || 30), OUT = process.argv[2] || 'glimmer-tidies-up.mp4';
const only = process.env.STILLS; // e.g. "0,3,10,21,24" → PNG stills instead of video
const types = {'.html':'text/html','.jpg':'image/jpeg','.woff2':'font/woff2'};
const srv = http.createServer((q,r)=>{const f=path.join(process.cwd(),decodeURIComponent(q.url.split('?')[0])==='/'?'index.html':decodeURIComponent(q.url.split('?')[0]));
  fs.readFile(f,(e,d)=>{if(e){r.writeHead(404);r.end();return}r.writeHead(200,{'content-type':types[path.extname(f)]||'application/octet-stream'});r.end(d)})}).listen(0);
const port = srv.address().port;
const b = await chromium.launch(); const p = await b.newPage();
p.on('pageerror', e => console.error('PAGE ERROR', e));
await p.goto(`http://localhost:${port}/?render`); await p.waitForFunction(() => window.__ready);
const grab = t => p.evaluate(t => { window.__render(t); return document.getElementById('cv').toDataURL('image/png').split(',')[1]; }, t);
if (only) { for (const t of only.split(',')) fs.writeFileSync(`${process.env.SDIR}/still_${t}.png`, Buffer.from(await grab(+t), 'base64')); }
else {
  const ff = spawn(FFMPEG, ['-y','-f','image2pipe','-framerate',String(FPS),'-i','-','-c:v','libx264','-pix_fmt','yuv420p','-crf','20','-preset','medium','-movflags','+faststart',OUT], {stdio:['pipe','inherit','inherit']});
  const N = Math.round(26 * FPS);
  for (let i = 0; i <= N; i++) { const buf = Buffer.from(await grab(i / FPS), 'base64'); if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r)); }
  ff.stdin.end(); await new Promise(r => ff.on('close', r));
}
await b.close(); srv.close();
