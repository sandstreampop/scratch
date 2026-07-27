import { load } from './_pp.mjs';
for(const f of process.argv.slice(2)){
  const img=load(f); let r255=0,g255=0,b255=0,n=0,allhi=0, b248=0;
  let mb=0;
  for(let y=0;y<img.height;y++)for(let x=0;x<img.width;x++){
    const ny=y/img.height,nx=x/img.width;
    if(ny<0.13) continue; if(ny>0.86&&(nx<0.20||nx>0.80)) continue;
    const [r,g,b]=img.px(x,y); n++;
    if(r>=255)r255++; if(g>=255)g255++; if(b>=255)b255++;
    if(b>mb)mb=b; if(b>=245)b248++;
    if(r>=250&&g>=250&&b>=250)allhi++;
  }
  console.log(`${f}: R=255 ${(100*r255/n).toFixed(2)}% (${r255}px)  G=255 ${(100*g255/n).toFixed(3)}%  B=255 ${b255}px  B>=245 ${b248}px  maxB ${mb}  all>=250 ${allhi}px`);
}
