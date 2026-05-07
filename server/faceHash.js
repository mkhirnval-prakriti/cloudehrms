/**
 * Perceptual difference hash (dHash) for face photo comparison — JPEG buffer in.
 */
const jpeg = require("jpeg-js");

function grayAt(data, w, x, y) {
  const i = (y * w + x) * 4;
  return data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
}

function sampleBlock(data, w, h, bw, bh, gx, gy) {
  let sum = 0;
  const x0 = Math.floor((gx * w) / bw);
  const x1 = Math.floor(((gx + 1) * w) / bw);
  const y0 = Math.floor((gy * h) / bh);
  const y1 = Math.floor(((gy + 1) * h) / bh);
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      sum += grayAt(data, w, x, y);
      n++;
    }
  }
  return n ? sum / n : 0;
}

function dHashFromRgba(data, width, height) {
  const bw = 9;
  const bh = 8;
  const g = [];
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      g.push(sampleBlock(data, width, height, bw, bh, x, y));
    }
  }
  let bits = 0n;
  let bit = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const i = y * 9 + x;
      if (g[i] > g[i + 1]) bits |= 1n << BigInt(bit);
      bit++;
    }
  }
  return bits.toString(16).padStart(16, "0");
}

function hammingHex(a, b) {
  if (!a || !b || a.length !== b.length) return 64;
  try {
    const x = BigInt("0x" + a) ^ BigInt("0x" + b);
    let n = 0;
    for (let i = 0n; i < 64n; i++) {
      if ((x >> i) & 1n) n++;
    }
    return n;
  } catch {
    return 64;
  }
}

function phashFromBuffer(buf) {
  const decoded = jpeg.decode(buf, { useTArray: true });
  if (!decoded || !decoded.data) throw new Error("Could not decode JPEG");
  return dHashFromRgba(decoded.data, decoded.width, decoded.height);
}

module.exports = { phashFromBuffer, hammingHex };
