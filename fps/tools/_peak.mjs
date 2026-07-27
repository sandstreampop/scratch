import { load } from './_pp.mjs';
for (const f of process.argv.slice(2)) {
  const img = load(f);
  let best = -1, bx = 0, by = 0;
  const hist = new Array(256).fill(0);
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    const ny = y / img.height, nx = x / img.width;
    if (ny < 0.13) continue;
    if (ny > 0.86 && (nx < 0.20 || nx > 0.80)) continue;
    const l = img.luma(x, y);
    hist[Math.min(255, Math.round(l))]++;
    if (l > best) { best = l; bx = x; by = y; }
  }
  // top percentiles
  let n = hist.reduce((a, b) => a + b, 0);
  const pct = (p) => { let c = 0; for (let v = 255; v >= 0; v--) { c += hist[v]; if (c / n >= p) return v; } return 0; };
  console.log(`${f}: peak luma ${best.toFixed(1)} at (${bx},${by}) rgb=${img.px(bx,by)}`);
  console.log(`   p99.9=${pct(0.001)} p99.99=${pct(0.0001)}  maxR/G/B seen:`);
  let mr=0,mg=0,mb=0;
  for (let y=0;y<img.height;y++) for(let x=0;x<img.width;x++){const [r,g,b]=img.px(x,y); if(r>mr)mr=r; if(g>mg)mg=g; if(b>mb)mb=b;}
  console.log(`   ${mr} ${mg} ${mb}`);
}
