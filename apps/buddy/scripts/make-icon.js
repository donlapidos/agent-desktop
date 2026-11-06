// Draws Buddy's pointer (the same shape as the on-screen buddy) into assets/buddy.ico and assets/buddy.png.
// Each size is rasterized natively, with 4x4 supersampling, so small sizes stay crisp. Run: node scripts/make-icon.js
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, "../assets");
const POINTER = [[3, 2], [19, 10], [11.5, 12], [8.5, 19.5]]; // overlay.html's 22x22 path
const BLUE = [0x2f, 0x7a, 0xff];
const SIZES = [256, 64, 48, 32, 24, 16];

function segDist(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

function inside(px, py, poly) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function render(size) {
  // Fit the pointer's 16 x 17.5 bounding box into the canvas with room for the outline and shadow.
  const scale = (size * 0.74) / 17.5;
  const ox = (size - 16 * scale) / 2 - 3 * scale;
  const oy = (size - 17.5 * scale) / 2 - 2 * scale - size * 0.02;
  const poly = POINTER.map(([x, y]) => [ox + x * scale, oy + y * scale]);
  const stroke = Math.max(1.2, size * 0.045);
  const shadowY = size * 0.025, blur = size * 0.05;
  const edge = (x, y) => Math.min(...poly.map((p, i) => segDist(x, y, p, poly[(i + 1) % poly.length])));

  const px = Buffer.alloc(size * size * 4);
  const S = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const fx = x + (sx + 0.5) / S, fy = y + (sy + 0.5) / S;
          const d = edge(fx, fy), inPoly = inside(fx, fy, poly);
          if (inPoly && d > stroke) { r += BLUE[0]; g += BLUE[1]; b += BLUE[2]; a += 255; continue; }
          if (inPoly || d <= stroke) { r += 255; g += 255; b += 255; a += 255; continue; }
          const sd = inside(fx, fy - shadowY, poly) ? 0 : edge(fx, fy - shadowY) - stroke;
          const sa = sd <= 0 ? 0.3 : 0.3 * Math.max(0, 1 - sd / blur) ** 2;
          a += sa * 255; // black shadow: color channels stay 0
        }
      }
      const n = S * S, alpha = a / n, o = (y * size + x) * 4;
      // Store straight (unpremultiplied) color.
      px[o] = alpha ? Math.round(r / n / (alpha / 255)) : 0;
      px[o + 1] = alpha ? Math.round(g / n / (alpha / 255)) : 0;
      px[o + 2] = alpha ? Math.round(b / n / (alpha / 255)) : 0;
      px[o + 3] = Math.round(alpha);
    }
  }
  return px;
}

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ICO with PNG-compressed entries (supported since Windows Vista).
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    header[e] = size >= 256 ? 0 : size; header[e + 1] = size >= 256 ? 0 : size;
    header.writeUInt16LE(1, e + 4); header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(data.length, e + 8); header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map((i) => i.data)]);
}

fs.mkdirSync(OUT, { recursive: true });
const images = SIZES.map((size) => ({ size, data: png(size, render(size)) }));
fs.writeFileSync(path.join(OUT, "buddy.ico"), ico(images));
fs.writeFileSync(path.join(OUT, "buddy.png"), images[0].data);
fs.writeFileSync(path.join(OUT, "tray.png"), images.find((i) => i.size === 32).data);
console.log("wrote", SIZES.join(", "), "px into", OUT);
