import { load } from './_pp.mjs';
const img = load(process.argv[2]);
// locate brightest cluster (sun) by 5x5 box mean
let best=-1,bx=0,by=0;
for(let y=100;y<img.height-100;y+=2)for(let x=100;x<img.width-100;x+=2){
  let s=0; for(let j=-2;j<=2;j++)for(let i=-2;i<=2;i++) s+=img.luma(x+i,y+j);
  if(s>best){best=s;bx=x;by=y;}
}
console.log('sun centre approx',bx,by,'mean',(best/25).toFixed(1));
// radial profile
const rows=[];
for(const r of [0,2,4,6,8,12,16,24,32,48,64,96,128,192,256,320]){
  let s=0,n=0;
  for(let a=0;a<64;a++){const t=a/64*Math.PI*2; const x=bx+Math.cos(t)*r, y=by+Math.sin(t)*r; s+=img.luma(x,y); n++;}
  rows.push(`  r=${String(r).padStart(3)}  luma ${(s/n).toFixed(1)}`);
}
console.log(rows.join('\n'));
// horizontal scan through sun
let line='';
for(let x=bx-320;x<=bx+320;x+=20) line+=`${x}:${img.luma(x,by).toFixed(0)} `;
console.log('h-scan:',line);
