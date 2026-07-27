import { load } from './_pp.mjs';
const img=load('shots/combat.png');
for(let y=400;y<=620;y+=20){
  let row='';
  for(let x=780;x<=1080;x+=20){ const [r,g,b]=img.px(x,y); row+=`${String(r).padStart(3)},${String(g).padStart(3)},${String(b).padStart(3)} `; }
  console.log(`y${y} `+row);
}
