import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.png':'image/png','.json':'application/json' };
const server = http.createServer((req,res)=>{const p=decodeURIComponent(new URL(req.url,'http://x').pathname);
  const f=path.join(ROOT,p==='/'?'index.html':p);
  if(!f.startsWith(ROOT)||!fs.existsSync(f)||fs.statSync(f).isDirectory()){res.writeHead(404);res.end('no');return;}
  res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});fs.createReadStream(f).pipe(res);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const port=server.address().port;
const preset=process.argv[2]||'cross';
const browser=await chromium.launch({executablePath:'/opt/pw-browsers/chromium',headless:true,
  args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage','--hide-scrollbars']});
const page=await browser.newPage({viewport:{width:1600,height:900}});
page.on('pageerror',e=>console.error('PAGEERROR',String(e).slice(0,300)));
await page.goto(`http://127.0.0.1:${port}/index.html?shot=${preset}`,{timeout:60000});
await page.waitForFunction('window.__SHOT_READY === true',null,{timeout:300000,polling:500});
const out=await page.evaluate(async()=>{
  const THREE=await import('/vendor/three/three.module.js');
  const g=window.__GAME, a=g.atmosphere;
  const R={sunDir:a.sunDirection.toArray().map(v=>+v.toFixed(3)),
    sunElev:+(Math.asin(a.sunDirection.y)*180/Math.PI).toFixed(2),
    sunI:a.sun.intensity, hemiI:a.hemi.intensity, fillI:a.bounce.intensity,
    exposure:g.renderer.toneMappingExposure,
    camPos:g.camera.position.toArray().map(v=>+v.toFixed(2))};
  // find container bodies: painted material with non-white color
  R.painted=[];
  g.scene.traverse(o=>{
    if(!o.isMesh)return; const m=o.material; if(!m||!m.color)return;
    const hex=m.color.getHexString(THREE.SRGBColorSpace);
    if(hex!=='ffffff' && m.map && m.map.image && m.map.image.data && m.map.image.width>=256){
      const key=hex+'|'+o.geometry.parameters?.width;
      if(!R.painted.find(p=>p.key===key)){
        const d=m.map.image.data; let sr=0,sg=0,sb=0,n=0;
        for(let i=0;i<d.length;i+=4){sr+=d[i];sg+=d[i+1];sb+=d[i+2];n++;}
        const s=v=>{v/=255; return v<=0.04045?v/12.92:Math.pow((v+0.055)/1.055,2.4);};
        const base=[s(sr/n),s(sg/n),s(sb/n)];
        R.painted.push({key,hex,size:o.geometry.parameters,
          baseLin:base.map(v=>+v.toFixed(4)),
          tintLin:[m.color.r,m.color.g,m.color.b].map(v=>+v.toFixed(4)),
          productLin:[base[0]*m.color.r,base[1]*m.color.g,base[2]*m.color.b].map(v=>+v.toFixed(4)),
          worldPos:o.getWorldPosition(new THREE.Vector3()).toArray().map(v=>+v.toFixed(1))});
      }
    }
  });
  // sand albedo for comparison
  g.scene.traverse(o=>{
    if(R.sand||!o.isMesh)return; const m=o.material;
    if(m&&m.map&&m.map.image&&m.map.image.data&&o.geometry.type==='PlaneGeometry'){
      const d=m.map.image.data;let sr=0,sg=0,sb=0,n=0;
      for(let i=0;i<d.length;i+=4){sr+=d[i];sg+=d[i+1];sb+=d[i+2];n++;}
      const s=v=>{v/=255;return v<=0.04045?v/12.92:Math.pow((v+0.055)/1.055,2.4);};
      R.sand={lin:[s(sr/n),s(sg/n),s(sb/n)].map(v=>+v.toFixed(4)),tint:m.color.getHexString(THREE.SRGBColorSpace)};
    }
  });
  return R;
});
console.log(JSON.stringify(out,null,1));
await browser.close(); server.close();
