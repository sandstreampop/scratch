import { load } from './_pp.mjs';
// Measure "dottiness" of thin dark geometry against a smooth bright background.
// For each row in a box, find min luma and the local background (row median),
// report contrast. A continuous line gives similar contrast every row; a
// stippled one alternates between full contrast and ~zero.
const [f,X,Y,W,H] = process.argv.slice(2);
const img = load(f);
const x0=+X,y0=+Y,w=+W,h=+H;
const rows=[];
for(let y=y0;y<y0+h;y++){
  const vals=[]; for(let x=x0;x<x0+w;x++) vals.push(img.luma(x,y));
  const sorted=[...vals].sort((a,b)=>a-b);
  const med=sorted[sorted.length>>1];
  const mn=sorted[0];
  rows.push({y, dip: med-mn, med});
}
const dips=rows.map(r=>r.dip);
const mx=Math.max(...dips);
console.log(`${f} box ${x0},${y0} ${w}x${h}  max dip ${mx.toFixed(1)}`);
console.log(rows.map(r=>`  y=${r.y} bg${r.med.toFixed(0)} dip${r.dip.toFixed(0)} ${'#'.repeat(Math.round(r.dip/2))}`).join('\n'));
