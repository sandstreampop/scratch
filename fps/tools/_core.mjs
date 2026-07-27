import { load } from './_pp.mjs';
const img=load('shots/hero.png'); const bx=964,by=346; const m=new Map();
for(let y=by-14;y<=by+14;y++)for(let x=bx-14;x<=bx+14;x++){
  if((x-bx)**2+(y-by)**2>196) continue;
  const k=img.px(x,y).join(','); m.set(k,(m.get(k)||0)+1);
}
const s=[...m].sort((a,b)=>b[1]-a[1]).slice(0,8);
console.log(`  ${m.size} distinct RGB triples in a 14px-radius disc (${[...m.values()].reduce((a,b)=>a+b,0)} px)`);
console.log(s.map(([k,v])=>`    ${k} x${v}`).join('\n'));
