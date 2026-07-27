import { load } from './_pp.mjs';
// Sub-pixel per-channel edge position on a near-vertical edge, averaged over rows.
const [f,X0,X1,Y0,Y1] = process.argv.slice(2);
const img=load(f); const x0=+X0,x1=+X1,y0=+Y0,y1=+Y1;
const cent=[0,0,0]; let rows=0;
for(let y=y0;y<=y1;y++){
  const c=[0,0,0], w=[0,0,0]; let ok=true;
  for(let ch=0;ch<3;ch++){
    for(let x=x0;x<x1;x++){
      const g=Math.abs(img.px(x+1,y)[ch]-img.px(x,y)[ch]);
      c[ch]+= (x+0.5)*g; w[ch]+=g;
    }
    if(w[ch]<40) ok=false;
  }
  if(!ok) continue;
  for(let ch=0;ch<3;ch++) cent[ch]+=c[ch]/w[ch];
  rows++;
}
if(!rows){console.log('no usable rows');process.exit(0);}
const R=cent[0]/rows,G=cent[1]/rows,B=cent[2]/rows;
const cx=(x0+x1)/2/1600-0.5;
const pred=cx*0.00045*1600; // predicted per-channel shift in px from uAberration
console.log(`${f} edge x~${((x0+x1)/2)|0} rows ${rows}`);
console.log(`  R centroid ${R.toFixed(3)}  G ${G.toFixed(3)}  B ${B.toFixed(3)}`);
console.log(`  R-B separation ${(R-B).toFixed(3)} px   (uAberration alone predicts ${(-2*pred).toFixed(3)} px)`);
