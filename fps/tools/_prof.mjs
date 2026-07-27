import { load } from './_pp.mjs';
const img = load(process.argv[2]);
const mode = process.argv[3]; // 'col' walks y, 'row' walks x
const fixed = +process.argv[4], a = +process.argv[5], b = +process.argv[6];
const out=[];
for (let t=a;t<=b;t++){
  const [r,g,bb] = mode==='col' ? img.px(fixed,t) : img.px(t,fixed);
  out.push(`${String(t).padStart(4)}  R${String(r).padStart(3)} G${String(g).padStart(3)} B${String(bb).padStart(3)}   B-R ${String(bb-r).padStart(4)}   L${(0.2126*r+0.7152*g+0.0722*bb).toFixed(0).padStart(3)}`);
}
console.log(out.join('\n'));
