import { load } from './_pp.mjs';
const img=load(process.argv[2]);
const x=+process.argv[3];
for(let y=140;y<=860;y+=60){
  let s=0,n=0; for(let j=-4;j<=4;j++)for(let i=-4;i<=4;i++){s+=img.luma(x+i,y+j);n++;}
  const cx=x/1600-0.5, cy=y/900-0.5, r2=cx*cx+cy*cy;
  const t=Math.min(1,Math.max(0,(r2*2-0.10)/0.72));
  const ss=t*t*(3-2*t); const vig=1-0.30*ss;
  console.log(`  y=${String(y).padStart(4)}  L ${(s/n).toFixed(1).padStart(6)}  vig ${vig.toFixed(3)}`);
}
