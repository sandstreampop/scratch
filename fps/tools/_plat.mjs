import { load } from './_pp.mjs';
const img=load('shots/combat.png');
let n=0,gs=0,bs=0,gmin=999,gmax=-1,bmin=999,bmax=-1;
for(let y=415;y<545;y++)for(let x=900;x<1070;x++){
  const [r,g,b]=img.px(x,y); if(r<255) continue;
  n++; gs+=g; bs+=b; if(g<gmin)gmin=g; if(g>gmax)gmax=g; if(b<bmin)bmin=b; if(b>bmax)bmax=b;
}
console.log(`combat flash core: ${n} px with R=255 inside 170x130 box; G ${gmin}..${gmax} (mean ${(gs/n).toFixed(1)}), B ${bmin}..${bmax} (mean ${(bs/n).toFixed(1)})`);
// local RMS contrast around the enemy in combat vs detail
function rms(img,x0,y0,w,h){let s=0,s2=0,n=0;for(let y=y0;y<y0+h;y++)for(let x=x0;x<x0+w;x++){const l=img.luma(x,y);s+=l;s2+=l*l;n++;}const m=s/n;return {mean:m.toFixed(1),rms:Math.sqrt(s2/n-m*m).toFixed(1)};}
const d=load('shots/detail.png');
console.log('combat enemy window (860,540,80,70):', JSON.stringify(rms(img,860,540,80,70)));
console.log('detail enemy window (400,405,80,70):', JSON.stringify(rms(d,400,405,80,70)));
