import fs from 'node:fs'; import zlib from 'node:zlib'; import { load } from './_pp.mjs';
const [f,X,Y,W,H,S,LO,HI,out]=process.argv.slice(2);
const img=load(f); const x0=+X,y0=+Y,w=+W,h=+H,s=+S,lo=+LO,hi=+HI;
const ow=w*s,oh=h*s; const raw=Buffer.alloc(oh*(ow*3+1)); let p=0;
const map=v=>Math.max(0,Math.min(255,Math.round((v-lo)*255/(hi-lo))));
for(let y=0;y<oh;y++){raw[p++]=0;for(let x=0;x<ow;x++){const [r,g,b]=img.px(x0+Math.floor(x/s),y0+Math.floor(y/s));raw[p++]=map(r);raw[p++]=map(g);raw[p++]=map(b);}}
function chunk(t,d){const l=Buffer.alloc(4);l.writeUInt32BE(d.length);const td=Buffer.concat([Buffer.from(t,'ascii'),d]);const T=(()=>{const a=[];for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;a[n]=c>>>0}return a})();let c=0xffffffff;for(const b of td)c=T[(c^b)&0xff]^(c>>>8);const cr=Buffer.alloc(4);cr.writeUInt32BE((c^0xffffffff)>>>0);return Buffer.concat([l,td,cr]);}
const ih=Buffer.alloc(13);ih.writeUInt32BE(ow,0);ih.writeUInt32BE(oh,4);ih[8]=8;ih[9]=2;
fs.writeFileSync(out,Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ih),chunk('IDAT',zlib.deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]));
console.log('wrote',out);
