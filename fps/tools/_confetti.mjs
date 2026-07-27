import { load } from './_pp.mjs';
// Find isolated pixels whose hue deviates hugely from their 8-neighbourhood.
for (const f of process.argv.slice(2)) {
  const img = load(f);
  let count=0; const ex=[];
  for(let y=2;y<img.height-2;y++)for(let x=2;x<img.width-2;x++){
    const nx=x/img.width, ny=y/img.height;
    if(ny<0.13) continue; if(ny>0.86&&(nx<0.20||nx>0.80)) continue;
    const [r,g,b]=img.px(x,y);
    let sr=0,sg=0,sb=0;
    for(let j=-1;j<=1;j++)for(let i=-1;i<=1;i++){ if(!i&&!j)continue; const p=img.px(x+i,y+j); sr+=p[0];sg+=p[1];sb+=p[2]; }
    sr/=8;sg/=8;sb/=8;
    const drb=(r-b)-(sr-sb);
    if(Math.abs(drb)>110){ count++; if(ex.length<14) ex.push(`  (${x},${y}) px ${r},${g},${b}  nbr ${sr.toFixed(0)},${sg.toFixed(0)},${sb.toFixed(0)}`); }
  }
  console.log(`${f}: ${count} isolated hue-outlier pixels (|d(R-B)| > 110 vs 8-neighbour mean)`);
  console.log(ex.join('\n'));
}
