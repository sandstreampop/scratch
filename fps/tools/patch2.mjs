// Region sampler: node tools/patch2.mjs shots/x.png x0 y0 x1 y1 [label] ...
import fs from 'node:fs';
import zlib from 'node:zlib';

function decodePng(buf) {
  let pos = 8, width = 0, height = 0, colourType = 0, depth = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      depth = data[8]; colourType = data[9];
    } else if (type === 'IDAT') idat.push(data);
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
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
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

const args = process.argv.slice(2);
const img = decodePng(fs.readFileSync(args[0]));
const rest = args.slice(1);
const toLin = (v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
for (let i = 0; i < rest.length; i += 5) {
  const [x0, y0, x1, y1] = rest.slice(i, i + 4).map(Number);
  const label = rest[i + 4] ?? '';
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const k = (y * img.width + x) * img.channels;
    r += img.data[k]; g += img.data[k + 1]; b += img.data[k + 2]; n++;
  }
  r /= n; g /= n; b /= n;
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const lr = toLin(r), lg = toLin(g), lb = toLin(b);
  const linY = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  console.log(`${label.padEnd(26)} rgb ${r.toFixed(1)},${g.toFixed(1)},${b.toFixed(1)}  luma ${luma.toFixed(1)}  lin ${linY.toFixed(4)}  sat ${((mx - mn) / Math.max(mx, 1e-6) * 100).toFixed(1)}%  B-R ${(b - r).toFixed(1)}`);
}
