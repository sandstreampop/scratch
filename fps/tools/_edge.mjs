import { load } from './_pp.mjs';
const img = load(process.argv[2]);
// print an RGB strip along a scanline
const y = +process.argv[3], x0 = +process.argv[4], x1 = +process.argv[5];
const vert = process.argv[6] === 'v';
let out=[];
for (let x = x0; x <= x1; x++) {
  const [r,g,b] = vert ? img.px(y, x) : img.px(x, y);
  out.push(`${String(x).padStart(4)} ${String(r).padStart(3)} ${String(g).padStart(3)} ${String(b).padStart(3)}  L${(0.2126*r+0.7152*g+0.0722*b).toFixed(0).padStart(3)}  r-b ${String(r-b).padStart(4)}`);
}
console.log(out.join('\n'));
