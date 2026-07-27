// Tonal statistics for a captured frame.
//
// "Too dark" and "blown out" are the two complaints a look gets most often and
// the two that are least worth arguing about from memory. This reads the
// actual pixels and reports where they sit, so a grading change can be checked
// rather than described.
//
// Usage: node tools/histo.mjs shots/cross.png [more.png ...]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/** Minimal PNG reader: 8-bit truecolour(+alpha), non-interlaced. */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png');
  let pos = 8;
  let width = 0, height = 0, colourType = 0, depth = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colourType = data[9];
      if (depth !== 8 || (colourType !== 2 && colourType !== 6)) {
        throw new Error(`unsupported png: depth ${depth} colour ${colourType}`);
      }
      if (data[12] !== 0) throw new Error('interlaced png unsupported');
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

// The HUD is drawn over the render and would count as blown highlights and
// crushed shadows that the renderer never produced. Text sits top-centre,
// bottom-left and bottom-right; skipping those bands keeps the statistics
// about the image.
function inHud(x, y, w, h) {
  const nx = x / w, ny = y / h;
  if (ny < 0.13) return true;                      // compass and objective
  if (ny > 0.86 && (nx < 0.20 || nx > 0.80)) return true;  // score and ammo
  return false;
}

for (const file of process.argv.slice(2)) {
  const { width, height, channels, data } = decodePng(fs.readFileSync(file));
  const bins = new Array(16).fill(0);
  // Per channel, because a conjunction over all three cannot fire on a grade
  // whose blue gain is below 1. This counter used to be `r>249 && g>249 &&
  // b>249` and duly reported no clipping at all on a frame with 34,000 hard-
  // clipped red pixels: blue is capped at code 251 by uGain.b before anything
  // in the scene is considered, so the condition is unreachable by
  // construction. A metric that cannot report the defect it exists to catch is
  // worse than no metric, because it gets quoted as evidence of the opposite.
  const chan = [[], [], []].map(() => new Uint32Array(256));
  let n = 0, sum = 0, black = 0, satPx = 0;
  const satSum = [0, 0, 0];
  let colourful = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (inHud(x, y, width, height)) continue;
      const i = (y * width + x) * channels;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      bins[Math.min(15, luma / 16 | 0)]++;
      chan[0][r]++; chan[1][g]++; chan[2][b]++;
      n++; sum += luma;
      if (luma < 6) black++;
      if (r >= 254 || g >= 254 || b >= 254) {
        satPx++; satSum[0] += r; satSum[1] += g; satSum[2] += b;
      }
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (mx > 8 && (mx - mn) / mx > 0.12) colourful++;
    }
  }
  const pct = (v) => `${(100 * v / n).toFixed(2)}%`;
  const quantile = (h, q) => {
    let seen = 0; const target = q * n;
    for (let v = 0; v < 256; v++) { seen += h[v]; if (seen >= target) return v; }
    return 255;
  };
  const extreme = (h, hi) => {
    if (hi) { for (let v = 255; v >= 0; v--) if (h[v]) return v; }
    else { for (let v = 0; v < 256; v++) if (h[v]) return v; }
    return -1;
  };
  console.log(`\n${path.basename(file)}  ${width}x${height}`);
  console.log(`  mean luma      ${(sum / n).toFixed(1)}`);
  console.log(`  crushed <6     ${pct(black)}`);
  console.log(`  any chan >=254 ${pct(satPx)}`
    + (satPx ? `  mean colour rgb(${satSum.map((s) => Math.round(s / satPx)).join(',')})` : ''));
  console.log(`  saturated      ${pct(colourful)}`);
  console.log('  per channel    ' + ['R', 'G', 'B'].map((c, k) =>
    `${c} min ${extreme(chan[k], false)} p99.9 ${quantile(chan[k], 0.999)} max ${extreme(chan[k], true)}`,
  ).join('\n                 '));
  const peak = Math.max(...bins);
  console.log('  histogram (16 buckets, 0 -> 255)');
  bins.forEach((c, i) => {
    const bar = '#'.repeat(Math.round(40 * c / peak));
    console.log(`    ${String(i * 16).padStart(3)}-${String(i * 16 + 15).padEnd(3)} ${pct(c).padStart(6)} ${bar}`);
  });
}
