import { load } from './_pp.mjs';
// usage: node tools/_vmstat.mjs file.png x y w h [label]
const [f, ...rest] = process.argv.slice(2);
const img = load(f);
for (let i = 0; i < rest.length; i += 5) {
  const x0 = +rest[i], y0 = +rest[i + 1], w = +rest[i + 2], h = +rest[i + 3];
  const label = rest[i + 4] ?? '';
  let n = 0, sl = 0, sl2 = 0, sr = 0, sg = 0, sb = 0, mn = 999, mx = -1;
  // local gradient energy (detail measure)
  let ge = 0;
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
    const L = img.luma(x, y);
    const [r, g, b] = img.px(x, y);
    n++; sl += L; sl2 += L * L; sr += r; sg += g; sb += b;
    if (L < mn) mn = L; if (L > mx) mx = L;
    ge += Math.abs(img.luma(x + 1, y) - L) + Math.abs(img.luma(x, y + 1) - L);
  }
  const mean = sl / n;
  const sd = Math.sqrt(sl2 / n - mean * mean);
  console.log(
    `${label.padEnd(22)} mean L ${mean.toFixed(1)}  sd ${sd.toFixed(2)}  min ${mn.toFixed(0)} max ${mx.toFixed(0)}` +
    `  rgb ${(sr / n).toFixed(0)},${(sg / n).toFixed(0)},${(sb / n).toFixed(0)}  gradE ${(ge / n / 2).toFixed(2)}`);
}
