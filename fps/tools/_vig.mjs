import { load } from './_pp.mjs';
const img=load(process.argv[2]);
const y=+process.argv[3];
const out=[];
for(let x=40;x<=1560;x+=80){
  let s=0,n=0; for(let j=-4;j<=4;j++)for(let i=-4;i<=4;i++){s+=img.luma(x+i,y+j);n++;}
  const cx=x/1600-0.5, cy=y/900-0.5, r2=cx*cx+cy*cy;
  const t=Math.min(1,Math.max(0,(r2*2-0.10)/0.72));
  const ss=t*t*(3-2*t);
  const vig=1-0.30*ss;
  out.push(`  x=${String(x).padStart(4)}  measured L ${(s/n).toFixed(1).padStart(6)}   vignette mult ${vig.toFixed(3)}  -> devignetted ${((s/n)/vig).toFixed(1)}`);
}
console.log(`${process.argv[2]} row y=${y}`);
console.log(out.join('\n'));
