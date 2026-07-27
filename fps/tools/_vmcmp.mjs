import { load } from './_pp.mjs';
const S = '/tmp/claude-0/-home-user-scratch/04050bce-8cd4-5b27-8bb2-a86253a2ff74/scratchpad/c';
const withGlass = load('shots/ads.png');
const noWeapon = load(`${S}/ads_noweapon.png`);
const noGlass = load(`${S}/ads_ng_full.png`);

function patch(img, x0, y0, w, h) {
  let sl = 0, sr = 0, sg = 0, sb = 0, n = 0, s2 = 0;
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
    const L = img.luma(x, y); const [r, g, b] = img.px(x, y);
    sl += L; s2 += L * L; sr += r; sg += g; sb += b; n++;
  }
  const m = sl / n;
  return { L: m, sd: Math.sqrt(s2 / n - m * m), r: sr / n, g: sg / n, b: sb / n };
}
const rects = [
  ['sight centre-left', 745, 430, 34, 34],
  ['sight below dot  ', 782, 480, 36, 30],
  ['sight lower      ', 760, 500, 60, 24],
  ['world left of tube', 620, 430, 40, 60],
  ['world right of tube', 960, 430, 40, 60],
];
for (const [name, x, y, w, h] of rects) {
  const a = patch(withGlass, x, y, w, h);
  const b = patch(noWeapon, x, y, w, h);
  const c = patch(noGlass, x, y, w, h);
  console.log(`${name}  glass L ${a.L.toFixed(1)} (${a.r.toFixed(0)},${a.g.toFixed(0)},${a.b.toFixed(0)}) sd ${a.sd.toFixed(1)} | noGlass L ${c.L.toFixed(1)} sd ${c.sd.toFixed(1)} | world L ${b.L.toFixed(1)} (${b.r.toFixed(0)},${b.g.toFixed(0)},${b.b.toFixed(0)}) sd ${b.sd.toFixed(1)}  -> transmit ${(a.L / b.L * 100).toFixed(0)}%  contrast ${(a.sd / b.sd * 100).toFixed(0)}%`);
}
