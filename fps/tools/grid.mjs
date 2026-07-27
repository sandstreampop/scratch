// Overlay a coordinate grid, or crop a region. Writes /tmp out.
// node tools/grid.mjs in.png out.png [x0 y0 w h scale]
import fs from 'node:fs';
import zlib from 'node:zlib';

function decodePng(buf) {
  let pos = 8, width = 0, height = 0, colourType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); colourType = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const channels = colourType === 6 ? 4 : 3;
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const line = raw.subarray(rp, rp + stride); rp += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = (prev && x >= channels) ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a; else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

const crcTable = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(w, h, rgb) {
  const stride = w * 3;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) { raw[y * (stride + 1)] = 0; rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const [inp, outp, ...r] = process.argv.slice(2);
const img = decodePng(fs.readFileSync(inp));
const x0 = r[0] ? Number(r[0]) : 0, y0 = r[1] ? Number(r[1]) : 0;
const cw = r[2] ? Number(r[2]) : img.width, ch = r[3] ? Number(r[3]) : img.height;
const sc = r[4] ? Number(r[4]) : 1;
const W = cw * sc, H = ch * sc;
const out = Buffer.alloc(W * H * 3);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const sx = Math.min(img.width - 1, x0 + Math.floor(x / sc));
  const sy = Math.min(img.height - 1, y0 + Math.floor(y / sc));
  const k = (sy * img.width + sx) * img.channels, o = (y * W + x) * 3;
  out[o] = img.data[k]; out[o + 1] = img.data[k + 1]; out[o + 2] = img.data[k + 2];
}
// grid in source coordinates
const step = Number(process.env.STEP || 100);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const sx = x0 + Math.floor(x / sc), sy = y0 + Math.floor(y / sc);
  const o = (y * W + x) * 3;
  const vx = sx % step === 0, vy = sy % step === 0;
  const major = (sx % (step * 5) === 0) || (sy % (step * 5) === 0);
  if (vx || vy) {
    if (major && ((sx % (step * 5) === 0 && vx) || (sy % (step * 5) === 0 && vy))) { out[o] = 0; out[o + 1] = 255; out[o + 2] = 0; }
    else { out[o] = 255; out[o + 1] = 0; out[o + 2] = 255; }
  }
}
fs.writeFileSync(outp, encodePng(W, H, out));
console.log(`${outp} ${W}x${H} from (${x0},${y0}) ${cw}x${ch} x${sc}, grid ${step}`);
