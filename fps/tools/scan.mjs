// node tools/scan.mjs img.png row|col index start end step
import fs from 'node:fs';
import zlib from 'node:zlib';
function decodePng(buf) {
  let pos = 8, width = 0, height = 0, colourType = 0; const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); colourType = data[9]; }
    else if (type === 'IDAT') idat.push(data); else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const channels = colourType === 6 ? 4 : 3, stride = width * channels;
  const out = Buffer.alloc(height * stride); let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++]; const line = raw.subarray(rp, rp + stride); rp += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0, b = prev ? prev[x] : 0;
      const c = (prev && x >= channels) ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a; else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
      cur[x] = v & 0xff;
    }
  }
  return { width, height, channels, data: out };
}
const [f, mode, idxS, s0, s1, stS, avgS] = process.argv.slice(2);
const img = decodePng(fs.readFileSync(f));
const idx = Number(idxS), st = Number(stS || 10), avg = Number(avgS || 3);
for (let t = Number(s0); t < Number(s1); t += st) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let d = -avg; d <= avg; d++) {
    const x = mode === 'row' ? t : idx + d, y = mode === 'row' ? idx + d : t;
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
    const k = (y * img.width + x) * img.channels;
    r += img.data[k]; g += img.data[k + 1]; b += img.data[k + 2]; n++;
  }
  r /= n; g /= n; b /= n;
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  console.log(`${String(t).padStart(5)}  ${r.toFixed(0).padStart(3)} ${g.toFixed(0).padStart(3)} ${b.toFixed(0).padStart(3)}   Y ${luma.toFixed(1).padStart(5)}  ${'#'.repeat(Math.round(luma / 6))}`);
}
