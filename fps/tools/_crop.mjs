import fs from 'node:fs';
import zlib from 'node:zlib';
import { load } from './_pp.mjs';
const [f,X,Y,W,H,S,out] = process.argv.slice(2);
const img = load(f);
const x0=+X,y0=+Y,w=+W,h=+H,s=+S;
const ow=w*s, oh=h*s;
const raw = Buffer.alloc(oh*(ow*3+1));
let p=0;
for(let y=0;y<oh;y++){
  raw[p++]=0;
  for(let x=0;x<ow;x++){
    const [r,g,b]=img.px(x0+Math.floor(x/s), y0+Math.floor(y/s));
    raw[p++]=r; raw[p++]=g; raw[p++]=b;
  }
}
function chunk(type,data){
  const len=Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td=Buffer.concat([Buffer.from(type,'ascii'),data]);
  const crcT=(()=>{const t=[];for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[n]=c>>>0;}return t;})();
  let c=0xffffffff; for(const b of td) c=crcT[(c^b)&0xff]^(c>>>8);
  const crc=Buffer.alloc(4); crc.writeUInt32BE((c^0xffffffff)>>>0);
  return Buffer.concat([len,td,crc]);
}
const ihdr=Buffer.alloc(13); ihdr.writeUInt32BE(ow,0); ihdr.writeUInt32BE(oh,4); ihdr[8]=8; ihdr[9]=2;
fs.writeFileSync(out, Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]));
console.log('wrote',out,ow+'x'+oh);
