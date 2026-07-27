import { load } from './_pp.mjs';
// Sky banding: walk a column through clean sky, report the run-length of
// identical 8-bit values per channel. Real dither -> runs of 1-2. Terracing
// -> long flat runs with unit jumps.
const img = load(process.argv[2]);
const x = +process.argv[3], y0 = +process.argv[4], y1 = +process.argv[5];
const chans = ['R','G','B'];
for (let c=0;c<3;c++){
  let runs=[], last=null, len=0, vals=[];
  for(let y=y0;y<=y1;y++){ const v=img.px(x,y)[c]; vals.push(v);
    if(v===last) len++; else { if(last!==null) runs.push(len); last=v; len=1; } }
  runs.push(len);
  const uniq = new Set(vals).size;
  const span = Math.max(...vals)-Math.min(...vals);
  const maxRun = Math.max(...runs);
  const mean = runs.reduce((a,b)=>a+b,0)/runs.length;
  console.log(`  ${chans[c]}: span ${span} over ${y1-y0+1}px, ${uniq} distinct values, mean flat-run ${mean.toFixed(1)}px, longest ${maxRun}px`);
}
// also: how many *transitions* are non-monotonic (dither) vs monotonic steps
let up=0,down=0,flat=0;
for(let y=y0;y<y1;y++){const a=img.luma(x,y),b=img.luma(x,y+1); if(b>a+0.01)up++; else if(b<a-0.01)down++; else flat++;}
console.log(`  luma transitions: up ${up} down ${down} flat ${flat}`);
