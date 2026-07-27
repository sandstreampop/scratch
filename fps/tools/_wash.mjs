import { load } from './_pp.mjs';
for(const f of process.argv.slice(2)){
  const img=load(f);
  const th=[180,200,220,235,245];
  const cnt=th.map(()=>0); let n=0;
  let cx=0,cy=0,cn=0, minx=1e9,maxx=-1,miny=1e9,maxy=-1;
  for(let y=0;y<img.height;y++)for(let x=0;x<img.width;x++){
    const nx=x/img.width, ny=y/img.height;
    if(ny<0.13) continue; if(ny>0.86&&(nx<0.20||nx>0.80)) continue;
    const l=img.luma(x,y); n++;
    th.forEach((t,i)=>{ if(l>t) cnt[i]++; });
    if(l>220){ cx+=x;cy+=y;cn++; if(x<minx)minx=x; if(x>maxx)maxx=x; if(y<miny)miny=y; if(y>maxy)maxy=y;}
  }
  console.log(`${f}: ` + th.map((t,i)=>`>${t}: ${(100*cnt[i]/n).toFixed(1)}%`).join('  '));
  if(cn) console.log(`   >220 region: centroid (${(cx/cn).toFixed(0)},${(cy/cn).toFixed(0)}) bbox ${minx}..${maxx} x ${miny}..${maxy}`);
}
