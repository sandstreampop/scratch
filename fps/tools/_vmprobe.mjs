import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = '/tmp/claude-0/-home-user-scratch/04050bce-8cd4-5b27-8bb2-a86253a2ff74/scratchpad/c';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
function serve() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      const file = path.join(ROOT, p === '/' ? 'index.html' : p);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}
const preset = process.argv[2] || 'sunlit';
const server = await serve();
const port = server.address().port;
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium', headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 300)));
await page.goto(`http://127.0.0.1:${port}/index.html?shot=${preset}`, { timeout: 60000 });
await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 240000, polling: 500 });

const info = await page.evaluate(async () => {
  const THREE = await import('/vendor/three/three.module.js');
  const g = window.__GAME, w = g.weapon;

  const lights = (scene) => {
    const out = [];
    scene.traverse((o) => {
      if (!o.isLight) return;
      out.push({ type: o.type, intensity: o.intensity, color: '#' + o.color.getHexString(),
        gc: o.groundColor ? '#' + o.groundColor.getHexString() : null,
        pos: o.position ? o.position.toArray().map((v) => +v.toFixed(3)) : null });
    });
    return out;
  };

  // identical matte probe in both scenes, both facing the camera
  const mat = new THREE.MeshStandardMaterial({ color: 0x808080, roughness: 1, metalness: 0 });
  const geo = new THREE.SphereGeometry(1, 32, 24);

  const vmProbe = new THREE.Mesh(geo, mat);
  vmProbe.scale.setScalar(0.030);
  vmProbe.position.set(-0.13, 0.06, -0.40);   // upper-left of view, clear of the weapon
  w.scene.add(vmProbe);

  const worldProbe = new THREE.Mesh(geo, mat);
  worldProbe.scale.setScalar(0.20);
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(g.camera.quaternion);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(g.camera.quaternion);
  const rt = new THREE.Vector3(1, 0, 0).applyQuaternion(g.camera.quaternion);
  worldProbe.position.copy(g.camera.position)
    .addScaledVector(fwd, 2.7).addScaledVector(up, 0.40).addScaledVector(rt, -0.88);
  g.scene.add(worldProbe);

  g.render(1 / 60);

  // project both probe centres to screen
  const project = (obj, cam) => {
    const v = obj.getWorldPosition(new THREE.Vector3()).project(cam);
    return [Math.round((v.x * 0.5 + 0.5) * 1600), Math.round((-v.y * 0.5 + 0.5) * 900)];
  };
  return {
    vmLights: lights(w.scene), vmEnvIntensity: w.scene.environmentIntensity,
    worldLights: lights(g.scene), worldEnvIntensity: g.scene.environmentIntensity,
    vmScreen: project(vmProbe, w.camera), worldScreen: project(worldProbe, g.camera),
    vmRadiusPx: Math.round(0.030 / 0.40 / Math.tan(w.camera.fov * Math.PI / 360) * 450),
    worldRadiusPx: Math.round(0.20 / 2.7 / Math.tan(g.camera.fov * Math.PI / 360) * 450),
  };
});
await page.screenshot({ path: `${OUT}/probe_${preset}.png` });
console.log(JSON.stringify(info, null, 1));
await browser.close();
server.close();
